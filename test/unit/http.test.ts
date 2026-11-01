import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MongoNetworkError } from "mongodb";
import type { JwtVerifier } from "@famashines/ai-systems-kit/auth";
import { createService, ForbiddenError, UnauthorizedError } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { fakeIds } from "@famashines/ai-systems-kit/testing";
import { routes } from "../../src/adapters/http.ts";
import type { Device } from "../../src/application/notify.ts";

const tokens: Record<string, JwtVerifier> = {
  owner: () => Promise.resolve({ sub: "owner-1", roles: ["owner"], exp: 0 }),
  guest: () => Promise.reject(new ForbiddenError("The role is missing")),
};
const verify: JwtVerifier = (token) =>
  (tokens[token] ?? (() => Promise.reject(new UnauthorizedError())))(token);
const stored = new Map<string, Device>();
const removed: { deviceId: string; ownerId: string }[] = [];
let failing = false;
const now = new Date("2026-11-01T10:00:00.000Z");
const app = createService({
  logger: createLogger({ service: "notification", release: "test", level: "silent" }),
  routes: routes({
    devices: {
      register: (device) => {
        if (failing) return Promise.reject(new MongoNetworkError("down"));
        const created = !stored.has(device.deviceId);
        stored.set(device.deviceId, device);
        return Promise.resolve({ created });
      },
      unregister: (deviceId, ownerId) => {
        removed.push({ deviceId, ownerId });
        stored.delete(deviceId);
        return Promise.resolve();
      },
    },
    verify,
    now: () => now,
  }),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

const ids = fakeIds(5);

const register = (overrides: Record<string, unknown> = {}) => ({
  commandId: ids(),
  type: "notification.RegisterDevice",
  actor: { kind: "owner", id: "owner-1" },
  payload: { deviceId: ids(), platform: "android", token: "fcm-token-1", locale: "de" },
  ...overrides,
});

const post = (path: string, body: unknown, token: string | null = "owner") =>
  fetch(`${base}/internal/commands/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});

test("the owner registers a device: 201, then 200 with a new token and locale", async () => {
  const command = register();
  const first = await post("register-device", command);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { deviceId: command.payload.deviceId });
  assert.deepEqual(stored.get(command.payload.deviceId), {
    ...command.payload,
    ownerId: "owner-1",
  });
  const payload = { ...command.payload, token: "fcm-token-2", locale: "ur" };
  const second = await post("register-device", register({ payload }));
  assert.equal(second.status, 200);
  assert.equal(stored.get(command.payload.deviceId)?.token, "fcm-token-2");
  assert.equal(stored.get(command.payload.deviceId)?.locale, "ur");
});

test("the owner unregisters a device", async () => {
  const command = register();
  await post("register-device", command);
  const response = await post("unregister-device", {
    commandId: ids(),
    type: "notification.UnregisterDevice",
    actor: { kind: "owner", id: "owner-1" },
    payload: { deviceId: command.payload.deviceId },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deviceId: command.payload.deviceId });
  assert.equal(stored.has(command.payload.deviceId), false);
  assert.deepEqual(removed.at(-1), { deviceId: command.payload.deviceId, ownerId: "owner-1" });
});

test("no token gives 401 and a token with no owner role gives 403, before the body", async () => {
  for (const path of ["register-device", "unregister-device"]) {
    assert.deepEqual(await problem(await post(path, { not: "a command" }, null)), {
      status: 401,
      code: "unauthorized",
    });
    assert.deepEqual(await problem(await post(path, { not: "a command" }, "guest")), {
      status: 403,
      code: "forbidden",
    });
  }
});

test("an actor that is not the subject of the token gives 403", async () => {
  const body = register({ actor: { kind: "owner", id: "someone-else" } });
  assert.deepEqual(await problem(await post("register-device", body)), {
    status: 403,
    code: "forbidden",
  });
});

test("a bad body gives 400", async () => {
  const good = register();
  for (const body of [
    register({ type: "notification.UnregisterDevice" }),
    register({ actor: { kind: "agent", id: "owner-1" } }),
    register({ payload: { ...good.payload, locale: "fr" } }),
    register({ payload: { ...good.payload, platform: "ios" } }),
    register({ payload: { ...good.payload, token: "has space" } }),
    register({ payload: { ...good.payload, deviceId: "not-a-uuid" } }),
  ]) {
    assert.deepEqual(await problem(await post("register-device", body)), {
      status: 400,
      code: "validation_failed",
    });
  }
});

test("a database failure gives 503", async () => {
  failing = true;
  try {
    assert.deepEqual(await problem(await post("register-device", register())), {
      status: 503,
      code: "unavailable",
    });
  } finally {
    failing = false;
  }
});
