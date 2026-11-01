# ai-systems-notification

The Notification service of ai-systems. It keeps the FCM tokens of the
owner's devices and sends a push with the FCM HTTP v1 API when a task is
done, failed, needs an approval, or a budget limit needs the owner
(ADR 0013). It is not event-sourced and emits no events (ARCHITECTURE 6
and 7). The service is internal and has no Ingress.

```
owner --api-gateway--POST /internal/commands/register-device-----> devices (MongoDB)
owner --api-gateway--POST /internal/commands/unregister-device---> devices

ORCHESTRATION --one durable for each push event--+
BUDGET --durable notification (ThresholdCrossed)-+--> push table --> sent (claim, mark)
                                                                   --> PushSender --> FCM HTTP v1
                                                                         | UNREGISTERED, SENDER_ID_MISMATCH
                                                                         v
                                                               device removed
```

Architecture and reasons: `ai-systems-docs` (`ARCHITECTURE.md` 7 and 11,
ADR 0013, 0021, 0023, 0028). Schemas: `@famashines/ai-systems-contracts`
v0.4.1 (`src/notification.ts`, README "Push").

## Commands

Both routes check the owner bearer token in the handler before they read
the body (`kit/auth`: role `owner`, issuer, audience, `exp`). No token
gives 401, a token with no `owner` role gives 403. Then the body is
checked. The `actor.id` must be the `sub` of the token, else 403.
api-gateway must forward `Authorization` on these routes.

| Route                                       | Body type                                                                 | Answer                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /internal/commands/register-device`   | `notification.RegisterDevice` (`deviceId`, `platform`, `token`, `locale`) | 201 `{ deviceId }` for a new device, 200 for a known one |
| `POST /internal/commands/unregister-device` | `notification.UnregisterDevice` (`deviceId`)                              | 200 `{ deviceId }`, also when the device is not known    |

- A register with a known `deviceId` replaces its token and locale. A
  token that another `deviceId` has is moved to the new device, so a
  device never gets the same push two times.
- Unregister removes the device only if the same owner (`sub`)
  registered it.
- The commands are idempotent by their effect, so the service keeps no
  `commands` collection.
- The token is a secret of the device. It is only in `devices`. No log,
  no event and no answer has it.

## Push table

| Event                                                   | `PushKind`        |
| ------------------------------------------------------- | ----------------- |
| `orchestration.RunCompleted`                            | `completed`       |
| `orchestration.RunFailed`                               | `failed`          |
| `orchestration.RunBlocked` with `subtask_failed`        | `failed`          |
| `orchestration.RunBlocked` with `forbidden`             | `failed`          |
| `orchestration.PlanProposed` with `awaitsApproval` true | `approval_needed` |
| `orchestration.CheckpointOpened`                        | `approval_needed` |
| `budget.ThresholdCrossed`                               | `budget`          |
| `orchestration.RunBlocked` with `budget_refused`        | `budget`          |
| `orchestration.RunBlocked` with `runaway_stopped`       | `budget`          |

Other events give no push. The `forbidden` and `runaway_stopped` rows
are owner decisions of M3 (2026-11-01); the contracts table gets them in
its next release.

## Push content

- A push has a fixed title and a short body in the locale of the device
  (`en`, `de`, `ur`, in `src/domain/push.ts`), and the data `PushDataV1`:
  `kind`, and `taskId` for every kind except `budget`. No text of the
  event goes into a push: no prompt, no output, no summary, no reason,
  no subtask title (ADR 0013).
- FCM message: `notification` (title, body), `data`, Android priority
  `HIGH`, and the tag `taskId` (or `budget`), so a newer push of the same
  task replaces the older one on the phone.
- ADR 0013 says that done and failed push only when the app is not in the
  foreground. The server cannot know this. It sends every push, and the
  app does not show done and failed while it is in the foreground.

## Once only

The service claims, then sends, then marks. A crash does not lose a push. A
second copy can come after a crash, and the Android tag of the task
replaces the first copy on the phone.

```
claim (insert, claimedAt) --> send --> mark (sentAt)
   | exists, sentAt                    sent: skip
   | exists, no sentAt, under 60 s     busy: throw, the message comes again
   | exists, no sentAt, 60 s or more   take over the claim and send
