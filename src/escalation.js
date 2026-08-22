const { decideOutcome } = require('./recovery-simulator');

const RUNGS = [0, 2, 5, 7]; // day offsets from failed_at — the hard stop is structural
const DAY_MS = 24 * 60 * 60 * 1000;

function simulatedTimestamp(failedAt, dayOffset) {
  return new Date(new Date(failedAt).getTime() + dayOffset * DAY_MS).toISOString();
}

function actionFor(rungIndex, outcome) {
  if (outcome === 'recovered') return 'recover';
  return rungIndex === RUNGS.length - 1 ? 'exhaust' : 'escalate';
}

function buildReason(record, rungIndex, outcome) {
  const day = RUNGS[rungIndex];
  const isLastRung = rungIndex === RUNGS.length - 1;

  if (outcome === 'recovered') {
    return `Day ${day}: customer completed payment after nudge — recovered, stopping ladder.`;
  }
  if (rungIndex === 0) {
    return `Day 0: initial recovery nudge sent for ${record.failure_reason} failure.`;
  }
  if (isLastRung) {
    return `Day ${day}: final reminder sent, no response after ${RUNGS.length} attempts — exhausting ladder per hard stop rule, marking unrecovered.`;
  }
  return `Day ${day}: no response to previous nudge(s) — escalating to reminder tier ${rungIndex + 1}.`;
}

function processRecord(record, rng) {
  const attempts = [];
  let outcome = 'unrecovered';
  let recoveredAtRung = null;

  for (let rungIndex = 0; rungIndex < RUNGS.length; rungIndex++) {
    const dayOffset = RUNGS[rungIndex];
    const attemptOutcome = decideOutcome({
      failureReason: record.failure_reason,
      rungIndex,
      rng,
    });

    attempts.push({
      timestamp: simulatedTimestamp(record.failed_at, dayOffset),
      customer_id: record.customer_id,
      rung: dayOffset,
      day_offset: dayOffset,
      action: actionFor(rungIndex, attemptOutcome),
      reason: buildReason(record, rungIndex, attemptOutcome),
      outcome: attemptOutcome,
    });

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
