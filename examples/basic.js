// Basic example for @datalyr/api SDK
const { Datalyr } = require('@datalyr/api');

async function main() {
  // Initialize with your API key
  const datalyr = new Datalyr('dk_your_api_key_here');

  try {
    // Track a simple event
    await datalyr.track('user_123', 'Button Clicked', {
      button_name: 'Sign Up',
      page: 'Homepage'
    });

    // Identify a user
    await datalyr.identify('user_123', {
      email: 'user@example.com',
      name: 'John Doe',
      plan: 'free'
    });

    // Track a purchase
    await datalyr.track('user_123', 'Purchase Completed', {
      amount: 49.99,
      currency: 'USD',
      items: ['Product A', 'Product B']
    });

    // Flush events and close
    await datalyr.flush();
    await datalyr.close();
    
    console.log('Events sent successfully!');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();