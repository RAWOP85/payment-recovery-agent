#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { createRng } = require('../src/recovery-simulator');
const { processRecord } = require('../src/escalation');
const { startLog, appendEntry } = require('../src/audit-log');
const { buildReport, formatSummary } = require('../src/report');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'failed-payments.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'report.json');

function parseArgs(argv) {
  const args = { seed: null, live: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') {
      args.live = true;
    } else if (arg === '--seed') {
      args.seed = Number(argv[i + 1]);
      i++;
    } else if (arg.startsWith('--seed=')) {
      args.seed = Number(arg.split('=')[1]);
    }
  }
  return args;
}

async function runLiveDemoRecord() {
  // Required lazily so a plain `npm run recover` never needs Razorpay credentials.
  const razorpayClient = require('../src/config/razorpay');
  const { processLiveRecord } = require('../src/live-recovery');
  console.log('Running the live Razorpay demo record (real test-mode API calls)...');
  return processLiveRecord(razorpayClient);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number.isFinite(args.seed) ? args.seed : Math.floor(Math.random() * 0xffffffff);
  const rng = createRng(seed);

  const records = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));

  startLog();
  const results = records.map((record) => {
    const result = processRecord(record, rng);
    for (const attempt of result.attempts) {
      appendEntry(attempt);
    }
    return result;
  });

  if (args.live) {
    const liveResult = await runLiveDemoRecord();
    for (const attempt of liveResult.attempts) {
      appendEntry(attempt);
    }
    results.push(liveResult);
  }

  const report = buildReport({ seed, results });
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
