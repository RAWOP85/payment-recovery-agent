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

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Case- and value-weighted recovery stats for one strategy arm (baseline or
// AI). `results` elements are processRecord() results merged with the
// originating record's `amount` (paise) by the caller — this module never
// reads data/failed-payments.json itself.
function summarizeStrategy(results) {
  const totalCases = results.length;
  let recoveredCases = 0;
  let totalValuePaise = 0;
  let recoveredValuePaise = 0;

  for (const result of results) {
    const amount = Number.isFinite(result.amount) ? result.amount : 0;
    totalValuePaise += amount;
    if (result.outcome === 'recovered') {
      recoveredCases += 1;
      recoveredValuePaise += amount;
    }
  }

  return {
    total_cases: totalCases,
    recovered_cases: recoveredCases,
    unrecovered_cases: totalCases - recoveredCases,
    case_recovery_rate: totalCases === 0 ? 0 : round4(recoveredCases / totalCases),
    total_value_paise: totalValuePaise,
    recovered_value_paise: recoveredValuePaise,
    value_recovery_rate: totalValuePaise === 0 ? 0 : round4(recoveredValuePaise / totalValuePaise),
  };
}

// `baselineResults` and `aiResults` must cover the same records with each
// record's RNG stream shared identically between the two arms (see
// deriveSeed() in recovery-simulator.js and scripts/run-evaluation.js) — that
// is what isolates `delta` to the intervention choice alone rather than RNG
// drift between two independent runs. `delta` is left unclamped so a
// worse-than-baseline AI result would show honestly, never hidden, matching
// this project's own no-cherry-picking requirement.
function buildComparisonReport({ seed, baselineResults, aiResults }) {
  const baseline = summarizeStrategy(baselineResults);
  const ai = summarizeStrategy(aiResults);

  return {
    generated_at: new Date().toISOString(),
    seed,
    label:
      'Synthetic/simulated comparison over the same seeded dataset — not real customer statistics. ' +
      'Baseline = fixed sms_nudge on every rung, no AI diagnosis. ' +
      'AI = per-failure-reason diagnosis (live LLM or deterministic fallback) gated by policy-engine. ' +
      'NOTE: because the LLM call is live and not temperature-pinned, its recommended intervention can ' +
      'vary between runs — observed to default to sms_nudge in ~6/7 sampled calls, occasionally ' +
      'differentiating (see seed 999: +1 case, +Rs.3332.68). This run’s delta is reported as measured, ' +
      'not selected.',
    baseline,
    ai,
    delta: {
      recovered_cases: ai.recovered_cases - baseline.recovered_cases,
      case_recovery_rate: round4(ai.case_recovery_rate - baseline.case_recovery_rate),
      recovered_value_paise: ai.recovered_value_paise - baseline.recovered_value_paise,
      value_recovery_rate: round4(ai.value_recovery_rate - baseline.value_recovery_rate),
    },
  };
}

function formatComparisonSummary(comparison) {
  const lines = [];
  lines.push('Payment Recovery Agent — baseline vs. AI evaluation (synthetic, not real customer stats)');
  lines.push(`  Seed: ${comparison.seed}`);
  const pct = (rate) => `${(rate * 100).toFixed(1)}%`;
  const rupees = (paise) => `Rs.${(paise / 100).toFixed(2)}`;
  lines.push(
    `  Baseline: ${comparison.baseline.recovered_cases}/${comparison.baseline.total_cases} recovered ` +
      `(${pct(comparison.baseline.case_recovery_rate)}), ${rupees(comparison.baseline.recovered_value_paise)} of ` +
      `${rupees(comparison.baseline.total_value_paise)} (${pct(comparison.baseline.value_recovery_rate)})`
  );
  lines.push(
    `  AI:       ${comparison.ai.recovered_cases}/${comparison.ai.total_cases} recovered ` +
      `(${pct(comparison.ai.case_recovery_rate)}), ${rupees(comparison.ai.recovered_value_paise)} of ` +
      `${rupees(comparison.ai.total_value_paise)} (${pct(comparison.ai.value_recovery_rate)})`
  );
  const sign = (n) => (n >= 0 ? '+' : '');
  lines.push(
    `  Delta:    ${sign(comparison.delta.recovered_cases)}${comparison.delta.recovered_cases} cases ` +
      `(${sign(comparison.delta.case_recovery_rate)}${pct(comparison.delta.case_recovery_rate)}), ` +
      `${sign(comparison.delta.recovered_value_paise)}${rupees(comparison.delta.recovered_value_paise)} ` +
      `(${sign(comparison.delta.value_recovery_rate)}${pct(comparison.delta.value_recovery_rate)})`
  );
  return lines.join('\n');
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

module.exports = {
  buildReport,
  formatSummary,
  summarizeStrategy,
  buildComparisonReport,
  formatComparisonSummary,
};
