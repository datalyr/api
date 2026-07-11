# @datalyr/api

Server-side analytics and attribution SDK for Node.js. Track events, identify users, and preserve attribution data from your backend.

## Installation

```bash
npm install @datalyr/api
```

## Quick Start

```javascript
import { Datalyr } from '@datalyr/api';

// String shorthand
const datalyr = new Datalyr('dk_your_api_key');

// Or with config object
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  debug: true,
});

// Track an event
await datalyr.track('user_123', 'signup_completed', { plan: 'pro' });

// Identify a user
await datalyr.identify('user_123', { email: 'user@example.com' });

// Flush and shut down
await datalyr.close();
```

## Configuration

The constructor accepts a `DatalyrConfig` object or an API key string.

```javascript
// Config object
const datalyr = new Datalyr({
  apiKey: 'dk_...',           // Required. Must start with "dk_".
  host: 'https://ingest.datalyr.com/track',  // API endpoint (default: 'https://ingest.datalyr.com/track')
  flushAt: 20,                // Flush when queue reaches this size (default: 20, range: 1-100)
  flushInterval: 10000,       // Flush timer interval in ms (default: 10000)
  debug: false,               // Log events and errors to console (default: false)
  timeout: 10000,             // HTTP request timeout in ms (default: 10000, range: 1000-60000)
  retryLimit: 3,              // Max retries for failed requests (default: 3, range: 0-10)
  maxQueueSize: 1000,         // Max queued events before dropping oldest (default: 1000, range: 100-10000)
  closeTimeout: 30000,        // Max ms close() spends draining before giving up (default: 30000, range: 1000-120000)
  onError: (event, error) => {},          // Optional — called on every send failure (before retry/drop)
  onDrop: (events, reason) => {},         // Optional — called whenever event(s) are permanently dropped
});

// String shorthand — uses all defaults
const datalyr = new Datalyr('dk_your_api_key');
```

## Methods

### track()

Two call signatures:

```javascript
// Object form (TrackOptions)
await datalyr.track({
  event: 'Purchase Completed',     // Required
  userId: 'user_123',              // Optional
  anonymousId: 'anon_from_browser', // Optional — override the auto-generated anonymous ID
  eventId: 'evt_1Nxxxxx',          // Optional — idempotency key (see below)
  timestamp: 1751373296,           // Optional — when the event happened (ISO string, Date, or epoch)
  properties: {                    // Optional
    amount: 99.99,
    currency: 'USD',
  },
});

// Legacy form
await datalyr.track('user_123', 'Purchase Completed', {
  amount: 99.99,
  currency: 'USD',
});

// Pass null as userId for anonymous events
await datalyr.track(null, 'page_loaded', { url: '/pricing' });
```

**`eventId` — idempotent delivery (important for webhooks).** The ingest server
de-duplicates events on their event id within a **6-hour window**. By default each
`track()` call generates a fresh UUID, so a *redelivered* webhook (Stripe, Shopify, etc.
deliver at-least-once) would be counted as a **new** event — double-counting revenue.
Pass the source system's event id as `eventId` and redeliveries dedup server-side:

```javascript
await datalyr.track({
  event: 'Purchase Completed',
  userId: session.client_reference_id,
  eventId: stripeEvent.id,        // same id on redelivery → counted once
  timestamp: stripeEvent.created, // when it happened, not when the retry arrived
  properties: { amount: session.amount_total / 100 },
});
```

`eventId` must be a non-empty string; invalid values are ignored (a random UUID is used,
with a warning in debug mode) — the SDK never throws for it.

**`timestamp`.** Accepts an ISO-8601 string, a `Date`, or a numeric epoch. Numbers below
`1e12` are interpreted as epoch **seconds** (webhook payloads like Stripe's
`event.created` are seconds), larger numbers as milliseconds. Omitted or invalid values
fall back to the current time. Pass it on delayed webhook replays so the event lands on
the day it actually happened.

### identify()

```javascript
await datalyr.identify(userId: string, traits?: any);
```

