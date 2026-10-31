/**
 * Supabase Auth client for the assistant sign-in gate.
 *
 * Configuration is injected by the deployment at runtime, never committed:
 *
 *   window.AKINLOWO_SUPABASE = {
 *     url: 'https://<project-ref>.supabase.co',
 *     anonKey: '<public anon/publishable key>',
 *     assistantEndpoint: '…/functions/v1/dealership-assistant'   // optional
 *   };
 *
 * The anon key is a public client key, not a secret. A service-role or secret
 * key is refused outright so it can never be shipped to a browser by mistake.
 *
 * Tokens live in sessionStorage for this tab only. Passwords are sent to the
 * Supabase project and never stored, logged or reused.
 */

export const AUTH_STORAGE_KEY = 'akinlowo-global-auth-v1';
export const AUTH_ENDPOINT_PATH = '/functions/v1/dealership-assistant';

export const AUTH_COPY = Object.freeze({
  missingFields: 'Enter your email and password.',
  invalidEmail: 'Enter a valid email address.',
  invalidCredentials: 'That email and password did not match. Try again.',
  emailUnconfirmed: 'Confirm your email address before signing in.',
  tooMany: 'Too many attempts. Wait a moment and try again.',
  unavailable: 'Sign-in is unavailable right now. Try again shortly.',
  offline: 'Could not reach the sign-in service. Check your connection.',
  expired: 'Your session ended. Sign in again.',
  storageBlocked: 'This browser is blocking session storage, so sign-in cannot be kept.'
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeSupabaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.username || url.password) return '';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname.toLowerCase()))) return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function base64UrlToBase64(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return padded + '='.repeat((4 - (padded.length % 4)) % 4);
}

export function jwtRole(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = globalThis.atob(base64UrlToBase64(parts[1]));
    const payload = JSON.parse(json);
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/** Accepts a legacy anon JWT or a publishable key; refuses secret/service keys. */
export function isPublicClientKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 20) return false;
  if (/^sb_secret_/i.test(key) || /^sb_service_/i.test(key)) return false;
  if (/^sb_publishable_/i.test(key)) return true;
  return jwtRole(key) === 'anon';
}

export function readAuthConfig(scope = globalThis) {
  const raw = scope?.AKINLOWO_SUPABASE;
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeSupabaseUrl(raw.url);
  const anonKey = typeof raw.anonKey === 'string' ? raw.anonKey.trim() : '';
  if (!url || !isPublicClientKey(anonKey)) return null;

  const rawEndpoint = typeof raw.assistantEndpoint === 'string' ? raw.assistantEndpoint.trim() : '';
  let endpoint = `${url}${AUTH_ENDPOINT_PATH}`;
  if (rawEndpoint) {
    try {
      const resolved = new URL(rawEndpoint, scope?.location?.href ?? 'https://localhost/');
      if (resolved.protocol === 'https:' || (resolved.protocol === 'http:' && LOCAL_HOSTS.has(resolved.hostname.toLowerCase()))) {
        endpoint = resolved.href;
      }
    } catch {
      /* keep the derived endpoint */
    }
  }
  return { url, anonKey, endpoint };
}

/* ------------------------------------------------------------------ *
 * Session storage (sessionStorage: this tab only, cleared on close).
 * ------------------------------------------------------------------ */
function validSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.access_token !== 'string' || !value.access_token) return null;
  if (!value.user || typeof value.user !== 'object') return null;
  return {
    access_token: value.access_token,
    refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : '',
    expires_at: Number(value.expires_at) || 0,
    user: {
      id: typeof value.user.id === 'string' ? value.user.id : '',
      email: typeof value.user.email === 'string' ? value.user.email : ''
    }
  };
}

