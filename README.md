# @datalyr/api

Server-side analytics and attribution SDK for Node.js. Track events, identify users, and preserve attribution data from your backend.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Event Tracking](#event-tracking)
  - [Custom Events](#custom-events)
  - [Page Views](#page-views)
- [User Identity](#user-identity)
  - [Anonymous ID](#anonymous-id)
  - [Identifying Users](#identifying-users)
  - [Groups](#groups)
- [Attribution Preservation](#attribution-preservation)
- [Event Queue](#event-queue)
- [Framework Examples](#framework-examples)
  - [Express.js](#expressjs)
  - [Stripe Webhooks](#stripe-webhooks)
- [TypeScript](#typescript)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

```bash
npm install @datalyr/api
```

---

## Quick Start

```javascript
import { Datalyr } from '@datalyr/api';

// Initialize
const datalyr = new Datalyr('dk_your_api_key');

// Track events
await datalyr.track('user_123', 'button_clicked', { button: 'signup' });

// Identify users
await datalyr.identify('user_123', { email: 'user@example.com' });

// Clean up on shutdown
await datalyr.close();
```

---

## How It Works

The SDK collects events and sends them to the Datalyr backend for analytics and attribution.

### Data Flow

1. Events are created with `track()`, `identify()`, `page()`, or `group()`
2. Events are queued locally and sent in batches
3. Batches are sent when queue reaches 20 events or every 10 seconds
4. Failed requests are retried with exponential backoff
5. Events are processed server-side for analytics and attribution reporting

### Event Payload

Every event includes:

```javascript
{
  event: 'purchase',              // Event name
  properties: { ... },            // Custom properties

  // Identity
  anonymous_id: 'uuid',           // Persistent ID
  user_id: 'user_123',            // Set after identify()

  // Timestamps
  timestamp: '2024-01-15T10:30:00Z',
}
```

---

## Configuration

```javascript
const datalyr = new Datalyr({
  // Required
  apiKey: string,

  // Optional
  host?: string,              // Custom endpoint (default: https://ingest.datalyr.com)
  flushAt?: number,           // Batch size (default: 20)
  flushInterval?: number,     // Send interval ms (default: 10000)
  timeout?: number,           // Request timeout ms (default: 10000)
  retryLimit?: number,        // Max retries (default: 3)
  maxQueueSize?: number,      // Max queued events (default: 1000)
  debug?: boolean,            // Console logging (default: false)
});
```

---

## Event Tracking

### Custom Events

Track any action in your application:

```javascript
// Simple event
await datalyr.track('user_123', 'signup_started');

// Event with properties
await datalyr.track('user_123', 'product_viewed', {
  product_id: 'SKU123',
  product_name: 'Blue Shirt',
  price: 29.99,
  currency: 'USD',
});

// Purchase event
await datalyr.track('user_123', 'Purchase Completed', {
  order_id: 'ORD-456',
  total: 99.99,
  currency: 'USD',
  items: ['SKU123', 'SKU456'],
});
```

### Page Views

Track server-rendered page views:

```javascript
await datalyr.page('user_123', 'Homepage', {
  url: 'https://example.com',
  referrer: 'https://google.com',
});

await datalyr.page('user_123', 'Product Details', {
  url: 'https://example.com/products/123',
  product_id: 'SKU123',
});
```

---

## User Identity

### Anonymous ID

The SDK generates a persistent anonymous ID:

```javascript
const anonymousId = datalyr.getAnonymousId();
// 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
```

For attribution preservation, pass the anonymous ID from your browser/mobile SDK instead.

### Identifying Users

Link events to a known user:

```javascript
await datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium',
});
```

### Groups

Associate users with companies or teams:

```javascript
await datalyr.group('user_123', 'company_456', {
  name: 'Acme Corp',
  industry: 'Technology',
  employees: 50,
});
```

---

## Attribution Preservation

Pass the anonymous ID from browser/mobile SDKs to preserve attribution data:

```javascript
// Object signature with anonymousId
await datalyr.track({
  event: 'Purchase Completed',
  userId: 'user_123',
  anonymousId: req.body.anonymous_id,  // From browser SDK
  properties: {
    amount: 99.99,
    currency: 'USD',
  },
});
```

This links server-side events to the user's browser session, preserving:
- UTM parameters (utm_source, utm_medium, utm_campaign)
- Click IDs (fbclid, gclid, ttclid)
- Referrer and landing page
- Customer journey touchpoints

---

## Event Queue

Events are batched for efficiency.

### Configuration

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  flushAt: 20,           // Send when 20 events queued
  flushInterval: 10000,  // Or every 10 seconds
});
```

### Manual Flush

Send all queued events immediately:

```javascript
await datalyr.flush();
```

### Graceful Shutdown

Always close the client on application shutdown:

```javascript
process.on('SIGTERM', async () => {
  await datalyr.close();  // Flushes remaining events
  process.exit(0);
});
```

---

## Framework Examples

### Express.js

```javascript
import express from 'express';
import { Datalyr } from '@datalyr/api';

const app = express();
const datalyr = new Datalyr('dk_your_api_key');

app.post('/api/purchase', async (req, res) => {
  const { items, anonymous_id } = req.body;

  // Track with anonymous_id to preserve attribution
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

// Graceful shutdown
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
    case 'checkout.session.completed':
      const session = event.data.object;
      await datalyr.track(
        session.client_reference_id,
        'Purchase Completed',
        {
          amount: session.amount_total / 100,
          currency: session.currency,
          stripe_session_id: session.id,
        }
      );
      break;

    case 'customer.subscription.created':
      const subscription = event.data.object;
      await datalyr.track(
        subscription.metadata.userId,
        'Subscription Started',
        {
          plan: subscription.items.data[0].price.nickname,
          mrr: subscription.items.data[0].price.unit_amount / 100,
          interval: subscription.items.data[0].price.recurring.interval,
        }
      );
      break;
  }

  res.json({ received: true });
});
```

---

## TypeScript

```typescript
import { Datalyr, TrackOptions, IdentifyOptions } from '@datalyr/api';

const datalyr = new Datalyr('dk_your_api_key');

// Type-safe tracking
const trackOptions: TrackOptions = {
  event: 'Purchase Completed',
  userId: 'user_123',
  anonymousId: 'anon_456',
  properties: {
    amount: 99.99,
    currency: 'USD',
  },
};

await datalyr.track(trackOptions);
```

---

## Troubleshooting

### Events not appearing

1. Check API key starts with `dk_`
2. Enable `debug: true`
3. Call `flush()` to force send
4. Check server logs for errors

### Request timeouts

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  timeout: 30000,     // Increase timeout
  retryLimit: 5,      // More retries
});
```

### Queue full

```javascript
const datalyr = new Datalyr({
  apiKey: 'dk_your_api_key',
  maxQueueSize: 5000,   // Increase queue size
  flushAt: 50,          // Larger batches
});
```

---

## License

MIT
