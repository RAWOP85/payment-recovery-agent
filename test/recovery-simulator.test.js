const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRng,
  deriveSeed,
  decideOutcome,
  BASE_RECOVERY_PROBABILITY,
  RUNG_DECAY,
  INTERVENTION_MULTIPLIER,
  MAX_RECOVERY_PROBABILITY,
} = require('../src/recovery-simulator');

test('createRng is deterministic for the same seed', () => {
  const rngA = createRng(42);
  const rngB = createRng(42);
  const sequenceA = [rngA(), rngA(), rngA()];
  const sequenceB = [rngB(), rngB(), rngB()];
  assert.deepEqual(sequenceA, sequenceB);
});

test('createRng produces values in [0, 1)', () => {
  const rng = createRng(1);
  for (let i = 0; i < 100; i++) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `value ${value} out of range`);
  }
});

test('decideOutcome returns recovered when rng falls below the probability threshold', () => {
  const probability = BASE_RECOVERY_PROBABILITY.checkout_abandoned * RUNG_DECAY[0];
  const rng = () => probability - 0.001;
  const outcome = decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 0, rng });
  assert.equal(outcome, 'recovered');
});

test('decideOutcome returns no_response when rng is at or above the probability threshold', () => {
  const probability = BASE_RECOVERY_PROBABILITY.checkout_abandoned * RUNG_DECAY[0];
  const rng = () => probability + 0.001;
  const outcome = decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 0, rng });
  assert.equal(outcome, 'no_response');
});

test('decideOutcome throws on an unknown failure_reason', () => {
  assert.throws(
    () => decideOutcome({ failureReason: 'bogus_reason', rungIndex: 0, rng: () => 0 }),
    /Unknown failure_reason/
  );
});

test('decideOutcome throws on an unknown rungIndex', () => {
  assert.throws(
    () => decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 4, rng: () => 0 }),
    /Unknown rungIndex/
  );
});

test('omitting intervention reproduces the original sms_nudge probability exactly', () => {
  const probability = BASE_RECOVERY_PROBABILITY.checkout_abandoned * RUNG_DECAY[1];
  const justBelow = () => probability - 1e-9;
  const justAbove = () => probability + 1e-9;

  assert.equal(
    decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 1, rng: justBelow }),
    'recovered'
  );
  assert.equal(
    decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 1, rng: justAbove }),
    'no_response'
  );
  assert.equal(INTERVENTION_MULTIPLIER.sms_nudge, 1.0);
});

test('a stronger intervention raises the recovery probability by its multiplier', () => {
  const base = BASE_RECOVERY_PROBABILITY.card_declined * RUNG_DECAY[0];
  const boosted = base * INTERVENTION_MULTIPLIER.personal_call_offer;
  // An rng value between the two thresholds recovers only with the stronger nudge.
  const between = () => (base + boosted) / 2;

  assert.equal(
    decideOutcome({ failureReason: 'card_declined', rungIndex: 0, intervention: 'sms_nudge', rng: between }),
    'no_response'
  );
  assert.equal(
    decideOutcome({
      failureReason: 'card_declined',
      rungIndex: 0,
      intervention: 'personal_call_offer',
      rng: between,
    }),
    'recovered'
  );
});

test('decideOutcome throws on an unknown intervention, after the existing checks', () => {
  assert.throws(
    () =>
      decideOutcome({
        failureReason: 'checkout_abandoned',
        rungIndex: 0,
        intervention: 'skywriting',
        rng: () => 0,
      }),
    /Unknown intervention/
  );
  // Reason and rung are still validated first, so throw ordering is unchanged.
  assert.throws(
    () => decideOutcome({ failureReason: 'bogus', rungIndex: 0, intervention: 'skywriting', rng: () => 0 }),
    /Unknown failure_reason/
  );
});

test('no combination of reason, rung and intervention implies certain recovery', () => {
  for (const failureReason of Object.keys(BASE_RECOVERY_PROBABILITY)) {
    for (let rungIndex = 0; rungIndex < RUNG_DECAY.length; rungIndex++) {
      for (const intervention of Object.keys(INTERVENTION_MULTIPLIER)) {
        const atCap = () => MAX_RECOVERY_PROBABILITY;
        assert.equal(
          decideOutcome({ failureReason, rungIndex, intervention, rng: atCap }),
          'no_response',
          `${failureReason}/${rungIndex}/${intervention} exceeded the probability cap`
        );
      }
    }
  }
});

test('deriveSeed is deterministic and separates keys', () => {
  assert.equal(deriveSeed(42, 'cust_0001'), deriveSeed(42, 'cust_0001'));
  assert.notEqual(deriveSeed(42, 'cust_0001'), deriveSeed(42, 'cust_0002'));
  assert.notEqual(deriveSeed(42, 'cust_0001'), deriveSeed(43, 'cust_0001'));
});

test('deriveSeed returns a usable unsigned 32-bit seed', () => {
  for (const key of ['cust_0001', 'demo_live_001', '']) {
    const seed = deriveSeed(42, key);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, `bad seed ${seed}`);
    const value = createRng(seed)();
    assert.ok(value >= 0 && value < 1);
  }
});