Links a user ID to traits. Internally sends a `$identify` event.

```javascript
await datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'Jane Doe',
  plan: 'premium',
});
```

### page()

```javascript
await datalyr.page(userId: string, name?: string, properties?: any);
```

Track a page view. Internally sends a `$pageview` event.

```javascript
await datalyr.page('user_123', 'Pricing', {
  url: 'https://example.com/pricing',
  referrer: 'https://google.com',
});
```

### alias()

```javascript
await datalyr.alias(newUserId: string, previousId?: string);
```

Link a new user ID to a previous one (e.g., after account merge). If `previousId` is omitted, the current anonymous ID is used. Internally sends a `$alias` event.

```javascript
// Link new ID to the current anonymous user
await datalyr.alias('new_user_456');

// Or specify the previous ID explicitly
await datalyr.alias('new_user_456', 'old_user_123');
```

### group()

```javascript
await datalyr.group(userId: string, groupId: string, traits?: any);
```

Associate a user with a group (company, team, etc.). Internally sends a `$group` event.

> ⚠️ **No server-side semantics yet.** `$group` is currently recorded as a plain event with
> the group traits in `properties`; the ingest pipeline does **not** build account/group
> associations from it. Don't rely on `group()` for B2B account rollups today — it's kept for
> API compatibility.

```javascript
await datalyr.group('user_123', 'company_456', {
  name: 'Acme Corp',
  industry: 'Technology',
  employees: 50,
});
```

### trackPurchase()

Convenience helper for revenue events. Validates that `value` is a **finite number** (a
`NaN`/`Infinity`/non-number would land as $0 or corrupt revenue rollups, so it is
warned-and-dropped, never sent), stamps the canonical `value` field, and uppercases
`currency` (default `USD`). `opts` forwards `eventId` (webhook idempotency) and `timestamp`
exactly like `track()`.

```javascript
await datalyr.trackPurchase('user_123',
  { value: 49.99, currency: 'usd', plan: 'pro' },
  { eventId: stripeEvent.id, timestamp: stripeEvent.created });
```

> **Revenue field contract.** The ingest revenue pipeline reads the amount as
> `value ?? revenue ?? amount` (in that order) — **`value` is the canonical field**.
> `trackPurchase()` always sets `value`; if you use plain `track()` for purchases, put the
> amount in `value` (or at least `revenue`/`amount`) so it isn't counted as $0.

### flush()

Drains **all** queued events and resolves once they've been sent (or a pass makes no
progress against a down endpoint). Because it fully drains — including events enqueued while
a flush was already in flight — this is the call to use in **serverless / per-invocation**
handlers where the instance may freeze right after you return:

```javascript
// e.g. AWS Lambda / Cloud Functions — flush per invocation, do NOT close() the client
export async function handler(event) {
  await datalyr.track({ userId: event.userId, event: 'api_call' });
  await datalyr.flush();   // guarantees delivery before the instance freezes
  return { ok: true };
}
```

### close()

Stops the flush timer, then drains the queue until empty or the configured **`closeTimeout`**
(default **30s**, race-bounded so it never overshoots) expires. `close()` is **terminal and
idempotent** — repeat/concurrent calls share one drain. Events tracked **after** `close()`
are dropped and a single loud error is logged (use `flush()` per invocation for serverless;
reserve `close()` for process shutdown). Any events still undelivered at the budget are
handed to `onDrop(events, 'close_timeout')`.

```javascript
process.on('SIGTERM', async () => {
  await datalyr.close();
  process.exit(0);
});
```

### Delivery hooks — `onError` / `onDrop`

