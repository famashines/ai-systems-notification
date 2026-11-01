import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { fakeClock } from "@famashines/ai-systems-kit/testing";
import {
  notify,
  type Device,
  type Devices,
  type NotifyDeps,
  type SentEntry,
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

interface Claim {
  claimedAt: Date;
  sentAt?: Date;
}

function memorySent(): SentLog & {
  claims: Map<string, Claim>;
  failRelease: boolean;
  failMark: boolean;
} {
  const claims = new Map<string, Claim>();
  const log = {
    claims,
    failRelease: false,
    failMark: false,
    claim: ({ eventId, deviceId }: SentEntry, now: Date, staleBefore: Date) => {
      const id = `${eventId}:${deviceId}`;
      const claim = claims.get(id);
      if (claim === undefined || (claim.sentAt === undefined && claim.claimedAt <= staleBefore)) {
        claims.set(id, { claimedAt: now });
        return Promise.resolve("claimed" as const);
      }
      return Promise.resolve(claim.sentAt === undefined ? ("busy" as const) : ("sent" as const));
    },
    markSent: ({ eventId, deviceId }: SentEntry, now: Date) => {
      if (log.failMark) return Promise.reject(new Error("MongoDB is down"));
      const claim = claims.get(`${eventId}:${deviceId}`);
      if (claim) claim.sentAt = now;
      return Promise.resolve();
    },
    release: ({ eventId, deviceId }: SentEntry) => {
      if (log.failRelease) return Promise.reject(new Error("MongoDB is down"));
      claims.delete(`${eventId}:${deviceId}`);
      return Promise.resolve();
    },
  };
  return log;
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
  const clock = fakeClock(new Date());
  const deps: NotifyDeps = {
    devices: memoryDevices(list),
    sent,
    sender,
    now: clock.now,
    logger,
  };
  return { deps, sender, sent, list, clock };
}

const firstRow = () => rows[0]?.event(randomUUID()) ?? assert.fail();

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

test("each push is marked as sent after the send", async () => {
  const { deps, sent } = setup();
  await notify(deps, firstRow());
  assert.equal(sent.claims.size, 3);
  for (const claim of sent.claims.values()) assert.ok(claim.sentAt);
});

test("a crash between claim and send: a fresh claim waits, an old claim is sent again", async () => {
  const { deps, sender, sent, list, clock } = setup([device("en")]);
  const event = firstRow();
  const crashed = list[0] ?? assert.fail();
  sent.claims.set(`${event.eventId}:${crashed.deviceId}`, { claimedAt: clock.now() });
  clock.advance(30_000);
  await assert.rejects(notify(deps, event), { name: "ClaimBusyError" });
  assert.deepEqual(sender.sent, []);
  clock.advance(30_001);
  await notify(deps, event);
  assert.equal(sender.sent.length, 1);
  await notify(deps, event);
  assert.equal(sender.sent.length, 1);
});

test("an approval_needed push is not lost when the release of a failed send fails", async () => {
  const { deps, sender, sent, clock } = setup([device("en")]);
  const event = rows.find((row) => row.name.startsWith("CheckpointOpened"))?.event(randomUUID());
  assert.ok(event);
  sender.answers.set("token-en", new Error("FCM answered 503"));
  sent.failRelease = true;
  await assert.rejects(notify(deps, event), /503/);
  sender.answers.delete("token-en");
  sent.failRelease = false;
  await assert.rejects(notify(deps, event), { name: "ClaimBusyError" });
  clock.advance(60_000);
  await notify(deps, event);
  assert.deepEqual(
    sender.sent.map((item) => item.push.data.kind),
    ["approval_needed"],
  );
});

test("a failed mark after the send throws, and the push comes again only after the timeout", async () => {
  const { deps, sender, sent, clock } = setup([device("en")]);
  const event = firstRow();
  sent.failMark = true;
  await assert.rejects(notify(deps, event), /MongoDB is down/);
  sent.failMark = false;
  await assert.rejects(notify(deps, event), { name: "ClaimBusyError" });
  clock.advance(60_000);
  await notify(deps, event);
  assert.equal(sender.sent.length, 2);
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
  assert.equal(sent.claims.size, 0);
});

test("no device gives no push", async () => {
  const { deps, sender } = setup([]);
  await notify(deps, rows[0]?.event(randomUUID()) ?? assert.fail());
  assert.deepEqual(sender.sent, []);
});
