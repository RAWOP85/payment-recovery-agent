// The safety gate between what the AI recommends and what the system actually does.
//
// This is the second of two independent checks on model output. The first
// (`validateStrategy` in recovery-agent.js) asks "is this well-formed?" at the
// trust boundary. This one asks "is this *allowed*?" — a policy question, not a
// parsing one. With a real LLM behind diagnose(), that separation is
// load-bearing rather than decorative.
//
// Note what this function CANNOT return: there is no rung, day_offset, or
// timing field in its output shape. Structurally, the AI/policy layer chooses
// only which intervention to send — never when, never how many times, and never
// whether the ladder keeps going. The hard stop is not something policy can
// negotiate with.

const { INTERVENTIONS, DEFAULT_INTERVENTION } = require('./recovery-agent');

const CONFIDENCE_THRESHOLD = 0.5;

/**
 * @returns {{executed_intervention: string, policy_decision: 'allowed'|'overridden'|'blocked', policy_reason: string}}
 */
function decide({ aiOutput, rungIndex, rungCount, recovered = false } = {}) {
  // Duplicate-action prevention outranks everything else: never contact a
  // customer who has already paid, whatever the model suggests.
  if (recovered) {
    return {
      executed_intervention: 'none',
      policy_decision: 'blocked',
      policy_reason:
        'Record already recovered — blocking further outreach (duplicate-action prevention).',
    };
  }

  // Defensive hard-stop enforcement. escalation.js's loop already guarantees
  // this bound; asserting it here means a future caller cannot quietly escalate
  // past the ladder without tripping something loud.
  if (
    !Number.isInteger(rungIndex) ||
    !Number.isInteger(rungCount) ||
    rungCount <= 0 ||
    rungIndex < 0 ||
    rungIndex >= rungCount
  ) {
    throw new Error(
      `Policy violation: rungIndex ${rungIndex} is outside the hard-stop ladder [0, ${rungCount}).`
    );
  }

  const intervention =
    aiOutput && typeof aiOutput.intervention === 'string' ? aiOutput.intervention : null;
  if (!INTERVENTIONS.includes(intervention)) {
    return {
      executed_intervention: DEFAULT_INTERVENTION,
      policy_decision: 'overridden',
      policy_reason:
        `Recommended intervention ${JSON.stringify(intervention)} is not on the approved ` +
        `whitelist — overriding to ${DEFAULT_INTERVENTION}.`,
    };
  }

  const confidence = aiOutput && typeof aiOutput.confidence === 'number' ? aiOutput.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_THRESHOLD) {
    const shown = Number.isFinite(confidence) ? confidence.toFixed(2) : 'missing';
    return {
      executed_intervention: DEFAULT_INTERVENTION,
      policy_decision: 'overridden',
      policy_reason:
        `Confidence ${shown} is below the ${CONFIDENCE_THRESHOLD} threshold — ` +
        `overriding to ${DEFAULT_INTERVENTION}.`,
    };
  }

  return {
    executed_intervention: intervention,
    policy_decision: 'allowed',
    policy_reason:
      `Confidence ${confidence.toFixed(2)} meets the ${CONFIDENCE_THRESHOLD} threshold and ` +
      `${intervention} is whitelisted — approved as recommended.`,
  };
}

module.exports = { decide, CONFIDENCE_THRESHOLD };
