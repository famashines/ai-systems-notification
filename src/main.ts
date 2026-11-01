import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { commonEnv, loadConfig } from "@famashines/ai-systems-kit/config";
import { createService } from "@famashines/ai-systems-kit/http";
import { connectNats, startConsumer } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, runMigrations } from "@famashines/ai-systems-kit/mongo";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";
import { z } from "zod";
import { fcmSender, readServiceAccount } from "./adapters/fcm.ts";
import { routes } from "./adapters/http.ts";
import { indexMigration, mongoDevices, mongoSent } from "./adapters/mongo.ts";
import { notify, type PushSender } from "./application/notify.ts";

export const service = "notification";

export const subscriptions = [
  {
    durable: "notification-run-completed",
    stream: "ORCHESTRATION",
    filter: "orchestration.RunCompleted",
  },
  {
    durable: "notification-run-failed",
    stream: "ORCHESTRATION",
    filter: "orchestration.RunFailed",
  },
  {
    durable: "notification-run-blocked",
    stream: "ORCHESTRATION",
    filter: "orchestration.RunBlocked",
  },
  {
    durable: "notification-plan-proposed",
    stream: "ORCHESTRATION",
    filter: "orchestration.PlanProposed",
  },
  {
    durable: "notification-checkpoint-opened",
    stream: "ORCHESTRATION",
    filter: "orchestration.CheckpointOpened",
  },
  { durable: "notification", stream: "BUDGET", filter: "budget.ThresholdCrossed" },
] as const;

const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = commonEnv.omit({ SERVICE_NAME: true }).extend({
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("notification"),
  NATS_SERVERS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((server) => server.trim())
        .filter((server) => server !== ""),
    )
    .pipe(z.array(z.string()).min(1)),
  NATS_USER: z.string().min(1),
  NATS_PASSWORD: z.string().min(1),
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
});

export type Config = z.output<typeof envSchema>;

export interface StartOptions {
  drainDelayMs?: number;
  sender?: PushSender;
}

export async function start(config: Readonly<Config>, { sender, ...options }: StartOptions = {}) {
  const release = config.RELEASE;
  const telemetry = startTelemetry({ serviceName: service, release });
  const logger = createLogger({ service, release, level: config.LOG_LEVEL });
  const push =
    sender ??
    fcmSender({ account: await readServiceAccount(config.GOOGLE_APPLICATION_CREDENTIALS) });
  logger.info("connecting to MongoDB");
  const mongo = await connectMongo({
    url: config.MONGODB_URI,
    database: config.MONGODB_DATABASE,
    clientOptions: { serverSelectionTimeoutMS: 5000 },
  });
  const migrations = [indexMigration];
  await runMigrations(mongo.db, migrations);
  const now = () => new Date();
  const devices = mongoDevices(mongo.db);
  const deps = { devices, sent: mongoSent(mongo.db), sender: push, now, logger };
  logger.info("connecting to NATS");
  const nats = await connectNats({
    servers: config.NATS_SERVERS,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
    service,
    logger,
  });
  const consumers = subscriptions.map(({ durable, stream, filter }) =>
    startConsumer({
      nats: { ...nats, service: durable },
      db: mongo.db,
      stream,
      filter,
      handler: (event) => notify(deps, event),
    }),
  );
  const verify = createJwtVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    requiredRole: "owner",
    ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
    logger,
  });
  const app = createService({
    logger,
    routes: routes({ devices, verify, now }),
    readiness: {
      mongo: mongo.ready,
      migrations: async () =>
        (await mongo.db
          .collection<{ _id: string }>("migrations")
          .countDocuments({ _id: { $in: migrations.map((migration) => migration.name) } })) ===
        migrations.length,
      consumers: async () =>
        (await Promise.all(consumers.map(async (consumer) => consumer.ready()))).every(Boolean),
    },
    metrics: telemetry.metricsHandler,
    closeHooks: [
      telemetry.shutdown,
      mongo.close,
      nats.close,
      async () => {
        await Promise.all(consumers.map(async (consumer) => consumer.close()));
      },
    ],
    ...options,
  });
  const address = await app.listen(config.PORT);
  logger.info({ port: address.port }, "notification started");
  return { app, address };
}

if (import.meta.main) {
  const exitEarly = (): never => process.exit(143);
  process.once("SIGTERM", exitEarly);
  process.once("SIGINT", exitEarly);
  const { app } = await start(loadConfig(envSchema));
  process.off("SIGTERM", exitEarly);
  process.off("SIGINT", exitEarly);
  app.handleSignals();
}
