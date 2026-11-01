import { crossRate, rateFreshness, RATE_CURRENCIES } from './core.js';

/**
 * ExchangeRate-API Open Access feed.
 * - No API key is used or stored, so there is nothing secret to expose.
 * - The request is a fixed public GET with no record, customer or device data.
 * - The provider permits display with attribution and caching; it does not
 *   permit re-distribution of the raw feed, so only derived NGN rates are shown.
 */
export const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
export const FX_SOURCE = Object.freeze({
  name: 'ExchangeRate-API',
  attribution: 'Rates By Exchange Rate API',
  url: 'https://www.exchangerate-api.com',
  termsUrl: 'https://www.exchangerate-api.com/terms',
  docsUrl: 'https://www.exchangerate-api.com/docs/free'
});
export const FX_CACHE_TTL_MS = 60 * 60 * 1000;
export const FX_TIMEOUT_MS = 9000;

export function parseRates(payload, receivedAt = Date.now()) {
  if (!payload || payload.result !== 'success') {
    throw new Error(payload?.['error-type'] ? `Rate provider error: ${payload['error-type']}` : 'The rate provider returned an unexpected response');
  }
  if (payload.base_code !== 'USD' || !payload.rates || typeof payload.rates !== 'object') {
    throw new Error('The rate provider did not return a USD-based table');
  }
  const lastUpdated = Number(payload.time_last_update_unix) * 1000;
  if (!Number.isFinite(lastUpdated) || lastUpdated <= 0) throw new Error('The rate provider did not report an update time');
  const nextUpdate = Number(payload.time_next_update_unix) * 1000;
  const ngn = {};
  for (const { code } of RATE_CURRENCIES) {
    ngn[code] = Math.round(crossRate(payload.rates, code, 'NGN') * 100) / 100;
  }
  return {
    provider: payload.provider || FX_SOURCE.url,
    base: 'USD',
    lastUpdated,
    nextUpdate: Number.isFinite(nextUpdate) && nextUpdate > 0 ? nextUpdate : null,
    ngn,
    receivedAt
  };
}

export function fetchRates({ fetchImpl = globalThis.fetch, timeoutMs = FX_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return Promise.reject(new Error('This browser cannot request exchange rates'));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs)
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  return Promise.resolve()
    .then(() => fetchImpl(FX_ENDPOINT, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-cache',
      signal: controller?.signal
    }))
    .then(response => {
      if (!response.ok) throw new Error(`Rate provider responded ${response.status}`);
      return response.json();
    })
    .then(payload => parseRates(payload))
    .finally(() => { if (timer) clearTimeout(timer); });
}

export function cacheIsFresh(cache, now = Date.now(), ttlMs = FX_CACHE_TTL_MS) {
  if (!cache) return false;
  const received = Number(cache.receivedAt ?? cache.cachedAt);
  return Number.isFinite(received) && now - received >= 0 && now - received < ttlMs;
}

export function ratesAreCurrent(data, now = Date.now()) {
  return rateFreshness({ lastUpdated: data?.lastUpdated, nextUpdate: data?.nextUpdate, now }).state === 'current';
}
