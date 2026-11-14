# @datalyr/api

Server-side analytics and attribution SDK for Node.js. Track events, identify users, and
preserve attribution data from your backend.

Version 1.3.1. Full reference: [Node.js SDK](https://docs.datalyr.com/sdk-reference/node).

## Requirements

| Item | Value |
| --- | --- |
| Package | `@datalyr/api` |
| Version | `1.3.1` |
| Runtime Node version | 18 or later |
| Runtime dependencies | None |
| Module formats | CommonJS and ESM |
| TypeScript types | Included |

> **Run this SDK on Node 18 or later.** It calls global `fetch` and `AbortController`.
> Node 16 and earlier do not provide either, and the SDK fails at the first send.
> `engines.node` declares `>=18.0.0` as of **1.3.2**, so npm now warns you before you
> install it on a runtime that cannot run it. Published versions up to and including
> **1.3.1 declare `>=14.17.0` and install silently on Node 14–16**, where they fail at
> the first send rather than at install time.

## Installation

```bash
npm install @datalyr/api
```

## Quick start

```javascript
import { Datalyr } from '@datalyr/api';

const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY,
  debug: true,
});

// Track an event
await datalyr.track({
  event: 'signup_completed',
  userId: 'user_123',
  properties: { plan: 'pro' },
});

// Identify a user
await datalyr.identify('user_123', { email: 'user@example.com' });

// Drain the queue at process shutdown
await datalyr.close();
```

The constructor throws `Error('Datalyr API key is required')` when `apiKey` is missing.
That is the only throw in the SDK. Every other method resolves, including on invalid
input. A key that does not begin with `dk_` logs a warning and continues.

The SDK reads no environment variable. Pass the key yourself.

## Authentication

| Header | Value |
| --- | --- |
| `X-API-Key` | Your write key from **Settings → API** |
| `Content-Type` | `application/json` |
| `User-Agent` | `@datalyr/api/1.3.1` |

The SDK sends no workspace ID. The key alone selects the workspace.

## Configuration

The constructor accepts a `DatalyrConfig` object or an API key string.

> **Use the object form when you want failure callbacks.** The string shorthand
> `new Datalyr('dk_...')` never assigns `onError` or `onDrop`, so delivery failures are
> invisible to your code.

```javascript
const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY,
  host: 'https://ingest.datalyr.com/track',
  flushAt: 20,
  flushInterval: 10000,
  debug: false,
  timeout: 10000,
  retryLimit: 3,
  maxQueueSize: 1000,
  closeTimeout: 30000,
  onError: (event, error) => console.error(event.event, error),
  onDrop: (events, reason) => console.error(reason, events.length),
});

// String shorthand — every default applies, no failure callbacks
const datalyr = new Datalyr('dk_your_api_key');
```

Every numeric option is clamped. A value outside its range becomes the nearest bound.

| Option | Type | Default | Unit | Range |
| --- | --- | --- | --- | --- |
| `apiKey` | `string` | Required. Throws when missing. | — | — |
| `host` | `string` | `'https://ingest.datalyr.com/track'` | URL | — |
| `flushAt` | `number` | `20` | events | 1–100 |
| `flushInterval` | `number` | `10000` | milliseconds | 1000–3600000 |
| `timeout` | `number` | `10000` | milliseconds | 1000–60000 |
| `retryLimit` | `number` | `3` | retries | 0–10 |
| `maxQueueSize` | `number` | `1000` | events | 100–10000 |
| `closeTimeout` | `number` | `30000` | milliseconds | 1000–120000 |
| `debug` | `boolean` | `false` | — | — |
| `onError` | `(event: TrackEvent, error: Error) => void` | Unset | — | — |
| `onDrop` | `(events: TrackEvent[], reason: DropReason) => void` | Unset | — | — |

`host` carries its own `/track` path. An override must include a full path.

Every option above is read by the SDK. None is dead.

## Complete method list

| Method | Signature |
| --- | --- |
| `constructor` | `(config: DatalyrConfig \| string)` |
| `track` | `(options: TrackOptions) => Promise<void>` |
| `track` | `(userId: string \| null, event: string, properties?: any) => Promise<void>` — legacy form |
| `identify` | `(userId: string, traits?: any, anonymousId?: string) => Promise<void>` |
| `alias` | `(newUserId: string, previousId?: string, anonymousId?: string) => Promise<void>` |
| `page` | `(userId: string, name?: string, properties?: any, anonymousId?: string) => Promise<void>` |
| `group` | `(userId: string, groupId: string, traits?: any, anonymousId?: string) => Promise<void>` |
| `trackPurchase` | `(userId: string \| null, purchase: PurchaseProperties, opts?: { anonymousId?: string; eventId?: string; timestamp?: string \| Date \| number }) => Promise<void>` |
| `flush` | `() => Promise<void>` |
| `close` | `() => Promise<void>` |
| `getAnonymousId` | `() => string` |

## Identity

> **Pass `userId`, `anonymousId`, or both on every call.** With neither, the SDK mints a
> fresh `anon_<uuid>` for that one call. Every such call becomes a separate person with no
> journey. The SDK logs one warning the first time this happens.

This SDK runs in a multi-user process, so it keeps no shared anonymous ID. Take the
anonymous ID from the browser: call `datalyr.getVisitorId()` in the Web SDK, send the
value to your server, and pass it back as `anonymousId`.

```javascript
await datalyr.track({
  event: 'purchase',
  userId: 'user_123',
  anonymousId: session.visitorId,
  properties: { value: 99.99, currency: 'USD' },
});

await datalyr.identify('user_123', { email: 'user@example.com' }, session.visitorId);
```

`identify`, `alias`, `page`, and `group` all accept `anonymousId` as their last argument.

### getAnonymousId()

```javascript
const anonId = datalyr.getAnonymousId(); // 'anon_3d5cf66d-203f-4009-8bb0-f3714da152a4'
```

> **`getAnonymousId()` generates a new `anon_<uuid>` on every call and stores nothing.**
> It is not a getter and it is not stable per instance. Never call it to look up an
> existing person. Persist the value in your own per-user store, then pass it back as
> `anonymousId`.

## Track an event

`track()` has two call signatures.

```javascript
// Object form (TrackOptions)
await datalyr.track({
  event: 'purchase',               // Required
  userId: 'user_123',              // Optional
  anonymousId: 'anon_from_browser', // Optional
  eventId: 'evt_1Nxxxxx',          // Optional — idempotency key
  timestamp: 1751373296,           // Optional — ISO string, Date, or epoch
  properties: {
    value: 99.99,
    currency: 'USD',
  },
});

// Legacy form
await datalyr.track('user_123', 'purchase', { value: 99.99, currency: 'USD' });

// Pass null as userId for an event with no known user
await datalyr.track(null, 'page_loaded', { url: '/pricing' });
```

An empty or non-string event name logs a warning, calls `onDrop` with
`validation_error`, and resolves. It never throws.

### What goes on the wire

The SDK posts one event object per request. There is no envelope and no `events` array.

```json
{
  "userId": "user_123",
  "anonymousId": "anon_9f2c1b40-1c2e-4d55-9a0b-6a4f7f1d2e33",
  "eventId": "evt_1Nxxxxx",
  "event": "purchase",
  "properties": {
    "value": 99.99,
    "currency": "USD",
    "anonymous_id": "anon_9f2c1b40-1c2e-4d55-9a0b-6a4f7f1d2e33"
  },
  "context": {
    "library": "@datalyr/api",
    "version": "1.3.1",
    "source": "api",
    "schema_version": 1
  },
  "timestamp": "2026-07-25T12:00:00.000Z"
}
```

| Wire field | Value |
| --- | --- |
| `userId` | Your ID. camelCase. |
| `anonymousId` | The browser `visitor_id`. camelCase. |
| `properties.anonymous_id` | The same value, in snake_case. The SDK adds it to every event. |
| `context` | Always these four keys. A `context` you pass is overwritten. |
| `timestamp` | Your event time normalized to ISO 8601, or the enqueue time. |

This SDK sends no `distinct_id` and no `session_id`. It has no session concept.

### eventId — idempotent delivery

Stripe, Shopify, and every other webhook source deliver at-least-once. Without an
`eventId`, each `track()` call generates a fresh UUID, so a redelivery counts as a new
event and double-counts revenue.

Pass the source system's event ID as `eventId`. The ingest server de-duplicates on that
key for **7 days** by default.

```javascript
await datalyr.track({
  event: 'purchase',
  userId: session.client_reference_id,
  eventId: stripeEvent.id,        // same ID on redelivery → counted once
  timestamp: stripeEvent.created, // when it happened, not when the retry arrived
  properties: { value: session.amount_total / 100, currency: session.currency },
});
```

`eventId` must be a non-empty string. Any other value is ignored, and the SDK uses a
random UUID with a debug-mode warning. An `eventId` over 256 characters becomes its first
191 characters, a hyphen, and a SHA-256 hex digest of the original. That collapse is
deterministic, so redeliveries still dedupe.

### timestamp

`timestamp` accepts an ISO 8601 string, a `Date`, or a number. A number below `1e12` is
read as epoch **seconds**. Stripe's `event.created` is seconds. A larger number is read as
milliseconds. An omitted or invalid value falls back to the current time.

Pass `timestamp` on delayed webhook replays so the event lands on the day it happened.

## Events the SDK sends for you

These event names are reserved. Never send one through `track()` yourself.

| Method | Wire event name |
| --- | --- |
| `identify()` | `$identify` |
| `alias()` | `$alias` |
| `page()` | `$pageview` |
| `group()` | `$group` |
| `trackPurchase()` | `purchase` |

### identify()

```javascript
await datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'Jane Doe',
  plan: 'premium',
}, session.visitorId);
```

Traits are sent flat inside `properties`.

### page()

```javascript
await datalyr.page('user_123', 'Pricing', {
  url: 'https://example.com/pricing',
  referrer: 'https://google.com',
}, session.visitorId);
```

Ingest derives `page_url` from `properties.url` only. When you pass no `url`, the SDK
copies `name` into `url` so the pageview stays addressable. Pass a real URL.

### alias()

```javascript
// Link a new ID to a fresh anonymous ID
await datalyr.alias('new_user_456');

// Link a new ID to a known previous ID
await datalyr.alias('new_user_456', 'old_user_123', session.visitorId);
```

When you omit `previousId`, the SDK uses the resolved anonymous ID for that call.

### group()

```javascript
await datalyr.group('user_123', 'company_456', {
  name: 'Acme Corp',
  industry: 'Technology',
  employees: 50,
}, session.visitorId);
```

> **Do not use `group()` for B2B account rollups.** It records a plain `$group` event.
> Datalyr builds no account or group association from it. The method exists for API
> compatibility only.

### trackPurchase()

`trackPurchase()` stamps the canonical `value` field and uppercases `currency`, which
defaults to `USD`. `opts` forwards `anonymousId`, `eventId`, and `timestamp`.

```javascript
await datalyr.trackPurchase('user_123',
  { value: 49.99, currency: 'usd', plan: 'pro' },
  { eventId: stripeEvent.id, timestamp: stripeEvent.created, anonymousId: session.visitorId });
```

`PurchaseProperties` requires a finite `value: number`. A `NaN`, an `Infinity`, or a
non-number logs a warning, calls `onDrop` with `validation_error`, and sends nothing.

> **Put the amount in `value` when you use plain `track()` for revenue.** The ingest
> revenue pipeline reads `value ?? revenue ?? amount`, in that order. An amount under any
> other key is counted as \$0.

## Flush and shut down

```javascript
await datalyr.flush();   // between invocations of a reused instance
await datalyr.close();   // once, at process shutdown
```

### flush()

`flush()` drains the whole queue and resolves once every event is sent, or once a pass
delivers nothing against a down endpoint. It loops, so events enqueued during a flush are
also sent. When a drain is already running, `flush()` awaits that drain instead of
starting a second one. That includes a drain started by reaching `flushAt`, even though
the queue is already empty by then. Before 1.3.4, `flush()` returned at once in that case
with the sends still in flight.

Use `flush()` in serverless handlers, where the instance can freeze the moment you return.

```javascript
// AWS Lambda / Cloud Functions — flush per invocation, never close()
export async function handler(event) {
  await datalyr.track({ event: 'api_call', userId: event.userId });
  await datalyr.flush();
  return { ok: true };
}
```

### close()

`close()` stops the flush timer, then drains the queue, and waits for any send already in
flight, until both are done or `closeTimeout` expires. It is terminal and idempotent:
repeat and concurrent calls share one drain.

> **Call `close()` only at process shutdown.** A `track()` call after `close()` is dropped
> with reason `closed`, and the SDK logs one loud error.

```javascript
process.on('SIGTERM', async () => {
  await datalyr.close();
  process.exit(0);
});
```

Events still queued when the budget expires go to `onDrop(events, 'close_timeout')`. A
send still running at that moment keeps going in the background, so its result arrives
after `close()` has returned: it is delivered, or `onDrop` fires for it then
(`close_timeout` for a retryable failure, `permanent_client_error` for a 4xx).

The SDK also registers a `beforeExit` hook that calls `flush()` best-effort. That hook
does not replace `await close()`.

## Delivery hooks

Pass `onError` and `onDrop` in the config to see delivery problems.

```javascript
const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY,
  onError: (event, error) => log.warn('datalyr send failed', { event: event.event, error }),
  onDrop: (events, reason) => deadLetter.saveAll(events, reason),
});
```

`onError` fires on every send failure, before any retry, requeue, or drop decision.
`onDrop` fires when events are dropped permanently.

| `reason` | Cause |
| --- | --- |
| `validation_error` | A missing event name, `userId`, `newUserId`, or `groupId`, or a non-finite purchase `value` |
| `queue_overflow` | The queue reached `maxQueueSize`. The oldest event was evicted. |
| `permanent_client_error` | A `4xx` other than `408` or `429` |
| `max_flush_attempts` | 10 failed flush cycles for one event |
| `close_timeout` | `close()` ran out of time |
| `closed` | `track()` ran after `close()` |

An exception thrown inside your hook is swallowed. A hook can never crash the SDK.

## Delivery, retries, and limits

The SDK never batches. It sends one HTTP request per event, with up to 10 requests in
flight at once.

| Limit | Value |
| --- | --- |
| Auto-flush trigger | `flushAt` queued events, default 20 |
| Flush timer | `flushInterval`, default 10,000 ms |
| HTTP concurrency | 10 requests in parallel, one event each |
| Requests per event | One |
| Retries per send | `retryLimit`, default 3 |
| Retry backoff | `min(2^n × 1000, 10000)` ms, multiplied by `0.5 + random()/2` |
| Request timeout | `timeout`, default 10,000 ms, through `AbortController` |
| Queue | `maxQueueSize`, default 1000. The oldest event is dropped first. |
| Failed flush cycles per event | 10, then the event is dropped |
| Drain passes per flush | 12 |
| `close()` budget | `closeTimeout`, default 30,000 ms |
| `eventId` length | 256 characters |
| Server-side dedupe window | 7 days |

### How failed requests behave

| Response | Behavior |
| --- | --- |
| `2xx` | Success. |
| `408`, `429`, any `5xx` | Retried with jittered exponential backoff, up to `retryLimit`. |
| `401`, `403` | Dropped. The SDK logs an authentication failure once. |
| Other `4xx` | Dropped immediately. Never retried. |
| Network, DNS, TLS, abort | Retried like a `5xx`. |

An event that exhausts its retries returns to the front of the queue. After 10 failed
flush cycles the SDK drops it, so one bad event cannot block the queue.

## Attribution preservation

Pass the browser's `visitor_id` as `anonymousId` to link a server-side event to the web
session that produced it.

```javascript
await datalyr.track({
  event: 'purchase',
  userId: 'user_123',
  anonymousId: req.body.visitor_id,  // from datalyr.getVisitorId() in the Web SDK
  properties: { value: 99.99, currency: 'USD' },
});
```

The link carries the UTM parameters, click IDs, referrer, landing page, and journey the
Web SDK captured. The Web SDK captures these 15 click IDs: `fbclid`, `gclid`, `gbraid`,
`wbraid`, `ttclid`, `msclkid`, `twclid`, `li_fat_id`, `sclid`, `dclid`, `epik`,
`rdt_cid`, `obclid`, `irclid`, `ko_click_id`.

## Framework examples

### Express

```javascript
import express from 'express';
import { Datalyr } from '@datalyr/api';

const app = express();
const datalyr = new Datalyr({ apiKey: process.env.DATALYR_API_KEY });

app.post('/api/purchase', async (req, res) => {
  const { items, visitor_id } = req.body;

  await datalyr.track({
    event: 'purchase',
    userId: req.user?.id,
    anonymousId: visitor_id,
    properties: {
      value: calculateTotal(items),
      currency: 'USD',
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

### Stripe webhooks

Stripe delivers webhooks at-least-once. Pass `event.id` as `eventId` so redeliveries
dedupe. Pass `event.created` as `timestamp` so replays land on the right day.

```javascript
import express from 'express';
import Stripe from 'stripe';
import { Datalyr } from '@datalyr/api';

const app = express();
const datalyr = new Datalyr({ apiKey: process.env.DATALYR_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await datalyr.track({
        event: 'purchase',
        userId: session.client_reference_id,
        anonymousId: session.metadata?.visitor_id,
        eventId: event.id,
        timestamp: event.created,
        properties: {
          value: session.amount_total / 100,
          currency: session.currency,
          stripe_session_id: session.id,
        },
      });
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      await datalyr.track({
        event: 'subscription_started',
        userId: subscription.metadata.userId,
        anonymousId: subscription.metadata.visitor_id,
        eventId: event.id,
        timestamp: event.created,
        properties: {
          plan: subscription.items.data[0].price.nickname,
          value: subscription.items.data[0].price.unit_amount / 100,
          currency: subscription.currency,
          interval: subscription.items.data[0].price.recurring.interval,
        },
      });
      break;
    }
  }

  res.json({ received: true });
});
```

`session.metadata.visitor_id` comes from `datalyr.getStripeMetadata()` in the Web SDK.

## TypeScript

Type definitions ship with the package.

```typescript
import { Datalyr, DatalyrConfig, TrackOptions, TrackEvent } from '@datalyr/api';

