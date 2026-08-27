// The diagnosis layer — "what is actually wrong with this customer, and which
// nudge is most likely to fix it?"
//
// The per-failure-mode strategy comes from a real LLM call. The deterministic
// rule table below is kept as an automatic fallback, not as dead code: if the
// API key is missing, the call fails, times out, or the response is malformed,
// the agent uses the table and records why.
//
// Two properties are load-bearing and deliberate:
//
//   1. `diagnose()` is SYNCHRONOUS and performs no I/O. All network work happens
//      once, up front, in `warmStrategyCache()`. That is what keeps
//      `processRecord`'s per-rung loop synchronous and the orchestrators
//      unchanged.
//   2. The LLM is consulted at most ONCE PER UNIQUE failure_reason per run — the
//      dataset has exactly 4 — never per record and never per rung. Because
//      `diagnose()` holds no client and cannot await, that bound is structural
//      rather than a convention a later edit could quietly break.
//
// Everything the LLM returns is untrusted until `validateStrategy()` passes it,
// and is then gated a second time by policy-engine.js before anything acts on it.

const { LlmError, requestJson } = require('./llm-client');

// The only interventions this system is allowed to propose. An outbound nudge
// is simulated (logged), per the project's stated scope — no real WhatsApp or
// email dispatch — but the whitelist is what makes "the AI cannot invent an
// action" true rather than merely intended.
const INTERVENTIONS = ['sms_nudge', 'email_reminder', 'discount_incentive', 'personal_call_offer'];
const DEFAULT_INTERVENTION = 'sms_nudge';
const URGENCIES = ['low', 'medium', 'high'];

// Interventions with a real per-contact cost stay locked until the cheap rungs
// have demonstrably failed.
const EXPENSIVE_INTERVENTIONS = new Set(['discount_incentive', 'personal_call_offer']);
const ESCALATION_RUNG_INDEX = 2; // Day 5 and later

const HIGH_VALUE_THRESHOLD_PAISE = 150000; // Rs.1,500
const CONFIDENCE_DECAY_PER_NO_RESPONSE = 0.15;
const UNKNOWN_REASON_CONFIDENCE = 0.3;
const MAX_TEXT_LENGTH = 240; // keep audit-log lines legible

// Deterministic fallback: the exact per-reason rule table from the design.
// Used verbatim whenever the LLM path does not produce a valid strategy.
const FALLBACK_STRATEGY = {
  insufficient_funds: {
    diagnosis: 'price_sensitive',
    intervention: 'discount_incentive',
    urgency: 'medium',
    confidence: 0.72,
    reason: 'Balance shortfall at checkout — the amount, not the intent, is the blocker.',
  },
  otp_timeout: {
    diagnosis: 'attention_lapse',
    intervention: 'sms_nudge',
    urgency: 'high',
    confidence: 0.8,
    reason: 'Customer started authentication and let it expire — intent was high, attention lapsed.',
  },
  card_declined: {
    diagnosis: 'technical_friction',
    intervention: 'email_reminder',
    urgency: 'medium',
    confidence: 0.68,
    reason: 'Issuer refused the instrument — recovery needs an alternative method, not persuasion.',
  },
  checkout_abandoned: {
    diagnosis: 'attention_lapse',
    intervention: 'sms_nudge',
    urgency: 'low',
    confidence: 0.65,
    reason: 'Customer left before authorising — a light reminder is proportionate.',
  },
};

// An unrecognised failure_reason must not throw: it degrades to a low-confidence
// default, which is precisely the case policy-engine.js is built to override.
// That makes the fallback path something the system exercises honestly rather
// than something only a contrived test can reach.
const UNKNOWN_FALLBACK = {
  diagnosis: 'unclassified_failure',
  intervention: DEFAULT_INTERVENTION,
  urgency: 'low',
  confidence: UNKNOWN_REASON_CONFIDENCE,
  reason: 'Failure reason not recognised — defaulting to the cheapest nudge at low confidence.',
};

const SYSTEM_PROMPT = [
  'You are a payments recovery analyst for an Indian payment aggregator.',
  'Given one payment failure_reason, recommend a single recovery strategy for that failure mode.',
  'Respond with ONLY a JSON object and no other text:',
  '{"diagnosis":"<snake_case label for the customer\'s underlying problem>",',
  ' "intervention":"<exactly one of: sms_nudge | email_reminder | discount_incentive | personal_call_offer>",',
  ' "urgency":"<exactly one of: low | medium | high>",',
  ' "confidence":<number between 0 and 1>,',
  ' "reason":"<one sentence, under 200 characters>"}',
  'You choose only WHICH intervention. Timing is fixed by a Day 0/2/5/7 ladder with a hard stop',
  'after four attempts; you never influence timing, retry count, or whether payment succeeded.',
].join('\n');

