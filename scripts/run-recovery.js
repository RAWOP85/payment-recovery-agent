#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { createRng } = require('../src/recovery-simulator');
const { processRecord } = require('../src/escalation');
const {
  warmStrategyCache,
  getFallbackLog,
  FALLBACK_STRATEGY,
  UNKNOWN_FALLBACK,
} = require('../src/recovery-agent');
const { startLog, appendEntry } = require('../src/audit-log');
const { buildReport, formatSummary } = require('../src/report');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'failed-payments.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'report.json');

function parseArgs(argv) {
  const args = { seed: null, live: false, liveWait: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') {
      args.live = true;
    } else if (arg === '--live-wait') {
      args.live = true;
      args.liveWait = true;
    } else if (arg === '--seed') {
      args.seed = Number(argv[i + 1]);
      i++;
    } else if (arg.startsWith('--seed=')) {
      args.seed = Number(arg.split('=')[1]);
    }
  }
  return args;
}

async function runLiveDemoRecord(liveWait) {
  // Required lazily so a plain `npm run recover` never needs Razorpay credentials.
  const razorpayClient = require('../src/config/razorpay');
  const { processLiveRecord } = require('../src/live-recovery');
  console.log('Running the live Razorpay demo record (real test-mode API calls)...');
  return processLiveRecord(razorpayClient, undefined, { liveWait });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number.isFinite(args.seed) ? args.seed : Math.floor(Math.random() * 0xffffffff);
  const rng = createRng(seed);

  const records = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));

  // One diagnosis call per unique failure_reason (4 for this dataset), done up
  // front so escalation.js's per-record loop can stay synchronous. Missing
  // ANTHROPIC_API_KEY, a timeout, or a malformed response all degrade to the
  // deterministic rule table per-reason rather than failing the run — recorded
  // honestly below via warmStrategyCache()'s own returned manifest (which
  // includes fallback entries, unlike getStrategyManifest()'s LLM-only cache
  // view) and getFallbackLog(), never hidden.
  const uniqueFailureReasons = [...new Set(records.map((record) => record.failure_reason))];
  let strategyManifest;
  try {
    strategyManifest = await warmStrategyCache({ failureReasons: uniqueFailureReasons, logger: console });
  } catch (err) {
    // warmStrategyCache() is documented to catch its own per-reason failures
    // internally and never reject — but this is still a real network call, and
    // this project's hardest-learned lesson (see CLAUDE.md) is that a live API
    // failure must never abort the run before data/report.json is written.
    // Treat an unexpected rejection here the same way the --live leg below is
    // treated: report it honestly and degrade to the deterministic rule table
    // for every reason, rather than losing the whole batch's results.
    console.error(
      `AI strategy warm-up failed unexpectedly (${err.message}) — falling back to the rule table for all failure reasons.`
    );
    strategyManifest = uniqueFailureReasons.map((reason) => {
      const table = FALLBACK_STRATEGY[reason];
      return {
        failure_reason: reason,
        source: table ? 'fallback_table' : 'fallback_unknown_reason',
        fallback_reason: `warmStrategyCache rejected unexpectedly: ${err.message}`,
        ...(table || UNKNOWN_FALLBACK),
      };
    });
  }

  startLog();
  const results = records.map((record) => {
    const result = processRecord(record, rng);
    for (const attempt of result.attempts) {
      appendEntry(attempt);
    }
    return result;
  });

  if (args.live) {
    try {
      const liveResult = await runLiveDemoRecord(args.liveWait);
      for (const attempt of liveResult.attempts) {
        appendEntry(attempt);
      }
      results.push(liveResult);
    } catch (err) {
      console.error(`Live Razorpay leg FAILED: ${err.message}`);
      const failedAttempt = {
        timestamp: new Date().toISOString(),
        customer_id: 'demo_live_001',
        rung: 0,
        day_offset: 0,
        action: 'exhaust',
        reason: `Live Razorpay API call failed: ${err.message} — reporting as unrecovered, not hidden.`,
        outcome: 'no_response',
      };
      appendEntry(failedAttempt);
      results.push({
        customer_id: 'demo_live_001',
        failure_reason: 'checkout_abandoned',
        outcome: 'unrecovered',
        recovered_at_rung: null,
        attempts: [failedAttempt],
      });
    }
  }

  const report = buildReport({
    seed,
    results,
    aiStrategyManifest: strategyManifest,
    aiFallbackLog: getFallbackLog(),
  });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(formatSummary(report));
  console.log(`\nSeed: ${seed} (pass --seed ${seed} to reproduce this exact run)`);
  console.log('Audit trail: data/audit-log.jsonl');
  console.log('Full report: data/report.json');
}

main().catch((err) => {
  console.error('Recovery run FAILED');
  console.error(err);
  process.exit(1);
});
