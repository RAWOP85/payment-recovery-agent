// Minimal Anthropic Messages API client.
//
// Deliberately dependency-free: Node 18+ ships a global fetch, so the real LLM
// call costs zero new npm dependencies. One POST, one attempt, no retry, no SDK
// and no agent framework — the agent needs a single small structured-JSON
// response, and anything more is schedule risk this project cannot absorb.
//
// Every failure mode throws LlmError with a short, human-readable cause so the
// caller can log exactly why it fell back to deterministic rules.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_TOKENS = 400;

class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmError';
  }
}

// The model is asked for bare JSON, but tolerate a fenced or chatty response
// rather than discarding an otherwise-good answer over formatting.
function extractJson(text) {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LlmError('response contained no JSON object');
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    throw new LlmError(`response JSON did not parse: ${err.message}`);
  }
}

function textFromContent(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

// `fetchImpl` is the single injection seam: tests pass a stub, so the suite
// never opens a socket. Nothing else in this module reaches the network.
async function requestJson({
  system,
  prompt,
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.LLM_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    throw new LlmError('ANTHROPIC_API_KEY is not set');
  }
  if (typeof fetchImpl !== 'function') {
    throw new LlmError('no fetch implementation available (Node 18+ required)');
  }

  // A hung API must never stall a live pitch recording, so the call is bounded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new LlmError(`request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError(`request failed: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw new LlmError('fetch returned a malformed response object');
  }
  if (!response.ok) {
    throw new LlmError(`HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new LlmError(`response body was not JSON: ${err.message}`);
  }

  const text = textFromContent(body);
  if (!text.trim()) {
    throw new LlmError('response contained no text block');
  }

  return { data: extractJson(text), model: (body && body.model) || model };
}

module.exports = {
  LlmError,
  requestJson,
  extractJson,
  API_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
};
