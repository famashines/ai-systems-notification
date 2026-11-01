import {
  Actor,
  CommandEnvelopeV1,
  RegisterDeviceCommandPayloadV1,
  UnregisterDeviceCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { bearerHook, subjectOf, type JwtVerifier } from "@famashines/ai-systems-kit/auth";
import {
  ForbiddenError,
  UnavailableError,
  validate,
  type Handler,
  type Request,
  type Route,
} from "@famashines/ai-systems-kit/http";
import { isInfrastructure } from "@famashines/ai-systems-kit/messaging";
import { z } from "zod";
import type { Devices } from "../application/notify.ts";

const Owner = Actor.extend({ kind: z.literal("owner") });

const RegisterDeviceBody = CommandEnvelopeV1(RegisterDeviceCommandPayloadV1).extend({
  type: z.literal("notification.RegisterDevice"),
  actor: Owner,
});

const UnregisterDeviceBody = CommandEnvelopeV1(UnregisterDeviceCommandPayloadV1).extend({
  type: z.literal("notification.UnregisterDevice"),
  actor: Owner,
});

export function toHttpError(error: unknown): unknown {
  if (isInfrastructure(error)) return new UnavailableError("The database is not available");
  return error;
}

const guard =
  (handler: Handler): Handler =>
  async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      throw toHttpError(error);
    }
  };

export interface HttpDeps {
  devices: Pick<Devices, "register" | "unregister">;
  verify: JwtVerifier;
  now: () => Date;
}

export function routes({ devices, verify, now }: HttpDeps): Route[] {
  const owner = bearerHook(verify);
  const ownerOf = async <S extends z.ZodType<{ actor: Actor }>>(
    request: Request,
    schema: S,
  ): Promise<{ body: z.output<S>; sub: string }> => {
    await owner(request);
    const { body } = await validate(request, { body: schema });
    const { sub } = subjectOf(request);
    if (body.actor.id !== sub) {
      throw new ForbiddenError("The actor is not the subject of the token");
    }
    return { body, sub };
  };
  return [
    {
      method: "POST",
      path: "/internal/commands/register-device",
      handler: guard(async (request) => {
        const { body, sub } = await ownerOf(request, RegisterDeviceBody);
        const { created } = await devices.register({ ...body.payload, ownerId: sub }, now());
        return { status: created ? 201 : 200, body: { deviceId: body.payload.deviceId } };
      }),
    },
    {
      method: "POST",
      path: "/internal/commands/unregister-device",
      handler: guard(async (request) => {
        const { body, sub } = await ownerOf(request, UnregisterDeviceBody);
        await devices.unregister(body.payload.deviceId, sub);
        return { body: { deviceId: body.payload.deviceId } };
      }),
    },
  ];
}
