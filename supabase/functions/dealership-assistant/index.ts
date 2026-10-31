/**
 * Supabase Edge Function: dealership-assistant
 *
 * Security posture:
 * - The browser never sees a Groq key. GROQ_API_KEY is a server-side secret.
 * - Every request must carry a real Supabase user access token. The platform
 *   JWT check is not enough, because an anon key is also a valid JWT, so the
 *   token is verified against Supabase Auth here and must resolve to a user.
 * - An optional ASSISTANT_ALLOWED_EMAILS allowlist narrows access further.
 * - Origin allowlist (ASSISTANT_ALLOWED_ORIGINS) is required for browsers.
 * - Input is size- and length-limited, errors are generic, and no request or
 *   reply content is logged.
 *
 * Secrets (never commit these):
 *   supabase secrets set GROQ_API_KEY=... ASSISTANT_ALLOWED_ORIGINS=https://example.com
 * Optional:
 *   GROQ_MODEL, ASSISTANT_ALLOWED_EMAILS, ASSISTANT_RATE_LIMIT_PER_MINUTE
 *
 * Deploy: supabase functions deploy dealership-assistant
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  ASSISTANT_LIMITS,
  DEFAULT_GROQ_MODEL,
  createAssistantHandler,
  createRateLimiter,
  errorBody,
  parseAllowedOrigins
} from './assistant-core.mjs';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const authClient = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

const allowedEmails = new Set(
  (Deno.env.get('ASSISTANT_ALLOWED_EMAILS') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

async function authorize(token) {
  if (!authClient) throw new Error('Auth is not configured');
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user?.id) throw new Error('Invalid session');
  const email = String(data.user.email ?? '').trim().toLowerCase();
  if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
    return { id: data.user.id, authorised: false };
  }
  return { id: data.user.id, authorised: true };
}

const configuredLimit = Number(Deno.env.get('ASSISTANT_RATE_LIMIT_PER_MINUTE') ?? ASSISTANT_LIMITS.rateLimitPerMinute);

const handler = createAssistantHandler({
  authorize,
  fetchImpl: fetch,
  groqApiKey: Deno.env.get('GROQ_API_KEY') ?? '',
  model: Deno.env.get('GROQ_MODEL')?.trim() || DEFAULT_GROQ_MODEL,
  allowedOrigins: parseAllowedOrigins(Deno.env.get('ASSISTANT_ALLOWED_ORIGINS') ?? ''),
  rateLimiter: createRateLimiter({
    limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : ASSISTANT_LIMITS.rateLimitPerMinute
  })
});

function corsHeadersFor(origin) {
  return {
    vary: 'Origin',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin } : {})
  };
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') ?? '';
  try {
    const bodyText = request.method === 'POST' ? await request.text() : '';
    const result = await handler({
      method: request.method,
      origin,
      authorization: request.headers.get('authorization') ?? '',
      bodyText
    });
    return new Response(result.body ? JSON.stringify(result.body) : null, {
      status: result.status,
      headers: result.headers
    });
  } catch {
    // Never echo internals, stack traces or provider payloads to the client.
    const headers = { 'content-type': 'application/json; charset=utf-8', ...corsHeadersFor(origin) };
    return new Response(JSON.stringify(errorBody('server_error')), { status: 500, headers });
  }
});
