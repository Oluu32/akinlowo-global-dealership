import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantHandler, createRateLimiter } from '../supabase/functions/dealership-assistant/assistant-core.mjs';

const KEY = 'groq-test-key-never-printed';
const TOKEN = 'user-access-token-'.padEnd(40, 'x');
const ORIGIN = 'https://dealer.example';

const user = content => ({ role: 'user', content });
const post = (messages, overrides = {}) => ({
  method: 'POST',
  origin: ORIGIN,
  authorization: `Bearer ${TOKEN}`,
  bodyText: JSON.stringify({ messages }),
  ...overrides
});

function groqReply(content = 'Ask the Sales screen for a new sale.') {
  return async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
}

function buildHandler({ fetchImpl = groqReply(), authorize, groqApiKey = KEY, rateLimiter, allowedOrigins = [ORIGIN] } = {}) {
  return createAssistantHandler({
    authorize: authorize ?? (async token => (token === TOKEN ? { id: 'user-1' } : Promise.reject(new Error('bad token')))),
    fetchImpl,
    groqApiKey,
    allowedOrigins,
    rateLimiter,
    model: 'test-model'
  });
}

test('answers an authorised message with the assistant reply', async () => {
  const handler = buildHandler();
  const result = await handler(post([user('  How do I create an invoice? ')]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { reply: 'Ask the Sales screen for a new sale.' });
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(result.body).includes(KEY), false);
});

test('forwards only the conversation to the provider', async () => {
  let sent;
  const handler = buildHandler({
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    }
  });
  await handler(post([user('hello')]));
  assert.equal(sent.model, 'test-model');
  assert.deepEqual(sent.messages.slice(1), [user('hello')]);
  assert.deepEqual(Object.keys(sent).sort(), ['max_tokens', 'messages', 'model', 'n', 'stream', 'temperature', 'top_p']);
  assert.equal(JSON.stringify(sent.messages.slice(1)).includes('buyerName'), false);
  assert.equal(JSON.stringify(sent.messages.slice(1)).includes('demo-car'), false);
});

test('answers CORS preflight only for allowed origins', async () => {
  const handler = buildHandler();
  const allowed = await handler({ method: 'OPTIONS', origin: ORIGIN });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.body, null);
  assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);

  const blocked = await handler({ method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
});

test('blocks requests from an origin that is not allowlisted', async () => {
  const handler = buildHandler();
  const result = await handler(post([user('hello')], { origin: 'https://evil.example' }));
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'origin_not_allowed');
});

test('rejects missing, malformed and invalid sessions', async () => {
  const handler = buildHandler();
  const missing = await handler(post([user('hello')], { authorization: '' }));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'missing_token');

  const malformed = await handler(post([user('hello')], { authorization: 'Basic abcdefghijklmnopqrstuvwxyz' }));
  assert.equal(malformed.status, 401);

  const invalid = await handler(post([user('hello')], { authorization: `Bearer ${'z'.repeat(40)}` }));
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.error.code, 'invalid_token');
  assert.equal(JSON.stringify(invalid.body).includes('bad token'), false);
});

test('rejects a verified user outside the allowlist', async () => {
  const handler = buildHandler({ authorize: async () => ({ id: 'user-2', authorised: false }) });
  const result = await handler(post([user('hello')]));
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'not_authorized_user');
});

test('fails honestly when no provider key is configured', async () => {
  const handler = buildHandler({ groqApiKey: '' });
  const result = await handler(post([user('hello')]));
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'not_configured');
});

test('rejects unsupported methods', async () => {
  const handler = buildHandler();
  const result = await handler({ method: 'GET', origin: ORIGIN });
  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, 'POST, OPTIONS');
});

test('rejects invalid JSON, oversized bodies and invalid payloads before calling the provider', async () => {
  let called = false;
  const handler = buildHandler({
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
    }
  });
  const badJson = await handler(post([], { bodyText: '{not json' }));
  assert.equal(badJson.status, 400);

  const huge = await handler(post([], { bodyText: 'x'.repeat(30000) }));
  assert.equal(huge.status, 413);

  const tooLong = await handler(post([user('x'.repeat(1300))]));
  assert.equal(tooLong.status, 413);

  const noMessages = await handler(post([]));
  assert.equal(noMessages.status, 400);

  const endsWithAssistant = await handler(post([user('q'), { role: 'assistant', content: 'a' }]));
  assert.equal(endsWithAssistant.status, 400);

  assert.equal(called, false);
});

test('rate limits one signed-in user without affecting another', async () => {
  const handler = buildHandler({
    rateLimiter: createRateLimiter({ limit: 2 }),
    authorize: async token => ({ id: token === `Bearer ${TOKEN}` ? 'user-1' : 'user-1' })
  });
  assert.equal((await handler(post([user('one')]))).status, 200);
  assert.equal((await handler(post([user('two')]))).status, 200);
  const limited = await handler(post([user('three')]));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});

test('converts provider failures into safe errors', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401, json: async () => ({ error: { message: KEY } }) }), 502],
    [async () => ({ ok: false, status: 429, json: async () => ({ error: { message: KEY } }) }), 429],
    [async () => ({ ok: false, status: 500, json: async () => ({ error: { message: KEY } }) }), 502],
    [async () => { throw new TypeError('network down'); }, 502],
    [async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }), 502]
  ];
  for (const [fetchImpl, expected] of cases) {
    const handler = buildHandler({ fetchImpl });
    const result = await handler(post([user('hello')]));
    assert.equal(result.status, expected);
    assert.equal(typeof result.body.error.message, 'string');
    assert.equal(JSON.stringify(result.body).includes(KEY), false);
    assert.equal(JSON.stringify(result.body).includes('network down'), false);
  }
});

test('never includes provider text or the key in any response header', async () => {
  const handler = buildHandler({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: `invalid ${KEY}` } }) })
  });
  const result = await handler(post([user('hello')]));
  const serialized = JSON.stringify(result.headers) + JSON.stringify(result.body);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.toLowerCase().includes('bearer'), false);
});