Pass these in the config for observability into delivery problems (e.g. persist survivors to
your own dead-letter store, or alert on a bad API key):

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_...',
  onError: (event, error) => log.warn('datalyr send failed', { event: event.event, error }),
  onDrop:  (events, reason) => deadLetter.saveAll(events, reason),
});
```

`onError` fires on **every** send failure (before any retry/requeue/drop decision). `onDrop`
fires whenever event(s) are **permanently** dropped, with a `reason`:

| `reason` | When |
| --- | --- |
| `validation_error` | `track`/`identify`/`alias`/`group`/`trackPurchase` called with invalid args |
| `queue_overflow` | `maxQueueSize` reached — oldest event evicted |
| `permanent_client_error` | Non-retryable 4xx (≠ 408/429) — e.g. `401`/`403`/`400` |
| `max_flush_attempts` | Transient failures exceeded the internal retry-cycle cap |
| `close_timeout` | Still queued when `close()`'s `closeTimeout` budget expired |
| `closed` | `track()` called after `close()` |

Both hooks are wrapped — an exception thrown inside your hook can never crash the SDK.

### getAnonymousId()

Generates and returns a **new** anonymous ID each call, format `anon_<uuid>` (e.g.
`anon_3d5cf66d-203f-4009-8bb0-f3714da152a4`). It is **not** a stable per-instance value.

> **Server-side identity (important).** This SDK runs in a multi-user process, so it does
> NOT keep one shared anonymous ID — that would merge distinct end-users into a single
> identity. Persist an anonymous/session ID **in your own per-user store** (e.g. from the
> visitor's browser/mobile SDK or your session) and pass it back as `anonymousId` on each
> call to stitch that user's events:
>
> ```javascript
> datalyr.track({ userId: 'user_123', anonymousId: session.anonymousId, event: 'Purchase' });
> datalyr.identify('user_123', { email }, session.anonymousId);
> ```
>
> Calls without a `userId` or `anonymousId` get a fresh anonymous ID and can't be stitched
> across calls (a one-time warning is logged). `identify`/`alias`/`page`/`group` all accept
> an `anonymousId` as their last argument.

```javascript
const anonId = datalyr.getAnonymousId(); // a fresh id — persist it yourself, pass back as anonymousId
```

## Event Payload

Every event sent to the API has this structure:

```javascript
{
  event: 'Purchase Completed',
  userId: 'user_123',                              // undefined if not provided
  anonymousId: 'anon_3d5cf66d-203f-4009-...',      // provided id, else a fresh one per call
  eventId: 'evt_1Nxxxxx',                          // provided id, else a random UUID per call
  properties: {
    amount: 99.99,
    anonymous_id: 'anon_3d5cf66d-203f-4009-...',   // automatically added (mirrors anonymousId)
  },
  context: {
    library: '@datalyr/api',
    version: '1.3.0',
    source: 'api',
  },
  timestamp: '2025-01-15T10:30:00.000Z',
}
```

Notes:
- `anonymous_id` is automatically added to `properties` on every event for attribution.
- The `context` object identifies the SDK and version.
- `eventId` is the server-side de-duplication key (6h window). Pass your own (e.g. the
  webhook event id) for idempotent delivery; otherwise a fresh UUID is generated per call.
- `timestamp` is the caller-supplied event time normalized to ISO 8601, or the time the
  event was created when not provided.

## Batching and Retry Behavior

Events are queued locally and flushed with up to 10 requests in flight at once — a
concurrency window, **not** a single batched request (one POST per event).

- **Auto-flush triggers:** when the queue reaches `flushAt` events, or every `flushInterval` ms.
- **Concurrency:** up to 10 events are sent in parallel within a single flush.
- **Queue overflow:** when the queue reaches `maxQueueSize`, the oldest event is dropped to make room (a warning is logged once, and `onDrop(..., 'queue_overflow')` fires).
- **Retry:** 5xx (server) errors — plus **408** (Request Timeout) and **429** (Too Many Requests) — are retried up to `retryLimit` times with jittered exponential backoff (≈1s, 2s, 4s, … capped at 10s). Every other 4xx (client) error is a **permanent** failure: the event is dropped immediately (no retry, no requeue) and `onDrop(..., 'permanent_client_error')` fires. A `401`/`403` additionally logs a one-time **authentication-failure** error — the most common "no data" cause is a wrong API key.
- **Failed events:** transient failures are re-queued at the front and retried on later flushes; dropped (with a warning + `onDrop(..., 'max_flush_attempts')`) after repeated failed flush cycles so one permanently-failing event can't block the queue.
- **Shutdown:** `await close()` keeps flushing until the queue drains or `closeTimeout` (default 30s) expires.

## Attribution Preservation

Pass the anonymous ID from your browser or mobile SDK to link server-side events to a client-side session:

```javascript
await datalyr.track({
  event: 'Purchase Completed',
  userId: 'user_123',
  anonymousId: req.body.anonymous_id,  // From browser SDK
  properties: {
    amount: 99.99,
  },
});
```

This preserves UTM parameters, click IDs (gclid, fbclid, ttclid, oppref), referrer, landing page, and the full customer journey.

## Framework Examples

### Express.js Middleware

```javascript
import express from 'express';
import { Datalyr } from '@datalyr/api';

