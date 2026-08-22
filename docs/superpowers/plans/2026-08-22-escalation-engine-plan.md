# Escalation Engine, Simulated Recovery, and Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Day 2 core mechanic — run each of the 120 synthetic failed-payment
records through a fixed Day 0/2/5/7 escalation ladder, decide a simulated recovery
outcome at each rung, log every decision to an append-only audit trail with a
timestamp and stated reason, and produce an honest recovered/unrecovered report —
plus one real Razorpay test-mode Payment Link integration point.

**Architecture:** Two pure, no-I/O modules (`src/recovery-simulator.js`,
`src/escalation.js`) implement the deterministic-given-a-seed decision logic and are
unit tested directly. Three I/O modules (`src/audit-log.js`, `src/report.js`,
`src/live-recovery.js`) wrap file writes, aggregation, and the real Razorpay API call
respectively. `scripts/run-recovery.js` is the thin orchestrating entrypoint.

**Tech Stack:** Node.js (CommonJS, matches existing `src/config/razorpay.js`), no new
npm dependencies. Tests use Node's built-in `node:test` + `node:assert/strict`
(available in the installed Node v24, declared `engines: >=18` in `package.json`) —
no test framework dependency needed.

**Spec:** `docs/superpowers/specs/2026-08-22-escalation-engine-design.md`

## Global Constraints

- Rule-based logic only — no ML, no external scoring service.
- No new npm dependencies. Use only `dotenv`, `razorpay` (already installed) and
  Node built-ins.
- CommonJS modules (`require`/`module.exports`), matching `src/config/razorpay.js`.
- The escalation ladder is exactly `[0, 2, 5, 7]` (day offsets from `failed_at`) —
  never more than 4 attempts per record. This is the hard stopping rule.
- Every escalation decision is appended to `data/audit-log.jsonl` with a
  `timestamp`, `reason`, and `outcome` — never skipped, never batched-and-lost.
- The 120 synthetic dataset records (`data/failed-payments.json`) are always
  processed via the simulator, never against the real Razorpay API.
- Exactly one dedicated demo record is processed via the real Razorpay test-mode
  Payment Link API (`src/live-recovery.js`), gated behind an explicit `--live` flag
  so a plain `npm run recover` needs no API credentials.
- The RNG is seedable (`--seed <n>`); when omitted, a random seed is generated and
  echoed back so any run can be reproduced on request.
- The final report must always include both `recovered` and `unrecovered` counts —
  never omit or bury the unrecovered figure.

---

## Task 1: Initialize git and commit the existing Day 1 work

The project directory is not yet a git repository, but every later task in this plan
ends with a commit. This has to happen first.

**Files:**
- Create: `.git/` (via `git init`)

- [ ] **Step 1: Initialize the repository**

Run: `git init`

- [ ] **Step 2: Stage and commit everything currently in the working tree**

```bash
git add CLAUDE.md README.md .gitignore .env.example package.json package-lock.json data/generate-dataset.js data/failed-payments.json src/config/razorpay.js scripts/check-razorpay.js docs/superpowers/specs/2026-08-22-escalation-engine-design.md
git commit -m "chore: initialize repo, commit Day 1 work and Day 2 design spec"
```

- [ ] **Step 3: Verify**

Run: `git log --oneline` and `git status`
Expected: one commit listed; `git status` reports a clean working tree.

---

## Task 2: Seedable RNG and weighted recovery simulator

**Files:**
- Create: `src/recovery-simulator.js`
- Test: `test/recovery-simulator.test.js`

**Interfaces:**
- Produces: `createRng(seed: number) => () => number` (returns a function producing
  floats in `[0, 1)`, deterministic for a given seed).
- Produces: `decideOutcome({ failureReason: string, rungIndex: number, rng: () => number }) => 'recovered' | 'no_response'`.
- Produces: `BASE_RECOVERY_PROBABILITY: { insufficient_funds, card_declined, checkout_abandoned, otp_timeout }` (numbers).
- Produces: `RUNG_DECAY: number[]` (length 4, index-aligned to rung position).

- [ ] **Step 1: Write the failing tests**

