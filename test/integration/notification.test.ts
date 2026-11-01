import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { jetstream } from "@nats-io/jetstream";
import type { PushDataV1, RegisteredEvent } from "@famashines/ai-systems-contracts";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { connectNats, type Nats } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, type Mongo } from "@famashines/ai-systems-kit/mongo";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  createStreams,
  startMongo,
  startNats,
  waitFor,
  type Started,
} from "@famashines/ai-systems-kit/testing";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { texts } from "../../src/domain/push.ts";
import { envSchema, start } from "../../src/main.ts";
import { rows, sentinel } from "../events.ts";
import { fakeSender } from "../fake-sender.ts";

const orchestrationDurables = [
  ["notification-run-completed", "RunCompleted"],
  ["notification-run-failed", "RunFailed"],
  ["notification-run-blocked", "RunBlocked"],
  ["notification-plan-proposed", "PlanProposed"],
  ["notification-checkpoint-opened", "CheckpointOpened"],
];

const notificationGrants = [
  "dlq.notification.>",
  ...orchestrationDurables.map(([durable]) => `dlq.${String(durable)}.>`),
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.ORCHESTRATION",
  ...orchestrationDurables.flatMap(([durable, type]) => [
    `$JS.API.CONSUMER.CREATE.ORCHESTRATION.${String(durable)}.orchestration.${String(type)}`,
    `$JS.API.CONSUMER.INFO.ORCHESTRATION.${String(durable)}`,
    `$JS.API.CONSUMER.MSG.NEXT.ORCHESTRATION.${String(durable)}`,
    `$JS.ACK.ORCHESTRATION.${String(durable)}.>`,
  ]),
  "$JS.API.STREAM.INFO.BUDGET",
  "$JS.API.CONSUMER.CREATE.BUDGET.notification.budget.ThresholdCrossed",
  "$JS.API.CONSUMER.INFO.BUDGET.notification",
  "$JS.API.CONSUMER.MSG.NEXT.BUDGET.notification",
  "$JS.ACK.BUDGET.notification.>",
];

const adminGrants = ["$JS.API.>", "$JS.ACK.>", "orchestration.>", "budget.>", "dlq.>"];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const natsConfig = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: ai-systems-admin, password: admin
        permissions {
          publish { allow: [${list(adminGrants)}] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: ai-systems-notification, password: notification
        permissions {
          publish { allow: [${list(notificationGrants)}] }
          subscribe { allow: ["_INBOX_notification.>"] }
        }
      }
    ]
  }
}
`;

const logger = createLogger({ service: "test", release: "test", level: "silent" });
const issuer = "http://127.0.0.1/realms/ai-systems";
const owner = randomUUID();
const sender = fakeSender();
let mongoContainer: Started;
let natsContainer: Started;
let mongo: Mongo;
let admin: Nats;
let notification: Nats;
let jwks: Server;
let privateKey: CryptoKey;
let running: Awaited<ReturnType<typeof start>> | undefined;
let base = "";

const token = (roles: string[]) =>
  new SignJWT({ typ: "Bearer", azp: "ai-systems-app", realm_access: { roles } })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience("ai-systems-app")
    .setSubject(owner)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

before(async () => {
  [mongoContainer, natsContainer] = await Promise.all([
    startMongo(),
    startNats({ config: natsConfig }),
  ]);
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const jwksUrl = `http://127.0.0.1:${String((jwks.address() as AddressInfo).port)}/certs`;
  mongo = await connectMongo({ url: mongoContainer.url, database: "notification" });
  const client = (user: string, pass: string) =>
    connectNats({ servers: natsContainer.url, user, pass, service: pass, logger });
  admin = await client("ai-systems-admin", "admin");
  notification = await client("ai-systems-notification", "notification");
  await createStreams(admin.connection, [
    { name: "ORCHESTRATION", subjects: ["orchestration.>"] },
    { name: "BUDGET", subjects: ["budget.>"] },
    { name: "DLQ", subjects: ["dlq.>"] },
  ]);
  const config = loadConfig(envSchema, {
    MONGODB_URI: mongoContainer.url,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-notification",
    NATS_PASSWORD: "notification",
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: jwksUrl,
    GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/service-account.json",
    LOG_LEVEL: "silent",
  });
  running = await start({ ...config, PORT: 0 }, { drainDelayMs: 0, sender });
  base = `http://127.0.0.1:${String(running.address.port)}`;
  await waitFor(async () => (await fetch(`${base}/ready`)).ok);
});

after(async () => {
  if (running) assert.equal(await running.app.close(), true);
  await Promise.all([admin.close(), notification.close(), mongo.close()]);
  await new Promise((resolve) => jwks.close(resolve));
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const command = async (path: string, type: string, payload: unknown, roles = ["owner"]) =>
  fetch(`${base}/internal/commands/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await token(roles)}`,
    },
    body: JSON.stringify({
      commandId: randomUUID(),
      type,
      actor: { kind: "owner", id: owner },
      payload,
    }),
  });

