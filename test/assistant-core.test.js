import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_LIMITS,
  DEFAULT_GROQ_MODEL,
  GROQ_URL,
  SAFE_ERRORS,
  buildGroqPayload,
  buildSystemPrompt,
  corsHeaders,
  createRateLimiter,
  errorBody,
  extractReply,
  mapUpstreamStatus,
  parseAllowedOrigins,
  requestGroq,
  validatePayload
} from '../supabase/functions/dealership-assistant/assistant-core.mjs';

const user = content => ({ role: 'user', content });

test('system prompt scopes the assistant to dealership support without invented data', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Never invent records/);
  assert.match(prompt, /cannot perform actions/);
  assert.match(prompt, /AGI-INV-YYYY-0001/);
  assert.match(prompt, /AGI-RCT-YYYY-0001/);
  assert.match(prompt, /customer personal data/);
  assert.match(prompt, /not tax advice/);
});

test('the prompt forbids inventing numbering or screen behaviour', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /never resets that counter/);
  assert.match(prompt, /Do not extrapolate details such as when numbering counters reset/);
});

test('validates a normal conversation and trims content', () => {
  const result = validatePayload({ messages: [user('  How do I create an invoice?  ')] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, [user('How do I create an invoice?')]);
});

test('accepts a bounded assistant/user history', () => {
  const messages = [user('q1'), { role: 'assistant', content: 'a1' }, user('q2')];
  const result = validatePayload({ messages });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 3);
});

test('rejects malformed payloads, unknown roles and empty content', () => {
  assert.equal(validatePayload(null).ok, false);
  assert.equal(validatePayload({}).ok, false);
  assert.equal(validatePayload({ messages: [] }).code, 'invalid_request');
  assert.equal(validatePayload({ messages: [{ role: 'system', content: 'x' }] }).code, 'invalid_request');
  assert.equal(validatePayload({ messages: [user('   ')] }).code, 'invalid_request');
  assert.equal(validatePayload({ messages: [{ role: 'user', content: 42 }] }).code, 'invalid_request');
  assert.equal(validatePayload({ messages: [{ role: 'assistant', content: 'a' }, user('q')] }).code, 'invalid_request');
  assert.equal(validatePayload({ messages: [user('q'), { role: 'assistant', content: 'a' }] }).code, 'invalid_request');
});

test('rejects over-long messages and over-long histories', () => {
  const long = 'x'.repeat(ASSISTANT_LIMITS.maxMessageChars + 1);
  assert.equal(validatePayload({ messages: [user(long)] }).code, 'payload_too_large');
  const many = Array.from({ length: ASSISTANT_LIMITS.maxHistoryMessages + 2 }, (_, i) => user(`m${i}`));
  assert.equal(validatePayload({ messages: many }).code, 'invalid_request');
});

test('assembles a Groq payload with the system prompt first and no secret', () => {
  const body = buildGroqPayload({ messages: [user('hello')] });
  assert.equal(body.model, DEFAULT_GROQ_MODEL);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'hello');
  assert.equal(body.stream, false);
  assert.ok(body.max_tokens <= 1000);
  assert.ok(!('apiKey' in body) && !('api_key' in body));
  assert.equal(JSON.stringify(body).includes('GROQ_API_KEY'), false);
});

test('extracts a trimmed reply and rejects empty or malformed payloads', () => {
  assert.equal(extractReply({ choices: [{ message: { content: '  Hello  ' } }] }), 'Hello');
  assert.throws(() => extractReply({ choices: [] }), { code: 'upstream_bad_response' });
  assert.throws(() => extractReply({ choices: [{ message: { content: '   ' } }] }), { code: 'upstream_bad_response' });
});

test('maps upstream statuses to safe assistant codes', () => {
  assert.equal(mapUpstreamStatus(401), 'upstream_auth');
  assert.equal(mapUpstreamStatus(403), 'upstream_auth');
  assert.equal(mapUpstreamStatus(429), 'upstream_rate_limited');
  assert.equal(mapUpstreamStatus(404), 'upstream_bad_response');
  assert.equal(mapUpstreamStatus(500), 'upstream_unavailable');
  assert.equal(mapUpstreamStatus(503), 'upstream_unavailable');
});

test('CORS allows only listed origins and never uses a wildcard', () => {
  const allowed = corsHeaders('https://dealer.example', ['https://dealer.example']);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://dealer.example');
  assert.equal(allowed.headers['access-control-allow-methods'], 'POST, OPTIONS');

  const blocked = corsHeaders('https://evil.example', ['https://dealer.example']);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);

  const serverToServer = corsHeaders('', ['https://dealer.example']);
  assert.equal(serverToServer.allowed, true);
  assert.equal(serverToServer.headers['access-control-allow-origin'], undefined);
});

test('parses an origin allowlist from a comma-separated env value', () => {
  assert.deepEqual(parseAllowedOrigins(' https://a.example , https://b.example/ '), [
    'https://a.example',
    'https://b.example'
  ]);
  assert.deepEqual(parseAllowedOrigins(''), []);
});

test('safe error bodies never carry internal detail', () => {
  const body = errorBody('invalid_token');
  assert.equal(body.error.code, 'invalid_token');
  assert.equal(body.error.message, SAFE_ERRORS.invalid_token.message);
  assert.equal(JSON.stringify(body).includes('supabase'), false);
  assert.equal(errorBody('unknown_code').error.code, 'server_error');
});

test('rate limiter allows the configured number of messages per user', () => {
  let clock = 1000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000, now: () => clock });
  assert.equal(limiter.check('user-a').allowed, true);
  assert.equal(limiter.check('user-a').allowed, true);
  const blocked = limiter.check('user-a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.check('user-b').allowed, true);
  clock += 61000;
  assert.equal(limiter.check('user-a').allowed, true);
});

test('requestGroq sends the key only in the Authorization header', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Reply' } }] }) };
  };
  const reply = await requestGroq({ apiKey: 'secret-key-value', body: { model: 'm' }, fetchImpl });
  assert.equal(reply, 'Reply');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GROQ_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key-value');
  assert.equal(calls[0].init.body.includes('secret-key-value'), false);
});

test('requestGroq maps provider failures without leaking the key', async () => {
  const failing = status => async () => ({ ok: false, status, json: async () => ({ error: { message: 'bad key secret-key-value' } }) });
  await assert.rejects(requestGroq({ apiKey: 'secret-key-value', body: {}, fetchImpl: failing(401) }), { code: 'upstream_auth' });
  await assert.rejects(requestGroq({ apiKey: 'secret-key-value', body: {}, fetchImpl: failing(429) }), { code: 'upstream_rate_limited' });
  await assert.rejects(requestGroq({ apiKey: 'secret-key-value', body: {}, fetchImpl: failing(500) }), { code: 'upstream_unavailable' });
  await assert.rejects(requestGroq({ apiKey: 'secret-key-value', body: {}, fetchImpl: async () => { throw new TypeError('network down'); } }), { code: 'upstream_unavailable' });
  await assert.rejects(requestGroq({ apiKey: '', body: {}, fetchImpl: async () => ({ ok: true }) }), { code: 'upstream_auth' });
});

test('requestGroq times out a hanging provider', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(requestGroq({ apiKey: 'k'.repeat(20), body: {}, fetchImpl, timeoutMs: 20 }), { code: 'upstream_unavailable' });
});
