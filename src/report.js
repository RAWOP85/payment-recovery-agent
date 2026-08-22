const { RUNGS } = require('./escalation');

function emptyReasonBucket() {
  return { recovered: 0, unrecovered: 0 };
}

function buildReport({ seed, results }) {
  const totals = { processed: results.length, recovered: 0, unrecovered: 0 };
  const byFailureReason = {};
  const byRungRecovered = Object.fromEntries(RUNGS.map((day) => [day, 0]));

  for (const result of results) {
    const bucket = result.outcome === 'recovered' ? 'recovered' : 'unrecovered';
    totals[bucket] += 1;

    if (!byFailureReason[result.failure_reason]) {
      byFailureReason[result.failure_reason] = emptyReasonBucket();
    }
    byFailureReason[result.failure_reason][bucket] += 1;

    if (result.outcome === 'recovered') {
      byRungRecovered[result.recovered_at_rung] += 1;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    seed,
    totals,
    by_failure_reason: byFailureReason,
    by_rung_recovered: byRungRecovered,
    records: results.map((result) => ({
      customer_id: result.customer_id,
      failure_reason: result.failure_reason,
      outcome: result.outcome,
      recovered_at_rung: result.recovered_at_rung,
      attempts: result.attempts.length,
    })),
  };
}

function formatSummary(report) {
  const lines = [];
  lines.push('Payment Recovery Agent — run summary');
  lines.push(`  Processed: ${report.totals.processed}`);
  const rate = report.totals.processed === 0
    ? '0.0'
    : ((report.totals.recovered / report.totals.processed) * 100).toFixed(1);
  lines.push(`  Recovered: ${report.totals.recovered} (${rate}%)`);
  lines.push(`  Unrecovered: ${report.totals.unrecovered}`);
  lines.push('  By failure reason:');
  for (const [reason, counts] of Object.entries(report.by_failure_reason)) {
    lines.push(`    ${reason}: recovered=${counts.recovered} unrecovered=${counts.unrecovered}`);
  }
  lines.push('  Recovered at rung (day offset):');
  for (const [rung, count] of Object.entries(report.by_rung_recovered)) {
    lines.push(`    day ${rung}: ${count}`);
  }
  return lines.join('\n');
}

module.exports = { buildReport, formatSummary };
