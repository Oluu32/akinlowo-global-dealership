import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['.git', 'node_modules', '.freebuff']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

test('no Groq, OpenAI or Supabase service key is committed', async () => {
  const files = await walk(ROOT);
  const suspicious = [];
  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|zip)$/i.test(file)) continue;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (/gsk_[A-Za-z0-9]{20,}/.test(text) || /sk-[A-Za-z0-9]{32,}/.test(text) || /service_role["'\s:=]+ey[A-Za-z0-9._-]{20,}/.test(text)) {
      suspicious.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(suspicious, []);
});

test('the edge function reads its key from the server environment only', async () => {
  const source = await readFile(join(ROOT, 'supabase/functions/dealership-assistant/index.ts'), 'utf8');
  assert.match(source, /Deno\.env\.get\('GROQ_API_KEY'\)/);
  assert.match(source, /auth\.getUser\(token\)/);
  assert.match(source, /ASSISTANT_ALLOWED_ORIGINS/);
  assert.equal(/gsk_/.test(source), false);
});

test('the browser client holds no key and never writes chat to storage', async () => {
  const source = await readFile(join(ROOT, 'assistant-client.js'), 'utf8');
  assert.equal(/localStorage/.test(source), false);
  assert.equal(/GROQ_API_KEY/.test(source), false);
  assert.equal(/gsk_/.test(source), false);
  assert.match(source, /authorization: `Bearer \$\{token\.trim\(\)\}`/);
});
