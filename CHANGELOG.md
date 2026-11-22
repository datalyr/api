# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Warnings for dropped events (invalid `track()`/`identify()`/`alias()`/`group()`/`trackPurchase()`
  arguments, and events dropped after the maximum failed flush attempts) are logged once per
  client for each kind, then only with `debug: true`. `onDrop` and `onError` still fire for every event.
- All clients share one process `beforeExit` listener (it was one per client, which triggered
  `MaxListenersExceededWarning` when a client was created per request). Each live client is
  still flushed once on exit; the listener is removed when the last client is closed.
- The API key prefix warning accepts `sk_` keys as well as `dk_`.
- `examples/stripe-webhook.js` sends the Stripe customer id as `externalIds: { stripe }`
  instead of using it as `userId`.
- `page()` no longer copies the page `name` into `properties.url` when no url is passed.
  Pass `properties.url` to record the page URL.

### Added
- `trackPurchase()` options accept `externalIds` (same as `track()`), sent only when passed.

## [1.3.4] - 2026-11-14

### Fixed
- **`flush()` and `close()` returned while a send was still in flight.** `flush()` returned
  on an empty queue before checking for a running drain, and a drain empties the queue as
  soon as it starts. So once an auto-flush (queue reached `flushAt`) had taken the events,
  `await flush()` and `await close()` resolved in ~0 ms while the POST and its retries were
  still running, and `onDrop` for those events fired after `close()` had returned. A
  serverless handler that hit `flushAt` (or used `flushAt: 1`) could return and freeze
  with sends in flight. `flush()` now awaits a running drain even when the queue is empty,
  and `close()` keeps waiting, within `closeTimeout`, while a drain is running. On a shared
  instance this means `await flush()` can now take as long as an in-flight send's retries,
  including sends for other callers' events.
- **A send that failed after `close()` gave up was lost without an `onDrop`.** A send still
  running when `closeTimeout` expired was re-queued on a retryable failure, onto a closed
  client that never drains again. It now goes to `onDrop(events, 'close_timeout')`.

## [1.3.3] - 2026-09-03

### Added
- `externalIds` on `track()` options: `{ namespace: id }` declared identities, e.g. `{ stripe: 'cus_123' }`, sent top-level on the envelope. Ingest classifies them as declared namespaces so they join the customer journey; undeclared namespaces are reported as unjoined rather than minting a person.

### Fixed
- The `SDK_VERSION` sent in `context.library.version` and the `User-Agent` was stuck at `1.3.1` through the 1.3.2 release; it now matches the package version.

## [1.3.2] - 2026-07-25

### Changed
- **`engines.node` raised to `>=18.0.0`.** The SDK calls global `fetch` and
  `AbortController`; Node 16 and earlier provide neither and the SDK fails at the first
  send. `engines` nonetheless declared `>=14.17.0`, so npm installed it silently on
  runtimes that cannot run it and the failure surfaced at the first event instead of at
  install time. The field was corrected in the tree on 2026-07-25 but the tree was still
  version 1.3.1, identical to what was published — so the correction could not reach
  anyone. This release is what ships it.

### Fixed
- **README documented the fixed bug as live.** It stated that `engines.node` "states
  `>=14.17.0`. That field is wrong." It now describes the `>=18.0.0` declaration shipping
  here, and states plainly that published versions up to 1.3.1 install silently on Node
  14–16.

## [1.3.1] - 2026-07-12

### Added
- **`schema_version` envelope stamp.** Every event's context now carries
  `schema_version: 1`, the first canonical envelope version shared across the SDK fleet,
  so the server can key on one version marker.
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
- **`close()` hung the process up to `closeTimeout` (~30s) after resolving.** The
  drain loop's `Promise.race` budget/pause timers were never cleared, so a won race left a
  live timer pinning the event loop — reintroducing the exact exit-hang the 1.3.0 unref work
  fixed. Timers are now canceled when their race settles (proven: process exits ~4ms after
  `close()` instead of ~8s).
- **`await flush()` did not guarantee a drain.** If a flush was already in flight it
  returned that promise, which had snapshotted the queue **before** later events — so the
  serverless `track(); track(); await flush()` pattern stranded the second event. `flush()`
  now loops until the queue empties (or a pass delivers nothing against a down endpoint).
- **Invalid args threw out of a fire-and-forget promise.** `track({event:''})`,
  `identify()`/`alias()`/`group()` with a missing required id used to `throw`, which — for an
  un-awaited call — surfaced as an `ERR_UNHANDLED_REJECTION` and crashed the host (exit 1).
  They now warn-and-drop (`onDrop('validation_error')`) and resolve.
- **A wrong API key black-holed everything silently.** A permanent 4xx (≠ 408/429)
  was re-queued and retried ~10 flush cycles per event before a generic drop. It is now
  dropped immediately (no retry/requeue), and `401`/`403` logs a one-time authentication
  failure. `408`/`429` are now correctly treated as **transient** (retried), not permanent.
- **`track()` after `close()` was silently dropped.** It now logs one loud error and
  fires `onDrop('closed')`; `close()` is idempotent under repeat/concurrent calls.
- **Over-long `eventId`.** A pathological caller id became a pathological server-side
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

## [1.2.3] - 2026-03-20

(entry added later)

### Added
- `eventId` (a UUID) on every event, so the ingest server can de-duplicate.
- `User-Agent: @datalyr/api/<version>` header on every request.
- `alias()` for linking identities (`$alias` events).

### Fixed
- `identify()` sends traits as flat properties instead of wrapping them in `$set`.
- `group()` sends traits as flat properties instead of nesting them under `traits`.

## [1.2.2] - 2026-03-20

(entry added later)

### Fixed
- Events are sent to `https://ingest.datalyr.com/track` instead of `api.datalyr.com`,
  which did not record them.
- `SDK_VERSION` constant matches the package version.

### Changed
- README rewritten with the full API reference.

## [1.2.1] - 2026-01-01

### Changed
- Complete README rewrite to match iOS/React Native/Web SDK documentation style

## [1.2.0] - 2026-01-01

### Changed
- Version bump for ecosystem consistency across all Datalyr SDKs

## [1.1.0] - 2025-09-04

### Added
- Anonymous ID support for complete user journey tracking
- New object-based track() signature with anonymousId parameter
- getAnonymousId() method to retrieve SDK's anonymous ID
- Attribution preservation when passing anonymousId from browser/mobile SDKs

### Changed
- track() now supports both legacy (userId, event, properties) and new object signature
- identify() now supports both legacy and new object signature with anonymousId

## [1.0.4] - 2025-08-19

(entry added later) Published to npm; no source history was kept for this version.

## [1.0.3] - 2025-08-19

(entry added later) Published to npm; no source history was kept for this version.

## [1.0.2] - 2025-08-18

(entry added later) Published to npm; no source history was kept for this version.

## [1.0.1] - 2025-08-18

(entry added later) Published to npm; no source history was kept for this version.

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
