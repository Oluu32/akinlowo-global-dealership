# Akinlowo Global dealership desk

An original, sign-in-protected dealership management desk for Akinlowo Global Investments and Autos. The project uses public feature descriptions as broad workflow context and is independently implemented. It does not contain copied DealerBoss code, assets, screenshots, or customer examples.

## Run locally

Requires Node.js 18+ for the tests. The app itself is static and has no install step. Serve the repository root with any static file server, for example:

```sh
python -m http.server 8000
```

Open `http://localhost:8000`. To run the automated tests:

```sh
npm test
```

## Included

- Responsive overview, inventory, sales, finance, supplier payable and document views.
- Fixed desktop sidebar with the existing Akinlowo Global logo displayed on a light plate at a readable size, and a fixed bottom navigation bar on narrow phones.
- Overview welcome driven by `Africa/Lagos` (WAT, UTC+1): time-based greeting, Lagos date/time and a shortcut into a new sale. The owner's name is used only when app data already contains one (for example `settings.ownerName`); otherwise the greeting stays generic. No name is invented or seeded.
- Indicative NGN exchange-rate panel for USD, CAD, CNY and EUR with the provider's own last-updated time, a stale/unavailable status, the source link and an "indicative, not guaranteed transaction rates" note.
- Vehicle stock records with VIN/chassis, condition, mileage, colour, engine/plate/customs identifiers, status, arrival date, acquisition cost, clearing, transport, repair costs and asking price.
- Sale recording with optional editable VAT (off by default for a new sale), partial payments, remaining balances, duplicate-sale prevention and separate invoice/receipt numbering. Changing the default never rewrites an existing sale.
- A4-friendly invoice and payment receipt print views using browser print / save as PDF, business details and an original vector logo mark.
- Expense and supplier payable ledgers, payment records, VAT summaries, gross-profit estimates and CSV export.
- Records stored in Supabase Postgres (`public.desk_state`) and loaded only for a signed-in dealer, with clearly labelled fictional demo vehicles seeded on first use. No demo customers or real financial data are included in seed records.
- A full-desk sign-in gate: nothing renders until a Supabase user session exists, and signing out locks the desk again. No business record is written to `localStorage`, `sessionStorage` or IndexedDB — only the auth session is kept, in `sessionStorage` for the tab.
- A floating dealership support assistant that answers questions about using the desk (invoices, receipts, VAT, payments, stock, rates). It is gated behind a secure Supabase Edge Function and a server-side Groq key. Without a configured endpoint the panel stays open, labelled **Not configured**, and sends nothing.

## Sign-in and record storage

Nothing on the desk renders until Supabase Auth has issued a session, and every record read or write goes to Postgres through PostgREST with that session's access token. The project's public publishable key alone cannot read the desk: row level security grants nothing to `anon`.

One row holds the whole desk (`id = 'default'`), so this is a shared dealership desk rather than per-account data: every dealer login sees and edits the same records, and each save overwrites the entire row. That is deliberate for a single-owner dealership, and it is the main limitation to revisit before adding staff with different access.

Set it up once in the SQL editor:

```sql
create table if not exists public.desk_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.desk_state enable row level security;
revoke all on public.desk_state from anon;
grant select, insert, update on public.desk_state to authenticated;

create policy desk_state_read on public.desk_state
  for select to authenticated using (true);
create policy desk_state_insert on public.desk_state
  for insert to authenticated with check (id = 'default');
create policy desk_state_update on public.desk_state
  for update to authenticated using (id = 'default') with check (id = 'default');
```

Create dealer logins under **Authentication → Users**; there is no public sign-up, invite or reset screen in this app. On the first sign-in of an empty desk, any records left in this browser by older versions are uploaded once and the old `localStorage` keys are deleted; after that the browser keeps nothing but the session.

## Daily NGN rates

The overview rate panel reads the ExchangeRate-API Open Access feed at `https://open.er-api.com/v6/latest/USD`. It is a public, keyless endpoint, so no API key exists in this codebase to expose. The browser makes a single fixed GET with no customer, sale, inventory or storage data, and the request is sent with `credentials: omit`.

Cross rates follow the provider's USD-based table only: `NGN per 1 unit = rates.NGN / rates[unit]`, and each figure is rounded to two decimals for display.

- Support and terms were re-checked on 31 October 2026 against <https://www.exchangerate-api.com/docs/free>: the Open Access endpoint requires attribution, updates once per day and permits caching for personal or commercial conversion, but not re-distribution of the feed.
- The panel therefore displays derived naira rates only, links the required "Rates By Exchange Rate API" attribution to <https://www.exchangerate-api.com>, and links the provider terms.
- The response is cached in this browser for one hour under its own storage key; the rest of the app's data is untouched. A rate older than 36 hours, or one the provider has not refreshed on schedule, is labelled **Stale** and the last saved copy is clearly marked.
- If the request fails, no rate is invented: the panel reports **Unavailable**, keeps the source and terms links, and offers a retry. If a saved copy exists it is shown with its real provider timestamp and labelled accordingly.
- Rates are a display reference only. They are not used in invoices, receipts, sale totals, VAT or any other stored figure, and they are not a quote.

## Dealership assistant

The assistant is a real chat panel backed by the Supabase Edge Function in [`supabase/functions/dealership-assistant`](supabase/functions/dealership-assistant/README.md). This repository ships only the project URL and its public publishable key, in the runtime config near the foot of `index.html`. If the function is not deployed, the panel loads but any message reports **Unavailable**.