const register = (deviceId: string, token: string, locale: string) =>
  command("register-device", "notification.RegisterDevice", {
    deviceId,
    platform: "android",
    token,
    locale,
  });

const publish = async (event: RegisteredEvent, msgID = event.eventId) => {
  await jetstream(admin.connection).publish(event.type, JSON.stringify(event), { msgID });
};

const devices = () => mongo.db.collection<{ _id: string; token: string }>("devices");

const enDevice = randomUUID();
const urDevice = randomUUID();

const pushed = (data: PushDataV1) =>
  sender.sent.filter((item) => JSON.stringify(item.push.data) === JSON.stringify(data));

test("the owner registers two devices; a token with no owner role gives 403", async () => {
  assert.equal((await register(enDevice, "token-en", "en")).status, 201);
  assert.equal((await register(urDevice, "token-ur", "ur")).status, 201);
  assert.equal((await register(urDevice, "token-ur", "ur")).status, 200);
  const guest = await command(
    "register-device",
    "notification.RegisterDevice",
    { deviceId: randomUUID(), platform: "android", token: "token-x", locale: "en" },
    ["guest"],
  );
  assert.equal(guest.status, 403);
  assert.equal(await devices().countDocuments(), 2);
  const stored = await devices().findOne({ _id: urDevice });
  assert.equal(stored?.token, "token-ur");
});

test("each row of the push table pushes once to each device in its locale", async () => {
  const approval = rows.find((row) => row.name.startsWith("PlanProposed with")) ?? assert.fail();
  for (const row of rows) {
    const taskId = randomUUID();
    const data = row.push(taskId);
    const before = sender.sent.length;
    const event = row.event(taskId);
    await publish(event);
    if (data === undefined) {
      const marker = randomUUID();
      await publish(approval.event(marker));
      await waitFor(() => pushed({ kind: "approval_needed", taskId: marker }).length === 2);
      assert.equal(sender.sent.length, before + 2, row.name);
      continue;
    }
    await waitFor(() => sender.sent.length === before + 2);
    const pushes = sender.sent.slice(before);
    assert.deepEqual(
      pushes
        .map(({ token, push }) => ({ token, push }))
        .sort((a, b) => a.token.localeCompare(b.token)),
      [
        { token: "token-en", push: { ...texts.en[data.kind], data } },
        { token: "token-ur", push: { ...texts.ur[data.kind], data } },
      ],
      row.name,
    );
    assert.ok(!JSON.stringify(pushes).includes(sentinel), row.name);
    assert.equal(await mongo.db.collection("sent").countDocuments({ eventId: event.eventId }), 2);
  }
});

test("a redelivered event with a new message id pushes nothing again", async () => {
  const row = rows[0];
  assert.ok(row);
  const first = randomUUID();
  const event = row.event(first);
  await publish(event);
  await waitFor(() => pushed({ kind: "completed", taskId: first }).length === 2);
  await publish(event, randomUUID());
  const marker = randomUUID();
  await publish(row.event(marker));
  await waitFor(() => pushed({ kind: "completed", taskId: marker }).length === 2);
  assert.equal(pushed({ kind: "completed", taskId: first }).length, 2);
});

test("a token that FCM marks unregistered removes the device", async () => {
  sender.answers.set("token-ur", "unregistered");
  await publish(rows[0]?.event(randomUUID()) ?? assert.fail());
  await waitFor(async () => (await devices().countDocuments({ _id: urDevice })) === 0);
  sender.answers.delete("token-ur");
  assert.equal(await devices().countDocuments({ _id: enDevice }), 1);
});

test("the owner unregisters a device", async () => {
  const response = await command("unregister-device", "notification.UnregisterDevice", {
    deviceId: enDevice,
  });
  assert.equal(response.status, 200);
  assert.equal(await devices().countDocuments(), 0);
});

test("the grants let the service read only its fixed subjects", async () => {
  await assert.rejects(
    notification.connection.request(
      "$JS.API.CONSUMER.CREATE.ORCHESTRATION.notification-run-completed.orchestration.>",
      JSON.stringify({
        stream_name: "ORCHESTRATION",
        config: { durable_name: "notification-run-completed", filter_subject: "orchestration.>" },
      }),
      { timeout: 1000 },
    ),
  );
  const reply = await notification.connection.request(
    "$JS.API.CONSUMER.CREATE.ORCHESTRATION.notification-run-completed.orchestration.RunCompleted",
    JSON.stringify({
      stream_name: "ORCHESTRATION",
      config: {
        durable_name: "notification-run-completed",
        filter_subject: "orchestration.CallRequested",
        ack_policy: "explicit",
      },
      action: "",
    }),
    { timeout: 2000 },
  );
  assert.ok(reply.json<{ error?: unknown }>().error);
});

test("sent has a 30-day TTL", async () => {
  const indexes = await mongo.db.collection("sent").indexes();
  assert.ok(
    indexes.some((index) => index.key.sentAt === 1 && index.expireAfterSeconds === 30 * 86400),
  );
});
