// Basic example for the DATALYR Node SDK (@datalyr/api)
const { Datalyr } = require('@datalyr/api');

async function main() {
  // Initialize with your server API key
  const datalyr = new Datalyr({ apiKey: process.env.DATALYR_API_KEY || 'dk_your_api_key_here' });

  try {
    // Track an event
    await datalyr.track({
      event: 'button_clicked',
      userId: 'user_123',
      properties: { button_name: 'sign_up', page: 'homepage' }
    });

    // Identify a user
    await datalyr.identify('user_123', {
      email: 'user@example.com',
      name: 'Jane Doe',
      plan: 'free'
    });

    // Record a purchase with its value
    await datalyr.trackPurchase('user_123', {
      value: 49.99,
      currency: 'USD',
      items: ['Product A', 'Product B']
    });

    // Send queued events and stop the client before exit
    await datalyr.close();

    console.log('Events sent.');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
