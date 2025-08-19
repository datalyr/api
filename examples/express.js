// Express.js integration example for @datalyr/api SDK
const express = require('express');
const { Datalyr } = require('@datalyr/api');

const app = express();
app.use(express.json());

// Initialize Datalyr SDK
const datalyr = new Datalyr({
  apiKey: process.env.DATALYR_API_KEY || 'dk_your_api_key_here',
  debug: true
});

// Middleware to track API requests
app.use(async (req, res, next) => {
  // Track API request
  await datalyr.track(
    req.user?.id || null,
    'API Request',
    {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }
  );
  next();
});

// Example route: User signup
app.post('/api/signup', async (req, res) => {
  const { email, name } = req.body;
  const userId = `user_${Date.now()}`;

  // Track signup event
  await datalyr.track(userId, 'User Signed Up', {
    email,
    source: 'api'
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

  // Track purchase event
  await datalyr.track(userId, 'Purchase Completed', {
    amount,
    currency: 'USD',
    products,
    timestamp: new Date().toISOString()
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