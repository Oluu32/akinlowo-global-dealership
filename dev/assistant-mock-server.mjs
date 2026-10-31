/**
 * Local-only mock of the assistant Edge Function.
 *
 * It runs the real request pipeline (auth, CORS, limits, validation, safe
 * errors) with a stubbed "Groq" provider so the browser flow can be verified
 * without a Supabase project, a user account or a real GROQ_API_KEY.
 *
 * Usage:  node dev/assistant-mock-server.mjs   → http://127.0.0.1:8787
 *
 * This file contains no secrets and is never deployed. The token below is a
 * fake string that only this mock accepts.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantHandler } from '../supabase/functions/dealership-assistant/assistant-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DEMO_TOKEN = 'mock-session-token-for-local-ui-only';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

const handler = createAssistantHandler({
  authorize: async token => {
    if (token !== DEMO_TOKEN) throw new Error('invalid demo token');
    return { id: 'mock-dealer-user' };
  },
  groqApiKey: 'mock-groq-key-not-real',
  model: 'mock-model',
  allowedOrigins: [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
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

  if (url.pathname === '/assistant') {
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
  console.log(`Mock dealership desk on http://127.0.0.1:${PORT} (assistant stub at /assistant)`);
});