const app = express();
const datalyr = new Datalyr('dk_your_api_key');

app.post('/api/purchase', async (req, res) => {
  const { items, anonymous_id } = req.body;

  await datalyr.track({
    event: 'Purchase Completed',
    userId: req.user?.id,
    anonymousId: anonymous_id,
    properties: {
      total: calculateTotal(items),
      item_count: items.length,
    },
  });

  res.json({ success: true });
});

process.on('SIGTERM', async () => {
  await datalyr.close();
  process.exit(0);
});
```

### Stripe Webhooks

Stripe delivers webhooks **at-least-once** — the same event can arrive multiple times.
Pass the Stripe event id as `eventId` so redeliveries dedup server-side instead of
double-counting revenue, and `event.created` as `timestamp` so replays land on the day
the event happened:

```javascript
import { Datalyr } from '@datalyr/api';
import Stripe from 'stripe';

const datalyr = new Datalyr('dk_your_api_key');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await datalyr.track({
        userId: session.client_reference_id,
        event: 'Purchase Completed',
        eventId: event.id,          // idempotency: redelivery carries the same id → counted once
        timestamp: event.created,   // epoch seconds — when it happened, not when delivered
        properties: {
          amount: session.amount_total / 100,
          currency: session.currency,
          stripe_session_id: session.id,
        },
      });
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      await datalyr.track({
        userId: subscription.metadata.userId,
        event: 'Subscription Started',
        eventId: event.id,
        timestamp: event.created,
        properties: {
          plan: subscription.items.data[0].price.nickname,
          mrr: subscription.items.data[0].price.unit_amount / 100,
          interval: subscription.items.data[0].price.recurring.interval,
        },
      });
      break;
    }
  }

  res.json({ received: true });
});
```

## TypeScript

Full type definitions are included. Exported types:

```typescript
import { Datalyr, DatalyrConfig, TrackOptions, TrackEvent } from '@datalyr/api';

const config: DatalyrConfig = {
  apiKey: 'dk_your_api_key',
  debug: true,
};

const datalyr = new Datalyr(config);

const options: TrackOptions = {
  event: 'Purchase Completed',
  userId: 'user_123',
  anonymousId: 'anon_from_browser',
  eventId: 'evt_1Nxxxxx',              // optional idempotency key
  timestamp: '2026-07-01T12:00:00Z',   // optional: string | Date | number
  properties: {
    amount: 99.99,
    currency: 'USD',
  },
};

await datalyr.track(options);
```

## Troubleshooting

**Events not appearing**

1. Verify your API key starts with `dk_`.
2. Enable `debug: true` to see console output.
3. Call `await datalyr.flush()` to force-send queued events.
4. Check for 4xx errors in debug output -- these indicate a client-side issue (bad API key, malformed payload).

**Request timeouts**

Increase `timeout` and `retryLimit`:

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  timeout: 30000,
  retryLimit: 5,
});
```

**Queue full (oldest events dropped)**

Increase `maxQueueSize` or flush more aggressively:

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  maxQueueSize: 5000,
  flushAt: 50,
});
```

## License

MIT