Create `test/recovery-simulator.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRng,
  decideOutcome,
  BASE_RECOVERY_PROBABILITY,
  RUNG_DECAY,
} = require('../src/recovery-simulator');

test('createRng is deterministic for the same seed', () => {
  const rngA = createRng(42);
  const rngB = createRng(42);
  const sequenceA = [rngA(), rngA(), rngA()];
  const sequenceB = [rngB(), rngB(), rngB()];
  assert.deepEqual(sequenceA, sequenceB);
});

test('createRng produces values in [0, 1)', () => {
  const rng = createRng(1);
  for (let i = 0; i < 100; i++) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `value ${value} out of range`);
  }
});

test('decideOutcome returns recovered when rng falls below the probability threshold', () => {
  const probability = BASE_RECOVERY_PROBABILITY.checkout_abandoned * RUNG_DECAY[0];
  const rng = () => probability - 0.001;
  const outcome = decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 0, rng });
  assert.equal(outcome, 'recovered');
});

test('decideOutcome returns no_response when rng is at or above the probability threshold', () => {
  const probability = BASE_RECOVERY_PROBABILITY.checkout_abandoned * RUNG_DECAY[0];
  const rng = () => probability + 0.001;
  const outcome = decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 0, rng });
  assert.equal(outcome, 'no_response');
});

test('decideOutcome throws on an unknown failure_reason', () => {
  assert.throws(
    () => decideOutcome({ failureReason: 'bogus_reason', rungIndex: 0, rng: () => 0 }),
    /Unknown failure_reason/
  );
});

test('decideOutcome throws on an unknown rungIndex', () => {
  assert.throws(
    () => decideOutcome({ failureReason: 'checkout_abandoned', rungIndex: 4, rng: () => 0 }),
    /Unknown rungIndex/
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/recovery-simulator.test.js`
Expected: FAIL — `Cannot find module '../src/recovery-simulator'`.

- [ ] **Step 3: Write the implementation**

Create `src/recovery-simulator.js`:

```js
// Base per-nudge recovery probability by failure_reason, tapered per rung by
// RUNG_DECAY to model diminishing returns on repeated reminders.
const BASE_RECOVERY_PROBABILITY = {
  checkout_abandoned: 0.35,
  otp_timeout: 0.3,
  card_declined: 0.18,
  insufficient_funds: 0.12,
};

// Index-aligned to rung position (0 = Day 0, 1 = Day 2, 2 = Day 5, 3 = Day 7).
const RUNG_DECAY = [1.0, 0.85, 0.7, 0.55];

// mulberry32 — small, dependency-free, seedable PRNG.
function createRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decideOutcome({ failureReason, rungIndex, rng }) {
  const base = BASE_RECOVERY_PROBABILITY[failureReason];
  if (base === undefined) {
    throw new Error(`Unknown failure_reason: ${failureReason}`);
  }
  const decay = RUNG_DECAY[rungIndex];
  if (decay === undefined) {
    throw new Error(`Unknown rungIndex: ${rungIndex}`);
  }
  const probability = base * decay;
  return rng() < probability ? 'recovered' : 'no_response';
}

module.exports = { createRng, decideOutcome, BASE_RECOVERY_PROBABILITY, RUNG_DECAY };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/recovery-simulator.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/recovery-simulator.js test/recovery-simulator.test.js
git commit -m "feat: add seedable RNG and weighted recovery simulator"
```

---

## Task 3: Escalation state machine

**Files:**
- Create: `src/escalation.js`
- Test: `test/escalation.test.js`

**Interfaces:**
- Consumes: `recovery-simulator.decideOutcome({ failureReason, rungIndex, rng })` (Task 2).
- Produces: `RUNGS: number[]` = `[0, 2, 5, 7]`.
- Produces: `simulatedTimestamp(failedAt: string, dayOffset: number) => string` (ISO 8601).
- Produces: `actionFor(rungIndex: number, outcome: 'recovered'|'no_response') => 'escalate'|'recover'|'exhaust'`.
- Produces: `buildReason(record, rungIndex: number, outcome: 'recovered'|'no_response') => string`.
- Produces: `processRecord(record, rng: () => number) => { customer_id, failure_reason, outcome: 'recovered'|'unrecovered', recovered_at_rung: number|null, attempts: Array<{ timestamp, customer_id, rung, day_offset, action, reason, outcome }> }`.

