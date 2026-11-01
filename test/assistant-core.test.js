import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_LIMITS,
  DEFAULT_GROQ_MODEL,
  GROQ_URL,
  SAFE_ERRORS,
  buildGroqPayload,
  buildSystemPrompt,
  ASSISTANT_TOOLS,
  corsHeaders,
  createAssistantHandler,
  createRateLimiter,
  errorBody,
  extractMessage,
  extractReply,
  mapUpstreamStatus,
  parseAllowedOrigins,
  readDeskAction,
  requestGroq,
  validatePayload
} from '../supabase/functions/dealership-assistant/assistant-core.mjs';

const user = content => ({ role: 'user', content });

test('system prompt scopes the assistant to desk work without invented data', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Never invent records/);
  assert.match(prompt, /they do not save anything/);
  assert.match(prompt, /nothing is written until they press Approve/);
  assert.match(prompt, /AGI-INV-YYYY-0001/);
  assert.match(prompt, /AGI-RCT-YYYY-0001/);
  assert.match(prompt, /customer personal data/);
  assert.match(prompt, /not tax advice/);
});

test('the prompt names the three tools and forbids claiming a saved record', () => {
  const prompt = buildSystemPrompt();
  for (const name of ['create_sale', 'add_vehicle', 'open_document']) assert.match(prompt, new RegExp(name));
  assert.match(prompt, /ask one short question instead/);
  assert.match(prompt, /It is prepared, and the person approves it/);
  assert.match(prompt, /cannot edit or delete a saved record/);
});

test('the prompt forbids inventing numbering or screen behaviour', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /never restarts and never reuses a number/);
  assert.match(prompt, /Do not invent buttons, menus, searches/);
  assert.match(prompt, /Never write an example document number/);
});

