# Payment Recovery Agent

Rule-based agent (Razorpay AI Buildathon, Track 03) that detects failed/abandoned
Razorpay test-mode payments, escalates recovery nudges on a fixed schedule, stops
after a fixed number of attempts, and reports what it recovered versus what it
couldn't — honestly, including the failures.

See `CLAUDE.md` for the full spec and constraints.

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