- [ ] **Step 1: Write the failing tests**

Create `test/escalation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RUNGS, simulatedTimestamp, actionFor, buildReason, processRecord } = require('../src/escalation');

const RECORD = {
  customer_id: 'cust_test_001',
  amount: 50000,
  failure_reason: 'checkout_abandoned',
  failed_at: '2026-08-01T00:00:00.000Z',
};

test('RUNGS is the fixed Day 0/2/5/7 ladder', () => {
  assert.deepEqual(RUNGS, [0, 2, 5, 7]);
});

test('simulatedTimestamp adds the day offset in milliseconds', () => {
  assert.equal(simulatedTimestamp('2026-08-01T00:00:00.000Z', 2), '2026-08-03T00:00:00.000Z');
  assert.equal(simulatedTimestamp('2026-08-01T00:00:00.000Z', 7), '2026-08-08T00:00:00.000Z');
});

test('actionFor recovers regardless of rung, escalates mid-ladder, exhausts on the last rung', () => {
  assert.equal(actionFor(0, 'recovered'), 'recover');
  assert.equal(actionFor(3, 'recovered'), 'recover');
  assert.equal(actionFor(0, 'no_response'), 'escalate');
  assert.equal(actionFor(RUNGS.length - 1, 'no_response'), 'exhaust');
});

test('buildReason names the failure reason on the first rung', () => {
  const reason = buildReason(RECORD, 0, 'no_response');
  assert.match(reason, /Day 0/);
  assert.match(reason, /checkout_abandoned/);
});

test('buildReason explains the hard stop on the last rung', () => {
  const reason = buildReason(RECORD, RUNGS.length - 1, 'no_response');
  assert.match(reason, /Day 7/);
  assert.match(reason, /hard stop/);
});

test('processRecord stops at the first rung when the simulated outcome is recovery', () => {
  const alwaysRecover = () => 0; // 0 < any positive probability => recovered
  const result = processRecord(RECORD, alwaysRecover);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.recovered_at_rung, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].action, 'recover');
});

test('processRecord exhausts all four rungs when the customer never responds', () => {
  const neverRecover = () => 0.99; // above every reason's max possible probability
  const result = processRecord(RECORD, neverRecover);
  assert.equal(result.outcome, 'unrecovered');
  assert.equal(result.recovered_at_rung, null);
  assert.equal(result.attempts.length, 4);
  assert.equal(result.attempts[3].action, 'exhaust');
  assert.equal(result.attempts[3].rung, 7);
});

test('processRecord carries failure_reason through for downstream aggregation', () => {
  const result = processRecord(RECORD, () => 0.99);
  assert.equal(result.failure_reason, 'checkout_abandoned');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/escalation.test.js`
Expected: FAIL — `Cannot find module '../src/escalation'`.

- [ ] **Step 3: Write the implementation**

Create `src/escalation.js`:

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/escalation.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/escalation.js test/escalation.test.js
git commit -m "feat: add Day 0/2/5/7 escalation state machine"
```

---

## Task 4: Append-only audit log

**Files:**
- Create: `src/audit-log.js`
- Test: `test/audit-log.test.js`

**Interfaces:**
- Produces: `startLog(filePath?: string) => void` (truncates/creates the file empty).
- Produces: `appendEntry(entry: object, filePath?: string) => void` (appends one JSON line).
- Produces: `readEntries(filePath?: string) => object[]` (parses the JSONL file back).
- Produces: `DEFAULT_LOG_PATH: string` = `<repo>/data/audit-log.jsonl`.

- [ ] **Step 1: Write the failing tests**

Create `test/audit-log.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startLog, appendEntry, readEntries } = require('../src/audit-log');

