# Payment Recovery Agent

Agent (Razorpay AI Buildathon, Track 03) that detects failed/abandoned Razorpay
test-mode payments, diagnoses each failure with an LLM (deterministic rule-table
fallback) gated by a policy engine, escalates recovery nudges on a fixed
schedule, stops after a fixed number of attempts, and reports what it recovered
versus what it couldn't — honestly, including the failures.

See `CLAUDE.md` for the full spec and constraints, and `ARCHITECTURE.md` for how the
system is actually built (pipeline, the AI + policy-gate layer, the real Razorpay
integration, and the evaluation methodology).

## Results — measured, not cherry-picked

- **Batch run** (`data/report.json`): 121 records processed — **68 recovered,
  53 unrecovered**. Every escalation decision is logged in
  `data/audit-log.jsonl` with a timestamp and a stated reason.
- **One real Razorpay recovery** (`demo_live_001`): the agent created a real
  test-mode Payment Link (`plink_TUmAteDaUvnvM1`), it was genuinely paid, and
  the agent detected it — recovered at rung 0, 1 attempt, `source: "live"`.
  The same report carries a 4/4 live-LLM `ai_strategy_manifest`
  (Claude Sonnet 5), so the AI layer and the real integration are proven in
  one artifact.
- **Baseline vs. AI evaluation** (`data/evaluation-report.json`, seed 2026,
  chosen unseen): both arms recovered **69/120 cases (57.5%)** — **delta 0,
  reported as measured, not smoothed over**. Secondary finding: the AI arm
  recovers 2 cases in fewer attempts than baseline, and 0 in more. Why the
  headline delta is zero (and the disclosure around it) is explained in
  `ARCHITECTURE.md`.
- **Tests**: 102/102 passing (`npm test`).
- **Pitch video**: _coming before submission._

## Why this exists

**UPI has no silent retry.** Card networks can quietly re-attempt a declined
charge in the background (Stripe's Smart Retries). UPI can't — every payment
needs fresh human authentication, so the only mechanically correct way to
recover a failed UPI payment is to ask the person to come back and try again.
That's the entire mechanic here: detect, nudge, log, report — nothing more
exotic than that, because nothing more exotic is legal or necessary.

**Why Track 03, not Track 01 or 02:**
- Track 01 (Agentic Commerce) runs into RBI's 2FA/AFA mandate (in force since
  April 2026): a fully autonomous "AI just pays" flow doesn't work cleanly for
  most transactions in India. This project never touches authentication — it
  only reminds a human to retry, so the mandate isn't a constraint here.
- Track 02 (Risk Manager) needs a defensible synthetic fraud dataset and
  measured precision/recall — more data-science surface area than a solo,
  week-long build can responsibly deliver.
- The AI is deliberately scoped, not sprinkled on: an LLM diagnoses each
  failure and recommends an intervention, but a deterministic policy engine
  makes every final call, and every decision lands in a timestamped audit
  log. The requirement here is "did we follow a consistent, auditable
  policy" — so the model advises, the rules decide.

**What it actually targets.** NPCI splits UPI failures into *Technical
Decline* (bank/NPCI infrastructure — not fixable by any app, ~0.7-0.8% of
volume) and *Business Decline* (user-side: wrong PIN, low balance, abandoned
checkout — target under 5%). This agent only targets the second bucket, which
is the honest, defensible scope for an outbound nudge.

**The commercial case.** Razorpay earns close to nothing on UPI volume under
India's zero-MDR regime — UPI is 60%+ of aggregator transaction volume, and
the MDR ban's partial 2026 reopening leaves small merchants exempt. Recovered
revenue doesn't depend on MDR at all; it's money that's lost regardless of fee
structure. That makes revenue recovery one of the few real margin levers an
aggregator has right now.
