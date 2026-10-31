import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_COPY,
  AUTH_STORAGE_KEY,
  clearStoredSession,
  createAuthClient,
  isPublicClientKey,
  jwtRole,
  readAuthConfig,
  readStoredSession,
  sessionIsFresh,
  signInFailure,
  writeStoredSession
} from '../auth-client.js';

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const anonJwt = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: 'anon' })}.sig`;
const serviceJwt = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: 'service_role' })}.sig`;
const URL_BASE = 'https://demo.supabase.co';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    keyCount: () => map.size
  };
}

function sessionPayload({ expiresIn = 3600, access = 'access-1' } = {}) {
  return {
    access_token: access,
    refresh_token: 'refresh-1',
    expires_in: expiresIn,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const result = await handler({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body
    };
  };
  return { calls, fetchImpl };
}

test('reads a valid Supabase config and derives the function endpoint', () => {
  const config = readAuthConfig({
    location: { href: 'https://dealer.example/' },
    AKINLOWO_SUPABASE: { url: 'https://demo.supabase.co/', anonKey: anonJwt }
  });
  assert.equal(config.url, URL_BASE);
  assert.equal(config.endpoint, `${URL_BASE}/functions/v1/dealership-assistant`);
  assert.equal(config.anonKey, anonJwt);
});

test('refuses secret keys, service keys and insecure or credential-bearing URLs', () => {
  const location = { href: 'https://dealer.example/' };
  assert.equal(readAuthConfig({ location, AKINLOWO_SUPABASE: { url: URL_BASE, anonKey: serviceJwt } }), null);
  assert.equal(readAuthConfig({ location, AKINLOWO_SUPABASE: { url: URL_BASE, anonKey: 'sb_secret_abcdefghijklmnopqrst' } }), null);
  assert.equal(readAuthConfig({ location, AKINLOWO_SUPABASE: { url: 'http://demo.supabase.co', anonKey: anonJwt } }), null);
  assert.equal(readAuthConfig({ location, AKINLOWO_SUPABASE: { url: 'https://user:pass@demo.supabase.co', anonKey: anonJwt } }), null);
  assert.equal(readAuthConfig({ location, AKINLOWO_SUPABASE: { url: URL_BASE } }), null);
  assert.equal(readAuthConfig({ location }), null);
});

test('accepts publishable keys and identifies JWT roles', () => {
  assert.equal(isPublicClientKey('sb_publishable_abcdefghijklmnop'), true);
  assert.equal(isPublicClientKey('sb_secret_abcdefghijklmnop'), false);
  assert.equal(isPublicClientKey(anonJwt), true);
  assert.equal(isPublicClientKey(serviceJwt), false);
  assert.equal(jwtRole(anonJwt), 'anon');
  assert.equal(jwtRole('not-a-jwt'), null);
});

test('allows a custom https assistant endpoint but ignores an insecure one', () => {
  const custom = readAuthConfig({
    location: { href: 'https://dealer.example/' },
    AKINLOWO_SUPABASE: { url: URL_BASE, anonKey: anonJwt, assistantEndpoint: 'https://functions.dealer.example/assistant' }
  });
  assert.equal(custom.endpoint, 'https://functions.dealer.example/assistant');

  const insecure = readAuthConfig({
    location: { href: 'https://dealer.example/' },
    AKINLOWO_SUPABASE: { url: URL_BASE, anonKey: anonJwt, assistantEndpoint: 'http://evil.example/assistant' }
  });
  assert.equal(insecure.endpoint, `${URL_BASE}/functions/v1/dealership-assistant`);
});

test('signs in with email and password and stores only the session', async () => {
  const storage = memoryStorage();
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: sessionPayload() }));
  const auth = createAuthClient({ config: { url: URL_BASE, anonKey: anonJwt }, fetchImpl, storage });

  const result = await auth.signIn('  dealer@akinlowo.test ', 'correct horse');
  assert.equal(result.ok, true);
  assert.equal(result.session.user.email, 'dealer@akinlowo.test');
  assert.equal(calls[0].url, `${URL_BASE}/auth/v1/token?grant_type=password`);
  assert.equal(calls[0].init.headers.apikey, anonJwt);
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'dealer@akinlowo.test', password: 'correct horse' });

  const stored = storage.getItem(AUTH_STORAGE_KEY);
  assert.ok(stored);
  assert.equal(stored.includes('correct horse'), false);
  assert.equal(JSON.parse(stored).access_token, 'access-1');
  assert.equal(auth.hasSession(), true);
});

test('validates email and password before any request', async () => {
  let called = false;
  const auth = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage: memoryStorage(),
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => sessionPayload() };
    }
  });
  assert.equal((await auth.signIn('', '')).code, 'missing-fields');
  assert.equal((await auth.signIn('dealer@akinlowo.test', '')).code, 'missing-fields');
  assert.equal((await auth.signIn('not-an-email', 'secret')).code, 'invalid-email');
  assert.equal(called, false);
});