```

- `sent` has one document for each source event and device
  (`_id` `<eventId>:<deviceId>`, `claimedAt`, `sentAt`, 30 days TTL on
  `claimedAt`).
- A redelivery sends nothing to a device whose document has `sentAt`.
- A claim with no `sentAt` is from a try that runs now, or from a crash
  between the claim and the send. If it is under 60 seconds old, the
  handler throws and the consumer gets the message again with the kit
  backoff (1, 5, 30, 120 seconds). A claim of 60 seconds or more is taken
  over and sent.
- If FCM fails for a device, the service removes the claim of that device,
  tries the other devices, and then throws. Only the failed devices get the
  push on the next try. If the removal fails too (MongoDB is down), the
  claim stays, and a try after 60 seconds takes it over.
- If the mark fails after a send, the push can come a second time after 60
  seconds. The tag of the task collapses it on the phone.
- After 5 tries the message goes to the `DLQ`. A DLQ replay sends it
  only within 24 hours of the event (the max age below).
- An event older than 24 hours gives no push. A new durable consumer
  starts at the first message of its stream (30 days), so this stops a
  flood of old pushes when a consumer is made again.

## Consumers

Each push event has its own durable with one fixed filter subject
(ADR 0023), so the service reads only the events of the push table:

| Durable                          | Stream          | Filter                           |
| -------------------------------- | --------------- | -------------------------------- |
| `notification-run-completed`     | `ORCHESTRATION` | `orchestration.RunCompleted`     |
| `notification-run-failed`        | `ORCHESTRATION` | `orchestration.RunFailed`        |
| `notification-run-blocked`       | `ORCHESTRATION` | `orchestration.RunBlocked`       |
| `notification-plan-proposed`     | `ORCHESTRATION` | `orchestration.PlanProposed`     |
| `notification-checkpoint-opened` | `ORCHESTRATION` | `orchestration.CheckpointOpened` |
| `notification`                   | `BUDGET`        | `budget.ThresholdCrossed`        |

The NATS grants of the user `ai-systems-notification` must match this
table. The integration test has the grants.

## FCM

- The real sender signs a JWT (RS256, `node:crypto`) with the service
  account key, gets an access token from `https://oauth2.googleapis.com/token`
  (scope `firebase.messaging`) and keeps it until one minute before it
  expires. It sends to
  `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`.
- `GOOGLE_APPLICATION_CREDENTIALS` is the path of the service account
  JSON file (a mounted secret). The service reads it at start and stops
  if it is not a service account key. The error never shows the key.
- The error code `UNREGISTERED` (404) or `SENDER_ID_MISMATCH` (403)
  removes the device: the token is not valid for this Firebase project. A 401
  drops the cached access token. Every other error throws, so the push
  comes again.
- Tests and CI use only the fake sender (`test/fake-sender.ts`) and a fake
  `fetch`. No test calls FCM.

## Configuration

| Variable                         | Default                                         |
| -------------------------------- | ----------------------------------------------- |
| `MONGODB_URI`                    | required                                        |
| `MONGODB_DATABASE`               | `notification`                                  |
| `NATS_SERVERS`                   | required, comma-separated                       |
| `NATS_USER`, `NATS_PASSWORD`     | required                                        |
| `OIDC_ISSUER`                    | `https://auth.famashines.com/realms/ai-systems` |
| `OIDC_JWKS_URL`                  | from the issuer                                 |
| `OIDC_AUDIENCE`                  | `ai-systems-app`                                |
| `GOOGLE_APPLICATION_CREDENTIALS` | required, path of the service account JSON      |
| `PORT`                           | `8080`                                          |
| `LOG_LEVEL`, `RELEASE`, `OTEL_*` | kit defaults                                    |

`/health`, `/ready` (MongoDB, migrations, all six consumers), `/metrics`.

## Known limits

- One replica. Two pods share the durables, and `sent` stops a double
  push, so a rollout is safe.
- All devices get all pushes: the system has one owner.
- The app must make the Android notification channel. The message sends
  no `channel_id`, so Android uses the default channel of the app.
