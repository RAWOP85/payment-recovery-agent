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
// How often to re-check the link's status during the wait window, rather than
// only once after the full window elapses. A single post-wait check only
// catches a payment that happens to land before LIVE_WAIT_MS is up; periodic
// polling detects it the moment it happens, so the run doesn't have to blindly
// idle out the rest of a long window once the link is already paid. This does
// NOT extend how long we're willing to wait overall — LIVE_WAIT_MS is still
// the hard cap, so this stays a bounded wait, not open-ended retrying.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the link's status every `pollIntervalMs` until it's paid or
// `totalWaitMs` has elapsed, whichever comes first, then returns the last
// observed status. Elapsed time is bounded by `Date.now()` against a fixed
// deadline (rather than counting fixed-size sleeps) so the final sleep is
// trimmed to land on the deadline instead of overshooting it.
async function pollUntilPaidOrTimeout(razorpayClient, linkId, { totalWaitMs, pollIntervalMs }) {
  const deadline = Date.now() + totalWaitMs;
  let status = await fetchPaymentLinkStatus(razorpayClient, linkId);

  while (status !== 'paid' && Date.now() < deadline) {
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    status = await fetchPaymentLinkStatus(razorpayClient, linkId);
  }

  return status;
}

async function processLiveRecord(razorpayClient, record = DEMO_RECORD, { liveWait = false } = {}) {
  const link = await createDemoPaymentLink(razorpayClient, record);

  let finalStatus;
  if (liveWait) {
    console.log(`Pay this link now to test recovery: ${link.short_url}`);
    console.log(
      `Polling status every ${POLL_INTERVAL_MS / 1000}s for up to ${LIVE_WAIT_MS / 1000}s (returns as soon as it's paid)...`
    );
    finalStatus = await pollUntilPaidOrTimeout(razorpayClient, link.id, {
      totalWaitMs: LIVE_WAIT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    console.log(`Final Razorpay status after polling: ${finalStatus}`);
  } else {
    finalStatus = await fetchPaymentLinkStatus(razorpayClient, link.id);
  }

  const attempts = [];
  let outcome = 'unrecovered';
  let recoveredAtRung = null;

  for (let rungIndex = 0; rungIndex < RUNGS.length; rungIndex++) {
    const dayOffset = RUNGS[rungIndex];
    const attemptOutcome = finalStatus === 'paid' ? 'recovered' : 'no_response';

    attempts.push({
      timestamp: simulatedTimestamp(record.failed_at, dayOffset),
      customer_id: record.customer_id,
      rung: dayOffset,
      day_offset: dayOffset,
      action: actionFor(rungIndex, attemptOutcome),
      reason: `${buildReason(record, rungIndex, attemptOutcome)} [live Razorpay status: ${finalStatus}]`,
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
