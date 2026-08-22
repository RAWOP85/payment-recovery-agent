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
