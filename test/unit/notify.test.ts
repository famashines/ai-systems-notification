import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  notify,
  type Device,
  type Devices,
  type NotifyDeps,
  type SentLog,
} from "../../src/application/notify.ts";
import { texts } from "../../src/domain/push.ts";
import { rows, sentinel } from "../events.ts";
import { fakeSender } from "../fake-sender.ts";

const logger = createLogger({ service: "notification", release: "test", level: "silent" });

function memoryDevices(list: Device[]): Devices {
  return {
    all: () => Promise.resolve([...list]),
    register: () => Promise.reject(new Error("not used")),
    unregister: () => Promise.reject(new Error("not used")),
    remove: (deviceId, token) => {
      const index = list.findIndex((item) => item.deviceId === deviceId && item.token === token);
      if (index >= 0) list.splice(index, 1);
      return Promise.resolve();
    },
  };
}

function memorySent(): SentLog & { ids: Set<string> } {
  const ids = new Set<string>();
  return {
    ids,
    claim: ({ eventId, deviceId }) => {
      const id = `${eventId}:${deviceId}`;
      if (ids.has(id)) return Promise.resolve(false);
      ids.add(id);
      return Promise.resolve(true);
    },
    release: ({ eventId, deviceId }) => {
      ids.delete(`${eventId}:${deviceId}`);
      return Promise.resolve();
    },
  };
}

const device = (locale: Device["locale"], token = `token-${locale}`): Device => ({
  deviceId: randomUUID(),
  ownerId: "owner-1",
  platform: "android",
  token,
  locale,
});

function setup(list: Device[] = [device("en"), device("de"), device("ur")]) {
  const sender = fakeSender();
  const sent = memorySent();
  const deps: NotifyDeps = {
    devices: memoryDevices(list),
    sent,
    sender,
    now: () => new Date(),
    logger,
  };
  return { deps, sender, sent, list };
}

for (const row of rows) {
  test(`notify: ${row.name}, in the locale of each device, with no prompt or output`, async () => {
    const { deps, sender } = setup();
    const taskId = randomUUID();
    await notify(deps, row.event(taskId));
    const data = row.push(taskId);
    if (data === undefined) {
      assert.deepEqual(sender.sent, []);
      return;
    }
    assert.deepEqual(
      sender.sent.map(({ token, push }) => ({ token, push })),
      (["en", "de", "ur"] as const).map((locale) => ({
        token: `token-${locale}`,
        push: { ...texts[locale][data.kind], data },
      })),
    );
    for (const { push } of sender.sent) {
      assert.deepEqual(Object.keys(push).sort(), ["body", "data", "title"]);
      assert.ok(!JSON.stringify(push).includes(sentinel));
    }
  });
}

test("a redelivery of the same event sends nothing again", async () => {
  const { deps, sender } = setup();
  const event = rows[0]?.event(randomUUID());
  assert.ok(event);
  await notify(deps, event);
  await notify(deps, event);
  assert.equal(sender.sent.length, 3);
});

test("a failed device throws, the others are sent, and only it is sent again", async () => {
  const { deps, sender } = setup();
  sender.answers.set("token-de", new Error("FCM answered 503"));
  const event = rows[0]?.event(randomUUID());
  assert.ok(event);
  await assert.rejects(notify(deps, event), /503/);
  assert.deepEqual(
    sender.sent.map((item) => item.token),
    ["token-en", "token-ur"],
  );
  sender.answers.delete("token-de");
  await notify(deps, event);
  assert.deepEqual(
    sender.sent.map((item) => item.token),
    ["token-en", "token-ur", "token-de"],
  );
});

test("a token that FCM marks unregistered removes the device", async () => {
  const { deps, sender, list } = setup();
  sender.answers.set("token-de", "unregistered");
  await notify(deps, rows[0]?.event(randomUUID()) ?? assert.fail());
  assert.deepEqual(
    list.map((item) => item.locale),
    ["en", "ur"],
  );
});

test("an event older than one day gives no push", async () => {
  const { deps, sender, sent } = setup();
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await notify(deps, rows[0]?.event(randomUUID(), old) ?? assert.fail());
  assert.deepEqual(sender.sent, []);
  assert.equal(sent.ids.size, 0);
});

test("no device gives no push", async () => {
  const { deps, sender } = setup([]);
  await notify(deps, rows[0]?.event(randomUUID()) ?? assert.fail());
  assert.deepEqual(sender.sent, []);
});
