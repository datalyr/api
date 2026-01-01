// Test script for @datalyr/api SDK
// Usage: node test-sdk.js dk_your_api_key_here

const { Datalyr } = require('./dist/index.js');

async function testSDK() {
  const apiKey = process.argv[2];
  
  if (!apiKey) {
    console.error('Please provide your API key as an argument:');
    console.error('node test-sdk.js dk_your_api_key_here');
    process.exit(1);
  }

  console.log('🚀 Testing @datalyr/api SDK...\n');

  // Initialize SDK
  const datalyr = new Datalyr({
    apiKey: apiKey,
    debug: true,
    flushAt: 2,  // Flush after 2 events for testing
    flushInterval: 5000
  });

  try {
    // Test 1: Track a simple event
    console.log('Test 1: Tracking simple event...');
    await datalyr.track('test_user_123', 'Test Event', {
      test: true,
      timestamp: new Date().toISOString()
    });

    // Test 2: Track purchase event
    console.log('\nTest 2: Tracking purchase event...');
    await datalyr.track('test_user_123', 'Purchase Completed', {
      amount: 99.99,
      currency: 'USD',
      products: ['product_1', 'product_2'],
      test: true
    });

    // Test 3: Identify user
    console.log('\nTest 3: Identifying user...');
    await datalyr.identify('test_user_123', {
      email: 'test@example.com',
      name: 'Test User',
      plan: 'premium',
      test: true
    });

    // Test 4: Track pageview
    console.log('\nTest 4: Tracking pageview...');
    await datalyr.page('test_user_123', 'Homepage', {
      url: 'https://example.com',
      referrer: 'https://google.com',
      test: true
    });

    // Test 5: Group user
    console.log('\nTest 5: Grouping user...');
    await datalyr.group('test_user_123', 'company_456', {
      name: 'Test Company',
      industry: 'Technology',
      test: true
    });

    // Test 6: Anonymous event (no userId)
    console.log('\nTest 6: Tracking anonymous event...');
    await datalyr.track(null, 'Anonymous Event', {
      source: 'test_script',
      test: true
    });

    // Wait a bit for auto-flush to happen
    console.log('\n⏳ Waiting for auto-flush...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Manual flush remaining events
    console.log('\n📤 Manually flushing remaining events...');
    await datalyr.flush();

    // Close SDK
    console.log('\n🔒 Closing SDK...');
    await datalyr.close();

    console.log('\n✅ All tests completed successfully!');
    console.log('\n📊 Check your Datalyr dashboard to see the test events.');
    console.log('   They should appear with test: true in properties.');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run tests
testSDK().catch(console.error);