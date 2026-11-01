# Handover: Akinlowo Global dealership desk

This file is for the person taking ownership of the dealership desk. It says what
you are receiving, where every piece lives, what to do in the first week, and what
to watch for afterwards. It contains no passwords or API keys — those are handed
over privately and belong in a password manager, never in this repository (this
repository is public and publishes the live site).

## What you are receiving

A private, sign-in protected web desk for Akinlowo Global Investments and Autos:

- Vehicle stock with landed cost (acquisition, clearing, transport, repairs).
- Sales with an optional VAT amount, part payments and balances.
- Invoice and receipt print views you can print or save as PDF.
- Expenses, supplier payables, VAT summaries, gross-profit estimates, CSV export.
- Indicative USD/CAD/CNY/EUR → NGN rates, labelled as reference only.
- A support assistant that answers "how do I…" questions about the desk.

Nothing opens until someone signs in with a dealer account. Business records are
stored in a Supabase database, not in the browser.

## Where it lives

| Piece | Where |
| --- | --- |
| Live site | <https://oluu32.github.io/akinlowo-global-dealership/> |
| Hosting | GitHub Pages, publishing branch `main`, folder `/` (public repo, private desk) |
| Source code | <https://github.com/Oluu32/akinlowo-global-dealership> |
| Database, login accounts | Supabase project `lytyxtzdkrpqtdregwsg` (region `eu-west-3`) |
| Records table | `public.desk_state`, single row `id = 'default'` |
| Assistant backend | Supabase Edge Function `dealership-assistant` |
| Assistant model provider | Groq, key held as the Supabase secret `GROQ_API_KEY` |

The public keys inside `index.html` (Supabase project URL and publishable key) are
meant to be public. They grant nothing on their own: the database refuses every
request that is not from a signed-in dealer.

## Accounts you need

Three, all free to start:

