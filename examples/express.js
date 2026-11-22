// Express integration example for the DATALYR Node SDK (@datalyr/api)
const express = require('express');
const { Datalyr } = require('@datalyr/api');

const app = express();
app.use(express.json());

// Initialize the DATALYR SDK
const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY || 'dk_your_api_key_here',
  debug: true
});

// Middleware to track API requests
app.use(async (req, res, next) => {
  // Track API request
  await datalyr.track({
    event: 'api_request',
    userId: req.user?.id,
    properties: {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }
  });
  next();
});

// Example route: User signup
app.post('/api/signup', async (req, res) => {
  const { email, name } = req.body;
  const userId = `user_${Date.now()}`;

  // Track signup event
  await datalyr.track({
    event: 'signup_completed',
    userId,
    properties: { email, source: 'api' }
  });

  // Identify the new user
  await datalyr.identify(userId, {
    email,
    name,
    signupDate: new Date().toISOString()
  });

  res.json({ success: true, userId });
});

// Example route: Purchase
app.post('/api/purchase', async (req, res) => {
  const { userId, amount, products } = req.body;

  // Record the purchase with its value
  await datalyr.trackPurchase(userId, {
    value: amount,
    currency: 'USD',
    products
  });

  res.json({ success: true });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await datalyr.close();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});