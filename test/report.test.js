const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReport,
  formatSummary,
  summarizeStrategy,
  compareRecoverySpeed,
  buildComparisonReport,
  formatComparisonSummary,
} = require('../src/report');

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

test('buildReport labels a record carrying payment_link as source "live" and preserves the link', () => {
  const liveResult = {
    ...makeResult({ customerId: 'demo_live_001', reason: 'checkout_abandoned', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 1 }),
    payment_link: { id: 'plink_123', short_url: 'https://rzp.io/i/abc123' },
  };
  const simulatedResult = makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 });

  const report = buildReport({ seed: 99, results: [liveResult, simulatedResult] });

  const liveRecord = report.records.find((r) => r.customer_id === 'demo_live_001');
  const simulatedRecord = report.records.find((r) => r.customer_id === 'a');

  assert.equal(liveRecord.source, 'live');
  assert.deepEqual(liveRecord.payment_link, { id: 'plink_123', short_url: 'https://rzp.io/i/abc123' });

  assert.equal(simulatedRecord.source, 'simulated');
  assert.equal(simulatedRecord.payment_link, null);
});

test('formatSummary notes the live record when one is present in the report', () => {
  const liveResult = {
    ...makeResult({ customerId: 'demo_live_001', reason: 'checkout_abandoned', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 1 }),
    payment_link: { id: 'plink_123', short_url: 'https://rzp.io/i/abc123' },
  };
  const report = buildReport({ seed: 99, results: [liveResult] });
  const summary = formatSummary(report);
  assert.match(summary, /Live Razorpay record: demo_live_001/);
  assert.match(summary, /https:\/\/rzp\.io\/i\/abc123/);
});

test('formatSummary omits the live-record line when no record has source "live"', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 }),
  ];
  const report = buildReport({ seed: 7, results });
  const summary = formatSummary(report);
  assert.doesNotMatch(summary, /Live Razorpay record/);
});

test('buildReport defaults ai_strategy_manifest and ai_fallback_log to empty arrays when omitted', () => {
  const results = [makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 })];
  const report = buildReport({ seed: 7, results });
  assert.deepEqual(report.ai_strategy_manifest, []);
  assert.deepEqual(report.ai_fallback_log, []);
});

test('buildReport embeds the AI strategy manifest and formatSummary reports the llm-vs-fallback split honestly', () => {
  const results = [makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 })];
  const aiStrategyManifest = [
    { failure_reason: 'otp_timeout', source: 'llm', intervention: 'sms_nudge' },
    { failure_reason: 'card_declined', source: 'fallback_table', intervention: 'email_reminder' },
  ];
  const report = buildReport({ seed: 7, results, aiStrategyManifest });
  assert.deepEqual(report.ai_strategy_manifest, aiStrategyManifest);
  const summary = formatSummary(report);
  assert.match(summary, /AI diagnosis: 1\/2 failure reasons used a live LLM strategy, 1 fell back to the rule table\./);
});

// --- baseline-vs-AI comparison (scripts/run-evaluation.js) -----------------

function makeStratResult({ outcome, amount }) {
  return { outcome, amount };
}

test('summarizeStrategy computes case and value recovery rates', () => {
  const results = [
    makeStratResult({ outcome: 'recovered', amount: 10000 }),
    makeStratResult({ outcome: 'unrecovered', amount: 30000 }),
    makeStratResult({ outcome: 'recovered', amount: 60000 }),
  ];
  const summary = summarizeStrategy(results);
  assert.equal(summary.total_cases, 3);
  assert.equal(summary.recovered_cases, 2);
  assert.equal(summary.unrecovered_cases, 1);
  assert.equal(summary.case_recovery_rate, 0.6667);
  assert.equal(summary.total_value_paise, 100000);
  assert.equal(summary.recovered_value_paise, 70000);
  assert.equal(summary.value_recovery_rate, 0.7);
});

test('summarizeStrategy handles an empty result set without dividing by zero', () => {
  const summary = summarizeStrategy([]);
  assert.equal(summary.total_cases, 0);
  assert.equal(summary.case_recovery_rate, 0);
  assert.equal(summary.value_recovery_rate, 0);
});

test('buildComparisonReport labels the output as synthetic and computes an unclamped delta', () => {
  const baselineResults = [
    makeStratResult({ outcome: 'unrecovered', amount: 100000 }),
    makeStratResult({ outcome: 'unrecovered', amount: 100000 }),
  ];
  const aiResults = [
    makeStratResult({ outcome: 'recovered', amount: 100000 }),
    makeStratResult({ outcome: 'unrecovered', amount: 100000 }),
  ];
  const comparison = buildComparisonReport({ seed: 42, baselineResults, aiResults });

  assert.equal(comparison.seed, 42);
  assert.match(comparison.label, /synthetic/i);
  assert.match(comparison.label, /not real customer statistics/i);
  assert.equal(comparison.baseline.recovered_cases, 0);
  assert.equal(comparison.ai.recovered_cases, 1);
  assert.equal(comparison.delta.recovered_cases, 1);
  assert.equal(comparison.delta.recovered_value_paise, 100000);
});

