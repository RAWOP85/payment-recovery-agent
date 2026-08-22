require('dotenv').config();
const razorpay = require('../src/config/razorpay');

async function main() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    console.error(
      'RAZORPAY_KEY_ID is missing or is not a test-mode key (must start with rzp_test_).\n' +
        'Copy .env.example to .env and fill in your real Razorpay test-mode keys.'
    );
    process.exit(1);
  }

  const order = await razorpay.orders.create({
    amount: 50000, // paise -> ₹500.00, arbitrary but realistic
    currency: 'INR',
    receipt: `day1-check-${Date.now()}`,
    notes: { purpose: 'Day 1 Razorpay API connectivity check' },
  });

  console.log('Razorpay connectivity check: SUCCESS');
  console.log(JSON.stringify(order, null, 2));
}

main().catch((err) => {
  console.error('Razorpay connectivity check: FAILED');
  console.error(err);
  process.exit(1);
});
