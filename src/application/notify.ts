import type {
  DeviceLocale,
  DevicePlatform,
  PushKind,
  RegisteredEvent,
} from "@famashines/ai-systems-contracts";
import { describeError } from "@famashines/ai-systems-kit/messaging";
import type { createLogger } from "@famashines/ai-systems-kit/observability";
import { isStale, pushFor, pushOf, type Push } from "../domain/push.ts";

export interface Device {
  deviceId: string;
  ownerId: string;
  platform: DevicePlatform;
  token: string;
  locale: DeviceLocale;
}

export interface Devices {
  all(): Promise<Device[]>;
  register(device: Device, now: Date): Promise<{ created: boolean }>;
  unregister(deviceId: string, ownerId: string): Promise<void>;
  remove(deviceId: string, token: string): Promise<void>;
}

export interface SentEntry {
  eventId: string;
  deviceId: string;
  kind: PushKind;
}

export type ClaimState = "claimed" | "sent" | "busy";

export interface SentLog {
  claim(entry: SentEntry, now: Date, staleBefore: Date): Promise<ClaimState>;
  markSent(entry: SentEntry, now: Date): Promise<void>;
  release(entry: SentEntry): Promise<void>;
}

export const claimTimeoutMs = 60_000;

export class ClaimBusyError extends Error {
  override readonly name = "ClaimBusyError";
}

export type SendResult = "sent" | "unregistered";

export interface PushSender {
  send(token: string, push: Push): Promise<SendResult>;
}

export type Logger = ReturnType<typeof createLogger>;

export interface NotifyDeps {
  devices: Devices;
  sent: SentLog;
  sender: PushSender;
  now: () => Date;
  logger: Logger;
}

export async function notify(deps: NotifyDeps, event: RegisteredEvent): Promise<void> {
  const data = pushOf(event);
  if (data === undefined) return;
  if (isStale(event, deps.now())) {
    deps.logger.info({ eventId: event.eventId, type: event.type }, "an old event gives no push");
    return;
  }
  const failures: unknown[] = [];
  for (const device of await deps.devices.all()) {
    const entry = { eventId: event.eventId, deviceId: device.deviceId, kind: data.kind };
    const log = { eventId: event.eventId, deviceId: device.deviceId };
    try {
      const now = deps.now();
      const state = await deps.sent.claim(entry, now, new Date(now.getTime() - claimTimeoutMs));
      if (state === "sent") continue;
      if (state === "busy") throw new ClaimBusyError("Another try of this push is in progress");
      let result: SendResult;
      try {
        result = await deps.sender.send(device.token, pushFor(data, device.locale));
      } catch (error) {
        await deps.sent.release(entry).catch((releaseError: unknown) => {
          deps.logger.warn(
            { error: describeError(releaseError), ...log },
            "the claim was not released; a later try takes it over",
          );
        });
        throw error;
      }
      if (result === "unregistered") {
        await deps.devices.remove(device.deviceId, device.token);
        deps.logger.info({ deviceId: device.deviceId }, "FCM does not know the token; removed");
      }
      await deps.sent.markSent(entry, deps.now());
    } catch (error) {
      deps.logger.warn({ error: describeError(error), ...log }, "the push failed; it comes again");
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
