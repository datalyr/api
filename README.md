# @datalyr/api

Official API SDK for Datalyr server-side tracking with identity resolution support.

## Installation

```bash
npm install @datalyr/api
# or
yarn add @datalyr/api
# or
pnpm add @datalyr/api
```

## Quick Start

```javascript
const { Datalyr } = require('@datalyr/api');
// or
import { Datalyr } from '@datalyr/api';

// Initialize with your API key
const datalyr = new Datalyr('your_api_key_here');

// Track an event
await datalyr.track('user_123', 'Purchase Completed', {
  amount: 99.99,
  currency: 'USD',
  products: ['item_1', 'item_2']
});

// Identify a user
await datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium'
});

// Track a pageview
await datalyr.page('user_123', 'Homepage', {
  url: 'https://example.com',
  referrer: 'https://google.com'
});

// Group a user
await datalyr.group('user_123', 'company_456', {
  name: 'Acme Corp',
  industry: 'Technology'
});

// Clean up when done
await datalyr.close();
```

## Identity Resolution (New in v1.1.0)

The SDK now supports anonymous IDs for complete user journey tracking:

```javascript
// Option 1: Pass anonymous_id from browser/mobile for attribution preservation
await datalyr.track({
  event: 'Purchase Completed',
  userId: 'user_123',
  anonymousId: req.body.anonymous_id,  // From browser/mobile SDK
  properties: {
    amount: 99.99,
    currency: 'USD'
  }
});

// Option 2: Use legacy signature (SDK generates anonymous_id)
await datalyr.track('user_123', 'Purchase Completed', {
  amount: 99.99
});

// Get the SDK's anonymous ID (useful for server-only tracking)
const anonymousId = datalyr.getAnonymousId();
```

### Express.js Example with Browser Attribution

```javascript
app.post('/api/purchase', async (req, res) => {
  const { items, anonymous_id } = req.body;  // anonymous_id from browser
  
  // Track with anonymous_id to preserve attribution (fbclid, gclid, etc.)
  await datalyr.track({
    event: 'Purchase Completed',
    userId: req.user?.id,
    anonymousId: anonymous_id,  // Links to browser events!
    properties: {
      total: calculateTotal(items),
      items: items.length
    }
  });
  
  res.json({ success: true });
});
```

### Key Benefits:
- **Attribution Preservation**: Never lose fbclid, gclid, ttclid, or lyr tracking
- **Complete Journey**: Track users from web → server → mobile
- **Flexible API**: Support both legacy and new tracking methods

## Configuration

```javascript
const datalyr = new Datalyr({
  apiKey: 'your_api_key_here',
  host: 'https://api.datalyr.com',  // Optional: custom host
  flushAt: 20,                      // Optional: batch size (default: 20)
  flushInterval: 10000,             // Optional: batch interval in ms (default: 10000)
  debug: true,                      // Optional: enable debug logging (default: false)
  timeout: 10000,                   // Optional: request timeout in ms (default: 10000)
  retryLimit: 3,                    // Optional: max retries (default: 3)
  maxQueueSize: 1000                // Optional: max events in queue (default: 1000)
});
```

## Stripe Webhook Example

```javascript
const { Datalyr } = require('@datalyr/api');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const datalyr = new Datalyr(process.env.DATALYR_API_KEY);

app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  
  switch (event.type) {
    case 'checkout.session.completed':
      await datalyr.track(
        event.data.object.client_reference_id,
        'Purchase Completed',
        {
          amount: event.data.object.amount_total / 100,
          currency: event.data.object.currency,
          stripeSessionId: event.data.object.id
        }
      );
      break;
      
    case 'customer.subscription.created':
      await datalyr.track(
        event.data.object.metadata.userId,
        'Subscription Started',
        {
          plan: event.data.object.items.data[0].price.nickname,
          mrr: event.data.object.items.data[0].price.unit_amount / 100,
          interval: event.data.object.items.data[0].price.recurring.interval
        }
      );
      break;
  }
  
  res.json({ received: true });
});
```

## API Reference

### `new Datalyr(config)`

Creates a new Datalyr instance.

### `track(userId, event, properties?)`

Track a custom event.

### `identify(userId, traits?)`

Identify a user with traits.

### `page(userId, name?, properties?)`

Track a pageview.

### `group(userId, groupId, traits?)`

Associate a user with a group.

### `flush()`

Manually flush the event queue.

### `close()`

Flush remaining events and clean up resources.

## License

MIT