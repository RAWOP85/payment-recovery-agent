#!/usr/bin/env node
// Captures a second live Razorpay recovery record — UPI, not card — as
// evidence alongside the already-committed demo_live_001 card record. Run in
// two steps (not one, like `npm run recover -- --live-wait`) so the payment
// link's short_url is available in between: create the link, hand its URL to
// a browser automation step to pay it via a UPI test VPA, then finish by
// polling for the paid status and merging the result into data/report.json
// and data/audit-log.jsonl without disturbing any existing entries.
//
// Usage:
//   node scripts/capture-live-upi-recovery.js create
//     -> creates the payment link, prints {id, short_url} as JSON, exits.
//   node scripts/capture-live-upi-recovery.js finish <linkId> <shortUrl>
//     -> polls the link (LIVE_WAIT_MS, default 120000) and, once paid (or on
//        timeout), appends the audit-log attempts and merges the record into
//        data/report.json.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const razorpayClient = require('../src/config/razorpay');
const {
  createDemoPaymentLink,
  pollUntilPaidOrTimeout,
  buildLiveResult,
  DEMO_RECORD_UPI,
} = require('../src/live-recovery');
const { appendEntry } = require('../src/audit-log');

const REPORT_PATH = path.join(__dirname, '..', 'data', 'report.json');

async function createMode() {
  const link = await createDemoPaymentLink(razorpayClient, DEMO_RECORD_UPI);
  console.log(JSON.stringify({ id: link.id, short_url: link.short_url }));
}

async function finishMode(linkId, shortUrl) {
  if (!linkId || !shortUrl) {
    throw new Error('finish mode requires <linkId> <shortUrl>');
  }

  const waitMs = Number(process.env.LIVE_WAIT_MS) || 120000;
  const pollMs = Number(process.env.POLL_INTERVAL_MS) || 5000;
  console.error(`Polling ${linkId} for up to ${waitMs / 1000}s (every ${pollMs / 1000}s)...`);
  const finalStatus = await pollUntilPaidOrTimeout(razorpayClient, linkId, {
    totalWaitMs: waitMs,
    pollIntervalMs: pollMs,
  });
  console.error(`Final Razorpay status: ${finalStatus}`);

  const result = buildLiveResult(DEMO_RECORD_UPI, { id: linkId, short_url: shortUrl }, finalStatus);

  // Appends only — never calls startLog(), so the batch run's existing audit
  // trail (120 synthetic + the card demo record) is preserved, not truncated.
  for (const attempt of result.attempts) {
    appendEntry(attempt);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

  const bucket = result.outcome === 'recovered' ? 'recovered' : 'unrecovered';
  report.totals.processed += 1;
  report.totals[bucket] += 1;

  if (!report.by_failure_reason[result.failure_reason]) {
    report.by_failure_reason[result.failure_reason] = { recovered: 0, unrecovered: 0 };
  }
  report.by_failure_reason[result.failure_reason][bucket] += 1;

  if (result.outcome === 'recovered') {
    const rung = String(result.recovered_at_rung);
    report.by_rung_recovered[rung] = (report.by_rung_recovered[rung] || 0) + 1;
  }

  // payment_method disambiguates this from the pre-existing demo_live_001
  // (card) record now that report.json carries two live records.
  report.records.push({
    customer_id: result.customer_id,
    failure_reason: result.failure_reason,
    outcome: result.outcome,
    recovered_at_rung: result.recovered_at_rung,
    attempts: result.attempts.length,
    source: 'live',
    payment_method: 'upi',
    payment_link: result.payment_link,
  });

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Outcome: ${result.outcome} (recovered_at_rung: ${result.recovered_at_rung})`);
  console.log('Merged into data/report.json and data/audit-log.jsonl');
}

const [, , mode, ...rest] = process.argv;

if (mode === 'create') {
  createMode().catch((err) => {
    console.error('create failed:', err.message);
    process.exit(1);
  });
} else if (mode === 'finish') {
  finishMode(rest[0], rest[1]).catch((err) => {
    console.error('finish failed:', err.message);
    process.exit(1);
  });
} else {
  console.error('Usage: node scripts/capture-live-upi-recovery.js create | finish <linkId> <shortUrl>');
  process.exit(1);
}