test('maps sign-in failures without storing or leaking provider text', async () => {
  const storage = memoryStorage();
  const cases = [
    [400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }, 'invalid-credentials'],
    [400, { error_code: 'email_not_confirmed', error_description: 'Email not confirmed' }, 'email-unconfirmed'],
    [429, { error: 'over_request_rate_limit' }, 'too-many'],
    [500, { error: 'boom', error_description: 'internal password hash detail' }, 'unavailable']
  ];
  for (const [status, body, code] of cases) {
    const { fetchImpl } = fakeFetch(() => ({ status, body }));
    const auth = createAuthClient({ config: { url: URL_BASE, anonKey: anonJwt }, fetchImpl, storage });
    const result = await auth.signIn('dealer@akinlowo.test', 'wrong-password');
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.message.includes('password hash'), false);
    assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  }
  assert.equal(signInFailure(401, { error_description: 'Invalid login credentials' }).message, AUTH_COPY.invalidCredentials);
});

test('reports offline sign-in attempts distinctly', async () => {
  const auth = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage: memoryStorage(),
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  const result = await auth.signIn('dealer@akinlowo.test', 'secret');
  assert.equal(result.code, 'offline');
  assert.equal(result.message, AUTH_COPY.offline);
});

test('returns a fresh access token without refreshing', async () => {
  const storage = memoryStorage();
  writeStoredSession({
    access_token: 'fresh-token',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3600_000,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  }, storage);
  let called = false;
  const auth = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage,
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  assert.equal(await auth.getAccessToken(), 'fresh-token');
  assert.equal(called, false);
});

test('refreshes an expired session and stores the new tokens', async () => {
  const storage = memoryStorage();
  writeStoredSession({
    access_token: 'old-token',
    refresh_token: 'refresh-1',
    expires_at: Date.now() - 1000,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  }, storage);

  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: sessionPayload({ access: 'new-token' }) }));
  const auth = createAuthClient({ config: { url: URL_BASE, anonKey: anonJwt }, fetchImpl, storage });

  assert.equal(await auth.getAccessToken(), 'new-token');
  assert.equal(calls[0].url, `${URL_BASE}/auth/v1/token?grant_type=refresh_token`);
  assert.equal(calls[0].init.headers.apikey, anonJwt);
  assert.equal(readStoredSession(storage).access_token, 'new-token');
});

test('clears the session when a refresh token is rejected but keeps it while offline', async () => {
  const rejectedStorage = memoryStorage();
  writeStoredSession({
    access_token: 'old-token',
    refresh_token: 'bad-refresh',
    expires_at: Date.now() - 1000,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  }, rejectedStorage);
  const rejected = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage: rejectedStorage,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) })
  });
  assert.equal(await rejected.getAccessToken(), null);
  assert.equal(rejectedStorage.getItem(AUTH_STORAGE_KEY), null);

  const offlineStorage = memoryStorage();
  writeStoredSession({
    access_token: 'old-token',
    refresh_token: 'refresh-1',
    expires_at: Date.now() - 1000,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  }, offlineStorage);
  const offline = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage: offlineStorage,
    fetchImpl: async () => {
      throw new TypeError('offline');
    }
  });
  assert.equal(await offline.getAccessToken(), null);
  assert.ok(offlineStorage.getItem(AUTH_STORAGE_KEY));
});

test('signs out by revoking the token and clearing the session', async () => {
  const storage = memoryStorage();
  writeStoredSession({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3600_000,
    user: { id: 'user-1', email: 'dealer@akinlowo.test' }
  }, storage);
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 204, body: null }));
  const auth = createAuthClient({ config: { url: URL_BASE, anonKey: anonJwt }, fetchImpl, storage });

  await auth.signOut();
  assert.equal(calls[0].url, `${URL_BASE}/auth/v1/logout`);
  assert.equal(calls[0].init.headers.authorization, 'Bearer access-1');
  assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  assert.equal(auth.hasSession(), false);
});

test('ignores malformed stored sessions and blocked storage', async () => {
  const storage = memoryStorage();
  storage.setItem(AUTH_STORAGE_KEY, '{"access_token":""}');
  assert.equal(readStoredSession(storage), null);
  storage.setItem(AUTH_STORAGE_KEY, 'not json');
  assert.equal(readStoredSession(storage), null);

  const blocked = {
    getItem: () => null,
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); }
  };
  const auth = createAuthClient({
    config: { url: URL_BASE, anonKey: anonJwt },
    storage: blocked,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => sessionPayload() })
  });
  assert.equal((await auth.signIn('dealer@akinlowo.test', 'secret')).code, 'storage-blocked');
  assert.equal(clearStoredSession(blocked), false);
});

test('treats sessions near expiry as stale', () => {
  const now = 1_000_000;
  assert.equal(sessionIsFresh({ access_token: 't', expires_at: now + 30_000 }, now), false);
  assert.equal(sessionIsFresh({ access_token: 't', expires_at: now + 120_000 }, now), true);
  assert.equal(sessionIsFresh({ access_token: 't', expires_at: 0 }, now), false);
  assert.equal(sessionIsFresh(null, now), false);
});
