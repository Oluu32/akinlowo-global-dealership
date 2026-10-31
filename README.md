# Akinlowo Global dealership desk

An original local-first dealership management prototype for Akinlowo Global Investments and Autos. The project uses public feature descriptions as broad workflow context and is independently implemented. It does not contain copied DealerBoss code, assets, screenshots, or customer examples.

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
- Browser `localStorage` persistence and clearly labelled fictional demo vehicles. No demo customers or real financial data are included in seed records.
- A floating assistant button and panel that is a clearly labelled, not-connected interface shell. There is no AI service, no request is made and no record is sent anywhere.

## Daily NGN rates

The overview rate panel reads the ExchangeRate-API Open Access feed at `https://open.er-api.com/v6/latest/USD`. It is a public, keyless endpoint, so no API key exists in this codebase to expose. The browser makes a single fixed GET with no customer, sale, inventory or storage data, and the request is sent with `credentials: omit`.

Cross rates follow the provider's USD-based table only: `NGN per 1 unit = rates.NGN / rates[unit]`, and each figure is rounded to two decimals for display.

- Support and terms were re-checked on 31 October 2026 against <https://www.exchangerate-api.com/docs/free>: the Open Access endpoint requires attribution, updates once per day and permits caching for personal or commercial conversion, but not re-distribution of the feed.
- The panel therefore displays derived naira rates only, links the required "Rates By Exchange Rate API" attribution to <https://www.exchangerate-api.com>, and links the provider terms.
- The response is cached in this browser for one hour under its own storage key; the rest of the app's data is untouched. A rate older than 36 hours, or one the provider has not refreshed on schedule, is labelled **Stale** and the last saved copy is clearly marked.
- If the request fails, no rate is invented: the panel reports **Unavailable**, keeps the source and terms links, and offers a retry. If a saved copy exists it is shown with its real provider timestamp and labelled accordingly.
- Rates are a display reference only. They are not used in invoices, receipts, sale totals, VAT or any other stored figure, and they are not a quote.

## Akinlowo Global document identity

AKINLOWO GLOBAL INVESTMENTS AND AUTOS · RC 1554770 · 27 Street B3, Kuchiyako Ext Kuje Abuja Nigeria · +234-70-3392-1599 · +234-90-1696-0025 · natureautomobiles@outlook.com. NGN/₦ is the default currency. Confirm these details and every transaction field before issuing a document.

## Prototype limits

This is a local browser demo, not production accounting, tax advice, a statutory ledger or a government e-invoicing service. Records remain on one browser/device and can be lost if its storage is cleared. There is no backend, login/access control, multi-user synchronisation, external payment processing, bank reconciliation, live FX conversion, public vehicle marketplace, VIN camera scanning or cloud backup. VAT settings and calculations are editable arithmetic only and do not establish tax treatment or compliance. Use a secure production system and professional advice before relying on business records.

## Tests

`npm test` runs the Node test suite. It covers naira formatting, VAT and sale totals, balances and invalid payment/rate handling, document numbering, vehicle status transitions and landed-cost arithmetic; the Africa/Lagos greeting and owner-name fallback; NGN cross-rate building and rejection of missing currencies; rate freshness and stale/unavailable states; parsing the provider payload, its error responses, cache round-trip and blocked-storage handling; and that the rate request carries no credentials or record data.
