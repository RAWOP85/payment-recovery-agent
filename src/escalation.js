const { decideOutcome } = require('./recovery-simulator');
const { diagnose } = require('./recovery-agent');
const { decide: decidePolicy } = require('./policy-engine');

const RUNGS = [0, 2, 5, 7]; // day offsets from failed_at — the hard stop is structural
const DAY_MS = 24 * 60 * 60 * 1000;

// The 'baseline' arm for the evaluation script (scripts/run-evaluation.js):
// no diagnose()/decidePolicy() call at all, every rung sent as a plain
// sms_nudge. This reproduces the pre-AI-layer probability model exactly
// (INTERVENTION_MULTIPLIER.sms_nudge === 1.0), so the baseline-vs-AI delta
// measures the intervention choice alone, not a strawman.
const BASELINE_INTERVENTION = 'sms_nudge';
const BASELINE_AI_OUTPUT = {
  diagnosis: 'baseline_no_diagnosis',
  intervention: BASELINE_INTERVENTION,
  urgency: 'medium',
  confidence: 1,
  reason: 'Baseline arm: fixed sms_nudge on every rung, no AI diagnosis performed.',
  source: 'baseline_rule',
};
const BASELINE_POLICY = {
  executed_intervention: BASELINE_INTERVENTION,
  policy_decision: 'allowed',
  policy_reason: 'Baseline strategy — AI diagnosis and policy gating bypassed by design; fixed sms_nudge used on every rung.',
};

function simulatedTimestamp(failedAt, dayOffset) {
  return new Date(new Date(failedAt).getTime() + dayOffset * DAY_MS).toISOString();
}

function actionFor(rungIndex, outcome) {
  if (outcome === 'recovered') return 'recover';
  return rungIndex === RUNGS.length - 1 ? 'exhaust' : 'escalate';
}

// `aiContext` is optional and appended, never substituted, so the base ladder
// narrative stays byte-identical for every existing caller (live-recovery.js
// calls this with exactly 3 args, and so do the pre-existing unit tests) —
// only escalation.js's own loop, which has an AI decision to report, passes it.
function buildReason(record, rungIndex, outcome, aiContext) {
  const day = RUNGS[rungIndex];
  const isLastRung = rungIndex === RUNGS.length - 1;
  let base;

  if (outcome === 'recovered') {
    base = `Day ${day}: customer completed payment after nudge — recovered, stopping ladder.`;
  } else if (rungIndex === 0) {
    base = `Day 0: initial recovery nudge sent for ${record.failure_reason} failure.`;
  } else if (isLastRung) {
    base = `Day ${day}: final reminder sent, no response after ${RUNGS.length} attempts — exhausting ladder per hard stop rule, marking unrecovered.`;
  } else {
    base = `Day ${day}: no response to previous nudge(s) — escalating to reminder tier ${rungIndex + 1}.`;
  }

  if (!aiContext) return base;
  const { aiOutput, policy } = aiContext;
  // aiOutput.reason carries the record-level "why" (high-value re-diagnosis,
  // confidence decay, expensive-intervention withholding, etc.) computed by
  // recovery-agent.js's applyRecordContext(). Without it, the audit trail shows
  // WHAT was decided (diagnosis label, policy outcome) but not WHY — which
  // defeats the project's own audit-trail requirement. Guarded because test
  // fixtures may hand buildReason a minimal aiOutput without a `reason` field.
  const why = aiOutput.reason ? ` ${aiOutput.reason}` : '';
  return `${base} AI diagnosis: ${aiOutput.diagnosis} (source: ${aiOutput.source}, confidence: ${aiOutput.confidence})${why} — ${policy.policy_reason}`;
}

// Per rung: ask the diagnosis layer which intervention fits this failure mode,
// let policy-engine gate that recommendation, then feed the APPROVED
// intervention (never the raw AI one) into the outcome simulator. Timing
// (which rung, whether to keep going) stays entirely outside this exchange —
// the AI and policy layer only ever choose WHICH nudge, per the project's
// hard-stop and "no infinite retrying" constraints.
function processRecord(record, rng, { strategy = 'ai' } = {}) {
  const attempts = [];
  let outcome = 'unrecovered';
  let recoveredAtRung = null;
  const priorOutcomes = [];

  for (let rungIndex = 0; rungIndex < RUNGS.length; rungIndex++) {
    const dayOffset = RUNGS[rungIndex];

    let aiOutput;
    let policy;
    if (strategy === 'baseline') {
      aiOutput = BASELINE_AI_OUTPUT;
      policy = BASELINE_POLICY;
    } else {
      aiOutput = diagnose({
        failureReason: record.failure_reason,
        amount: record.amount,
        rungIndex,
        dayOffset,
        priorOutcomes,
      });

      policy = decidePolicy({
        aiOutput,
        rungIndex,
        rungCount: RUNGS.length,
        recovered: false, // this rung's outcome isn't known yet — that's what we're about to decide
      });
    }

    const attemptOutcome = decideOutcome({
      failureReason: record.failure_reason,
      rungIndex,
      intervention: policy.executed_intervention,
      rng,
    });

    attempts.push({
      timestamp: simulatedTimestamp(record.failed_at, dayOffset),
      customer_id: record.customer_id,
      rung: dayOffset,
      day_offset: dayOffset,
      action: actionFor(rungIndex, attemptOutcome),
      reason: buildReason(record, rungIndex, attemptOutcome, { aiOutput, policy }),
      outcome: attemptOutcome,
      diagnosis: aiOutput.diagnosis,
      ai_source: aiOutput.source,
      confidence: aiOutput.confidence,
      urgency: aiOutput.urgency,
      intervention: policy.executed_intervention,
      policy_decision: policy.policy_decision,
      policy_reason: policy.policy_reason,
    });

    priorOutcomes.push(attemptOutcome);

    if (attemptOutcome === 'recovered') {
      outcome = 'recovered';
      recoveredAtRung = dayOffset;
      break;
    }
  }

  return {
    customer_id: record.customer_id,
    failure_reason: record.failure_reason,
    outcome,
    recovered_at_rung: recoveredAtRung,
    attempts,
  };
}

module.exports = { RUNGS, simulatedTimestamp, buildReason, actionFor, processRecord };
