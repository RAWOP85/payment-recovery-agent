# Payment Recovery Agent

Rule-based agent (Razorpay AI Buildathon, Track 03) that detects failed/abandoned
Razorpay test-mode payments, escalates recovery nudges on a fixed schedule, stops
after a fixed number of attempts, and reports what it recovered versus what it
couldn't — honestly, including the failures.

See `CLAUDE.md` for the full spec and constraints.

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
  measured precision/recall — more data-science surface area than a
  rule-based, solo, week-long build can responsibly deliver.
- Rule-based logic (no ML) is a deliberate choice, not a shortcut: the
  requirement here is "did we follow a consistent, auditable policy," which a
  lookup table and a timestamped log answer better than a model would.

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