const config: DatalyrConfig = {
  apiKey: process.env.DATALYR_API_KEY!,
  debug: true,
};

const datalyr = new Datalyr(config);

const options: TrackOptions = {
  event: 'purchase',
  userId: 'user_123',
  anonymousId: 'anon_from_browser',
  eventId: 'evt_1Nxxxxx',
  timestamp: '2026-07-01T12:00:00Z',
  properties: {
    value: 99.99,
    currency: 'USD',
  },
};

await datalyr.track(options);
```

## Verify the install

1. Send one event with a `userId` you recognize.
2. Open **Events** in Datalyr.
3. Confirm the event arrives within 30 seconds.

When nothing arrives, add an `onDrop` callback and log the reason.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No events, `onDrop` reports `permanent_client_error` | Wrong API key, or a malformed payload | Confirm the key starts with `dk_` and matches **Settings → API** |
| No events, no `onDrop` call | The process exited before the queue drained | Call `await datalyr.flush()` before returning, or `await datalyr.close()` at shutdown |
| `onDrop` reports `closed` | `track()` ran after `close()` | Use `flush()` per invocation. Reserve `close()` for shutdown. |
| `onDrop` reports `queue_overflow` | Production volume exceeds `maxQueueSize` | Raise `maxQueueSize`, or lower `flushAt` to flush sooner |
| Revenue reports \$0 | The amount is not in `value` | Use `trackPurchase()`, or put the amount in `properties.value` |
| Every server event is a separate person | Calls carry neither `userId` nor `anonymousId` | Pass the browser `visitor_id` as `anonymousId` |
| `fetch is not defined` at send time | Node 16 or earlier | Upgrade to Node 18 or later |

Set `debug: true` to log every send and every error to the console.

## License

MIT