test('buildComparisonReport reports a negative delta honestly when AI does worse than baseline', () => {
  const baselineResults = [makeStratResult({ outcome: 'recovered', amount: 100000 })];
  const aiResults = [makeStratResult({ outcome: 'unrecovered', amount: 100000 })];
  const comparison = buildComparisonReport({ seed: 1, baselineResults, aiResults });
  assert.equal(comparison.delta.recovered_cases, -1);
  assert.ok(comparison.delta.recovered_value_paise < 0);
});

test('formatComparisonSummary prints both arms and a signed delta', () => {
  const baselineResults = [makeStratResult({ outcome: 'unrecovered', amount: 100000 })];
  const aiResults = [makeStratResult({ outcome: 'recovered', amount: 100000 })];
  const comparison = buildComparisonReport({ seed: 5, baselineResults, aiResults });
  const summary = formatComparisonSummary(comparison);
  assert.match(summary, /Baseline:/);
  assert.match(summary, /AI:/);
  assert.match(summary, /Delta:\s+\+1 cases/);
});

// --- recovery speed (same outcome, fewer/more attempts) --------------------

function makeAttemptsResult(customerId, outcome, attemptCount) {
  return { customer_id: customerId, outcome, attempts: new Array(attemptCount).fill({}) };
}

test('summarizeStrategy computes avg_attempts_when_recovered only over results carrying attempts data', () => {
  const results = [
    makeAttemptsResult('a', 'recovered', 1),
    makeAttemptsResult('b', 'recovered', 3),
    makeAttemptsResult('c', 'unrecovered', 4),
  ];
  const summary = summarizeStrategy(results);
  assert.equal(summary.avg_attempts_when_recovered, 2);
});

test('summarizeStrategy reports avg_attempts_when_recovered as null when no result carries attempts data', () => {
  const summary = summarizeStrategy([makeStratResult({ outcome: 'recovered', amount: 100000 })]);
  assert.equal(summary.avg_attempts_when_recovered, null);
});

test('compareRecoverySpeed counts a same-outcome record as faster when AI uses fewer attempts', () => {
  const baselineResults = [makeAttemptsResult('cust_1', 'recovered', 3)];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 2)];
  const speed = compareRecoverySpeed(baselineResults, aiResults);
  assert.equal(speed.faster_recovery_cases, 1);
  assert.equal(speed.slower_recovery_cases, 0);
  assert.equal(speed.same_speed_recovery_cases, 0);
});

test('compareRecoverySpeed counts a same-outcome record as slower when AI uses more attempts', () => {
  const baselineResults = [makeAttemptsResult('cust_1', 'recovered', 2)];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 3)];
  const speed = compareRecoverySpeed(baselineResults, aiResults);
  assert.equal(speed.faster_recovery_cases, 0);
  assert.equal(speed.slower_recovery_cases, 1);
});

test('compareRecoverySpeed excludes records not recovered in both arms', () => {
  const baselineResults = [makeAttemptsResult('cust_1', 'unrecovered', 4)];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 2)];
  const speed = compareRecoverySpeed(baselineResults, aiResults);
  assert.equal(speed.faster_recovery_cases, 0);
  assert.equal(speed.slower_recovery_cases, 0);
  assert.equal(speed.same_speed_recovery_cases, 0);
});

test('compareRecoverySpeed matches by customer_id, not array position', () => {
  const baselineResults = [
    makeAttemptsResult('cust_2', 'recovered', 4),
    makeAttemptsResult('cust_1', 'recovered', 3),
  ];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 1)];
  const speed = compareRecoverySpeed(baselineResults, aiResults);
  assert.equal(speed.faster_recovery_cases, 1);
});

test('buildComparisonReport embeds recovery_speed alongside the case/value delta', () => {
  const baselineResults = [makeAttemptsResult('cust_1', 'recovered', 3)];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 2)];
  const comparison = buildComparisonReport({ seed: 1, baselineResults, aiResults });
  assert.deepEqual(comparison.recovery_speed, {
    faster_recovery_cases: 1,
    slower_recovery_cases: 0,
    same_speed_recovery_cases: 0,
  });
});

test('formatComparisonSummary reports recovery speed', () => {
  const baselineResults = [makeAttemptsResult('cust_1', 'recovered', 3)];
  const aiResults = [makeAttemptsResult('cust_1', 'recovered', 2)];
  const comparison = buildComparisonReport({ seed: 1, baselineResults, aiResults });
  const summary = formatComparisonSummary(comparison);
  assert.match(summary, /Recovery speed.*1 faster with AI, 0 slower, 0 same speed/);
});
