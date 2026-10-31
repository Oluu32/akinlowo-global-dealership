/**
 * Local-only mock of the assistant Edge Function plus Supabase Auth.
 *
 * It runs the real request pipeline (auth, CORS, limits, validation, safe
 * errors) with a stubbed "Groq" provider and a stubbed GoTrue sign-in, so the
 * browser flow can be verified without a Supabase project, a user account or
 * a real GROQ_API_KEY.
 *
 * Usage:  node dev/assistant-mock-server.mjs   → http://127.0.0.1:8787
 * Demo sign-in: dealer@akinlowo.test / demo-dealer-2026
 *
 * These credentials and tokens are fake and only this mock accepts them.
 * Nothing here is deployed and no real secret is involved.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantHandler } from '../supabase/functions/dealership-assistant/assistant-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];

const DEMO_USER = { id: 'mock-dealer-user', email: 'dealer@akinlowo.test' };
const DEMO_PASSWORD = 'demo-dealer-2026';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

let refreshCounter = 1;

function issueSession() {
  const expiresAt = Date.now() + 3600 * 1000;
  refreshCounter += 1;
  return {
    access_token: `mock-access-${expiresAt}`,
    refresh_token: `mock-refresh-${refreshCounter}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: DEMO_USER.id, email: DEMO_USER.email, role: 'authenticated' }
  };
}

function mockAccessTokenIsValid(token) {
  const match = /^mock-access-(\d+)$/.exec(token ?? '');
  return Boolean(match) && Number(match[1]) > Date.now();
}

function corsFor(origin) {
  const allowed = !origin || ORIGINS.includes(origin);
  return {
    allowed,
    headers: {
      vary: 'Origin',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, apikey, content-type',
      ...(origin && allowed ? { 'access-control-allow-origin': origin } : {})
    }
  };
}

const handler = createAssistantHandler({
  authorize: async token => {
    if (!mockAccessTokenIsValid(token)) throw new Error('invalid mock token');
    return { id: DEMO_USER.id };
  },
  groqApiKey: 'mock-groq-key-not-real',
  model: 'mock-model',
  allowedOrigins: ORIGINS,
  // Stubbed provider: mirrors the Groq response shape. "boom" forces a 500 so
  // the unavailable state can be checked in the interface.
  fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1)?.content ?? '';
    if (last.toLowerCase().startsWith('boom')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'mock upstream failure' } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: `Mock reply for: "${last.slice(0, 120)}". This is a local stub, not a live model answer.`
          }
        }]
      })
    };
  }
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const cors = corsFor(request.headers.origin ?? '');

  if (url.pathname.startsWith('/auth/v1/')) {
    if (!cors.allowed) {
      response.writeHead(403, cors.headers).end();
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors.headers).end();
      return;
    }
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    Object.entries(cors.headers).forEach(([key, value]) => response.setHeader(key, value));

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (body?.email === DEMO_USER.email && body?.password === DEMO_PASSWORD) {
        response.writeHead(200).end(JSON.stringify(issueSession()));
      } else {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }));
      }
      return;
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      if (String(body?.refresh_token ?? '').startsWith('mock-refresh-')) {
        response.writeHead(200).end(JSON.stringify(issueSession()));
      } else {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }));
      }
      return;
    }
    if (url.pathname === '/auth/v1/logout') {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  if (url.pathname === '/assistant' || url.pathname === '/functions/v1/dealership-assistant') {
    const bodyText = request.method === 'POST' ? await readBody(request) : '';
    const result = await handler({
      method: request.method ?? 'GET',
      origin: request.headers.origin ?? '',
      authorization: request.headers.authorization ?? '',
      bodyText
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body ? JSON.stringify(result.body) : undefined);
    return;
  }

  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = normalize(join(ROOT, relative));
  if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

async function readJson(request) {
  const text = await readBody(request);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk;
      if (data.length > 64000) {
        reject(new Error('body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock dealership desk on http://127.0.0.1:${PORT} (assistant + auth stubs)`);
  console.log(`Demo sign-in: ${DEMO_USER.email} / ${DEMO_PASSWORD}`);
});
