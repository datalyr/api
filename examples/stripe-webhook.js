// Stripe webhook integration example for @datalyr/api SDK
const express = require('express');
const { Datalyr } = require('@datalyr/api');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const datalyr = new Datalyr(process.env.DATALYR_API_KEY);

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
        
        // Track purchase
        await datalyr.track(
          session.client_reference_id || session.customer,
          'Purchase Completed',
          {
            amount: session.amount_total / 100,
            currency: session.currency,
            paymentStatus: session.payment_status,
            stripeSessionId: session.id,
            customerEmail: session.customer_details?.email
          }
        );
        break;

      case 'customer.subscription.created':
        const subscription = event.data.object;
        
        // Track subscription start
        await datalyr.track(
          subscription.metadata?.userId || subscription.customer,
          'Subscription Started',
          {
            plan: subscription.items.data[0].price.nickname,
            amount: subscription.items.data[0].price.unit_amount / 100,
            interval: subscription.items.data[0].price.recurring.interval,
            stripeSubscriptionId: subscription.id,
            status: subscription.status
          }
        );

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
        await datalyr.track(
          canceledSub.metadata?.userId || canceledSub.customer,
          'Subscription Canceled',
          {
            plan: canceledSub.items.data[0].price.nickname,
            cancelReason: canceledSub.cancellation_details?.reason,
            stripeSubscriptionId: canceledSub.id
          }
        );

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
        await datalyr.track(
          invoice.metadata?.userId || invoice.customer,
          'Payment Failed',
          {
            amount: invoice.amount_due / 100,
            currency: invoice.currency,
            attemptCount: invoice.attempt_count,
            stripeInvoiceId: invoice.id
          }
        );
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