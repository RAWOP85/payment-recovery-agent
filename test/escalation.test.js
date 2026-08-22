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
