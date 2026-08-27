const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, requestJson, LlmError } = require('../src/llm-client');

// Offline: every call here injects `fetchImpl`. The real globalThis.fetch is
// never used and ANTHROPIC_API_KEY is never read.
const TEST_KEY = 'test-key-not-a-real-credential';

function call(fetchImpl, overrides = {}) {
  return requestJson({ system: 's', prompt: 'p', apiKey: TEST_KEY, fetchImpl, ...overrides });
}

function body(text, { model = 'claude-test' } = {}) {
  return { ok: true, status: 200, json: async () => ({ model, content: [{ type: 'text', text }] }) };
}

test('extractJson reads a bare JSON object', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```\nHope that helps!'), { a: 1 });
});

test('extractJson throws when there is no object at all', () => {
  assert.throws(() => extractJson('no json here'), /no JSON object/);
});

test('extractJson throws on an unparseable object', () => {
  assert.throws(() => extractJson('{"a": }'), /did not parse/);
});

test('requestJson returns the parsed object and the model that answered', async () => {
  const result = await call(async () => body('{"a":1}', { model: 'claude-x' }));
  assert.deepEqual(result.data, { a: 1 });
  assert.equal(result.model, 'claude-x');
});

test('requestJson refuses to call out without an API key', async () => {
  let called = false;
  await assert.rejects(
    // Empty string, not undefined: a default parameter fires on `undefined`, so
    // `apiKey: undefined` would silently pick up a real ANTHROPIC_API_KEY from
    // the developer's environment and stop testing what this claims to test.
    call(
      async () => {
        called = true;
        return body('{}');
      },
      { apiKey: '' }
    ),
    /ANTHROPIC_API_KEY is not set/
  );
  assert.equal(called, false, 'must not open a connection without a key');
});

test('requestJson surfaces an HTTP failure as an LlmError', async () => {
  await assert.rejects(
    call(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    (err) => err instanceof LlmError && /HTTP 503/.test(err.message)
  );
});

test('requestJson reports an abort as a timeout', async () => {
  await assert.rejects(
    call(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }),
    /timed out after/
  );
});

test('requestJson rejects a response with no text block', async () => {
  await assert.rejects(
    call(async () => ({ ok: true, status: 200, json: async () => ({ content: [] }) })),
    /no text block/
  );
});

test('requestJson passes an abort signal so a hung API cannot stall a run', async () => {
  let seenSignal = null;
  await call(async (_url, options) => {
    seenSignal = options.signal;
    return body('{"a":1}');
  });
  assert.ok(seenSignal, 'an AbortSignal must be supplied');
  assert.equal(seenSignal.aborted, false);
});
