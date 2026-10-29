# Akinlowo Global dealership desk

An original local-first dealership management prototype for Akinlowo Global Investments and Autos. The project uses public feature descriptions as broad workflow context and is independently implemented. It does not contain copied DealerBoss code, assets, screenshots, or customer examples.

## Run locally

Requires Node.js 18+ for the tests. The app itself is static and has no install step. Serve the repository root with any static file server, for example:

```sh
python -m http.server 8000
```

Open `http://localhost:8000`. To run the automated calculation tests:

```sh
npm test
```

## Included

- Responsive overview, inventory, sales, finance, supplier payable and document views.
- Vehicle stock records with VIN/chassis, condition, mileage, colour, engine/plate/customs identifiers, status, arrival date, acquisition cost, clearing, transport, repair costs and asking price.
- Sale recording with optional editable VAT, partial payments, remaining balances, duplicate-sale prevention and separate invoice/receipt numbering.
- A4-friendly invoice and payment receipt print views using browser print / save as PDF, business details and an original vector logo mark.
- Expense and supplier payable ledgers, payment records, VAT summaries, gross-profit estimates and CSV export.
- Browser `localStorage` persistence and clearly labelled fictional demo vehicles. No demo customers or real financial data are included in seed records.

## Akinlowo Global document identity

AKINLOWO GLOBAL INVESTMENTS AND AUTOS · RC 1554770 · 27 Street B3, Kuchiyako Ext Kuje Abuja Nigeria · +234-70-3392-1599 · +234-90-1696-0025 · natureautomobiles@outlook.com. NGN/₦ is the default currency. Confirm these details and every transaction field before issuing a document.

## Prototype limits

This is a local browser demo, not production accounting, tax advice, a statutory ledger or a government e-invoicing service. Records remain on one browser/device and can be lost if its storage is cleared. There is no backend, login/access control, multi-user synchronisation, external payment processing, bank reconciliation, live FX conversion, public vehicle marketplace, VIN camera scanning or cloud backup. VAT settings and calculations are editable arithmetic only and do not establish tax treatment or compliance. Use a secure production system and professional advice before relying on business records.

## Tests

The Node test suite covers naira formatting, VAT, sale totals and balances, invalid payment/rate handling, document numbering, vehicle status transitions and landed-cost arithmetic.
