#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { createRng, deriveSeed } = require('../src/recovery-simulator');
const { processRecord } = require('../src/escalation');
const { warmStrategyCache } = require('../src/recovery-agent');
const { buildComparisonReport, formatComparisonSummary } = require('../src/report');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'failed-payments.json');
const EVALUATION_REPORT_PATH = path.join(__dirname, '..', 'data', 'evaluation-report.json');

function parseArgs(argv) {
  const args = { seed: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') {
      args.seed = Number(argv[i + 1]);
      i++;
    } else if (arg.startsWith('--seed=')) {
      args.seed = Number(arg.split('=')[1]);
    }
  }
  return args;
}

// Runs every record through processRecord() once per strategy arm, giving
// each customer_id its own independent, reproducible RNG stream (deriveSeed)
// shared identically between the two arms — this is what isolates the
// measured delta to the intervention choice alone, not to RNG drift between
// two runs sharing one sequential generator.
function runArm(records, seed, strategy) {
  return records.map((record) => {
    const rng = createRng(deriveSeed(seed, record.customer_id));
    const result = processRecord(record, rng, { strategy });
    return { ...result, amount: record.amount };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number.isFinite(args.seed) ? args.seed : Math.floor(Math.random() * 0xffffffff);

  const records = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));

  // Warm the AI strategy cache once so the 'ai' arm can use a real LLM
  // diagnosis per unique failure_reason — same warm-up as run-recovery.js,
  // same honest fallback-on-failure behavior (never abort the run before the
  // comparison report is written). The 'baseline' arm never reads this cache.
  const uniqueFailureReasons = [...new Set(records.map((record) => record.failure_reason))];
  try {
    await warmStrategyCache({ failureReasons: uniqueFailureReasons, logger: console });
  } catch (err) {
    console.error(
      `AI strategy warm-up failed unexpectedly (${err.message}) — the AI arm will use the deterministic rule table for every reason.`
    );
  }

  const baselineResults = runArm(records, seed, 'baseline');
  const aiResults = runArm(records, seed, 'ai');

  const comparison = buildComparisonReport({ seed, baselineResults, aiResults });
  fs.writeFileSync(EVALUATION_REPORT_PATH, JSON.stringify(comparison, null, 2));

  console.log(formatComparisonSummary(comparison));
  console.log(`\nSeed: ${seed} (pass --seed ${seed} to reproduce this exact comparison)`);
  console.log('Full comparison report: data/evaluation-report.json');
}

main().catch((err) => {
  console.error('Evaluation run FAILED');
  console.error(err);
  process.exit(1);
});