export function readStoredSession(storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem(AUTH_STORAGE_KEY);
    return raw ? validSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeStoredSession(session, storage = globalThis.sessionStorage) {
  try {
    const clean = validSession(session);
    if (!clean) return false;
    storage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredSession(storage = globalThis.sessionStorage) {
  try {
    storage?.removeItem(AUTH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function sessionIsFresh(session, now = Date.now(), skewMs = 60000) {
  if (!session?.access_token) return false;
  const expires = Number(session.expires_at);
  if (!Number.isFinite(expires) || expires <= 0) return false;
  return expires - skewMs > Number(now);
}

export function signInFailure(status, payload) {
  const code = String(payload?.error_code ?? payload?.error ?? '');
  const description = String(payload?.error_description ?? payload?.msg ?? payload?.message ?? '');
  if (status === 400 || status === 401) {
    if (/email_not_confirmed/i.test(code) || /email not confirmed/i.test(description)) {
      return { code: 'email-unconfirmed', message: AUTH_COPY.emailUnconfirmed };
    }
    return { code: 'invalid-credentials', message: AUTH_COPY.invalidCredentials };
  }
  if (status === 422) return { code: 'invalid-input', message: AUTH_COPY.invalidEmail };
  if (status === 429) return { code: 'too-many', message: AUTH_COPY.tooMany };
  if (status >= 500) return { code: 'unavailable', message: AUTH_COPY.unavailable };
  return { code: 'unavailable', message: AUTH_COPY.unavailable };
}

export function createAuthClient({
  config,
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
  now = () => Date.now()
} = {}) {
  if (!config?.url || !config?.anonKey) throw new TypeError('createAuthClient requires a Supabase url and public key');

  async function post(path, body, { token = '' } = {}) {
    if (typeof fetchImpl !== 'function') return { offline: true };
    const headers = { apikey: config.anonKey, 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await fetchImpl(`${config.url}${path}`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        headers,
        body: JSON.stringify(body)
      });
      return { response, payload: await response.json().catch(() => null) };
    } catch {
      return { offline: true };
    }
  }

  function toSession(payload) {
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) return null;
    const expiresIn = Number(payload.expires_in);
    const expiresAt = Number(payload.expires_at);
    const user = payload.user ?? {};
    return {
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
      expires_at: Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt * 1000
        : now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000),
      user: {
        id: typeof user.id === 'string' ? user.id : '',
        email: typeof user.email === 'string' ? user.email : ''
      }
    };
  }

  async function refresh(session) {
    if (!session?.refresh_token) return null;
    const { response, payload, offline } = await post('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (offline) return null;
    if (!response?.ok) {
      if (response?.status === 400 || response?.status === 401) clearStoredSession(storage);
      return null;
    }
    const next = toSession(payload);
    if (!next) return null;
    writeStoredSession(next, storage);
    return next;
  }

  return {
    config,

    getSession() {
      return readStoredSession(storage);
    },

    hasSession() {
      return Boolean(readStoredSession(storage)?.user?.email);
    },

    async signIn(email, password) {
      const address = typeof email === 'string' ? email.trim() : '';
      const secret = typeof password === 'string' ? password : '';
      if (!address || !secret) return { ok: false, code: 'missing-fields', message: AUTH_COPY.missingFields };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, code: 'invalid-email', message: AUTH_COPY.invalidEmail };

      const { response, payload, offline } = await post('/auth/v1/token?grant_type=password', { email: address, password: secret });
      if (offline) return { ok: false, code: 'offline', message: AUTH_COPY.offline };
      if (!response?.ok) return { ok: false, ...signInFailure(response?.status ?? 0, payload) };

      const session = toSession(payload);
      if (!session) return { ok: false, code: 'unavailable', message: AUTH_COPY.unavailable };
      if (!writeStoredSession(session, storage)) return { ok: false, code: 'storage-blocked', message: AUTH_COPY.storageBlocked };
      return { ok: true, session };
    },

    async getAccessToken() {
      const session = readStoredSession(storage);
      if (!session) return null;
      if (sessionIsFresh(session, now())) return session.access_token;
      const refreshed = await refresh(session);
      return refreshed?.access_token ?? null;
    },

    async refreshSession() {
      return refresh(readStoredSession(storage));
    },

    clearSession() {
      clearStoredSession(storage);
    },

    async signOut() {
      const session = readStoredSession(storage);
      if (session?.access_token) await post('/auth/v1/logout', {}, { token: session.access_token });
      clearStoredSession(storage);
      return { ok: true };
    }
  };
}