test('the prompt describes the controls the desk actually has', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Invoice \(opens the invoice print view\)/);
  assert.match(prompt, /Record payment \(shown only while a balance remains/);
  assert.match(prompt, /no search, sort, edit or send control/);
  assert.match(prompt, /every signed-in account reads and edits the same desk/);
  assert.match(prompt, /"Track VAT on this desk" switch that is off by default/);
  assert.match(prompt, /deletes every vehicle, sale, document, expense and supplier/);
  assert.equal(/demo/i.test(prompt), false);
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
  const { reply, action } = await requestGroq({ apiKey: 'secret-key-value', body: { model: 'm' }, fetchImpl });
  assert.equal(reply, 'Reply');
  assert.equal(action, null);
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

/* ------------------------------------------------------------------ *
 * Desk actions: tools, normalisation and the reply contract.
 * ------------------------------------------------------------------ */
const toolCall = (name, args) => ({
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
});

test('the tool schema exposes exactly the three desk actions', () => {
  const names = ASSISTANT_TOOLS.map(tool => tool.function.name).sort();
  assert.deepEqual(names, ['add_vehicle', 'create_sale', 'open_document']);
  for (const tool of ASSISTANT_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.equal(typeof tool.function.description, 'string');
  }
  const sale = ASSISTANT_TOOLS.find(tool => tool.function.name === 'create_sale');
  assert.deepEqual(sale.function.parameters.required, ['buyer_name', 'vehicle', 'price']);
});

test('a sale tool call is normalised and clamped', () => {
  const action = readDeskAction([toolCall('create_sale', {
    buyer_name: '  Aisha Bello ',
    vehicle: '2021 Toyota Camry',
    price: 24500000,
    amount_paid: 12000000,
    payment_method: 'POS',
    buyer_phone: '0803 555 0111'
  })]);
  assert.equal(action.type, 'create_sale');
  assert.equal(action.buyerName, 'Aisha Bello');
  assert.equal(action.price, 24500000);
  assert.equal(action.amountPaid, 12000000);
  assert.equal(action.paymentMethod, 'POS');

  const overpaid = readDeskAction([toolCall('create_sale', {
    buyer_name: 'A', vehicle: 'B', price: 100, amount_paid: 900
  })]);
  assert.equal(overpaid.amountPaid, 100, 'a payment above the price is capped, not written as a negative balance');
  assert.equal(overpaid.paymentMethod, 'Bank transfer');
});

test('an incomplete sale is refused rather than filled with guesses', () => {
  assert.equal(readDeskAction([toolCall('create_sale', { buyer_name: 'Aisha', vehicle: 'Camry' })]), null);
  assert.equal(readDeskAction([toolCall('create_sale', { buyer_name: 'Aisha', price: 100 })]), null);
  assert.equal(readDeskAction([toolCall('create_sale', { buyer_name: '   ', vehicle: 'Camry', price: 100 })]), null);
  assert.equal(readDeskAction([toolCall('create_sale', { buyer_name: 'A', vehicle: 'B', price: -5 })]), null);
  assert.equal(readDeskAction([toolCall('create_sale', { buyer_name: 'A', vehicle: 'B', price: 'lots' })]), null);
});

test('a vehicle call validates the year and defaults its costs', () => {
  const action = readDeskAction([toolCall('add_vehicle', {
    make: 'Lexus', model: 'RX 350', year: 2019, vin: '2t2bzca0kc123456', condition: 'Foreign used'
  })]);
  assert.equal(action.type, 'add_vehicle');
  assert.equal(action.vin, '2T2BZCA0KC123456');
  assert.equal(action.askingPrice, 0);
  assert.equal(action.condition, 'Tokunbo', 'an unknown condition falls back to a real choice');
  assert.equal(readDeskAction([toolCall('add_vehicle', { make: 'Lexus', model: 'RX', year: 1900 })]), null);
  assert.equal(readDeskAction([toolCall('add_vehicle', { make: '', model: 'RX', year: 2019 })]), null);
});

test('a document call needs a number or a buyer and upper-cases the number', () => {
  const byNumber = readDeskAction([toolCall('open_document', { number: 'agi-inv-2026-0002' })]);
  assert.equal(byNumber.number, 'AGI-INV-2026-0002');
  assert.equal(byNumber.kind, '');
  const byBuyer = readDeskAction([toolCall('open_document', { buyer_name: 'Aisha Bello', kind: 'receipt' })]);
  assert.equal(byBuyer.buyerName, 'Aisha Bello');
  assert.equal(byBuyer.kind, 'receipt');
  assert.equal(readDeskAction([toolCall('open_document', {})]), null);
  assert.equal(readDeskAction([toolCall('open_document', { kind: 'quote' })]), null);
});

test('broken or unknown tool calls are ignored, not thrown', () => {
  assert.equal(readDeskAction(null), null);
  assert.equal(readDeskAction([]), null);
  assert.equal(readDeskAction([toolCall('create_sale', '{not json')]), null);
  assert.equal(readDeskAction([toolCall('drop_database', {})]), null);
  const mixed = readDeskAction([
    toolCall('create_sale', '{not json'),
    toolCall('open_document', { number: 'AGI-RCT-2026-0001' })
  ]);
  assert.equal(mixed.type, 'open_document', 'the first usable call wins');
});

test('a tool-only reply is not treated as an empty response', () => {
  const message = extractMessage({
    choices: [{ message: { content: '', tool_calls: [toolCall('open_document', { number: 'AGI-INV-2026-0001' })] } }]
  });
  assert.equal(message.reply, '');
  assert.equal(message.action.type, 'open_document');
  assert.throws(() => extractMessage({ choices: [{ message: { content: '' } }] }), { code: 'upstream_bad_response' });
});

test('the handler returns the prepared action alongside the reply', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: 'Prepared — approve it below.',
          tool_calls: [toolCall('create_sale', { buyer_name: 'Aisha', vehicle: '2021 Camry', price: 24500000 })]
        }
      }]
    })
  });
  const handle = createAssistantHandler({
    authorize: async () => ({ id: 'u1', authorised: true }),
    fetchImpl,
    groqApiKey: 'k'.repeat(20),
    allowedOrigins: ['https://dealer.example'],
    now: () => 1000
  });
  const result = await handle({
    method: 'POST',
    origin: 'https://dealer.example',
    authorization: `Bearer ${'t'.repeat(40)}`,
    bodyText: JSON.stringify({ messages: [user('Sell the 2021 Camry to Aisha for 24.5m')] })
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.action.type, 'create_sale');
  assert.equal(result.body.action.buyerName, 'Aisha');
  assert.equal(result.body.reply, 'Prepared — approve it below.');
});

test('the Groq payload asks for tools and still carries no secret', () => {
  const body = buildGroqPayload({ messages: [user('hello')] });
  assert.equal(body.tool_choice, 'auto');
  assert.ok(Array.isArray(body.tools) && body.tools.length === 3);
  assert.equal(JSON.stringify(body).includes('apiKey'), false);
});
