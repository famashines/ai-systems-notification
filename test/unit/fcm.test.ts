import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  fcmScope,
  fcmSender,
  readServiceAccount,
  tokenUrl,
  type ServiceAccount,
} from "../../src/adapters/fcm.ts";
import type { Push } from "../../src/domain/push.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const account: ServiceAccount = {
  type: "service_account",
  project_id: "famashines-ai",
  client_email: "push@famashines-ai.iam.gserviceaccount.com",
  private_key: privateKey,
};
const sendUrl = "https://fcm.googleapis.com/v1/projects/famashines-ai/messages:send";
const push: Push = {
  title: "Task done",
  body: "Your task has a result. Open the app to read it.",
  data: { kind: "completed", taskId: "00000000-0000-4000-8000-000000000001" },
};

interface Call {
  url: string;
  headers: Headers;
  body: string;
}

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (input: string, init: { headers: HeadersInit; body: string | URLSearchParams }) => {
    const call = { url: input, headers: new Headers(init.headers), body: init.body.toString() };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return {
    calls,
    fetch: fetch as unknown as typeof globalThis.fetch,
    at: (index: number) => calls[index] ?? assert.fail(`no call ${String(index)}`),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const google = (send: () => Response) => (call: Call) =>
  call.url === tokenUrl ? json(200, { access_token: "access-1", expires_in: 3600 }) : send();

const decode = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString()) as Record<string, unknown>;

test("the sender signs a token request, then sends the FCM v1 message", async () => {
  let clock = 1_800_000_000_000;
  const { calls, fetch, at } = fakeFetch(
    google(() => json(200, { name: "projects/x/messages/1" })),
  );
  const sender = fcmSender({ account, fetch, now: () => clock });
  assert.equal(await sender.send("device-token", push), "sent");
  const token = at(0);
  const send = at(1);
  assert.equal(token.url, tokenUrl);
  const form = new URLSearchParams(token.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(claims), {
    iss: account.client_email,
    scope: fcmScope,
    aud: tokenUrl,
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header ?? ""}.${claims ?? ""}`),
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
    ),
  );
  assert.equal(send.url, sendUrl);
  assert.equal(send.headers.get("authorization"), "Bearer access-1");
  assert.deepEqual(JSON.parse(send.body), {
    message: {
      token: "device-token",
      notification: { title: push.title, body: push.body },
      data: push.data,
      android: { priority: "HIGH", notification: { tag: push.data.taskId } },
    },
  });
  await sender.send("device-token", { ...push, data: { kind: "budget" } });
  assert.equal(calls.length, 3);
  assert.deepEqual((JSON.parse(at(2).body) as { message: { android: unknown } }).message.android, {
    priority: "HIGH",
    notification: { tag: "budget" },
  });
  clock += 3600 * 1000;
  await sender.send("device-token", push);
  assert.deepEqual(
    calls.map((call) => call.url),
    [tokenUrl, sendUrl, sendUrl, tokenUrl, sendUrl],
  );
});

test("UNREGISTERED gives unregistered", async () => {
  const { fetch } = fakeFetch(
    google(() =>
      json(404, {
        error: {
          code: 404,
          status: "NOT_FOUND",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      }),
    ),
  );
  assert.equal(await fcmSender({ account, fetch }).send("old-token", push), "unregistered");
});

test("other FCM errors throw; a 401 gets a new access token next time", async () => {
  let status = 503;
  const { calls, fetch } = fakeFetch(
    google(() => json(status, { error: { code: status, status: "UNAVAILABLE" } })),
  );
  const sender = fcmSender({ account, fetch });
  await assert.rejects(sender.send("device-token", push), /FCM answered 503 UNAVAILABLE/);
  status = 401;
  await assert.rejects(sender.send("device-token", push), /FCM answered 401/);
  status = 500;
  await assert.rejects(sender.send("device-token", push), /500/);
  assert.deepEqual(
    calls.map((call) => call.url),
    [tokenUrl, sendUrl, sendUrl, tokenUrl, sendUrl],
  );
});

test("an error body that is not JSON still throws", async () => {
  const { fetch } = fakeFetch(google(() => new Response("bad gateway", { status: 502 })));
  await assert.rejects(fcmSender({ account, fetch }).send("t", push), /502 with no code/);
});

test("a failed token request throws", async () => {
  const { fetch } = fakeFetch(() => json(400, { error: "invalid_grant" }));
  await assert.rejects(
    fcmSender({ account, fetch }).send("t", push),
    /token request failed with 400/,
  );
});

let folder = "";

before(async () => {
  folder = await mkdtemp(join(tmpdir(), "notification-fcm-"));
});

after(async () => {
  await rm(folder, { recursive: true, force: true });
});

test("the service account file is read and checked, and an error never shows the key", async () => {
  const good = join(folder, "good.json");
  await writeFile(good, JSON.stringify({ ...account, private_key_id: "k1" }));
  assert.deepEqual(await readServiceAccount(good), account);
  const broken = join(folder, "broken.json");
  await writeFile(broken, `{"private_key": "${account.private_key.slice(0, 80)}`);
  await assert.rejects(readServiceAccount(broken), (error: Error) => {
    assert.match(error.message, /cannot be read as JSON/);
    assert.ok(!error.message.includes("PRIVATE KEY"));
    return true;
  });
  const wrong = join(folder, "wrong.json");
  await writeFile(wrong, JSON.stringify({ ...account, type: "authorized_user" }));
  await assert.rejects(readServiceAccount(wrong), /not a Google service account key/);
  await assert.rejects(readServiceAccount(join(folder, "missing.json")), /cannot be read/);
});
