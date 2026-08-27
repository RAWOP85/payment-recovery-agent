const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, CONFIDENCE_THRESHOLD } = require('../src/policy-engine');
const { DEFAULT_INTERVENTION } = require('../src/recovery-agent');

const RUNG_COUNT = 4;

function aiOutput(overrides = {}) {
  return {
    diagnosis: 'price_sensitive',
    intervention: 'discount_incentive',
    urgency: 'medium',
    confidence: 0.8,
    reason: 'A plausible rationale.',
    ...overrides,
  };
}

test('a confident, whitelisted recommendation is allowed through unchanged', () => {
  const result = decide({ aiOutput: aiOutput(), rungIndex: 2, rungCount: RUNG_COUNT });
  assert.equal(result.policy_decision, 'allowed');
  assert.equal(result.executed_intervention, 'discount_incentive');
  assert.match(result.policy_reason, /whitelisted/);
});

test('an intervention outside the whitelist is overridden, not executed', () => {
  const result = decide({
    aiOutput: aiOutput({ intervention: 'wire_transfer_the_customer' }),
    rungIndex: 0,
    rungCount: RUNG_COUNT,
  });
  assert.equal(result.policy_decision, 'overridden');
  assert.equal(result.executed_intervention, DEFAULT_INTERVENTION);
  assert.match(result.policy_reason, /not on the approved whitelist/);
});

test('a missing or malformed intervention field is overridden rather than crashing', () => {
  for (const intervention of [undefined, null, 42, '', {}]) {
    const result = decide({
      aiOutput: aiOutput({ intervention }),
      rungIndex: 0,
      rungCount: RUNG_COUNT,
    });
    assert.equal(result.policy_decision, 'overridden');
    assert.equal(result.executed_intervention, DEFAULT_INTERVENTION);
  }
});

test('an entirely missing aiOutput is overridden rather than crashing', () => {
  for (const missing of [undefined, null]) {
    const result = decide({ aiOutput: missing, rungIndex: 0, rungCount: RUNG_COUNT });
    assert.equal(result.policy_decision, 'overridden');
    assert.equal(result.executed_intervention, DEFAULT_INTERVENTION);
  }
});

test('confidence below the threshold falls back to the cheapest nudge', () => {
  const result = decide({
    aiOutput: aiOutput({ confidence: CONFIDENCE_THRESHOLD - 0.01 }),
    rungIndex: 3,
    rungCount: RUNG_COUNT,
  });
  assert.equal(result.policy_decision, 'overridden');
  assert.equal(result.executed_intervention, DEFAULT_INTERVENTION);
  assert.match(result.policy_reason, /below the 0.5 threshold/);
});

test('confidence exactly at the threshold is allowed', () => {
  const result = decide({
    aiOutput: aiOutput({ confidence: CONFIDENCE_THRESHOLD }),
    rungIndex: 3,
    rungCount: RUNG_COUNT,
  });
  assert.equal(result.policy_decision, 'allowed');
});

test('a non-numeric confidence is overridden', () => {
  for (const confidence of [undefined, null, 'high', NaN]) {
    const result = decide({
      aiOutput: aiOutput({ confidence }),
      rungIndex: 1,
      rungCount: RUNG_COUNT,
    });
    assert.equal(result.policy_decision, 'overridden');
  }
});

test('an already-recovered record blocks all further outreach', () => {
  const result = decide({
    aiOutput: aiOutput(),
    rungIndex: 1,
    rungCount: RUNG_COUNT,
    recovered: true,
  });
  assert.equal(result.policy_decision, 'blocked');
  assert.equal(result.executed_intervention, 'none');
  assert.match(result.policy_reason, /duplicate-action prevention/);
});

test('a rung outside the hard-stop ladder throws', () => {
  for (const rungIndex of [-1, RUNG_COUNT, RUNG_COUNT + 10, 1.5, '2', undefined]) {
    assert.throws(
      () => decide({ aiOutput: aiOutput(), rungIndex, rungCount: RUNG_COUNT }),
      /outside the hard-stop ladder/,
      `rungIndex ${rungIndex} should have been rejected`
    );
  }
});

test('every rung inside the ladder is accepted', () => {
  for (let rungIndex = 0; rungIndex < RUNG_COUNT; rungIndex++) {
    assert.doesNotThrow(() => decide({ aiOutput: aiOutput(), rungIndex, rungCount: RUNG_COUNT }));
  }
});

test('the policy result can never carry a timing field', () => {
  // Structural guarantee: the AI/policy layer chooses which intervention, never
  // when it is sent or whether the ladder continues.
  const results = [
    decide({ aiOutput: aiOutput(), rungIndex: 0, rungCount: RUNG_COUNT }),
    decide({ aiOutput: aiOutput({ intervention: 'nope' }), rungIndex: 0, rungCount: RUNG_COUNT }),
    decide({ aiOutput: aiOutput(), rungIndex: 0, rungCount: RUNG_COUNT, recovered: true }),
  ];
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), [
      'executed_intervention',
      'policy_decision',
      'policy_reason',
    ]);
  }
});
