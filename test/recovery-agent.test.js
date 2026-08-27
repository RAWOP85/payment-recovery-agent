const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  diagnose,
  warmStrategyCache,
  resetAgentCache,
  getFallbackLog,
  getStrategyManifest,
  validateStrategy,
  FALLBACK_STRATEGY,
  INTERVENTIONS,
  DEFAULT_INTERVENTION,
  HIGH_VALUE_THRESHOLD_PAISE,
} = require('../src/recovery-agent');

// Every test in this file is offline. The LLM transport is reached only through
// an injected `fetchImpl`; nothing here reads ANTHROPIC_API_KEY or touches the
// real globalThis.fetch (one test deliberately poisons it to prove that).
const SILENT = { warn() {} };
const TEST_KEY = 'test-key-not-a-real-credential';

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

// Shapes a body the way the Anthropic Messages API does.
function anthropicResponse(payload, { model = 'claude-test', ok = true, status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok,
    status,
    json: async () => ({ model, content: [{ type: 'text', text }] }),
  };
}

const VALID_STRATEGY = {
  diagnosis: 'liquidity_gap',
  intervention: 'discount_incentive',
  urgency: 'high',
  confidence: 0.91,
  reason: 'Model-supplied rationale for this failure mode.',
};

function warmWith(handler, failureReasons, extra = {}) {
  const fetchImpl = stubFetch(handler);
  return {
    fetchImpl,
    promise: warmStrategyCache({
      failureReasons,
      logger: SILENT,
      apiKey: TEST_KEY,
      fetchImpl,
      ...extra,
    }),
  };
}

beforeEach(() => {
  resetAgentCache();
});

// --- the offline guarantee -------------------------------------------------

test('diagnose performs no network I/O — a poisoned global fetch is never called', () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error('diagnose() must never reach the network');
  };

  try {
    for (const failureReason of Object.keys(FALLBACK_STRATEGY)) {
      for (let rungIndex = 0; rungIndex < 4; rungIndex++) {
        const result = diagnose({ failureReason, amount: 50000, rungIndex, dayOffset: 0 });
        assert.ok(!(result instanceof Promise), 'diagnose must be synchronous');
      }
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('warmStrategyCache makes exactly one call per unique failure_reason', async () => {
  // 120 records, 4 unique reasons — the real dataset's shape.
  const reasons = Object.keys(FALLBACK_STRATEGY);
  const failureReasons = Array.from({ length: 120 }, (_, i) => reasons[i % reasons.length]);

  const { fetchImpl, promise } = warmWith(() => anthropicResponse(VALID_STRATEGY), failureReasons);
  await promise;

  assert.equal(fetchImpl.calls.length, 4, 'one call per unique reason, not per record');

  // And the cache genuinely serves every subsequent lookup.
  for (let i = 0; i < 500; i++) {
    diagnose({
      failureReason: failureReasons[i % failureReasons.length],
      rungIndex: i % 4,
      dayOffset: 0,
    });
  }
  assert.equal(fetchImpl.calls.length, 4, 'diagnose must never trigger an additional call');
});

test('warmStrategyCache sends the failure_reason and required auth headers', async () => {
  const { fetchImpl, promise } = warmWith(() => anthropicResponse(VALID_STRATEGY), ['otp_timeout']);
  await promise;

  const [call] = fetchImpl.calls;
  assert.match(call.url, /api\.anthropic\.com/);
  assert.equal(call.options.headers['x-api-key'], TEST_KEY);
  assert.ok(call.options.headers['anthropic-version']);

  const body = JSON.parse(call.options.body);
  // temperature/top_p/top_k are removed (400) on the Claude 5 family models this
  // project targets, so the request body must not send temperature at all.
  assert.equal(body.temperature, undefined);
  assert.match(body.messages[0].content, /otp_timeout/);
});

// --- the LLM path ----------------------------------------------------------

test('diagnose uses the warmed LLM strategy and reports source "llm"', async () => {
  const { promise } = warmWith(() => anthropicResponse(VALID_STRATEGY), ['insufficient_funds']);
  await promise;

  const result = diagnose({
    failureReason: 'insufficient_funds',
    amount: 50000,
    rungIndex: 3,
    dayOffset: 7,
  });

  assert.equal(result.source, 'llm');
  assert.equal(result.diagnosis, 'liquidity_gap');
  assert.equal(result.intervention, 'discount_incentive');
  assert.equal(result.urgency, 'high');
  assert.equal(result.confidence, 0.91);
  assert.match(result.reason, /Model-supplied rationale/);
});

test('a fenced or chatty LLM response is still parsed', async () => {
  const chatty = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(VALID_STRATEGY)}\n\`\`\``;
  const { promise } = warmWith(() => anthropicResponse(chatty), ['card_declined']);
  await promise;

  assert.equal(
    diagnose({ failureReason: 'card_declined', rungIndex: 3, dayOffset: 7 }).source,
    'llm'
  );
});

test('the warm-up manifest reports what each reason resolved to', async () => {
  const { promise } = warmWith(() => anthropicResponse(VALID_STRATEGY), ['otp_timeout']);
  const manifest = await promise;

  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].failure_reason, 'otp_timeout');
  assert.equal(manifest[0].source, 'llm');
  assert.equal(manifest[0].model, 'claude-test');
  assert.equal(getStrategyManifest().length, 1);
});

