const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, formatSummary } = require('../src/report');

function makeResult({ customerId, reason, outcome, recoveredAtRung, attemptCount }) {
  return {
    customer_id: customerId,
    failure_reason: reason,
    outcome,
    recovered_at_rung: recoveredAtRung,
    attempts: new Array(attemptCount).fill({}),
  };
}

test('buildReport aggregates totals, by-reason, and by-rung breakdowns', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'checkout_abandoned', outcome: 'recovered', recoveredAtRung: 0, attemptCount: 1 }),
    makeResult({ customerId: 'b', reason: 'checkout_abandoned', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
    makeResult({ customerId: 'c', reason: 'card_declined', outcome: 'recovered', recoveredAtRung: 5, attemptCount: 3 }),
  ];

  const report = buildReport({ seed: 42, results });

  assert.equal(report.seed, 42);
  assert.deepEqual(report.totals, { processed: 3, recovered: 2, unrecovered: 1 });
  assert.deepEqual(report.by_failure_reason.checkout_abandoned, { recovered: 1, unrecovered: 1 });
  assert.deepEqual(report.by_failure_reason.card_declined, { recovered: 1, unrecovered: 0 });
  assert.equal(report.by_rung_recovered[0], 1);
  assert.equal(report.by_rung_recovered[5], 1);
  assert.equal(report.records.length, 3);
});

test('buildReport never hides the unrecovered count', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
  ];
  const report = buildReport({ seed: 1, results });
  assert.equal(report.totals.unrecovered, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(report.totals, 'unrecovered'));
});

test('formatSummary includes both recovered and unrecovered counts in the printed text', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 }),
    makeResult({ customerId: 'b', reason: 'otp_timeout', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
  ];
  const report = buildReport({ seed: 7, results });
  const summary = formatSummary(report);
  assert.match(summary, /Recovered: 1/);
  assert.match(summary, /Unrecovered: 1/);
});
