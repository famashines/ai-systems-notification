# CLAUDE.md for ai-systems-notification

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../../docs/CLAUDE.md`). What the service does: `README.md`.

## Commands

| Command                    | Does                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `npm ci`                   | install from the lock file (builds kit and contracts on install) |
| `npm run check`            | `tsc --noEmit` (TypeScript 7)                                    |
| `npm run lint`             | ESLint (strict type-checked) and Prettier check                  |
| `npm test`                 | unit tests, two coverage gates (see below)                       |
| `npm run verify`           | check, lint and test                                             |
| `npm run test:integration` | `test/integration` with Testcontainers (needs Docker)            |
| `npm start`                | `node src/main.ts`                                               |

## Layout

```
src
├── domain/push.ts           push table, locale texts, max age; no I/O
├── application/notify.ts    ports (Devices, SentLog, PushSender), one push per event and device
├── adapters/http.ts         RegisterDevice, UnregisterDevice (owner token in the handler)
├── adapters/mongo.ts        devices, sent, the TTL migration
├── adapters/fcm.ts          FCM HTTP v1 sender, service account file
└── main.ts                  config, the six durables, wiring by constructor, start, shutdown
test
├── events.ts                one valid event for each row of the push table
├── fake-sender.ts           the PushSender of all tests; no test calls FCM
├── unit                     node:test, in-memory ports, fake fetch for FCM
└── integration              MongoDB and NATS in Testcontainers, the fake sender
```

## Coverage gates (ADR 0017)

`npm test` runs the unit tests two times, because node:test thresholds are
for all included files together:

- `test:domain`: `src/domain`, 90% lines and 85% branches.
- `test:unit`: `src` without `main.ts`, 70% lines.

`main.ts` is wiring. The integration test covers it through `start()`.
`adapters/mongo.ts` is covered by the integration test.

## Integration tests

The NATS config in the test has the grants of `ai-systems-notification`
for the six durables of `README.md`, and `ai-systems-admin`. They must be
the same as gitops (`kubernetes/infrastructure/nats/values.yaml`). Change
them together. `start()` takes the fake sender in its options, so
`GOOGLE_APPLICATION_CREDENTIALS` is not read. It signs tokens with `jose`
against a local JWKS. Wait with `waitFor`, never with a fixed sleep. Pass
`drainDelayMs: 0` to `start()`.

The CI job `integration` runs on `ubuntu-22.04`: `mongo:8.0.34` does not
start on the kernel of `ubuntu-24.04`. See the kit `CLAUDE.md`.

## Dependencies

- Kit and contracts come from git tags. A new tag needs a new
  `allowScripts` entry with the commit of the tag
  (`npm install-scripts approve <package>`).
- Check one copy with `npm ls @famashines/ai-systems-contracts zod mongodb`.
- `mongodb` and `zod` have the exact versions that the kit pins.
- The FCM sender uses `node:crypto` and `fetch`. It needs no Google
  library.
- TypeScript 6 (`typescript`, for ESLint) and 7 (`typescript-7`, for
  `check`): ADR 0022. Never run `npx tsc`.
- The Docker build stage uses the full Node image, because npm needs `git`
  to install the kit and contracts. The runtime stage is slim.