function tempLogPath() {
  return path.join(os.tmpdir(), `audit-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('startLog creates an empty file', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '');
  fs.unlinkSync(filePath);
});

test('appendEntry writes one JSON object per line', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  appendEntry({ customer_id: 'cust_0001', action: 'escalate' }, filePath);
  appendEntry({ customer_id: 'cust_0002', action: 'recover' }, filePath);
  const entries = readEntries(filePath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].customer_id, 'cust_0001');
  assert.equal(entries[1].action, 'recover');
  fs.unlinkSync(filePath);
});

test('startLog truncates a pre-existing file so re-runs do not mix audit trails', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  appendEntry({ customer_id: 'stale' }, filePath);
  startLog(filePath); // simulate a second run
  appendEntry({ customer_id: 'fresh' }, filePath);
  const entries = readEntries(filePath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customer_id, 'fresh');
  fs.unlinkSync(filePath);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/audit-log.test.js`
Expected: FAIL — `Cannot find module '../src/audit-log'`.

- [ ] **Step 3: Write the implementation**

Create `src/audit-log.js`:

```js
const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = path.join(__dirname, '..', 'data', 'audit-log.jsonl');

function startLog(filePath = DEFAULT_LOG_PATH) {
  fs.writeFileSync(filePath, '');
}

function appendEntry(entry, filePath = DEFAULT_LOG_PATH) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function readEntries(filePath = DEFAULT_LOG_PATH) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

module.exports = { startLog, appendEntry, readEntries, DEFAULT_LOG_PATH };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/audit-log.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audit-log.js test/audit-log.test.js
git commit -m "feat: add append-only JSONL audit log writer"
```

---

## Task 5: Report builder

**Files:**
- Create: `src/report.js`
- Test: `test/report.test.js`

**Interfaces:**
- Consumes: `escalation.RUNGS` (Task 3) — used to seed the `by_rung_recovered` buckets.
- Consumes: `processRecord(...)`-shaped result objects (Task 3): `{ customer_id, failure_reason, outcome, recovered_at_rung, attempts }`.
- Produces: `buildReport({ seed: number, results: object[] }) => { generated_at, seed, totals: { processed, recovered, unrecovered }, by_failure_reason, by_rung_recovered, records }`.
- Produces: `formatSummary(report) => string` (human-readable console text).

- [ ] **Step 1: Write the failing tests**

Create `test/report.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, formatSummary } = require('../src/report');

function makeResult({ customerId, reason, outcome, recoveredAtRung, attemptCount }) {
  return {
    customer_id: customerId,
    failure_reason: reason,
    outcome,
    recovered_at_rung: recoveredAtRung,
    attempts: new Array(attemptCount).fill({}),
  };
}

test('buildReport aggregates totals, by-reason, and by-rung breakdowns', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'checkout_abandoned', outcome: 'recovered', recoveredAtRung: 0, attemptCount: 1 }),
    makeResult({ customerId: 'b', reason: 'checkout_abandoned', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
    makeResult({ customerId: 'c', reason: 'card_declined', outcome: 'recovered', recoveredAtRung: 5, attemptCount: 3 }),
  ];

  const report = buildReport({ seed: 42, results });

  assert.equal(report.seed, 42);
  assert.deepEqual(report.totals, { processed: 3, recovered: 2, unrecovered: 1 });
  assert.deepEqual(report.by_failure_reason.checkout_abandoned, { recovered: 1, unrecovered: 1 });
  assert.deepEqual(report.by_failure_reason.card_declined, { recovered: 1, unrecovered: 0 });
  assert.equal(report.by_rung_recovered[0], 1);
  assert.equal(report.by_rung_recovered[5], 1);
  assert.equal(report.records.length, 3);
});

test('buildReport never hides the unrecovered count', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
  ];
  const report = buildReport({ seed: 1, results });
  assert.equal(report.totals.unrecovered, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(report.totals, 'unrecovered'));
});

test('formatSummary includes both recovered and unrecovered counts in the printed text', () => {
  const results = [
    makeResult({ customerId: 'a', reason: 'otp_timeout', outcome: 'recovered', recoveredAtRung: 2, attemptCount: 2 }),
    makeResult({ customerId: 'b', reason: 'otp_timeout', outcome: 'unrecovered', recoveredAtRung: null, attemptCount: 4 }),
  ];
  const report = buildReport({ seed: 7, results });
  const summary = formatSummary(report);
  assert.match(summary, /Recovered: 1/);
  assert.match(summary, /Unrecovered: 1/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/report.test.js`
Expected: FAIL — `Cannot find module '../src/report'`.

- [ ] **Step 3: Write the implementation**

Create `src/report.js`:

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/report.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.js test/report.test.js
git commit -m "feat: add report aggregation and console summary formatting"
```

---

## Task 6: Live Razorpay integration (the one real API record)

Not unit tested — this module makes real network calls to the Razorpay test-mode
API and is verified manually in Task 8, matching how `scripts/check-razorpay.js`
(Day 1) was verified.

**Files:**
- Create: `src/live-recovery.js`

**Interfaces:**
- Consumes: `escalation.{RUNGS, simulatedTimestamp, actionFor, buildReason}` (Task 3).
- Consumes: a Razorpay client instance shaped like `src/config/razorpay.js`'s export
  (must expose `paymentLink.create(...)` and `paymentLink.fetch(id)`).
- Produces: `DEMO_RECORD: object` — the fixed fixture record for the live demo.
- Produces: `createDemoPaymentLink(razorpayClient, record?) => Promise<{ id, short_url, status, ... }>`.
- Produces: `fetchPaymentLinkStatus(razorpayClient, paymentLinkId) => Promise<string>`.
- Produces: `processLiveRecord(razorpayClient, record?) => Promise<{ customer_id, failure_reason, outcome, recovered_at_rung, attempts, payment_link }>` — same shape as `escalation.processRecord`'s return value, plus `payment_link`.

- [ ] **Step 1: Write the implementation**

Create `src/live-recovery.js`:

```js
const { RUNGS, simulatedTimestamp, actionFor, buildReason } = require('./escalation');

// A dedicated fixture, separate from the 120 synthetic dataset records, so the
// live demo path never depends on which random record a dataset regeneration
// happens to produce.
const DEMO_RECORD = {
  customer_id: 'demo_live_001',
  amount: 49900, // paise -> ₹499.00
  currency: 'INR',
  failure_reason: 'checkout_abandoned',
  failed_at: new Date().toISOString(),
  description: 'Payment Recovery Agent — live demo payment link',
};

async function createDemoPaymentLink(razorpayClient, record = DEMO_RECORD) {
  return razorpayClient.paymentLink.create({
    amount: record.amount,
    currency: record.currency,
    description: record.description,
    reference_id: `${record.customer_id}-${Date.now()}`,
    notify: { sms: false, email: false },
  });
}

async function fetchPaymentLinkStatus(razorpayClient, paymentLinkId) {
  const link = await razorpayClient.paymentLink.fetch(paymentLinkId);
  return link.status; // 'created' | 'paid' | 'expired' | 'cancelled' | 'partially_paid'
}

async function processLiveRecord(razorpayClient, record = DEMO_RECORD) {
  const link = await createDemoPaymentLink(razorpayClient, record);
  const attempts = [];
  let outcome = 'unrecovered';
  let recoveredAtRung = null;

  for (let rungIndex = 0; rungIndex < RUNGS.length; rungIndex++) {
    const dayOffset = RUNGS[rungIndex];
    const status = await fetchPaymentLinkStatus(razorpayClient, link.id);
    const attemptOutcome = status === 'paid' ? 'recovered' : 'no_response';

    attempts.push({
      timestamp: simulatedTimestamp(record.failed_at, dayOffset),
      customer_id: record.customer_id,
      rung: dayOffset,
      day_offset: dayOffset,
      action: actionFor(rungIndex, attemptOutcome),
      reason: `${buildReason(record, rungIndex, attemptOutcome)} [live Razorpay status: ${status}]`,
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
    payment_link: { id: link.id, short_url: link.short_url },
  };
}

module.exports = { DEMO_RECORD, createDemoPaymentLink, fetchPaymentLinkStatus, processLiveRecord };
```

- [ ] **Step 2: Sanity-check the module loads**

Run: `node -e "console.log(Object.keys(require('./src/live-recovery')))"`
Expected: `[ 'DEMO_RECORD', 'createDemoPaymentLink', 'fetchPaymentLinkStatus', 'processLiveRecord' ]`
(This only checks the module has no syntax/import errors — the real API calls are
verified end-to-end in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src/live-recovery.js
git commit -m "feat: add real Razorpay test-mode Payment Link integration for the live demo record"
```

---

## Task 7: Runner entrypoint, npm scripts, and README

**Files:**
- Create: `scripts/run-recovery.js`
- Modify: `package.json` (add `test` and `recover` npm scripts)
- Modify: `README.md` (add Day 2 usage section)

**Interfaces:**
- Consumes: `recovery-simulator.createRng` (Task 2), `escalation.processRecord` (Task 3),
  `audit-log.{startLog, appendEntry}` (Task 4), `report.{buildReport, formatSummary}`
  (Task 5), `live-recovery.processLiveRecord` (Task 6), `src/config/razorpay.js`
  (Day 1, required lazily only when `--live` is passed).
- Produces: `data/audit-log.jsonl`, `data/report.json` as run artifacts (not exported
  functions — this is the CLI entrypoint).

- [ ] **Step 1: Write the runner script**

Create `scripts/run-recovery.js`:

```js
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
```

- [ ] **Step 2: Add npm scripts**

Modify `package.json` — add to `"scripts"` (alongside the existing `check:razorpay`
and `generate:dataset` entries):

```json
"test": "node --test test/",
"recover": "node scripts/run-recovery.js"
```

- [ ] **Step 3: Add a Day 2 section to README.md**

Modify `README.md` — append after the existing "Day 1 setup" section:

```markdown

## Day 2: run the recovery agent

1. Run the full unit test suite (escalation logic + recovery simulator + audit
   log + report — all pure/no external calls):
   ```
   npm test
   ```
2. Run the recovery agent against the 120 synthetic records (simulated outcomes
   only, no API calls, no credentials needed):
   ```
   npm run recover
   ```
   This writes `data/audit-log.jsonl` (every escalation decision, timestamped and
   reasoned) and `data/report.json` (aggregate + per-customer outcomes), and
   prints a console summary including the seed used.
3. Reproduce an exact prior run:
   ```
   npm run recover -- --seed 12345
   ```
4. Run including the one real Razorpay test-mode integration point (creates a
   real test-mode Payment Link and checks its live status — requires `.env` set
   up per the Day 1 steps above):
   ```
   npm run recover -- --live
   ```
```

- [ ] **Step 4: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS, all tests from Tasks 2-5 (20 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/run-recovery.js package.json README.md
git commit -m "feat: add run-recovery entrypoint, npm scripts, and Day 2 README section"
```

---

## Task 8: End-to-end manual verification

This task has no automated test — it verifies the whole pipeline actually works
together, including the real API call, which depends on external state (your
Razorpay test-mode credentials).

- [ ] **Step 1: Run the simulated-only path**

Run: `npm run recover`

Verify:
- Console prints a summary with non-zero `Processed`, and both `Recovered` and
  `Unrecovered` lines present (not omitted even if one is zero).
- `data/audit-log.jsonl` exists and every line parses as JSON with `timestamp`,
  `customer_id`, `rung`, `action`, `reason`, `outcome` fields.
- `data/report.json` exists, `totals.processed` equals 120, and
  `totals.recovered + totals.unrecovered === totals.processed`.

- [ ] **Step 2: Run the live path**

Confirm `.env` has real Razorpay test-mode keys (per Day 1 setup), then run:
`npm run recover -- --live`

Verify:
- Console shows "Running the live Razorpay demo record..." and no errors.
- `data/report.json`'s `records` array has 121 entries, with the last one's
  `customer_id` equal to `demo_live_001`.
- The audit log contains 4 (or fewer, if it shows "paid") entries for
  `demo_live_001`, each with a `[live Razorpay status: ...]` suffix in `reason`.

- [ ] **Step 3: Reproducibility check**

Run `npm run recover -- --seed 777` twice in a row. Diff the two `data/report.json`
outputs (excluding the `generated_at` field, which is wall-clock and expected to
differ):

Run: `node -e "const a=require('./data/report.json'); console.log(a.seed)"` after
each run — both should print `777`, and `totals`/`records` should be identical
between the two runs.

- [ ] **Step 4: Commit the generated demo artifacts as submission evidence**

```bash
git add data/audit-log.jsonl data/report.json
git commit -m "chore: commit a verified Day 2 run as submission evidence"
```
