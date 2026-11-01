/**
 * Server-side storage for the dealership desk.
 *
 * Records live in one Postgres row (`public.desk_state`, id = 'default'),
 * reached through PostgREST with the signed-in user's access token. Row level
 * security only lets authenticated users read or write that single row, so the
 * browser never keeps business records on the device and the publishable key
 * alone cannot read anything.
 *
 * The pure helpers here are runtime-agnostic so the Node test suite can exercise
 * them without a browser or a project.
 */

export const DESK_ROW_ID = 'default';
export const DESK_ENDPOINT_PATH = '/rest/v1/desk_state';
export const DESK_TIMEOUT_MS = 15000;
export const LEGACY_STORE_KEY = 'akinlowo-global-dealership-v1';
export const LEGACY_FX_KEY = 'akinlowo-global-fx-v1';

export class DeskStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeskStoreError';
    this.code = code;
  }
}

export const STORE_COPY = Object.freeze({
  offline: 'Could not reach the dealership database. Check your connection.',
  auth: 'Your session ended. Sign in again to load the desk.',
  server: 'The dealership database did not accept that change.',
  unknown: 'The desk could not be saved.'
});

/** Guarantees the shape the views expect, whatever the server or storage held. */
export function normalizeDeskState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const list = key => (Array.isArray(source[key]) ? source[key].filter(item => item && typeof item === 'object') : []);
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
  const counters = source.counters && typeof source.counters === 'object' ? source.counters : {};
  return {
    ...source,
    settings: { ...settings, vatRate: Number.isFinite(Number(settings.vatRate)) ? Number(settings.vatRate) : 7.5 },
    counters: { ...counters, invoice: Number(counters.invoice) || 0, receipt: Number(counters.receipt) || 0 },
    vehicles: list('vehicles'),
    sales: list('sales'),
    expenses: list('expenses'),
    suppliers: list('suppliers'),
    documents: list('documents')
  };
}

/** True when a loaded blob actually contains desk records. */
export function stateHasRecords(state) {
  if (!state || typeof state !== 'object') return false;
  return ['vehicles', 'sales', 'expenses', 'suppliers', 'documents'].some(key => Array.isArray(state[key]) && state[key].length > 0);
}

/** One-time read of records written by older local-only versions. */
export function readLegacyState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LEGACY_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? normalizeDeskState(parsed) : null;
  } catch {
    return null;
  }
}

/** Removes every key this app used to keep on the device. */
export function clearLegacyState(storage = globalThis.localStorage) {
  const removed = [];
  try {
    for (const key of [LEGACY_STORE_KEY, LEGACY_FX_KEY]) {
      if (storage?.getItem(key) != null) {
        storage.removeItem(key);
        removed.push(key);
      }
    }
  } catch {
    /* blocked storage: nothing to clear */
  }
  return removed;
}

function failureCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'server';
  return status >= 500 ? 'server' : 'unknown';
}

export function createDeskStore({ url, anonKey, getToken, fetchImpl = globalThis.fetch, timeoutMs = DESK_TIMEOUT_MS } = {}) {
  if (typeof url !== 'string' || !url) throw new TypeError('createDeskStore requires a Supabase url');
  if (typeof anonKey !== 'string' || !anonKey) throw new TypeError('createDeskStore requires a public key');
  if (typeof getToken !== 'function') throw new TypeError('createDeskStore requires a token source');

  async function request(path, options = {}) {
    if (typeof fetchImpl !== 'function') throw new DeskStoreError('offline', STORE_COPY.offline);
    const token = await getToken();
    if (!token) throw new DeskStoreError('auth', STORE_COPY.auth);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && Number.isFinite(timeoutMs) ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${url}${path}`, {
        ...options,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(options.headers ?? {})
        },
        signal: controller?.signal
      });
      return response;
    } catch {
      throw new DeskStoreError('offline', STORE_COPY.offline);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    url,

    /** Returns the stored desk, or null when the row is still empty. */
    async load() {
      const response = await request(`${DESK_ENDPOINT_PATH}?id=eq.${DESK_ROW_ID}&select=data,updated_at`);
      if (!response.ok) {
        const code = failureCode(response.status);
        throw new DeskStoreError(code, STORE_COPY[code]);
      }
      const rows = await response.json().catch(() => null);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;
      const state = normalizeDeskState(row.data);
      return { state, updatedAt: row.updated_at ?? null, hasRecords: stateHasRecords(state) };
    },

    /** Writes the whole desk in one upsert; resolves once the server has it. */
    async save(state) {
      const body = JSON.stringify([{
        id: DESK_ROW_ID,
        data: normalizeDeskState(state),
        updated_at: new Date().toISOString()
      }]);
      let response;
      try {
        response = await request(`${DESK_ENDPOINT_PATH}?on_conflict=id`, {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
          body
        });
      } catch (error) {
        throw error instanceof DeskStoreError ? error : new DeskStoreError('offline', STORE_COPY.offline);
      }
      if (!response.ok) {
        const code = failureCode(response.status);
        throw new DeskStoreError(code, STORE_COPY[code]);
      }
      return true;
    }
  };
}
