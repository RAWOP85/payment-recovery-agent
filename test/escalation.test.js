const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RUNGS, simulatedTimestamp, actionFor, buildReason, processRecord } = require('../src/escalation');

const RECORD = {
  customer_id: 'cust_test_001',
  amount: 50000,
  failure_reason: 'checkout_abandoned',
  failed_at: '2026-08-01T00:00:00.000Z',
};

test('RUNGS is the fixed Day 0/2/5/7 ladder', () => {
  assert.deepEqual(RUNGS, [0, 2, 5, 7]);
});

test('simulatedTimestamp adds the day offset in milliseconds', () => {
  assert.equal(simulatedTimestamp('2026-08-01T00:00:00.000Z', 2), '2026-08-03T00:00:00.000Z');
  assert.equal(simulatedTimestamp('2026-08-01T00:00:00.000Z', 7), '2026-08-08T00:00:00.000Z');
});

test('actionFor recovers regardless of rung, escalates mid-ladder, exhausts on the last rung', () => {
  assert.equal(actionFor(0, 'recovered'), 'recover');
  assert.equal(actionFor(3, 'recovered'), 'recover');
  assert.equal(actionFor(0, 'no_response'), 'escalate');
  assert.equal(actionFor(RUNGS.length - 1, 'no_response'), 'exhaust');
});

test('buildReason names the failure reason on the first rung', () => {
  const reason = buildReason(RECORD, 0, 'no_response');
  assert.match(reason, /Day 0/);
  assert.match(reason, /checkout_abandoned/);
});

test('buildReason explains the hard stop on the last rung', () => {
  const reason = buildReason(RECORD, RUNGS.length - 1, 'no_response');
  assert.match(reason, /Day 7/);
  assert.match(reason, /hard stop/);
});

test('processRecord stops at the first rung when the simulated outcome is recovery', () => {
  const alwaysRecover = () => 0; // 0 < any positive probability => recovered
  const result = processRecord(RECORD, alwaysRecover);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.recovered_at_rung, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].action, 'recover');
});

test('processRecord exhausts all four rungs when the customer never responds', () => {
  const neverRecover = () => 0.99; // above every reason's max possible probability
  const result = processRecord(RECORD, neverRecover);
  assert.equal(result.outcome, 'unrecovered');
  assert.equal(result.recovered_at_rung, null);
  assert.equal(result.attempts.length, 4);
  assert.equal(result.attempts[3].action, 'exhaust');
  assert.equal(result.attempts[3].rung, 7);
});

test('processRecord carries failure_reason through for downstream aggregation', () => {
  const result = processRecord(RECORD, () => 0.99);
  assert.equal(result.failure_reason, 'checkout_abandoned');
});

// --- AI diagnosis + policy-engine wiring -----------------------------------
// These run against a cold recovery-agent cache (no warmStrategyCache call in
// this file), so every diagnosis comes from FALLBACK_STRATEGY — deterministic,
// no network, and exactly what a plain `npm test` sees.

test('processRecord attaches an AI diagnosis and an approved intervention to every attempt', () => {
  const result = processRecord(RECORD, () => 0.99); // never recovers -> all 4 rungs
  for (const attempt of result.attempts) {
    assert.equal(typeof attempt.diagnosis, 'string');
    assert.ok(attempt.diagnosis.length > 0);
    assert.equal(attempt.ai_source, 'fallback_table');
    assert.ok(['sms_nudge', 'email_reminder', 'discount_incentive', 'personal_call_offer'].includes(attempt.intervention));
    assert.ok(['allowed', 'overridden', 'blocked'].includes(attempt.policy_decision));
    assert.equal(typeof attempt.policy_reason, 'string');
  }
});

test('a high-value record is re-diagnosed and escalated to personal_call_offer once policy allows it', () => {
  // otp_timeout starts at confidence 0.8 (vs. checkout_abandoned's 0.65), so at
  // rung 2 (Day 5, the first rung where an expensive intervention isn't
  // withheld) two prior no_responses have only decayed it to 0.8 - 2*0.15 =
  // 0.50 — exactly at the policy threshold, so it clears rather than being
  // overridden. This is the one rung where both gates open at once.
  const highValueRecord = { ...RECORD, amount: 500000, failure_reason: 'otp_timeout' };
  const result = processRecord(highValueRecord, () => 0.99); // never recovers -> all 4 rungs
  const day5Attempt = result.attempts[2];
  assert.equal(day5Attempt.diagnosis, 'high_value_at_risk');
  assert.equal(day5Attempt.intervention, 'personal_call_offer');
  assert.equal(day5Attempt.policy_decision, 'allowed');
});

test('an expensive intervention is withheld on early rungs regardless of what the AI recommends', () => {
  const highValueRecord = { ...RECORD, amount: 500000 };
  const result = processRecord(highValueRecord, () => 0.99);
  // Day 0 (rungIndex 0) is before ESCALATION_RUNG_INDEX (2) — personal_call_offer
  // must not fire yet, however high-value the diagnosis, per the project's own
  // no-premature-spend rule in recovery-agent.js.
  assert.equal(result.attempts[0].intervention, 'sms_nudge');
});

test("buildReason's base ladder text is unchanged when no aiContext is passed (back-compat for live-recovery.js)", () => {
  const withoutAi = buildReason(RECORD, 0, 'no_response');
  assert.match(withoutAi, /Day 0/);
  assert.match(withoutAi, /checkout_abandoned/);
  assert.doesNotMatch(withoutAi, /AI diagnosis/);
});

test('buildReason appends the AI diagnosis and policy reason when aiContext is passed', () => {
  const aiContext = {
    aiOutput: { diagnosis: 'attention_lapse', source: 'fallback_table', confidence: 0.65 },
    policy: { policy_decision: 'allowed', policy_reason: 'Confidence 0.65 meets the 0.5 threshold.' },
  };
  const withAi = buildReason(RECORD, 0, 'no_response', aiContext);
  assert.match(withAi, /Day 0/);
  assert.match(withAi, /AI diagnosis: attention_lapse/);
  assert.match(withAi, /Confidence 0\.65 meets the 0\.5 threshold\./);
});
