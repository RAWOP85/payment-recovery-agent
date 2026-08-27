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
//
// `avg_attempts_when_recovered` only counts results carrying an `attempts`
// array (processRecord()'s real shape) — a caller that omits it (as some
// existing test fixtures do) is treated as "no attempts data available"
// (null), not as zero attempts, so it can never silently skew the average.
function summarizeStrategy(results) {
  const totalCases = results.length;
  let recoveredCases = 0;
  let totalValuePaise = 0;
  let recoveredValuePaise = 0;
  let recoveredWithAttemptsData = 0;
  let totalAttemptsWhenRecovered = 0;

  for (const result of results) {
    const amount = Number.isFinite(result.amount) ? result.amount : 0;
    totalValuePaise += amount;
    if (result.outcome === 'recovered') {
      recoveredCases += 1;
      recoveredValuePaise += amount;
      if (Array.isArray(result.attempts)) {
        recoveredWithAttemptsData += 1;
        totalAttemptsWhenRecovered += result.attempts.length;
      }
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
    avg_attempts_when_recovered:
      recoveredWithAttemptsData === 0 ? null : round4(totalAttemptsWhenRecovered / recoveredWithAttemptsData),
  };
}

// Pairs baseline/AI results by customer_id (not array position — defensive
// against either arm's ordering ever changing independently) and counts, among
// records recovered in BOTH arms, how often the AI arm got there in fewer
// attempts (faster — earlier rung, lower operational cost, same outcome),
// more attempts (slower), or the same number. This exists because the
// recovered/unrecovered delta above can measure exactly zero even when the AI
// arm has a real, honest advantage: reaching the identical final outcome
// sooner. Records not recovered in both arms aren't comparable on speed and
// are excluded, not counted as either faster or slower.
function compareRecoverySpeed(baselineResults, aiResults) {
  const baselineByCustomer = new Map(baselineResults.map((r) => [r.customer_id, r]));
  let fasterCases = 0;
  let slowerCases = 0;
  let sameSpeedCases = 0;

  for (const aiResult of aiResults) {
    const baselineResult = baselineByCustomer.get(aiResult.customer_id);
    if (!baselineResult) continue;
    if (aiResult.outcome !== 'recovered' || baselineResult.outcome !== 'recovered') continue;
    if (!Array.isArray(aiResult.attempts) || !Array.isArray(baselineResult.attempts)) continue;

    if (aiResult.attempts.length < baselineResult.attempts.length) fasterCases += 1;
    else if (aiResult.attempts.length > baselineResult.attempts.length) slowerCases += 1;
    else sameSpeedCases += 1;
  }

  return { faster_recovery_cases: fasterCases, slower_recovery_cases: slowerCases, same_speed_recovery_cases: sameSpeedCases };
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
  const recoverySpeed = compareRecoverySpeed(baselineResults, aiResults);

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
    // Separate from `delta` on purpose: this can show a real AI advantage
    // (faster_recovery_cases > 0) even when `delta` is entirely zero — same
    // final recovered/unrecovered outcome, reached in fewer attempts.
    recovery_speed: recoverySpeed,
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
  if (comparison.recovery_speed) {
    const { faster_recovery_cases, slower_recovery_cases, same_speed_recovery_cases } = comparison.recovery_speed;
    lines.push(
      `  Recovery speed (same outcome, both arms): ${faster_recovery_cases} faster with AI, ` +
        `${slower_recovery_cases} slower, ${same_speed_recovery_cases} same speed.`
    );
  }
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
  compareRecoverySpeed,
  buildComparisonReport,
  formatComparisonSummary,
};
