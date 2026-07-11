// Stripe webhook integration example for @datalyr/api SDK
//
// IDEMPOTENT REDELIVERY: Stripe delivers webhooks at-least-once — the same event can
// arrive multiple times (retries, replays from the dashboard). Always pass the Stripe
// event id as `eventId`: Datalyr's ingest de-duplicates on it (6h window), so a
// redelivered Purchase is counted ONCE instead of double-counting revenue.
// Also pass `timestamp: event.created` (epoch seconds) so delayed replays land on the
// day the event actually happened, not the day the retry arrived.
const express = require('express');
const { Datalyr } = require('@datalyr/api');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY,
  // Observability: never lose a revenue event silently. onDrop fires whenever an event is
  // permanently dropped (bad key, overflow, close-timeout, …) — persist it to your own DLQ.
  onDrop: (events, reason) => console.error(`[datalyr] dropped ${events.length} event(s): ${reason}`),
});

// Stripe webhook endpoint
app.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;

        // trackPurchase() stamps the canonical `value` field (the server reads the amount as
        // value ?? revenue ?? amount) and validates it's a finite number, so a bad amount is
        // dropped rather than counted as $0. eventId makes redeliveries idempotent (no
        // double-counted revenue); timestamp backdates delayed replays.
        await datalyr.trackPurchase(
          session.client_reference_id || session.customer,
          {
            value: session.amount_total / 100,
            currency: session.currency,
            paymentStatus: session.payment_status,
            stripeSessionId: session.id,
            customerEmail: session.customer_details?.email
          },
          { eventId: event.id, timestamp: event.created }
        );
        break;

      case 'customer.subscription.created':
        const subscription = event.data.object;

        // Track subscription start
        await datalyr.track({
          userId: subscription.metadata?.userId || subscription.customer,
          event: 'Subscription Started',
          eventId: event.id,
          timestamp: event.created,
          properties: {
            plan: subscription.items.data[0].price.nickname,
            amount: subscription.items.data[0].price.unit_amount / 100,
            interval: subscription.items.data[0].price.recurring.interval,
            stripeSubscriptionId: subscription.id,
            status: subscription.status
          }
        });

        // Update user traits
        await datalyr.identify(
          subscription.metadata?.userId || subscription.customer,
          {
            subscriptionStatus: 'active',
            subscriptionPlan: subscription.items.data[0].price.nickname,
            stripeCustomerId: subscription.customer
          }
        );
        break;

      case 'customer.subscription.deleted':
        const canceledSub = event.data.object;

        // Track cancellation
        await datalyr.track({
          userId: canceledSub.metadata?.userId || canceledSub.customer,
          event: 'Subscription Canceled',
          eventId: event.id,
          timestamp: event.created,
          properties: {
            plan: canceledSub.items.data[0].price.nickname,
            cancelReason: canceledSub.cancellation_details?.reason,
            stripeSubscriptionId: canceledSub.id
          }
        });

        // Update user traits
        await datalyr.identify(
          canceledSub.metadata?.userId || canceledSub.customer,
          {
            subscriptionStatus: 'canceled',
            subscriptionEndDate: new Date(canceledSub.ended_at * 1000).toISOString()
          }
        );
        break;

      case 'invoice.payment_failed':
        const invoice = event.data.object;

        // Track failed payment
        await datalyr.track({
          userId: invoice.metadata?.userId || invoice.customer,
          event: 'Payment Failed',
          eventId: event.id,
          timestamp: event.created,
          properties: {
            amount: invoice.amount_due / 100,
            currency: invoice.currency,
            attemptCount: invoice.attempt_count,
            stripeInvoiceId: invoice.id
          }
        });
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stripe webhook server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await datalyr.close();
  process.exit(0);
});