// Populated only by warmStrategyCache(). Cold at require time — importing this
// module never triggers a network call.
const strategyCache = new Map();
const fallbackLog = [];

function round2(value) {
  return Math.round(value * 100) / 100;
}

function truncate(text) {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}...` : text;
}

function rupees(paise) {
  return `Rs.${(paise / 100).toFixed(2)}`;
}

function resetAgentCache() {
  strategyCache.clear();
  fallbackLog.length = 0;
}

// Rejects anything off-contract so a malformed model response can never inject
// an unknown intervention downstream. Validation lives here, at the trust
// boundary, so nothing invalid ever enters the cache.
function validateStrategy(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LlmError('response was not a JSON object');
  }

  const diagnosis = typeof data.diagnosis === 'string' ? data.diagnosis.trim() : '';
  if (!diagnosis) throw new LlmError('missing or empty "diagnosis"');

  const intervention = typeof data.intervention === 'string' ? data.intervention.trim() : '';
  if (!INTERVENTIONS.includes(intervention)) {
    throw new LlmError(`intervention ${JSON.stringify(data.intervention)} is not on the whitelist`);
  }

  const urgency = typeof data.urgency === 'string' ? data.urgency.trim().toLowerCase() : '';
  if (!URGENCIES.includes(urgency)) {
    throw new LlmError(`urgency ${JSON.stringify(data.urgency)} is not one of ${URGENCIES.join('/')}`);
  }

  const confidence = typeof data.confidence === 'number' ? data.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new LlmError(`confidence ${JSON.stringify(data.confidence)} is not a number in [0, 1]`);
  }

  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (!reason) throw new LlmError('missing or empty "reason"');

  return {
    diagnosis: truncate(diagnosis),
    intervention,
    urgency,
    confidence: round2(confidence),
    reason: truncate(reason),
  };
}

// failure_reason values come from our own generated enum, but the guard keeps
// the prompt surface closed regardless of what a future dataset contains.
function assertSafeReason(failureReason) {
  if (typeof failureReason !== 'string' || !/^[a-z0-9_]{1,40}$/.test(failureReason)) {
    throw new LlmError(`failure_reason ${JSON.stringify(failureReason)} is not a safe identifier`);
  }
}

async function fetchStrategy(failureReason, llmOptions) {
  assertSafeReason(failureReason);
  const { data, model } = await requestJson({
    system: SYSTEM_PROMPT,
    prompt: `failure_reason: ${failureReason}\n\nRecommend the recovery strategy for this failure mode.`,
    ...llmOptions,
  });
  return { ...validateStrategy(data), model };
}

/**
 * Resolve one LLM strategy per unique failure_reason, before any record is
 * processed. At most 4 real API calls per run for this dataset.
 *
 * On failure the cache entry is deliberately LEFT EMPTY rather than filled with
 * table values: diagnose() then falls through to FALLBACK_STRATEGY on its own,
 * so the deterministic logic has exactly one implementation and the two paths
 * cannot drift.
 *
 * Returns a manifest suitable for embedding in the run report, so a reviewer can
 * see whether a given run's numbers came from the model or from the table.
 */
async function warmStrategyCache({ failureReasons = [], logger = console, ...llmOptions } = {}) {
  const unique = [...new Set(failureReasons)].filter(
    (reason) => typeof reason === 'string' && reason.trim()
  );

  return Promise.all(
    unique.map(async (failureReason) => {
      try {
        const strategy = await fetchStrategy(failureReason, llmOptions);
        strategyCache.set(failureReason, strategy);
        const { model, ...fields } = strategy;
        return { failure_reason: failureReason, source: 'llm', model, ...fields };
      } catch (err) {
        const cause = err instanceof LlmError ? err.message : `unexpected error: ${err.message}`;
        const table = FALLBACK_STRATEGY[failureReason];
        fallbackLog.push({ failure_reason: failureReason, fallback_reason: cause });
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            `[recovery-agent] LLM diagnosis for "${failureReason}" failed (${cause}) — ` +
              'falling back to the deterministic rule table.'
          );
        }
        return {
          failure_reason: failureReason,
          source: table ? 'fallback_table' : 'fallback_unknown_reason',
          fallback_reason: cause,
          ...(table || UNKNOWN_FALLBACK),
        };
      }
    })
  );
}

// Record-level modulation. Stays deterministic in both the LLM and fallback
// paths — it must, for --seed reproducibility — and was never LLM territory:
// the model reasons about the failure mode, this reasons about this customer.
function applyRecordContext(base, { amount, rungIndex, priorOutcomes }) {
  const notes = [];
  let { diagnosis, intervention, urgency, confidence } = base;

  // A Rs.5,000 abandonment is not the same problem as a Rs.200 one.
  if (Number.isFinite(amount) && amount >= HIGH_VALUE_THRESHOLD_PAISE) {
    diagnosis = 'high_value_at_risk';
    urgency = 'high';
    if (!EXPENSIVE_INTERVENTIONS.has(intervention)) {
      intervention = 'personal_call_offer';
      notes.push(
        `${rupees(amount)} is at or above the ${rupees(HIGH_VALUE_THRESHOLD_PAISE)} high-value ` +
          'threshold — re-diagnosed as high_value_at_risk and upgraded to personal_call_offer.'
      );
    } else {
      notes.push(
        `${rupees(amount)} is at or above the ${rupees(HIGH_VALUE_THRESHOLD_PAISE)} high-value ` +
          'threshold — re-diagnosed as high_value_at_risk.'
      );
    }
  }

  // Never spend on a discount or a phone call before the free nudges have failed.
  if (EXPENSIVE_INTERVENTIONS.has(intervention) && rungIndex < ESCALATION_RUNG_INDEX) {
    notes.push(
      `${intervention} withheld until rung ${ESCALATION_RUNG_INDEX} (Day 5) — ` +
        `using ${DEFAULT_INTERVENTION} at rung ${rungIndex}.`
    );
    intervention = DEFAULT_INTERVENTION;
  }

  // Repeated silence is evidence the diagnosis was wrong, so confidence must
  // decay — which is what makes low-confidence policy overrides arise naturally
  // on later rungs instead of only in tests.
  const noResponseCount = Array.isArray(priorOutcomes)
    ? priorOutcomes.filter((outcome) => outcome === 'no_response').length
    : 0;
  if (noResponseCount > 0) {
    confidence = round2(Math.max(0, confidence - noResponseCount * CONFIDENCE_DECAY_PER_NO_RESPONSE));
    notes.push(
      `${noResponseCount} prior no_response — confidence decayed to ${confidence.toFixed(2)}.`
    );
  }

  return { diagnosis, intervention, urgency, confidence, notes };
}

/**
 * Synchronous, no I/O. Reads the warmed per-reason strategy if one exists,
 * otherwise the deterministic table, then applies record-level context.
 *
 * `source` reports which path produced the result, so the audit trail shows
 * whether a decision was model-driven or rule-driven.
 */
function diagnose({ failureReason, amount, rungIndex, dayOffset, priorOutcomes = [] } = {}) {
  const cached = strategyCache.get(failureReason);
  const table = FALLBACK_STRATEGY[failureReason];
  const base = cached || table || UNKNOWN_FALLBACK;

  let source;
  if (cached) source = 'llm';
  else if (table) source = 'fallback_table';
  else source = 'fallback_unknown_reason';

  const adjusted = applyRecordContext(base, { amount, rungIndex, priorOutcomes });
  const dayLabel = Number.isFinite(dayOffset) ? `Day ${dayOffset}` : `Rung ${rungIndex}`;

  return {
    diagnosis: adjusted.diagnosis,
    intervention: adjusted.intervention,
    urgency: adjusted.urgency,
    confidence: adjusted.confidence,
    reason: [`${dayLabel}: ${base.reason}`, ...adjusted.notes].join(' '),
    source,
  };
}

function getStrategyManifest() {
  return [...strategyCache.entries()].map(([failureReason, strategy]) => ({
    failure_reason: failureReason,
    source: 'llm',
    ...strategy,
  }));
}

function getFallbackLog() {
  return fallbackLog.map((entry) => ({ ...entry }));
}

module.exports = {
  diagnose,
  warmStrategyCache,
  resetAgentCache,
  getStrategyManifest,
  getFallbackLog,
  validateStrategy,
  INTERVENTIONS,
  DEFAULT_INTERVENTION,
  URGENCIES,
  FALLBACK_STRATEGY,
  UNKNOWN_FALLBACK,
  HIGH_VALUE_THRESHOLD_PAISE,
  CONFIDENCE_DECAY_PER_NO_RESPONSE,
  ESCALATION_RUNG_INDEX,
  SYSTEM_PROMPT,
};
