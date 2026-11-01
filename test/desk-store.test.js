import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESK_ROW_ID,
  DeskStoreError,
  LEGACY_FX_KEY,
  LEGACY_STORE_KEY,
  clearLegacyState,
  createDeskStore,
  normalizeDeskState,
  readLegacyState,
  stateHasRecords
} from '../desk-store.js';

const URL_BASE = 'https://project.supabase.co';
const KEY = 'sb_publishable_test_key_value_123';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

test('normalizes any stored shape into the desk the views expect', () => {
  const state = normalizeDeskState({ sales: 'nonsense', vehicles: [{ id: 'a' }, null], settings: { vatRate: '7.5' }, extra: true });
  assert.deepEqual(state.vehicles, [{ id: 'a' }]);
  assert.deepEqual(state.sales, []);
  assert.deepEqual(state.expenses, []);
  assert.equal(state.settings.vatRate, 7.5);
  assert.equal(state.extra, true);
  assert.deepEqual(state.counters, { invoice: 0, receipt: 0 });
  assert.equal(normalizeDeskState(null).vehicles.length, 0);
});

test('detects whether a stored desk actually holds records', () => {
  assert.equal(stateHasRecords({ vehicles: [], sales: [] }), false);
  assert.equal(stateHasRecords({ vehicles: [{ id: 'v' }] }), true);
  assert.equal(stateHasRecords(null), false);
});

test('reads a legacy local desk once and clears every key the app used to keep', () => {
  const storage = memoryStorage({
    [LEGACY_STORE_KEY]: JSON.stringify({ vehicles: [{ id: 'old', make: 'Toyota' }] }),
    [LEGACY_FX_KEY]: '{"base":"USD"}'
  });
  const legacy = readLegacyState(storage);
  assert.equal(legacy.vehicles[0].make, 'Toyota');
  assert.equal(legacy.settings.vatRate, 7.5);
  assert.deepEqual(clearLegacyState(storage).sort(), [LEGACY_FX_KEY, LEGACY_STORE_KEY].sort());
  assert.equal(storage.map.size, 0);
  assert.equal(readLegacyState(storage), null);

  const broken = memoryStorage({ [LEGACY_STORE_KEY]: 'not json' });
  assert.equal(readLegacyState(broken), null);
  assert.deepEqual(clearLegacyState({ getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } }), []);
});

test('loads the single desk row with the signed-in token', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, [{ data: { vehicles: [{ id: 'v1' }] }, updated_at: '2026-11-01T10:00:00Z' }]));
  const store = createDeskStore({ url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt', fetchImpl });
  const loaded = await store.load();

  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${URL_BASE}/rest/v1/desk_state?id=eq.${DESK_ROW_ID}&select=data,updated_at`);
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.headers.apikey, KEY);
  assert.equal(call.options.headers.authorization, 'Bearer user-jwt');
  assert.equal(loaded.hasRecords, true);
  assert.equal(loaded.updatedAt, '2026-11-01T10:00:00Z');
  assert.equal(loaded.state.vehicles.length, 1);
});

test('an empty row is reported as null rather than invented records', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, []));
  const store = createDeskStore({ url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt', fetchImpl });
  assert.equal(await store.load(), null);
});

test('maps auth, server and network failures to explicit errors', async () => {
  const unauthorised = createDeskStore({
    url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt',
    fetchImpl: fakeFetch(() => jsonResponse(401, { message: 'JWT expired' }))
  });
  await assert.rejects(unauthorised.load(), error => error instanceof DeskStoreError && error.code === 'auth');

  const noToken = createDeskStore({ url: URL_BASE, anonKey: KEY, getToken: async () => null, fetchImpl: fakeFetch(() => jsonResponse(200, [])) });
  await assert.rejects(noToken.load(), error => error.code === 'auth');

  const broken = createDeskStore({
    url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt',
    fetchImpl: fakeFetch(() => { throw new TypeError('Failed to fetch'); })
  });
  await assert.rejects(broken.load(), error => error.code === 'offline');

  const serverError = createDeskStore({
    url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt',
    fetchImpl: fakeFetch(() => jsonResponse(503, {}))
  });
  await assert.rejects(serverError.load(), error => error.code === 'server');
});

test('saves the whole desk as one upsert keyed on the singleton row', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 201, json: async () => null }));
  const store = createDeskStore({ url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt', fetchImpl });
  await store.save({ vehicles: [{ id: 'v1' }], settings: {} });

  const call = fetchImpl.calls[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(call.url, `${URL_BASE}/rest/v1/desk_state?on_conflict=id`);
  assert.match(call.options.headers.prefer, /resolution=merge-duplicates/);
  const body = JSON.parse(call.options.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, DESK_ROW_ID);
  assert.equal(body[0].data.vehicles.length, 1);
  assert.equal('token' in body[0], false);
});

test('a final save can ask the browser to keep it alive while the page closes', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 201, json: async () => null }));
  const store = createDeskStore({ url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt', fetchImpl });

  await store.save({ vehicles: [] });
  assert.equal(fetchImpl.calls[0].options.keepalive, false);

  await store.save({ vehicles: [] }, { keepalive: true });
  assert.equal(fetchImpl.calls[1].options.keepalive, true);
});

test('save refuses to swallow a rejected write', async () => {
  const store = createDeskStore({
    url: URL_BASE, anonKey: KEY, getToken: async () => 'user-jwt',
    fetchImpl: fakeFetch(() => jsonResponse(403, { message: 'new row violates row-level security policy' }))
  });
  await assert.rejects(store.save({ vehicles: [] }), error => error.code === 'auth');
});

test('the store refuses to be built without a url, key or token source', () => {
  assert.throws(() => createDeskStore({ anonKey: KEY, getToken: () => 't' }), /url/);
  assert.throws(() => createDeskStore({ url: URL_BASE, getToken: () => 't' }), /public key/);
  assert.throws(() => createDeskStore({ url: URL_BASE, anonKey: KEY }), /token source/);
});
