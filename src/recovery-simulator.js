// Base per-nudge recovery probability by failure_reason, tapered per rung by
// RUNG_DECAY to model diminishing returns on repeated reminders.
const BASE_RECOVERY_PROBABILITY = {
  checkout_abandoned: 0.35,
  otp_timeout: 0.3,
  card_declined: 0.18,
  insufficient_funds: 0.12,
};

// Index-aligned to rung position (0 = Day 0, 1 = Day 2, 2 = Day 5, 3 = Day 7).
const RUNG_DECAY = [1.0, 0.85, 0.7, 0.55];

// How much more likely each intervention is to land than a plain SMS nudge.
// sms_nudge is exactly 1.0 so that omitting `intervention` reproduces the
// original formula byte-for-byte — that is what keeps the pre-existing tests
// meaningful rather than merely passing.
const INTERVENTION_MULTIPLIER = {
  sms_nudge: 1.0,
  email_reminder: 1.05,
  discount_incentive: 1.2,
  personal_call_offer: 1.35,
};

// No intervention makes recovery a certainty. Caps the compounded probability
// so a generous multiplier can never imply a guaranteed save.
const MAX_RECOVERY_PROBABILITY = 0.95;

// mulberry32 — small, dependency-free, seedable PRNG.
function createRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derives an independent, reproducible seed per key (FNV-1a). Lets the
// baseline-vs-AI evaluation give each customer its own RNG stream, so the
// measured delta reflects the intervention choice alone rather than drift
// between two runs sharing one sequential generator.
function deriveSeed(seed, key) {
  let hash = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  const text = String(key);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function decideOutcome({ failureReason, rungIndex, intervention = 'sms_nudge', rng }) {
  const base = BASE_RECOVERY_PROBABILITY[failureReason];
  if (base === undefined) {
    throw new Error(`Unknown failure_reason: ${failureReason}`);
  }
  const decay = RUNG_DECAY[rungIndex];
  if (decay === undefined) {
    throw new Error(`Unknown rungIndex: ${rungIndex}`);
  }
  // Checked last so the pre-existing throw ordering is unchanged.
  const multiplier = INTERVENTION_MULTIPLIER[intervention];
  if (multiplier === undefined) {
    throw new Error(`Unknown intervention: ${intervention}`);
  }
  const probability = Math.min(MAX_RECOVERY_PROBABILITY, base * decay * multiplier);
  return rng() < probability ? 'recovered' : 'no_response';
}

module.exports = {
  createRng,
  deriveSeed,
  decideOutcome,
  BASE_RECOVERY_PROBABILITY,
  RUNG_DECAY,
  INTERVENTION_MULTIPLIER,
  MAX_RECOVERY_PROBABILITY,
};