1. **GitHub** — to own the repository and the site.
2. **Supabase** — to own the database, the dealer logins and the assistant function.
3. **Groq** (<https://console.groq.com>) — only needed when you replace or revoke
   the assistant key.

Ask the previous owner to transfer, not share, these:

- GitHub repository → Settings → General → Danger zone → Transfer ownership.
- Supabase project → Project settings → General → Transfer project to another
  organization/account.

After a transfer the previous owner should be removed from the repository and the
project, so only you can publish code or read records.

### The sign-in you were given

There is one dealer account today, created for you, with an email address and
password passed on privately. It is already email-confirmed, and this app has no
"forgot password" screen on purpose.

This app has no in-app password change, so replace it from the Supabase side. The
simplest route, and the one that keeps the records intact (they belong to the desk
row, not to the account): **Authentication → Users → Add user**, tick *Auto
Confirm*, then delete the handed-over account and keep the new password in a
password manager. Until you do, treat the old password as shared with everyone who
saw the handover message.

Keeping the same email address instead? Set the password through the Admin API in
**Project settings → API** (the `service_role` key is server-side only, never put
it in `index.html`):

```sh
curl -X PUT "https://<project-ref>.supabase.co/auth/v1/admin/users/<user-id>" \
  -H "apikey: <service_role key>" \
  -H "Authorization: Bearer <service_role key>" \
  -H "Content-Type: application/json" \
  -d '{"password":"<new long password>"}'
```

## First week

1. Accept the GitHub and Supabase transfers, then remove the previous owner.
2. Open the live site, sign in, and confirm the desk loads with **All changes saved**
   in the top bar.
3. Replace the handed-over password (see “The sign-in you were given” above) and
   store the new one in your password manager.
4. Decide on the login email. The current address uses a `.test` domain, which can
   never receive mail — fine while you sign in by hand, but if you ever want email
   based resets, create the account with a real mailbox instead
   (**Authentication → Users → Add user**, and delete the old one).
5. Delete the labelled **DEMO** vehicles once you are ready for real stock
   (**Inventory → Delete**). They are clearly marked fictional records, not your data.
6. Take a backup (see below) before you start entering real sales.
7. If staff will use the desk, give each person their own login rather than sharing
   one — then you can delete a login when someone leaves.

## Everyday jobs

**Add a staff login.** Supabase dashboard → **Authentication → Users → Add user**,
set an email and password, tick "auto confirm". Send the password to that person
privately. There is no public sign-up page, so no stranger can create an account.

**Remove someone's access.** Same screen → the user → delete. Their session dies at
the next load; records are untouched.

**Back up the records.** The desk lives in one row, so a backup is one export:

- Supabase dashboard → **Table editor → desk_state** → the row menu → export as CSV/JSON, or
- Supabase dashboard → **SQL editor**:
  `select data from public.desk_state where id = 'default';` and save the result.

Do this weekly, or before any big change. Keep the file somewhere you control.
For accounting hand-off, the app also has **Finance → Export CSV**.

**Restore from a backup.** SQL editor, wrapping the saved JSON in dollar quotes so
no inner quoting breaks the statement:

```sql
update public.desk_state
   set data = $backup$<paste the saved json here>$backup$::jsonb,
       updated_at = now()
 where id = 'default';
```

**Publish a change to the site.** Edit the files, then commit and push to `main` on
GitHub. GitHub Pages rebuilds in about a minute and the live site updates. There is
no build step and no separate deploy command. Check the site after pushing.

**Change the assistant.** It is a Supabase Edge Function. See
[`supabase/functions/dealership-assistant/README.md`](supabase/functions/dealership-assistant/README.md).
The short version, with the Supabase CLI installed and logged in:

```sh
supabase functions deploy dealership-assistant --project-ref lytyxtzdkrpqtdregwsg
supabase secrets set GROQ_API_KEY=<your Groq key> ASSISTANT_ALLOWED_ORIGINS=https://oluu32.github.io --project-ref lytyxtzdkrpqtdregwsg
```

If you ever serve the desk from a different address, add that exact origin (scheme,
host, port) to `ASSISTANT_ALLOWED_ORIGINS`, or the assistant will refuse to answer
from the browser. The records themselves do not depend on that setting.

**Run the tests.** `npm test` (Node 18+). 80 checks cover the money arithmetic,
document numbering, storage contract, sign-in gate and assistant limits. Run it
before pushing if you change code.

## What to know before real use

- **The desk is shared, not per-person.** Every signed-in account reads and edits
  the same one row. Last save wins: two people editing at the same time can
  overwrite each other. Fine for one owner; revisit before several staff work at once.
- **Free Supabase projects pause after about a week with no database activity.**
  A paused desk shows **Could not reach the dealership database** until you resume
  it: dashboard → the project → **Resume project**. Projects stay recoverable for
  a year, but the desk is offline meanwhile. One sign-in per week keeps it awake,
  or upgrade the project to a paid plan to remove pausing entirely.
- **Free tier has no automatic backups.** The weekly export above is your backup.
  A paid plan adds daily backups.
- **Revenue costs.** GitHub Pages for a public repository and Supabase's free tier
  cost nothing at this scale. The assistant uses a Groq account; watch its usage
  page. If Groq stops answering, the panel reports **Unavailable** and the rest of
  the desk keeps working.
- **The records are business data.** Anyone with a dealer login, or with access to
  your Supabase dashboard, can read and change them. Keep both accounts protected,
  and give the dashboard its own strong password and two-factor authentication.
- **The assistant can be wrong.** It is grounded in a written description of this
  desk and forbidden from inventing records, but it sometimes describes buttons or
  screens that do not exist. Treat it as a hint, and check the actual screen. It
  cannot read or change your records.
- **VAT here is arithmetic.** Rates and amounts are whatever you type; nothing is a
  tax filing or advice. Invoices are not connected to government e-invoicing.
- **The site address is public**, so anyone can find the sign-in page. Security rests
  on the password and on Supabase's rate limits, which is why a long random password
  matters more than a short one.

## If something goes wrong

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Page loads, sign-in says the service is unavailable | Supabase project paused | Dashboard → Resume project |
| Sign-in says the email and password do not match | wrong password, or the user was deleted | Authentication → Users: add a user, or set the password via the Admin API |
| Signed in, but the desk says it could not be loaded | database policy or table changed | compare against the SQL in [README](README.md#sign-in-and-record-storage) |
| Top bar says **Not saved · retry** | connection dropped, or the session ended | click the status, or sign in again |
| Assistant says **Unavailable** | Groq key missing, out of quota, or the function was not deployed | check the secret and redeploy |
| Live site shows old code | Pages build still running | GitHub → Actions/Pages, wait for **built** |

## What is still the previous developer's

Two items from the build are still held by the previous owner and are worth closing
after the handover:

- A Supabase **personal access token** used to set the function secrets. Once you
  hold the project, ask them to revoke it (Supabase → Account → Access tokens).
- Their GitHub and Supabase membership of this project, once the transfers are done.

Neither can read the desk without a dealer login, but both are more access than an
owner should leave lying around.
