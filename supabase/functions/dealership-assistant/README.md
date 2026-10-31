# Dealership assistant Edge Function

A Supabase Edge Function (Deno) that answers questions about using the dealership desk, using Groq for generation. It is **not deployed** in this repository and the browser panel stays in a labelled "Not configured" state until it is.

## What it does

- Verifies a real Supabase **user access token** with `auth.getUser` before doing any work. A project anon key, an expired token or a token for a deleted user is rejected.
- Optionally restricts access to an email allowlist.
- Restricts browser callers to an explicit origin allowlist (no wildcard CORS).
- Applies per-user rate limiting, message/history/body limits and an upstream timeout.
- Calls `https://api.groq.com/openai/v1/chat/completions` with a server-side key and a system prompt that scopes the assistant to this app, forbids invented records, forbids claiming actions, and forbids soliciting or repeating customer data.
- Returns `{ "reply": "..." }`, or `{ "error": { "code", "message" } }` with a generic message. Provider bodies, keys and stack traces are never returned or logged.

The function receives **only the text of the conversation** (`{ messages: [{ role, content }] }`). No vehicle, sale, customer, document or storage record is sent by the browser and no database access exists in this function.

## Secrets and configuration

Set these as project secrets, never in the repository or the browser:

```sh
supabase secrets set \
  GROQ_API_KEY=<server-side Groq key> \
  ASSISTANT_ALLOWED_ORIGINS=https://your-dealer-site.example
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | Server-side Groq key. Without it the function returns `503 not_configured`. |
| `ASSISTANT_ALLOWED_ORIGINS` | yes for browsers | Comma-separated exact origins, for example `https://dealer.example,https://www.dealer.example`. No wildcard is supported. |
| `GROQ_MODEL` | no | Defaults to `openai/gpt-oss-120b`. Check <https://console.groq.com/docs/models> before changing it. |
| `ASSISTANT_ALLOWED_EMAILS` | no | Comma-separated allowlist. When set, any other signed-in user receives `403`. |
| `ASSISTANT_RATE_LIMIT_PER_MINUTE` | no | Defaults to 12 messages per user per minute. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the Edge runtime. The service-role key is used only to call `auth.getUser`; it never leaves the function.

## Deploy

```sh
supabase login                      # requires a Supabase account
supabase link --project-ref <ref>   # requires project access
supabase functions deploy dealership-assistant
```

Keep the platform JWT check enabled (the default). This function still verifies the token itself, because an anon key is also a valid JWT and must not be accepted as a user session.

## Connect the browser panel

The panel reads its configuration from `window.AKINLOWO_ASSISTANT` at load time. Add a small runtime config **before** the `app.js` module tag:

```html
<script>
  window.AKINLOWO_ASSISTANT = {
    endpoint: 'https://<project-ref>.supabase.co/functions/v1/dealership-assistant',
    getAccessToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    }
  };
</script>
```

Rules enforced by the client:

- Only `https://` endpoints (plus `http://localhost` for local work) are accepted; credentials in the URL are rejected.
- Without the config object, or without `getAccessToken`, the panel stays disabled and says **Not configured**. Nothing is requested.
- A null/empty token shows **Sign-in required** and sends nothing.
- Chat history is kept in page memory only. It is never written to `localStorage` and disappears on reload.
- Failures map to plain messages: unavailable, busy, sign-in required, not authorised, message too long, offline, timed out.

This static app has no sign-in screen of its own. The deployment that hosts it must supply the Supabase session (its own login step or an existing portal) and pass the access token through `getAccessToken`.

## Limits

| Limit | Value |
| --- | --- |
| Message length | 1,200 characters |
| Conversation history | 8 previous messages |
| Request body | 24 KB |
| Reply size | 700 tokens |
| Upstream timeout | 20 seconds |
| Rate limit | 12 messages/user/minute (in-memory, per instance) |

Rate limiting is a guard rail, not a billing guarantee: Edge instances do not share memory. For hard spend caps, configure a Groq spend limit and, if needed, a durable limiter (Upstash/Postgres) in front of the provider call.

## Local verification with no account or key

```sh
node dev/assistant-mock-server.mjs      # http://127.0.0.1:8787
```

The mock runs the real handler with a stubbed provider and a fake token, so the interface can be exercised end to end. It accepts only `mock-session-token-for-local-ui-only`, serves only the allowlisted local origin, and contains no secrets. It is development-only and is not deployed.

`npm test` covers the handler (auth rejection, CORS, validation, limits, rate limiting, provider failures) and the browser client (config validation, privacy of the request body, history caps, safe error mapping).

## Not verified in this environment

- No Supabase project, account or CLI session was available, so the function has **not** been deployed or invoked live.
- No Groq key was available, so there has been **no live model call**.
- No browser auth/session provider exists in this static app yet, so the "signed-in" path is exercised only through the mock and unit tests.