- **No secret in the browser.** The only key in the client is Supabase's publishable key, which is public by design and grants nothing without a signed-in user. The Groq key exists only as the server-side `GROQ_API_KEY` secret; a `service_role` or `sb_secret_…` key is refused at startup. No model key is committed, logged or sent to the client.
- **Verified authorization.** The function rejects missing, expired or anon-key tokens by verifying the caller with `auth.getUser`, supports an optional email allowlist, and applies an origin allowlist, per-user rate limits, input caps and safe error messages.
- **No records leave the page.** The request body is only `{ messages: [{ role, content }] }` built from the words typed in the panel. Vehicles, sales, buyers, documents and storage are never read into it, and chat history is kept in memory only.
- **Sign-in gate.** The whole desk is behind a password gate, so the panel never needs its own. The session lives in `sessionStorage` for that tab, refreshes shortly before expiry, and is cleared on sign-out or when the service rejects it. Passwords are never stored, reused or written to disk.
- **Honest states.** With no endpoint the panel says **Not configured** and the composer is disabled. A missing or ended session says **Sign-in required**. Service failures say **Unavailable**, **Busy**, **Offline** or **Timed out** — never a fabricated answer.
- **Scoped instructions.** The system prompt limits the assistant to this desk, forbids inventing records, forbids claiming it created, sent or printed anything, forbids asking for or repeating customer data, and requires it to admit when a question needs the person to check a screen.

### Enabling it

1. Deploy the function and set `GROQ_API_KEY` and `ASSISTANT_ALLOWED_ORIGINS` as project secrets. See the [function README](supabase/functions/dealership-assistant/README.md) for the full command list.
2. Create dealer accounts under **Authentication → Users** in the Supabase dashboard. There is no public sign-up form in this app on purpose.
3. Serve this app with a small runtime config placed before the `app.js` module tag:

```html
<script>
  window.AKINLOWO_SUPABASE = {
    url: 'https://<project-ref>.supabase.co',
    // publishable key, or a legacy anon key; never service_role or sb_secret_
    anonKey: '<public anon / publishable key>'
    // assistantEndpoint: optional override; derived from the project URL otherwise
  };
</script>
```

This repository already carries that block at the foot of `index.html` (project `lytyxtzdkrpqtdregwsg`); replace the URL and key if you fork it. No build step is involved.

The panel then shows the sign-in gate, derives the function endpoint, and refreshes the session itself. A publishable or anon key is a public client key; a `service_role` or `sb_secret_…` key is rejected at startup so it cannot be shipped by mistake.

A host that already manages sessions can skip the gate entirely by supplying the token itself:

```html
<script>
  window.AKINLOWO_ASSISTANT = {
    endpoint: 'https://<project-ref>.supabase.co/functions/v1/dealership-assistant',
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null
  };
</script>
```

Local QA without a Supabase account or Groq key: `node dev/assistant-mock-server.mjs` runs the real request pipeline and a fake sign-in at <http://127.0.0.1:8787>. Demo credentials are `dealer@akinlowo.test` / `demo-dealer-2026`; they only exist in that local mock.

## Akinlowo Global document identity

AKINLOWO GLOBAL INVESTMENTS AND AUTOS · RC 1554770 · 27 Street B3, Kuchiyako Ext Kuje Abuja Nigeria · +234-70-3392-1599 · +234-90-1696-0025 · natureautomobiles@outlook.com. NGN/₦ is the default currency. Confirm these details and every transaction field before issuing a document.

## Prototype limits

This is a single-desk internal tool, not production accounting, tax advice, a statutory ledger or a government e-invoicing service. Records live in one shared `desk_state` row in Supabase and every signed-in account can read and change that same desk; there is no per-user separation, audit trail or role-based restriction beyond "signed in". Anyone with a project account therefore sees all dealership records. Concurrent edits are last-write-wins at the whole-desk level, because each save upserts the full state, so two people editing at once can overwrite each other. There is no external payment processing, bank reconciliation, currency conversion inside invoices, public vehicle marketplace, VIN camera scanning or document export beyond print/CSV. VAT settings and calculations are editable arithmetic only and do not establish tax treatment or compliance. The assistant is optional, cannot read or change records, and its replies can be wrong. Use professional advice before relying on business records, and take database backups from Supabase.

## Tests

`npm test` runs the Node test suite. It covers naira formatting, VAT and sale totals, balances and invalid payment/rate handling, document numbering, vehicle status transitions and landed-cost arithmetic; the Africa/Lagos greeting and owner-name fallback; NGN cross-rate building and rejection of missing currencies; rate freshness and stale/unavailable states; parsing the provider payload, its error responses, in-session rate freshness; and that the rate request carries no credentials or record data. For storage it covers normalising any stored desk shape, the one-time legacy import and key removal, and the PostgREST contract: the signed-in token on every call, the singleton-row upsert, an empty row reported as empty rather than invented records, and auth, server and offline failures surfacing as explicit errors.

For the assistant it covers the system prompt's accuracy and data rules; payload validation, length and history limits; the origin allowlist with no wildcard; missing, malformed, invalid and unlisted-user sessions; method and body limits; per-user rate limiting; provider failures being mapped to safe messages without the key or provider text; the browser client's config validation, token requirement, history capping, offline/timeout handling and the fact that the outbound body contains only the conversation.

For the sign-in gate it covers Supabase config validation (`https` only, public keys only, `service_role` and `sb_secret_` refused), password sign-in and its error mapping, token refresh just before expiry, refresh rejection clearing the session while an offline refresh keeps it, sign-out revoking and clearing, blocked storage, malformed stored sessions, and that no password is ever written to storage.
