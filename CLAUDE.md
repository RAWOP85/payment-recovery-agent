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

## Session log — 2026-08-25 (testing + submission-readiness pass)

**Submission requirements confirmed** (from `razorpay.com/buildathon/` directly, corroborated
by third-party listings for the deadline):
- Submit: a **public repository**, a **5-minute pitch video**, and **architecture
  documentation**.
- Track 03 is officially "**Revenue Recovery**": *"Show measured money recovered across a
  batch, with compliant escalation, stopping rules, and an audit trail."* — i.e. it explicitly
  wants evidence of actual recovery, not just the mechanism.
- Deadline: **September 5, 2026** (matches the hard deadline already in this file).

**Gaps found against those three requirements:**
1. **No public repo.** `git remote -v` is empty — this repo has never been pushed anywhere.
   Needs a GitHub push before submission.
2. **No pitch video yet.** README's "Why this exists" section is solid source material for
   the voiceover/script.
3. **Architecture doc exists but isn't submission-shaped.**
   `docs/superpowers/specs/2026-08-22-escalation-engine-design.md` is an internal planning
   doc, not something to hand a reviewer as-is.

**Live `--live-wait` testing — multiple attempts, root cause found:**
- Confirmed `npm run check:razorpay` and the full unit suite (23/23) still pass.
- First two `--live-wait` runs (hardcoded 75s window) both timed out with the payment link
  status stuck at `created` — the link was never even touched. Root cause: relaying the pay
  URL through this chat session has enough latency that 75s isn't a realistic window.
- Made `LIVE_WAIT_MS` in `src/live-recovery.js` read from `process.env.LIVE_WAIT_MS` (falls
  back to the original `75000` default) so it can be overridden per-run
  (`LIVE_WAIT_MS=240000 npm run recover -- --live-wait`) without changing default behavior.
  **This edit is still uncommitted** as of end of session.
- With a 240s window, hit a real Razorpay UX step: the test-mode checkout shows a **mock bank
  authorization page with explicit Success/Failure buttons** — clicking (or defaulting to)
  Failure fails the payment on purpose. That's expected Razorpay test-mode behavior, not a bug.
- Then hit the actual bug: **`4111 1111 1111 1111` (the card commonly assumed to work
  everywhere) is classified by Razorpay as an INTERNATIONAL card**, and this payment link only
  accepts domestic cards — produces "International cards are not supported." Confirmed against
  Razorpay's own docs repo (`github.com/razorpay/markdown-docs`). Correct **domestic** test
  cards:
  - Visa: `4100 2800 0000 1007`
  - Mastercard: `5500 6700 0000 1002`
  - (any future expiry, any CVV; OTP screen if shown: any 4+ digit number, e.g. `1234`)
- **As of end of session: still no confirmed real "recovered" outcome from the live path.**
  Four live-wait runs so far (`54ru1Ep`, `oVE2aM7`, `bjOwX739`, `puU7x2LB`), all ended
  `unrecovered` — first three from timing/wrong-card issues now understood and fixed, the
  fourth's window closed before the corrected card number could be tried. **Next step:** run
  `LIVE_WAIT_MS=240000 npm run recover -- --live-wait` again and pay with the correct domestic
  card above.

**Update — same day, later run: real recovery confirmed.**
Ran `LIVE_WAIT_MS=240000 npm run recover -- --live-wait` and paid the generated link
(`https://rzp.io/rzp/Sik4sw7m`, `plink_TU60fT4s8keMBh`) with the correct domestic Visa test
card within the 240s window. `data/report.json`'s `demo_live_001` record now shows
`"outcome": "recovered"`, `"recovered_at_rung": 0`, `"attempts": 1` — the real recovered-payment
record needed for the video and for Track 03's "measured money recovered" requirement. The
`LIVE_WAIT_MS` env-override is being kept (not reverted) since it was required to get this
result and is a strict opt-in default-preserving change.

**Still open / not yet done:**
- Push repo to GitHub (public or reviewer-invited private) — no remote configured yet.
- Turn `docs/superpowers/specs/2026-08-22-escalation-engine-design.md` into a submission-shaped
  architecture doc.
- Record the 5-minute pitch video.
- Delete `rzp-test-key(1).csv` from the Downloads folder — flagged days ago as containing
  live-usable test credentials in plaintext, never confirmed deleted.
- Minor oddity, not yet investigated: the `dotenv`/dotenvx startup line's rotating promotional
  tip showed an unfamiliar domain (`www.vestauth.com`) alongside the expected `dotenvx.com` —
  recurred again on this later run too, so it's a consistent tip rotation, not a one-off; still
  very likely benign but not root-caused.
