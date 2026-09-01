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

## Day 1 setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy the env template and fill in your real Razorpay **test-mode** keys
   (Razorpay Dashboard > Settings > API Keys > Generate Test Key):
   ```
   cp .env.example .env
   ```
3. Confirm the Razorpay API connection works (creates a real test Order):
   ```
   npm run check:razorpay
   ```
4. Generate the synthetic failed-payment dataset (120 records):
   ```
   npm run generate:dataset
   ```
   Output: `data/failed-payments.json`.

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
   `--live` checks the Payment Link's status once, immediately after creating
   it — useful for a fast smoke test, but too fast for anyone to actually pay
   the link first.
5. To actually demonstrate a real recovery, use `--live-wait` instead: it
   prints the pay URL, then polls the Payment Link's status every 5 seconds
   (`POLL_INTERVAL_MS`) until it's paid or a hard cap of 75 seconds
   (`LIVE_WAIT_MS`) is reached — whichever comes first. Polling (rather than a
   single check after one fixed sleep) means the run returns as soon as the
   link is paid instead of always idling out the full window, and a payment
   that lands late in a long window is no longer invisible to it. The default
   cap is too short once you factor in opening the link and entering test-card
   details — override it with the `LIVE_WAIT_MS` environment variable (in
   milliseconds; `POLL_INTERVAL_MS` is also overridable but rarely needs to be):
   ```
   LIVE_WAIT_MS=240000 npm run recover -- --live-wait
   ```
   Use a **domestic** Razorpay test card during the window — `4111 1111 1111
   1111` is commonly assumed to work everywhere but Razorpay classifies it as
   *international*, which this payment link rejects. Use one of:
   - Visa: `4100 2800 0000 1007`
   - Mastercard: `5500 6700 0000 1002`
   - any future expiry date, any CVV, and any 4+ digit OTP if prompted.

   If the link isn't paid within the window, the run still completes and
   honestly reports that record as unrecovered — the live leg is never
   allowed to fail silently or crash the batch.
