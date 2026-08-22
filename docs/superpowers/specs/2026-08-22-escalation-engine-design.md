# Escalation Engine, Simulated Recovery, and Audit Trail — Design

Date: 2026-08-22
Status: Approved for implementation planning

## Purpose

Day 1 delivered a working Razorpay test-mode connection (`src/config/razorpay.js`,
`scripts/check-razorpay.js`) and a synthetic dataset of 120 failed-payment records
(`data/generate-dataset.js` → `data/failed-payments.json`). Day 2 builds the core
mechanic of the product: run each failed payment through a fixed Day 0/2/5/7
escalation ladder, decide at each rung whether it recovers, log every decision with
a timestamp and stated reason, and produce an honest recovered-vs-unrecovered report.

This is the single most important piece of the whole build — it's what the grading
criteria (audit trail, hard stop, honest reporting) actually test.

## Constraints carried in from CLAUDE.md

- Rule-based logic only, no ML.
- Real Razorpay test-mode API required for at least one real integration point.
- Outbound nudges are simulated (logged), not real WhatsApp/email.
- Must report recovered AND unrecovered honestly — no cherry-picking.
- Every escalation decision logged with timestamp + stated reason.
- Hard stopping rule — no infinite retrying.

## Decisions made during brainstorming

1. **Time model: simulated clock.** The state machine never calls `Date.now()`
   internally. It takes a "current simulated day offset" as an input parameter.
   The runner advances this offset programmatically (0 → 2 → 5 → 7) so a full
   7-day ladder for all 120 records runs in seconds, deterministically.
2. **Recovery model: weighted random per `(failure_reason, rung)`.** Each
   `failure_reason` has a base recovery probability; probability tapers slightly
   at later rungs (customer fatigue). This is rule-based (a lookup table drives
   the weights) but still varies run-to-run, which reads as a live simulation
   rather than a canned demo.
3. **RNG: seedable, default random.** A `--seed <n>` CLI flag (or `SEED` env var)
   pins the PRNG for reproducible runs; omitted, every run is fresh.
4. **Real API scope: one real record, rest simulated.** One designated demo
   record gets a real Razorpay test-mode Payment Link created and its live status
   fetched via the SDK. The other ~119 records run the identical code path but
   with simulated outcomes from the recovery model. If the real demo link is
   never completed, it is honestly logged and reported as unrecovered — this is
   acceptable and in fact reinforces the "no cherry-picking" requirement.
5. **Report: CLI summary + JSON file.** Console output narrates totals, overall
   recovery rate, and breakdowns by `failure_reason` and by rung-of-recovery.
   `data/report.json` carries the same aggregates plus a full per-customer outcome
   list, so any individual case can be audited.

## Architecture

```
data/failed-payments.json ─┐
                            ▼
scripts/run-recovery.js  (runner / entrypoint)
   ├─ src/escalation.js         (pure state machine: rung decision logic)
   ├─ src/recovery-simulator.js (seedable weighted-random outcome per rung)
   ├─ src/live-recovery.js      (real Razorpay Payment Link create + status fetch,
   │                             used for exactly one designated demo record)
   └─ src/audit-log.js          (append-only JSONL writer)
        ▼
data/audit-log.jsonl   (append-only decision trail)
data/report.json        (final aggregate + per-customer outcomes)
console summary          (human-readable narration for the demo)
```

All new modules are CommonJS, matching the existing `src/config/razorpay.js`
pattern. No new npm dependencies — the seedable PRNG is a small (~15 line)
mulberry32-style implementation local to `src/recovery-simulator.js`.

## Data model / state machine

Each of the 120 records is processed independently. Conceptually:

```
pending → escalating(rung=0) → escalating(rung=2) → escalating(rung=5) → escalating(rung=7) → exhausted
                │                        │                    │                    │
                └──────────────────── recovered (at any rung) ┴────────────────────┘
```

- Rungs are fixed: `[0, 2, 5, 7]` (days after `failed_at`).
- At each rung, the runner calls `escalation.decideRung(record, rungIndex)` to get
  the intended action, then calls either `recovery-simulator` or `live-recovery`
  (for the one demo record) to get an outcome, then writes an audit entry via
  `audit-log.append(...)`.
- A record stops being processed the moment it recovers, or after rung 7 regardless
  of outcome — the loop has exactly 4 iterations max per record, so "no infinite
  retrying" is true by construction, not by a counter that could be misconfigured.
- `src/escalation.js` and `src/recovery-simulator.js` are pure functions with no
  I/O, so they're directly unit-testable with a fixed seed.

## Audit log schema

One JSON object per line in `data/audit-log.jsonl`:

```json
{
  "timestamp": "2026-08-24T00:00:00.000Z",
  "customer_id": "cust_0054",
  "rung": 2,
  "day_offset": 2,
  "action": "escalate | recover | exhaust",
  "reason": "human-readable stated reason for this decision",
  "outcome": "recovered | no_response | n/a"
}
```

`timestamp` is the simulated timestamp (`failed_at + day_offset` days), not wall-clock
time — this keeps the audit trail internally consistent with the simulated run.

## Report

**Console:** total records processed, overall recovery rate, recovery-rate
breakdown by `failure_reason`, and a breakdown of "recovered at which rung."
Explicitly states unrecovered count — never omitted or buried.

**`data/report.json`:**
```json
{
  "generated_at": "...",
  "seed": 12345,
  "totals": { "processed": 120, "recovered": 0, "unrecovered": 0 },
  "by_failure_reason": { "...": { "recovered": 0, "unrecovered": 0 } },
  "by_rung_recovered": { "0": 0, "2": 0, "5": 0, "7": 0 },
  "records": [
    { "customer_id": "...", "outcome": "recovered", "recovered_at_rung": 2, "attempts": 2 }
  ]
}
```

## Real integration point

`src/live-recovery.js` extends the existing `src/config/razorpay.js` client to:
1. Create a real test-mode Payment Link for a dedicated demo record — a small fixed
   fixture object (customer_id, amount, description) defined in `src/live-recovery.js`
   itself, separate from the 120 synthetic dataset records — so the demo path never
   depends on which random record a dataset regeneration happens to produce.
2. On each rung for that one record, fetch the Payment Link's live status via the SDK
   instead of calling the simulator.
3. Log whatever Razorpay actually reports — if it's genuinely completed (e.g. someone
   pays it with a test card during the demo), that's a real recovered case; if not,
   it's an honestly-reported unrecovered case.

This satisfies "must use real Razorpay test-mode API for at least one real integration
point" without needing 120 live API calls, and without fabricating a completion that
didn't happen.

## Testing approach

- Unit tests for `src/escalation.js` (rung decisions) and `src/recovery-simulator.js`
  (fixed-seed determinism, probability sanity) — no I/O, straightforward to test directly.
- `scripts/run-recovery.js` and `src/live-recovery.js` are exercised as a manual
  integration/smoke run against real Razorpay test-mode keys (already verified working
  in Day 1) — not unit tested, since they depend on external state.

## Out of scope for this spec

- Real WhatsApp/email delivery (explicitly excluded project-wide).
- A dashboard UI.
- ML-based recovery prediction.
- Any escalation logic beyond the fixed 4-rung ladder.
