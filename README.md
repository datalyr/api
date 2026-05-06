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
  retryLimit: 3,              // Max retries for failed requests (default: 3)
  maxQueueSize: 1000,         // Max queued events before dropping oldest (default: 1000, range: 100-10000)
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

```javascript
await datalyr.group('user_123', 'company_456', {
  name: 'Acme Corp',
  industry: 'Technology',
  employees: 50,
});
```

### flush()

Send all queued events immediately.

```javascript
await datalyr.flush();
```

### close()

Stops the flush timer, then attempts a final flush with a **5-second timeout**. Any events still queued after the timeout are dropped. New events tracked after `close()` is called are silently ignored.

```javascript
process.on('SIGTERM', async () => {
  await datalyr.close();
  process.exit(0);
});
```

### getAnonymousId()

Returns the SDK instance's persistent anonymous ID. The ID is generated lazily on first use and has the format `anon_<random><timestamp>` (e.g., `anon_k7x2m9f1lxyzabc`).

```javascript
const anonId = datalyr.getAnonymousId();
```

## Event Payload

Every event sent to the API has this structure:

```javascript
{
  event: 'Purchase Completed',
  userId: 'user_123',              // undefined if not provided
  anonymousId: 'anon_k7x2m9f...',  // Always present
  properties: {
    amount: 99.99,
    anonymous_id: 'anon_k7x2m9f...',  // Automatically added
  },
  context: {
    library: '@datalyr/api',
    version: '1.2.1',
    source: 'api',
  },
  timestamp: '2025-01-15T10:30:00.000Z',
}
```

Notes:
- `anonymous_id` is automatically added to `properties` on every event for attribution.
- The `context` object identifies the SDK and version.
- `timestamp` is set to the ISO 8601 time when the event was created.

## Batching and Retry Behavior

Events are queued locally and sent in batches, not one at a time.

- **Auto-flush triggers:** when the queue reaches `flushAt` events, or every `flushInterval` ms.
- **Batch size:** events are sent in parallel batches of 10 within a single flush.
- **Queue overflow:** when the queue reaches `maxQueueSize`, the oldest event is dropped to make room.
- **Retry:** 5xx (server) errors are retried up to `retryLimit` times with exponential backoff (1s, 2s, 4s, ... capped at 10s). 4xx (client) errors are permanent failures and are not retried.
- **Failed events:** events that fail after all retries are re-queued at the front.

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
      await datalyr.track(session.client_reference_id, 'Purchase Completed', {
        amount: session.amount_total / 100,
        currency: session.currency,
        stripe_session_id: session.id,
      });
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      await datalyr.track(subscription.metadata.userId, 'Subscription Started', {
        plan: subscription.items.data[0].price.nickname,
        mrr: subscription.items.data[0].price.unit_amount / 100,
        interval: subscription.items.data[0].price.recurring.interval,
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
