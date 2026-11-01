import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRates, fetchRates, readRateCache, writeRateCache, cacheIsFresh, FX_ENDPOINT, FX_CACHE_KEY } from '../fx.js';

const payload = () => ({
  result: 'success',
  provider: 'https://www.exchangerate-api.com',
  documentation: 'https://www.exchangerate-api.com/docs/free',
  terms_of_use: 'https://www.exchangerate-api.com/terms',
  time_last_update_unix: 1793404951,
  time_last_update_utc: 'Sat, 31 Oct 2026 00:02:31 +0000',
  time_next_update_unix: 1793492381,
  base_code: 'USD',
  rates: { USD: 1, NGN: 1345.473177, CAD: 1.396601, CNY: 6.669566, EUR: 0.895588 }
});

function memoryStorage() {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

test('parses the daily USD feed into NGN cross rates only', () => {
  const parsed = parseRates(payload(), 1_793_400_000_000);
  assert.equal(parsed.base, 'USD');
  assert.equal(parsed.lastUpdated, 1793404951000);
  assert.equal(parsed.nextUpdate, 1793492381000);
  assert.deepEqual(parsed.ngn, { USD: 1345.47, CAD: 963.39, CNY: 201.73, EUR: 1502.33 });
  assert.equal(parsed.rates, undefined, 'raw provider rates are not kept for display or redistribution');
});

test('rejects provider errors and tables that are not USD based', () => {
  assert.throws(() => parseRates({ result: 'error', 'error-type': 'quota-reached' }), /quota-reached/);
  assert.throws(() => parseRates({ ...payload(), base_code: 'EUR' }), /USD-based/);
  assert.throws(() => parseRates({ ...payload(), rates: { USD: 1, CAD: 1.4 } }), /NGN/);
  assert.throws(() => parseRates({ ...payload(), time_last_update_unix: 0 }), /update time/);
});

test('requests the documented endpoint without credentials or record data', async () => {
  let seen = null;
  const result = await fetchRates({
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => payload() };
    }
  });
  assert.equal(seen.url, FX_ENDPOINT);
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.credentials, 'omit');
  assert.equal(seen.options.body, undefined);
  assert.doesNotMatch(seen.url, /key|api_key|token|secret/i);
  assert.equal(result.ngn.USD, 1345.47);
});

test('surfaces HTTP failures instead of inventing rates', async () => {
  await assert.rejects(
    fetchRates({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }),
    /429/
  );
  await assert.rejects(
    fetchRates({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) }),
    /bad json/
  );
});

test('round-trips a saved copy and only treats recent copies as fresh', () => {
  const storage = memoryStorage();
  assert.equal(readRateCache(storage), null);
  const parsed = parseRates(payload(), 1_793_400_000_000);
  assert.equal(writeRateCache(parsed, storage), true);
  assert.ok(storage.map.get(FX_CACHE_KEY));
  const cached = readRateCache(storage);
  assert.equal(cached.ngn.CAD, 963.39);
  assert.equal(cacheIsFresh(cached, 1_793_400_000_000 + 30 * 60 * 1000), true);
  assert.equal(cacheIsFresh(cached, 1_793_400_000_000 + 2 * 60 * 60 * 1000), false);

  storage.setItem(FX_CACHE_KEY, '{"base":"EUR"}');
  assert.equal(readRateCache(storage), null);
  storage.setItem(FX_CACHE_KEY, 'not json');
  assert.equal(readRateCache(storage), null);
});

test('a blocked storage write does not break the rate panel', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(readRateCache(storage), null);
  assert.equal(writeRateCache(parseRates(payload()), storage), false);
});
