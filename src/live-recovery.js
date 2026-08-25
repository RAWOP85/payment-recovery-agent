const { RUNGS, simulatedTimestamp, actionFor, buildReason } = require('./escalation');

// A dedicated fixture, separate from the 120 synthetic dataset records, so the
// live demo path never depends on which random record a dataset regeneration
// happens to produce.
const DEMO_RECORD = {
  customer_id: 'demo_live_001',
  amount: 49900, // paise -> ₹499.00
  currency: 'INR',
  failure_reason: 'checkout_abandoned',
  failed_at: new Date().toISOString(),
  description: 'Payment Recovery Agent — live demo payment link',
};

async function createDemoPaymentLink(razorpayClient, record = DEMO_RECORD) {
  return razorpayClient.paymentLink.create({
    amount: record.amount,
    currency: record.currency,
    description: record.description,
    reference_id: `${record.customer_id}-${Date.now()}`,
    notify: { sms: false, email: false },
  });
}

async function fetchPaymentLinkStatus(razorpayClient, paymentLinkId) {
  const link = await razorpayClient.paymentLink.fetch(paymentLinkId);
  return link.status; // 'created' | 'paid' | 'expired' | 'cancelled' | 'partially_paid'
}

const LIVE_WAIT_MS = Number(process.env.LIVE_WAIT_MS) || 75000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processLiveRecord(razorpayClient, record = DEMO_RECORD, { liveWait = false } = {}) {
  const link = await createDemoPaymentLink(razorpayClient, record);

  if (liveWait) {
    console.log(`Pay this link now to test recovery: ${link.short_url}`);
    console.log(`Waiting ${LIVE_WAIT_MS / 1000}s before checking payment status...`);
    await wait(LIVE_WAIT_MS);
  }

  const attempts = [];
  let outcome = 'unrecovered';
  let recoveredAtRung = null;

  for (let rungIndex = 0; rungIndex < RUNGS.length; rungIndex++) {
    const dayOffset = RUNGS[rungIndex];
    const status = await fetchPaymentLinkStatus(razorpayClient, link.id);
    const attemptOutcome = status === 'paid' ? 'recovered' : 'no_response';

    attempts.push({
      timestamp: simulatedTimestamp(record.failed_at, dayOffset),
      customer_id: record.customer_id,
      rung: dayOffset,
      day_offset: dayOffset,
      action: actionFor(rungIndex, attemptOutcome),
      reason: `${buildReason(record, rungIndex, attemptOutcome)} [live Razorpay status: ${status}]`,
      outcome: attemptOutcome,
    });

    if (attemptOutcome === 'recovered') {
      outcome = 'recovered';
      recoveredAtRung = dayOffset;
      break;
    }
  }

  return {
    customer_id: record.customer_id,
    failure_reason: record.failure_reason,
    outcome,
    recovered_at_rung: recoveredAtRung,
    attempts,
    payment_link: { id: link.id, short_url: link.short_url },
  };
}

module.exports = { DEMO_RECORD, createDemoPaymentLink, fetchPaymentLinkStatus, processLiveRecord };
