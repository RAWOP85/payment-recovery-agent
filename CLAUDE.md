# Project: Payment Recovery Agent (Razorpay AI Buildathon — Track 03)

## Scope (do not expand this)
An agent that detects a failed or abandoned Razorpay test-mode payment,
escalates recovery attempts on a fixed schedule, stops after N attempts,
and reports what it recovered versus what it couldn't.

## Constraints
- Solo builder, ~6-7 focused days of work, hard deadline Sept 5.
- Rule-based logic only. ML might be needed or wanted.
- Must use real Razorpay test-mode API for at least one real integration
  point (creating a test Order/Payment Link and detecting completion).
- Outbound "messages" (the nudges) can be simulated as logged
  console/file output — no real WhatsApp/email integration needed.
- MUST report honest results: recovered AND unrecovered cases, with
  reasons. No cherry-picked happy-path demo. This is the single most
  important grading criterion for this program — never hide failures.
- Every escalation decision must be logged with a timestamp and a
  stated reason (this is the "audit trail" requirement).
- Must have a hard stopping rule (max attempts or max days) — no
  infinite retrying.

## Day 1 tasks (do these in order, don't skip ahead)
1. Confirm Razorpay test-mode API keys work — auth + create one test
   Order or Payment Link via the SDK, confirm a real response.
2. Build a synthetic dataset generator: 100-150 fake failed-payment
   records (customer_id, amount, failure_reason, failed_at timestamp).
   Failure reasons: insufficient funds, card declined, checkout
   abandoned, OTP timeout.
3. Set up the repo structure and commit real, working code — not a
   placeholder commit.

## Tech stack
Node.js

## Not building
- No real WhatsApp Business API.
