const { RUNGS } = require('./escalation');

function emptyReasonBucket() {
  return { recovered: 0, unrecovered: 0 };
}

function buildReport({ seed, results, aiStrategyManifest = [], aiFallbackLog = [] }) {
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
    // Lets a reviewer see, per failure_reason, whether the run's intervention
    // choices came from a real LLM call or the deterministic fallback table —
    // never hidden, same honesty standard as the recovered/unrecovered split.
    ai_strategy_manifest: aiStrategyManifest,
    ai_fallback_log: aiFallbackLog,
    records: results.map((result) => ({
      customer_id: result.customer_id,
      failure_reason: result.failure_reason,
      outcome: result.outcome,
      recovered_at_rung: result.recovered_at_rung,
      attempts: result.attempts.length,
      source: result.payment_link ? 'live' : 'simulated',
      payment_link: result.payment_link ?? null,
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
  if (Array.isArray(report.ai_strategy_manifest) && report.ai_strategy_manifest.length > 0) {
    const llmCount = report.ai_strategy_manifest.filter((entry) => entry.source === 'llm').length;
    const fallbackCount = report.ai_strategy_manifest.length - llmCount;
    lines.push(
      `  AI diagnosis: ${llmCount}/${report.ai_strategy_manifest.length} failure reasons used a live LLM strategy` +
        (fallbackCount > 0 ? `, ${fallbackCount} fell back to the rule table.` : '.')
    );
  }
  const liveRecord = report.records.find((record) => record.source === 'live');
  if (liveRecord) {
    const shortUrl = liveRecord.payment_link ? liveRecord.payment_link.short_url : 'n/a';
    lines.push(`  Live Razorpay record: ${liveRecord.customer_id} (payment_link: ${shortUrl || 'n/a'})`);
  }
  return lines.join('\n');
}

module.exports = { buildReport, formatSummary };
