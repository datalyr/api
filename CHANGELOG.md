# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **A3-25: `schema_version` envelope stamp.** Every event's context now carries
  `schema_version: 1`, the first canonical envelope version shared across the SDK fleet,
  so the ingest contract layer can key on one version marker.
- **`eventId` on `TrackOptions` (webhook idempotency).** The ingest server de-duplicates
  on the event id (6h window), but `track()` always minted a fresh UUID — so at-least-once
  webhook redeliveries (Stripe, Shopify, …) were counted as new events, double-counting
  revenue. Pass the source event id (e.g. Stripe `event.id`) and redeliveries dedup
  server-side. Invalid/empty values are ignored (UUID fallback + debug warning), never a
  throw. Omitted → unchanged behavior (fresh UUID).
- **`timestamp` on `TrackOptions`.** `track()` hardcoded "now", so delayed webhook
  replays landed on the wrong day. Accepts ISO string, `Date`, or numeric epoch (values
  < 1e12 are treated as epoch seconds — e.g. Stripe `event.created`); normalized to
  ISO-8601. Invalid → now (debug warning). Omitted → unchanged behavior.
- **`trackPurchase(userId, { value, currency, ... }, opts?)` helper.** Validates `value` is
  a finite number (a `NaN`/non-number would land as $0 or corrupt revenue rollups —
  warned-and-dropped, not sent), stamps the canonical `value` field, and uppercases
  `currency`. Documents the server revenue contract (`value ?? revenue ?? amount`).
- **`onError(event, error)` and `onDrop(events, reason)` config hooks.** Observe every send
  failure and every permanent drop (overflow / permanent-4xx / max-attempts / close-timeout /
  post-close / validation) — e.g. to persist survivors to your own dead-letter store. Hook
  exceptions are swallowed and can never crash the SDK.

### Fixed
- **`close()` hung the process up to `closeTimeout` (~30s) after resolving (TR-09).** The
  drain loop's `Promise.race` budget/pause timers were never cleared, so a won race left a
  live timer pinning the event loop — reintroducing the exact exit-hang the 1.3.0 unref work
  fixed. Timers are now canceled when their race settles (proven: process exits ~4ms after
  `close()` instead of ~8s).
- **`await flush()` did not guarantee a drain (TR-25).** If a flush was already in flight it
  returned that promise, which had snapshotted the queue **before** later events — so the
  serverless `track(); track(); await flush()` pattern stranded the second event. `flush()`
  now loops until the queue empties (or a pass delivers nothing against a down endpoint).
- **Invalid args threw out of a fire-and-forget promise (9.D.4).** `track({event:''})`,
  `identify()`/`alias()`/`group()` with a missing required id used to `throw`, which — for an
  un-awaited call — surfaced as an `ERR_UNHANDLED_REJECTION` and crashed the host (exit 1).
  They now warn-and-drop (`onDrop('validation_error')`) and resolve.
- **A wrong API key black-holed everything silently (9.D.8).** A permanent 4xx (≠ 408/429)
  was re-queued and retried ~10 flush cycles per event before a generic drop. It is now
  dropped immediately (no retry/requeue), and `401`/`403` logs a one-time authentication
  failure. `408`/`429` are now correctly treated as **transient** (retried), not permanent.
- **`track()` after `close()` was silently dropped (9.D.3).** It now logs one loud error and
  fires `onDrop('closed')`; `close()` is idempotent under repeat/concurrent calls.
- **Over-long `eventId` (B-4).** A pathological caller id became a pathological server Redis
  key; ids over 256 chars are now collapsed to a deterministic hash (redeliveries of the same
  id still dedup).
- **`page(userId, name)` left `page_url` blank server-side** — the pageview now falls back to
  the page name for `properties.url` when no url is given.

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
