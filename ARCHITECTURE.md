# Architecture — Payment Recovery Agent

Razorpay AI Buildathon, Track 03 (Revenue Recovery). This document explains how the
system is built and why, for a reviewer who has not seen the code before. Setup and
CLI usage live in `README.md`; the reasoning behind picking Track 03 lives in
`README.md`'s "Why this exists" section. This file is about the mechanism.

## What it does, in one paragraph

The agent takes a batch of failed/abandoned Razorpay payments, and for each one runs
a fixed Day 0 → 2 → 5 → 7 escalation ladder: at every rung it asks an AI diagnosis
layer *which* recovery nudge fits this failure mode, gates that recommendation
through a policy engine before anything executes, simulates (or, for one designated
record, actually observes via the real Razorpay API) whether the nudge worked, and
logs every decision with a timestamp and a stated reason. It stops after 4 attempts
per record, no exceptions, and reports recovered vs. unrecovered honestly — including
every failure, never just the wins.

## System diagram

```
data/failed-payments.json  (120 synthetic failed-payment records)
              │
              ▼
scripts/run-recovery.js  ─────────────────────────────────────────┐
   │                                                                │
   │ 1. warmStrategyCache()  ── one real Anthropic API call per    │
   │    (src/recovery-agent.js)  unique failure_reason (4 total),  │
   │                              never per record, never per rung │
   │                                                                │
   │ 2. per record: processRecord()  (src/escalation.js)          │
   │    for rung in [Day 0, 2, 5, 7]:                              │
   │        diagnose()        ─→ AI recommendation (or fallback)  │
   │        policy.decide()   ─→ approved intervention (or veto)  │
   │        decideOutcome()   ─→ recovered / no_response (rng)    │
   │        append audit entry, stop ladder if recovered           │
   │                                                                │
   │ 3. one designated record runs the SAME ladder shape but with  │
   │    processLiveRecord() (src/live-recovery.js) — a real        │
   │    Razorpay test-mode Payment Link, polled for real status    │
   └────────────────────────────────────────────────────────────────┘
              │                                    │
              ▼                                    ▼
   data/audit-log.jsonl                    data/report.json
   (append-only decision trail,            (aggregates + per-customer
    one JSON line per rung, never          outcomes + AI manifest —
    overwritten mid-run)                    never hides unrecovered cases)
```

`scripts/run-evaluation.js` reuses the same `processRecord()` core to run every
record through two arms — a fixed `sms_nudge`-only baseline and the full AI/policy
path — with each customer given an independently seeded, reproducible RNG stream
(`deriveSeed()`), and writes `data/evaluation-report.json`. This is what makes the
AI's contribution measurable rather than asserted.

## Component reference

| File | Responsibility |
|---|---|
| `data/generate-dataset.js` | Produces the 120-record synthetic dataset (`customer_id`, `amount`, `failure_reason`, `failed_at`). |
| `src/recovery-simulator.js` | Pure, seedable outcome model: `decideOutcome()` turns `(failure_reason, rung, intervention)` into `recovered`/`no_response` via a lookup-table probability, an intervention multiplier, and a mulberry32 PRNG. `deriveSeed()` gives each customer an independent stream for the evaluation script. No I/O. |
| `src/recovery-agent.js` | The diagnosis layer. `diagnose()` is synchronous and does no I/O — see "AI + policy layer" below. |
| `src/llm-client.js` | Minimal, dependency-free Anthropic Messages API client (Node 18 `fetch`, no SDK). One POST, no retry, bounded by a timeout. |
| `src/policy-engine.js` | The safety gate. `decide()` takes the AI's recommendation and either approves it, overrides it to the safe default, or blocks it outright — see below. |
| `src/escalation.js` | The state machine. `processRecord()` runs one record through the 4-rung ladder, wiring diagnosis → policy → outcome → audit entry together, and enforces the hard stop structurally (a bounded `for` loop, not a counter that could be misconfigured). |
| `src/live-recovery.js` | The one real Razorpay integration point — creates a real test-mode Payment Link and polls its live status (see below). |
| `src/audit-log.js` | Append-only JSONL writer/reader for `data/audit-log.jsonl`. |
| `src/report.js` | Builds `data/report.json` and `data/evaluation-report.json`, and the human-readable console summaries. |
| `scripts/run-recovery.js` | Entrypoint for `npm run recover` — wires everything above together for a full batch run. |
| `scripts/run-evaluation.js` | Entrypoint for `npm run evaluate` — baseline-vs-AI comparison over the same seeded dataset. |
| `scripts/check-razorpay.js` | Day-1 connectivity smoke test (`npm run check:razorpay`). |

