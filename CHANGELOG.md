# Changelog

## 0.2.0

- Claim, send, then mark: `sent` has `claimedAt` and `sentAt`. A
  redelivery sends again to a device whose claim has no `sentAt` and is 60
  seconds old or more, so a crash between the claim and the send, or a
  failed release of the claim, does not lose the push. A younger claim
  with no `sentAt` makes the handler throw, so the message comes again.
- Migration `002-notification-sent-claimed-at`: old rows get `claimedAt`
  from `sentAt`, and the 30-day TTL moves from
  `sentAt` to `claimedAt`.
- FCM `SENDER_ID_MISMATCH` removes the device, the same as `UNREGISTERED`.

## 0.1.0

- `POST /internal/commands/register-device` and
  `POST /internal/commands/unregister-device` (contracts v0.4.1). The
  handler checks the owner bearer token before the body (ADR 0028), and
  `actor.id` must be the `sub` of the token.
- `devices` collection with the FCM token and the locale of each device.
- Push table of contracts v0.4.1, and two owner decisions of M3:
  `RunBlocked` with `forbidden` gives `failed`, with `runaway_stopped`
  gives `budget`.
- Fixed titles and bodies in `en`, `de` and `ur`, and `PushDataV1` data.
  No prompt and no output in a push (ADR 0013).
- `sent` collection (30 days): one push for each source event and device,
  also on a redelivery.
- One durable for each push event, with a fixed filter subject (ADR 0023).
- FCM HTTP v1 sender with a service account file
  (`GOOGLE_APPLICATION_CREDENTIALS`). A token that FCM marks
  `UNREGISTERED` removes the device. A fake sender for all tests.
- An event older than 24 hours gives no push.
- `/health`, `/ready` (MongoDB, migrations, consumers), `/metrics`.
- Container image on Node 26 slim, uid 1000, read-only root file system.
- Release workflow: image, CycloneDX SBOM, grype scan, push to GHCR by tag
  and digest, and a release pull request in `famashines/gitops`.