// --- the fallback path -----------------------------------------------------

const FAILURE_CASES = [
  {
    name: 'the network throws',
    handler: () => {
      throw new Error('ECONNREFUSED');
    },
    expect: /request failed/,
  },
  {
    name: 'the request times out',
    handler: () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
    expect: /timed out/,
  },
  {
    name: 'the API returns a non-2xx status',
    handler: () => ({ ok: false, status: 500, json: async () => ({}) }),
    expect: /HTTP 500/,
  },
  {
    name: 'the body is not JSON',
    handler: () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    }),
    expect: /was not JSON/,
  },
  {
    name: 'the text contains no JSON object',
    handler: () => anthropicResponse('I am afraid I cannot help with that.'),
    expect: /no JSON object/,
  },
  {
    name: 'the intervention is not on the whitelist',
    handler: () => anthropicResponse({ ...VALID_STRATEGY, intervention: 'send_a_courier' }),
    expect: /not on the whitelist/,
  },
  {
    name: 'the confidence is out of range',
    handler: () => anthropicResponse({ ...VALID_STRATEGY, confidence: 4.2 }),
    expect: /not a number in \[0, 1\]/,
  },
  {
    name: 'the confidence is not a number',
    handler: () => anthropicResponse({ ...VALID_STRATEGY, confidence: 'very high' }),
    expect: /not a number in \[0, 1\]/,
  },
  {
    name: 'a required field is missing',
    handler: () => anthropicResponse({ intervention: 'sms_nudge', confidence: 0.9 }),
    expect: /diagnosis/,
  },
  {
    name: 'the urgency is not recognised',
    handler: () => anthropicResponse({ ...VALID_STRATEGY, urgency: 'catastrophic' }),
    expect: /urgency/,
  },
];

for (const { name, handler, expect } of FAILURE_CASES) {
  test(`falls back to the rule table when ${name}`, async () => {
    const { promise } = warmWith(handler, ['insufficient_funds']);
    const manifest = await promise;

    assert.equal(manifest[0].source, 'fallback_table');
    assert.match(manifest[0].fallback_reason, expect);

    const log = getFallbackLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].failure_reason, 'insufficient_funds');
    assert.match(log[0].fallback_reason, expect);

    // The deterministic table result, unchanged.
    const result = diagnose({ failureReason: 'insufficient_funds', rungIndex: 3, dayOffset: 7 });
    assert.equal(result.source, 'fallback_table');
    assert.equal(result.diagnosis, FALLBACK_STRATEGY.insufficient_funds.diagnosis);
    assert.equal(result.intervention, FALLBACK_STRATEGY.insufficient_funds.intervention);
    assert.equal(result.confidence, FALLBACK_STRATEGY.insufficient_funds.confidence);
  });
}

test('falls back when no API key is configured, without touching the network', async () => {
  const fetchImpl = stubFetch(() => {
    throw new Error('must not be called without a key');
  });
  // Empty string, not undefined: a default parameter fires on `undefined`, so
  // `apiKey: undefined` would silently pick up a real ANTHROPIC_API_KEY from the
  // developer's environment and this test would stop testing the no-key path.
  const manifest = await warmStrategyCache({
    failureReasons: ['otp_timeout'],
    logger: SILENT,
    apiKey: '',
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(manifest[0].source, 'fallback_table');
  assert.match(manifest[0].fallback_reason, /ANTHROPIC_API_KEY is not set/);
});

test('a fallback is logged so the run reports it rather than hiding it', async () => {
  const warnings = [];
  await warmStrategyCache({
    failureReasons: ['card_declined'],
    logger: { warn: (msg) => warnings.push(msg) },
    apiKey: TEST_KEY,
    fetchImpl: stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) })),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /card_declined/);
  assert.match(warnings[0], /HTTP 429/);
  assert.match(warnings[0], /deterministic rule table/);
});

test('one reason falling back does not poison the reasons that succeeded', async () => {
  const { promise } = warmWith(
    (_url, options) =>
      JSON.parse(options.body).messages[0].content.includes('otp_timeout')
        ? { ok: false, status: 500, json: async () => ({}) }
        : anthropicResponse(VALID_STRATEGY),
    ['otp_timeout', 'card_declined']
  );
  await promise;

  assert.equal(
    diagnose({ failureReason: 'otp_timeout', rungIndex: 3, dayOffset: 7 }).source,
    'fallback_table'
  );
  assert.equal(
    diagnose({ failureReason: 'card_declined', rungIndex: 3, dayOffset: 7 }).source,
    'llm'
  );
});

