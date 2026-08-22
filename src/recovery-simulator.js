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

function decideOutcome({ failureReason, rungIndex, rng }) {
  const base = BASE_RECOVERY_PROBABILITY[failureReason];
  if (base === undefined) {
    throw new Error(`Unknown failure_reason: ${failureReason}`);
  }
  const decay = RUNG_DECAY[rungIndex];
  if (decay === undefined) {
    throw new Error(`Unknown rungIndex: ${rungIndex}`);
  }
  const probability = base * decay;
  return rng() < probability ? 'recovered' : 'no_response';
}

module.exports = { createRng, decideOutcome, BASE_RECOVERY_PROBABILITY, RUNG_DECAY };
