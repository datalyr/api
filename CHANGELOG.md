# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-06-03

### Fixed
- **Cross-user identity contamination (critical for multi-user servers).** A single
  long-lived process no longer stamps every id-less event with one shared `anonymousId`
  (the ingest identity-resolution merged that into a single identity, cross-linking
  distinct users' traits). Each call without a `userId`/`anonymousId` now gets a FRESH
  anonymous id, and `getAnonymousId()` now returns a NEW id each call. **Behavior change**
  — pass a per-user/session `anonymousId` to stitch a given user's events.
- **Shutdown data loss.** `close()` now drains the queue (loops flush until empty or
  `closeTimeout`) instead of a single flush racing a hard 5s timeout; `flush()` awaits an
  in-flight flush instead of silently no-op'ing, so re-queued failures actually resend.
  Each flush is raced against the remaining budget, so a slow/failing endpoint can't make
  `close()` overshoot `closeTimeout` or hang (important for serverless time limits).
- **`alias()` now actually links** `previous_id → user_id`. It emitted only snake_case
  `previous_id`/`new_user_id`, but the ingest `$alias` link builder reads camelCase
  `previousId`/`userId` — so alias had silently written zero links. It now emits both.
- **Retry pressure.** Permanently-failing events are dropped (with a warning) after 10
  failed flush cycles instead of cycling at the queue front forever; backoff is jittered.
- **Reliability.** `flushInterval` is validated (0/negative no longer busy-loops the
  timer); ids use `crypto.randomUUID` unconditionally (was a weak `Math.random` fallback
  on Node <19 — and eventId is the server dedup key, imported from `node:crypto`); the
  request abort-timer is cleared on fetch error, not just success; queue-overflow drops
  are surfaced in production; the `beforeExit` listener is removed on `close()` (was
  leaking the instance per process for per-request client construction).

### Added
- `anonymousId` argument on `identify` / `alias` / `page` / `group`.
- `closeTimeout` config (default 30000 ms) — how long `close()` drains before giving up.
- Best-effort flush on process `beforeExit` for short scripts / cron (still use
  `await close()` for guaranteed delivery).

### Note
- "Batching" is a 10-wide concurrency window, not a single batched HTTP request (one POST
  per event); the `/batch` endpoint is not used.

## [1.2.1] - 2025-01

### Changed
- Complete README rewrite to match iOS/React Native/Web SDK documentation style

## [1.2.0] - 2025-01

### Changed
- Version bump for ecosystem consistency across all Datalyr SDKs

## [1.1.0] - 2025-01

### Added
- Anonymous ID support for complete user journey tracking
- New object-based track() signature with anonymousId parameter
- getAnonymousId() method to retrieve SDK's anonymous ID
- Attribution preservation when passing anonymousId from browser/mobile SDKs

### Changed
- track() now supports both legacy (userId, event, properties) and new object signature
- identify() now supports both legacy and new object signature with anonymousId

## [1.0.0] - 2024-12

### Added
- Initial release
- Server-side event tracking (track, identify, page, group)
- Automatic event batching (20 events or 10 seconds)
- Retry with exponential backoff (3 retries)
- Graceful shutdown with flush (5-second timeout)
- TypeScript support with full type definitions
- Zero production dependencies
- Configurable options (host, batchSize, flushInterval, timeout, retryLimit, maxQueueSize)