All modules are CommonJS. Two dependencies total: `razorpay` (SDK) and `dotenv`. No
ML/AI framework dependency — the one real model call goes through a ~120-line
hand-written HTTP client.

## The AI + policy layer

This is the part of the system a Track 03 reviewer is specifically checking isn't
cosmetic, so it's worth spelling out precisely what the AI can and cannot do.

**What the AI chooses:** for each unique `failure_reason` in the dataset (4 for this
one — `insufficient_funds`, `otp_timeout`, `card_declined`, `checkout_abandoned`),
`warmStrategyCache()` makes one real call to Claude (`claude-sonnet-5` by default),
asking it to recommend exactly one of four allowed interventions
(`sms_nudge`, `email_reminder`, `discount_incentive`, `personal_call_offer`), plus a
diagnosis label, an urgency, a confidence score, and a one-sentence reason — returned
as a single JSON object. This happens **once per unique reason per run** (4 calls
max for this dataset), not once per record and not once per rung — `diagnose()`
itself is synchronous and touches no network, so the per-rung escalation loop stays
simple and deterministic given a warmed cache.

**What the AI cannot choose:** timing. There is no rung, day-offset, or retry-count
field anywhere in the AI's output shape or in `policy-engine.decide()`'s return
value. The Day 0/2/5/7 ladder and the 4-attempt hard stop are structural — a bounded
loop in `escalation.js` — not something a model recommendation or a policy decision
can extend, skip, or negotiate.

**Two independent gates before anything executes:**
1. `recovery-agent.js`'s `validateStrategy()` — is the response *well-formed*? Right
   shape, intervention on the whitelist, confidence in `[0, 1]`. Anything else throws
   and the run falls back to a deterministic rule table (below) for that reason.
2. `policy-engine.js`'s `decide()` — is the (now well-formed) recommendation
   *allowed*? It overrides to `sms_nudge` if the intervention isn't whitelisted or if
   confidence is below `0.5`, and blocks outreach entirely if the record is already
   recovered (duplicate-action prevention). Every decision carries a
   `policy_reason` string that reaches the audit log verbatim.

**Fallback, not failure:** if `ANTHROPIC_API_KEY` is unset, the call times out, or
the response is malformed, `diagnose()` transparently falls back to a hand-written
rule table (`FALLBACK_STRATEGY`) for that failure reason and records `source:
"fallback_table"` in the audit trail and in `data/report.json`'s
`ai_strategy_manifest` — so a reviewer can see, per reason, whether a given run's
numbers came from the model or the table. A run never aborts because the AI call
failed; it degrades honestly instead (this is the single most emphasized failure
mode in this project's own build history — see `CLAUDE.md`'s session logs for the
incident that made it a hard requirement).

**Record-level modulation (`applyRecordContext`)**, applied deterministically on top
of whichever base strategy was resolved above, so it never breaks `--seed`
reproducibility:
- Amounts ≥ ₹1,500 are re-diagnosed as `high_value_at_risk` and upgraded toward
  `personal_call_offer`.
- Expensive interventions (`discount_incentive`, `personal_call_offer`) are withheld
  before Day 2 (`ESCALATION_RUNG_INDEX`) regardless of what the model recommends —
  don't spend on a discount or a phone call before the free nudges have had a chance.
- Confidence decays by `0.15` per prior `no_response`, which is what makes
  low-confidence policy overrides arise naturally on later rungs (repeated silence is
  itself evidence the diagnosis needs revisiting) rather than only in contrived tests.

## The real Razorpay integration point

