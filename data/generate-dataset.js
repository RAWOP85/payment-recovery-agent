const fs = require('fs');
const path = require('path');

const REASONS = ['insufficient_funds', 'card_declined', 'checkout_abandoned', 'otp_timeout'];
const COUNT = 120;
const NOW = Date.now();
const WINDOW_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

// Bucketed amounts (in paise) so the dataset reads as realistic rather than
// uniformly flat: most failures cluster at low-ticket amounts, fewer at mid-ticket.
const AMOUNT_BUCKETS = [
  { min: 9900, max: 99900, weight: 0.6 }, // ₹99 - ₹999
  { min: 100000, max: 499900, weight: 0.4 }, // ₹1000 - ₹4999
];

function randomAmountPaise() {
  const roll = Math.random();
  const bucket = roll < AMOUNT_BUCKETS[0].weight ? AMOUNT_BUCKETS[0] : AMOUNT_BUCKETS[1];
  return Math.floor(bucket.min + Math.random() * (bucket.max - bucket.min));
}

function randomFailedAt() {
  return new Date(NOW - Math.random() * WINDOW_MS).toISOString();
}

function randomReason() {
  return REASONS[Math.floor(Math.random() * REASONS.length)];
}

const records = Array.from({ length: COUNT }, (_, i) => ({
  customer_id: `cust_${String(i + 1).padStart(4, '0')}`,
  amount: randomAmountPaise(),
  failure_reason: randomReason(),
  failed_at: randomFailedAt(),
}));

// Shuffle so downstream logic can't rely on input order.
for (let i = records.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [records[i], records[j]] = [records[j], records[i]];
}

const outPath = path.join(__dirname, 'failed-payments.json');
fs.writeFileSync(outPath, JSON.stringify(records, null, 2));

const breakdown = REASONS.reduce((acc, reason) => {
  acc[reason] = records.filter((r) => r.failure_reason === reason).length;
  return acc;
}, {});

console.log(`Generated ${records.length} synthetic failed-payment records -> data/failed-payments.json`);
console.log('Breakdown by failure_reason:', breakdown);
