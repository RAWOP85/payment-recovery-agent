const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRng,
  decideOutcome,
  BASE_RECOVERY_PROBABILITY,
  RUNG_DECAY,
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