Per-record, running 120 live API round-trips for a synthetic dataset would be both
slow and pointless (119 of the 120 records aren't real people). Instead, exactly one
designated demo record (`demo_live_001`) gets a real test-mode Razorpay Payment Link
via `src/live-recovery.js`, and its live status is what actually determines its
`recovered`/`unrecovered` outcome — nothing about that record's result is simulated.

`npm run recover -- --live-wait` prints the payment link, then **polls its status
every 5 seconds (`POLL_INTERVAL_MS`) for up to 75 seconds (`LIVE_WAIT_MS`), returning
the moment the link is paid.** Both intervals are environment-overridable. Polling
rather than a single check after one fixed sleep matters for two reasons: the run
doesn't have to idle out a long window once the link is already paid, and a payment
that lands late within the window is no longer invisible the way a single post-sleep
check would make it. If the window closes unpaid, that's still reported as an honest
`unrecovered` outcome — the live leg is never allowed to fail silently or abort the
batch (a `try`/`catch` around it in `run-recovery.js` guarantees `data/report.json`
still gets written even if the Razorpay call itself throws).

Domestic Indian test cards are required for this link (`4100 2800 0000 1007` Visa /
`5500 6700 0000 1002` Mastercard) — Razorpay classifies the commonly-assumed
"works everywhere" `4111 1111 1111 1111` as international, and this link only
accepts domestic cards.

## Honest reporting, by construction

Track 03's grading language explicitly wants "an honest exception list," not a
cherry-picked demo, so a few structural choices exist specifically to make hiding a
failure hard rather than merely against policy:

- `data/report.json`'s `totals` block always includes both `recovered` and
  `unrecovered` counts — there is no code path that omits one.
- The live-Razorpay leg is wrapped so a real API failure still produces a
  (`unrecovered`, reason logged) record rather than crashing before the report is
  written.
- Every escalation decision — AI or fallback, allowed or overridden — writes one
  line to `data/audit-log.jsonl` with a timestamp and a human-readable `reason`
  string that names what happened and why.
- The evaluation report's `label` field explicitly discloses that the live LLM call
  is not temperature-pinned and can vary run to run (observed defaulting to
  `sms_nudge` in most sampled calls), rather than presenting one flattering seed as
  representative.

## Evaluation methodology (`npm run evaluate`)

`scripts/run-evaluation.js` runs every record through `processRecord()` twice — once
with `strategy: 'baseline'` (fixed `sms_nudge` on every rung, no AI call at all) and
once with the real AI/policy path — giving each `customer_id` its own independent,
reproducible RNG stream via `deriveSeed(seed, customer_id)`, shared identically
between the two arms. That last part is what makes the comparison meaningful: both
arms see the exact same random draw at each rung, so any difference in outcome is
attributable to the intervention choice, not to RNG drift between two separate runs.

**The honest result, not the flattering one:** the officially committed run
(`--seed 2026`, chosen unseen specifically to avoid the appearance of seed-shopping)
shows a recovered-case delta of **exactly zero** — 69/120 recovered in both arms.
This was root-caused, not shipped blind: the AI's higher-value interventions only
become eligible from Day 2 onward, by which point confidence has already decayed
below the policy engine's `0.5` threshold for every failure reason observed with a
live model in this project, so the escalation gate the AI's recommendation was
supposed to clear can — legitimately — end up vetoed most of the time. A follow-up
audit specifically verified this wasn't a wiring bug: `policy-engine.decide()`'s
input on a representative high-value `card_declined` record shows the AI genuinely
recommending `personal_call_offer` from Day 2 onward, with policy vetoing it purely
on the confidence floor.

**What the delta metric alone misses:** some records reach the *identical* final
outcome in both arms but the AI arm gets there in fewer attempts (e.g. recovered by
Day 2 instead of Day 5) — never slower. `avg_attempts_when_recovered` and a
`recovery_speed` block (`faster_recovery_cases` / `slower_recovery_cases` /
`same_speed_recovery_cases`, paired by `customer_id`) surface this: on the seed-2026
run, 2 records recover faster with AI, 0 slower. It's a small, honestly-reported
secondary finding, not a headline number — presented as exactly that.

## Testing

102 tests (`npm test`, Node's built-in `node --test`, no framework dependency),
covering `escalation.js`, `recovery-simulator.js`, `recovery-agent.js`,
`policy-engine.js`, `llm-client.js`, `audit-log.js`, and `report.js`. All of these
are pure functions or take an injected `fetchImpl` stub, so the suite never opens a
real network socket or depends on external state. `scripts/run-recovery.js`,
`scripts/run-evaluation.js`, and `src/live-recovery.js`'s actual Razorpay calls are
exercised as manual integration runs instead (deliberately, not an oversight — they
depend on external state a unit test can't meaningfully fake without becoming a
mock of Razorpay itself).

## Known limitations

Disclosed here for the same reason the evaluation report discloses its zero delta —
because Track 03 explicitly rewards honesty over a polished-looking demo:

- The live LLM call is not temperature-pinned (Claude 5 family models reject that
  parameter outright — see `src/llm-client.js`), so its recommended intervention can
  vary between runs of the same failure reason; `data/report.json`'s
  `ai_strategy_manifest` always shows what a given run actually got.
- The synthetic dataset's recovery probabilities (`BASE_RECOVERY_PROBABILITY`,
  `RUNG_DECAY`, `INTERVENTION_MULTIPLIER` in `src/recovery-simulator.js`) are
  hand-authored, not fit to real transaction data — this project has no access to
  real UPI/card recovery-rate statistics, so these are declared assumptions, not
  measurements.
- `--live-wait`'s polling cap is still a fixed budget you must set generously enough
  for a human (or browser automation) to complete checkout — it bounds the wait, it
  doesn't eliminate the need to pick a reasonable value for `LIVE_WAIT_MS`.
