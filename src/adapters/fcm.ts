import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PushSender } from "../application/notify.ts";

export const ServiceAccount = z.object({
  type: z.literal("service_account"),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/),
  client_email: z.email(),
  private_key: z.string().min(1),
});
export type ServiceAccount = z.infer<typeof ServiceAccount>;

const TokenReply = z.object({
  access_token: z.string().min(1),
  expires_in: z.int().positive(),
});

const ErrorReply = z.object({
  error: z.object({
    status: z.string().optional(),
    details: z.array(z.looseObject({ errorCode: z.string().optional() })).optional(),
  }),
});

export class FcmError extends Error {
  override readonly name = "FcmError";
}

export async function readServiceAccount(path: string): Promise<ServiceAccount> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new FcmError(`The service account file ${path} cannot be read as JSON`);
  }
  const account = ServiceAccount.safeParse(json);
  if (!account.success) {
    throw new FcmError(`The service account file ${path} is not a Google service account key`);
  }
  return account.data;
}

export interface FcmOptions {
  account: ServiceAccount;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export const tokenUrl = "https://oauth2.googleapis.com/token";
export const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";

const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export function fcmSender({
  account,
  fetch = globalThis.fetch,
  now = Date.now,
  timeoutMs = 10_000,
}: FcmOptions): PushSender {
  const key = createPrivateKey(account.private_key);
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({
      iss: account.client_email,
      scope: fcmScope,
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    })}`;
    const assertion = `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FcmError(`The Google token request failed with ${String(response.status)}`);
    }
    const reply = TokenReply.parse(await response.json());
    cached = {
      token: reply.access_token,
      expiresAt: now() + Math.max(0, reply.expires_in - 60) * 1000,
    };
    return cached.token;
  }

  return {
    send: async (token, { title, body, data }) => {
      const response = await fetch(sendUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data,
            android: {
              priority: "HIGH",
              notification: { tag: data.kind === "budget" ? "budget" : data.taskId },
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        await response.body?.cancel();
        return "sent";
      }
      const reply = ErrorReply.safeParse(await response.json().catch(() => undefined));
      const code = reply.success
        ? (reply.data.error.details?.find((detail) => detail.errorCode)?.errorCode ??
          reply.data.error.status)
        : undefined;
      if (code === "UNREGISTERED") return "unregistered";
      if (response.status === 401) cached = undefined;
      throw new FcmError(`FCM answered ${String(response.status)} ${code ?? "with no code"}`);
    },
  };
}
