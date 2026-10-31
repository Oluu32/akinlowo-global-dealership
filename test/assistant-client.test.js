import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_COPY,
  ASSISTANT_MAX_CHARS,
  ASSISTANT_MAX_HISTORY,
  buildRequestMessages,
  createAssistantClient,
  isAllowedEndpoint,
  readAssistantConfig
} from '../assistant-client.js';

const ENDPOINT = 'https://project.supabase.co/functions/v1/dealership-assistant';
const TOKEN = 'session-access-token';

function config(overrides = {}) {
  return { endpoint: ENDPOINT, getAccessToken: async () => TOKEN, ...overrides };
}

function okReply(text = 'Open Documents and press print.') {
  return async () => ({ ok: true, status: 200, json: async () => ({ reply: text }) });
}

test('reads a runtime config and refuses unsafe or incomplete ones', () => {
  const scope = {
    location: { href: 'https://dealer.example/app/' },
    AKINLOWO_ASSISTANT: { endpoint: ENDPOINT, getAccessToken: () => 't' }
  };
  const parsed = readAssistantConfig(scope);
  assert.equal(parsed.endpoint, ENDPOINT);

  assert.equal(readAssistantConfig({ location: scope.location }), null);
  assert.equal(readAssistantConfig({ location: scope.location, AKINLOWO_ASSISTANT: { endpoint: ENDPOINT } }), null);
  assert.equal(readAssistantConfig({ location: scope.location, AKINLOWO_ASSISTANT: { endpoint: 'http://evil.example/assistant', getAccessToken: () => 't' } }), null);
  assert.equal(readAssistantConfig({ location: scope.location, AKINLOWO_ASSISTANT: { endpoint: 'javascript:alert(1)', getAccessToken: () => 't' } }), null);
});

test('accepts https and same-origin development endpoints only', () => {
  const httpsPage = { href: 'https://dealer.example/' };
  assert.equal(isAllowedEndpoint(ENDPOINT, httpsPage), true);
  assert.equal(isAllowedEndpoint('/assistant', httpsPage), true);
  assert.equal(isAllowedEndpoint('http://localhost:8787/assistant', httpsPage), true);
  assert.equal(isAllowedEndpoint('http://127.0.0.1:8787/assistant', httpsPage), true);
  assert.equal(isAllowedEndpoint('http://dealer.example/assistant', httpsPage), false);
  assert.equal(isAllowedEndpoint('https://user:pass@dealer.example/assistant', httpsPage), false);
  assert.equal(isAllowedEndpoint('', httpsPage), false);
});

test('sends only the typed conversation and the session token', async () => {
  const calls = [];
  const client = createAssistantClient({
    config: config(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ reply: '  Use Inventory → Add vehicle.  ' }) };
    }
  });
  const history = [
    { role: 'user', content: 'earlier question', buyerName: 'Do not send me', vehicleId: 'demo-car-1' },
    { role: 'assistant', content: 'earlier answer' }
  ];
  const result = await client.send('How do I add a vehicle?', history);

  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Use Inventory → Add vehicle.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ['messages']);
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'How do I add a vehicle?' }
  ]);
  assert.equal(calls[0].init.body.includes('demo-car-1'), false);
  assert.equal(calls[0].init.body.includes('Do not send me'), false);
});

test('does nothing and invents nothing when the deployment has no endpoint', async () => {
  let called = false;
  const client = createAssistantClient({
    config: null,
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ reply: 'x' }) };
    }
  });
  const result = await client.send('hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-configured');
  assert.equal(result.message, ASSISTANT_COPY.notConfigured);
  assert.equal(called, false);
});

test('requires a signed-in token before calling the service', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ reply: 'x' }) };
  };
  const signedOut = createAssistantClient({ config: config({ getAccessToken: async () => null }), fetchImpl });
  assert.equal((await signedOut.send('hello')).code, 'signed-out');

  const failingToken = createAssistantClient({ config: config({ getAccessToken: async () => { throw new Error('no session'); } }), fetchImpl });
  assert.equal((await failingToken.send('hello')).code, 'signed-out');
  assert.equal(called, false);
  assert.equal((await signedOut.send('   ')).code, 'empty');
});

test('limits message length before sending', async () => {
  let called = false;
  const client = createAssistantClient({
    config: config(),
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ reply: 'x' }) };
    }
  });
  const result = await client.send('x'.repeat(ASSISTANT_MAX_CHARS + 1));
  assert.equal(result.code, 'too-long');
  assert.equal(called, false);
});

test('caps history and drops leading assistant turns', () => {
  const history = [
    { role: 'assistant', content: 'stray greeting' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }))
  ];
  const messages = buildRequestMessages(history, 'latest');
  assert.equal(messages.length, ASSISTANT_MAX_HISTORY + 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages.at(-1).content, 'latest');
  assert.ok(messages.every(message => Object.keys(message).every(key => key === 'role' || key === 'content')));
});

test('maps failures to honest, non-leaking messages', async () => {
  const leak = 'invalid api key gsk_live_secret_provider_text';
  const cases = [
    [401, { error: { message: leak } }, 'signed-out'],
    [403, { error: { message: leak } }, 'not-authorised'],
    [404, { error: { message: leak } }, 'not-configured'],
    [429, { error: { message: leak } }, 'busy'],
    [400, { error: { message: leak } }, 'rejected'],
    [500, { error: { message: leak } }, 'unavailable']
  ];
  for (const [status, payload, code] of cases) {
    const client = createAssistantClient({
      config: config(),
      fetchImpl: async () => ({ ok: false, status, json: async () => payload })
    });
    const result = await client.send('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.message.includes('gsk_live_secret_provider_text'), false);
    assert.equal(result.message.includes('api key'), false);
  }
});

test('reports an empty reply instead of inventing one', async () => {
  const client = createAssistantClient({
    config: config(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ reply: '   ' }) })
  });
  const result = await client.send('hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'empty-reply');
});

test('distinguishes offline errors from timeouts', async () => {
  const offline = createAssistantClient({
    config: config(),
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  assert.equal((await offline.send('hello')).code, 'offline');

  const hanging = createAssistantClient({
    config: config(),
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  const result = await hanging.send('hello');
  assert.equal(result.code, 'timed-out');
  assert.equal(result.message, ASSISTANT_COPY.timedOut);
});
