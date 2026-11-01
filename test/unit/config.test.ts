import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "@famashines/ai-systems-kit/config";
import { envSchema, subscriptions } from "../../src/main.ts";

const env = {
  MONGODB_URI: "mongodb://mongo:27017/?replicaSet=rs0",
  NATS_SERVERS: " nats://a:4222 ,, nats://b:4222,",
  NATS_USER: "ai-systems-notification",
  NATS_PASSWORD: "secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/var/run/secrets/fcm/service-account.json",
};

test("the defaults: database notification, the Keycloak realm", () => {
  const config = loadConfig(envSchema, env);
  assert.deepEqual(config.NATS_SERVERS, ["nats://a:4222", "nats://b:4222"]);
  assert.equal(config.MONGODB_DATABASE, "notification");
  assert.equal(config.OIDC_ISSUER, "https://auth.famashines.com/realms/ai-systems");
  assert.equal(config.OIDC_AUDIENCE, "ai-systems-app");
  assert.equal(config.OIDC_JWKS_URL, undefined);
});

for (const [name, value] of [
  ["GOOGLE_APPLICATION_CREDENTIALS", ""],
  ["NATS_SERVERS", " , ,"],
  ["OIDC_ISSUER", "ftp://auth.example"],
]) {
  test(`${String(name)} "${String(value)}" is refused`, () => {
    assert.throws(() => loadConfig(envSchema, { ...env, [String(name)]: value }), ConfigError);
  });
}

test("each push event has its own durable with one fixed subject", () => {
  assert.deepEqual(
    subscriptions.map(({ stream, filter }) => `${stream} ${filter}`),
    [
      "ORCHESTRATION orchestration.RunCompleted",
      "ORCHESTRATION orchestration.RunFailed",
      "ORCHESTRATION orchestration.RunBlocked",
      "ORCHESTRATION orchestration.PlanProposed",
      "ORCHESTRATION orchestration.CheckpointOpened",
      "BUDGET budget.ThresholdCrossed",
    ],
  );
  assert.equal(new Set(subscriptions.map(({ durable }) => durable)).size, subscriptions.length);
});