// --- the deterministic table, used directly (cold cache) -------------------

test('a cold cache diagnoses every known reason from the rule table', () => {
  for (const [failureReason, expected] of Object.entries(FALLBACK_STRATEGY)) {
    const result = diagnose({ failureReason, amount: 50000, rungIndex: 3, dayOffset: 7 });
    assert.equal(result.source, 'fallback_table');
    assert.equal(result.diagnosis, expected.diagnosis);
    assert.equal(result.intervention, expected.intervention);
    assert.ok(INTERVENTIONS.includes(result.intervention));
  }
});

test('an unrecognised failure_reason degrades to a low-confidence default instead of throwing', () => {
  const result = diagnose({
    failureReason: 'meteor_strike',
    amount: 50000,
    rungIndex: 0,
    dayOffset: 0,
  });
  assert.equal(result.source, 'fallback_unknown_reason');
  assert.equal(result.intervention, DEFAULT_INTERVENTION);
  assert.equal(result.confidence, 0.3);
  assert.equal(result.diagnosis, 'unclassified_failure');
});

// --- record-level modulation (identical on both paths) ---------------------

test('high-value records are re-diagnosed and upgraded to a personal call offer', () => {
  const result = diagnose({
    failureReason: 'checkout_abandoned',
    amount: HIGH_VALUE_THRESHOLD_PAISE,
    rungIndex: 3,
    dayOffset: 7,
  });
  assert.equal(result.diagnosis, 'high_value_at_risk');
  assert.equal(result.intervention, 'personal_call_offer');
  assert.equal(result.urgency, 'high');
  assert.match(result.reason, /high-value/);
});

test('a record just below the high-value threshold is left alone', () => {
  const result = diagnose({
    failureReason: 'checkout_abandoned',
    amount: HIGH_VALUE_THRESHOLD_PAISE - 1,
    rungIndex: 3,
    dayOffset: 7,
  });
  assert.equal(result.diagnosis, 'attention_lapse');
  assert.equal(result.intervention, 'sms_nudge');
});

test('expensive interventions are withheld until the later rungs', () => {
  for (const rungIndex of [0, 1]) {
    const early = diagnose({
      failureReason: 'insufficient_funds',
      amount: 50000,
      rungIndex,
      dayOffset: 0,
    });
    assert.equal(early.intervention, DEFAULT_INTERVENTION);
    assert.match(early.reason, /withheld until rung 2/);
  }
  for (const rungIndex of [2, 3]) {
    const late = diagnose({
      failureReason: 'insufficient_funds',
      amount: 50000,
      rungIndex,
      dayOffset: 5,
    });
    assert.equal(late.intervention, 'discount_incentive');
  }
});

test('confidence decays with each prior no_response', () => {
  const base = diagnose({ failureReason: 'otp_timeout', amount: 5000, rungIndex: 0, dayOffset: 0 });
  const decayed = diagnose({
    failureReason: 'otp_timeout',
    amount: 5000,
    rungIndex: 3,
    dayOffset: 7,
    priorOutcomes: ['no_response', 'no_response'],
  });

  assert.equal(base.confidence, 0.8);
  assert.equal(decayed.confidence, 0.5);
  assert.match(decayed.reason, /2 prior no_response/);
});

test('confidence decay is floored at zero', () => {
  const result = diagnose({
    failureReason: 'checkout_abandoned',
    amount: 5000,
    rungIndex: 3,
    dayOffset: 7,
    priorOutcomes: Array(20).fill('no_response'),
  });
  assert.ok(result.confidence >= 0);
});

test('diagnose never returns an intervention outside the whitelist', () => {
  const amounts = [100, 149999, HIGH_VALUE_THRESHOLD_PAISE, 999999];
  const reasons = [...Object.keys(FALLBACK_STRATEGY), 'meteor_strike'];
  for (const failureReason of reasons) {
    for (const amount of amounts) {
      for (let rungIndex = 0; rungIndex < 4; rungIndex++) {
        const result = diagnose({ failureReason, amount, rungIndex, dayOffset: 0 });
        assert.ok(
          INTERVENTIONS.includes(result.intervention),
          `${failureReason}/${amount}/rung ${rungIndex} produced ${result.intervention}`
        );
      }
    }
  }
});

// --- validateStrategy, exercised directly ----------------------------------

test('validateStrategy accepts a well-formed strategy and rounds confidence', () => {
  const validated = validateStrategy({ ...VALID_STRATEGY, confidence: 0.876 });
  assert.equal(validated.confidence, 0.88);
  assert.equal(validated.intervention, 'discount_incentive');
});

test('validateStrategy rejects a non-object', () => {
  assert.throws(() => validateStrategy(null), /not a JSON object/);
  assert.throws(() => validateStrategy([VALID_STRATEGY]), /not a JSON object/);
});
