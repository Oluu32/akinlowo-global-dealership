/**
 * Answers questions about the desk from the records already loaded in the
 * page. Nothing here touches the network: the figures are computed from the
 * same state the screens render, so an answer cannot disagree with a card on
 * screen, and no record leaves the browser to produce it.
 *
 * Returns a short plain-text answer, or null when the question is not a
 * record question — the assistant service then answers it instead.
 */

import { formatNaira, landedCost } from './core.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

const money = value => {
  try {
    return formatNaira(Number(value) || 0);
  } catch {
    return '—';
  }
};

const list = (state, key) => (Array.isArray(state?.[key]) ? state[key] : []);
const sum = (rows, read) => rows.reduce((total, row) => total + (Number(read(row)) || 0), 0);

const nameOf = vehicle => `${vehicle?.year || ''} ${vehicle?.make || ''} ${vehicle?.model || ''}`.trim() || 'Vehicle';

function daysOnLot(vehicle, today) {
  const from = new Date(`${vehicle?.arrivalDate || today}T00:00:00Z`);
  const to = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function monthOf(text, now) {
  const year = now.getUTCFullYear();
  const thisKey = `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (/\blast month\b/.test(text)) {
    const date = new Date(Date.UTC(year, now.getUTCMonth() - 1, 1));
    return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`, label: labelFor(date.getUTCMonth(), date.getUTCFullYear()) };
  }
  const index = MONTHS.findIndex(name => new RegExp(`\\b${name}\\b`).test(text));
  if (index < 0) {
    if (/\bthis month\b/.test(text)) return { key: thisKey, label: labelFor(now.getUTCMonth(), year) };
    return null;
  }
  const monthYear = index > now.getUTCMonth() ? year - 1 : year;
  return { key: `${monthYear}-${String(index + 1).padStart(2, '0')}`, label: labelFor(index, monthYear) };
}

function labelFor(index, year) {
  const name = MONTHS[index] || '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

export function deskSnapshot(state = {}, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const vehicles = list(state, 'vehicles');
  const sales = list(state, 'sales');
  const expenses = list(state, 'expenses');
  const documents = list(state, 'documents');
  const open = vehicles.filter(vehicle => vehicle.status !== 'sold');

  const outstandingRows = sales
    .filter(sale => Number(sale.total) - Number(sale.paidAmount) > 0.004)
    .sort((a, b) => (Number(b.total) - Number(b.paidAmount)) - (Number(a.total) - Number(a.paidAmount)));

  const realised = sales.reduce((total, sale) => {
    const vehicle = vehicles.find(item => item.id === sale.vehicleId);
    const cost = vehicle ? landedCost(vehicle) : 0;
    return total + (Number(sale.basePrice) || 0) - (cost + (Number(sale.vehicleExpense) || 0));
  }, 0);

  return {
    today,
    vehicles,
    open,
    sales,
    expenses,
    documents,
    countByStatus: status => vehicles.filter(vehicle => vehicle.status === status).length,
    stockCost: sum(open, vehicle => landedCost(vehicle)),
    stockAsking: sum(open, vehicle => vehicle.askingPrice),
    received: sum(sales, sale => sale.paidAmount),
    soldValue: sum(sales, sale => sale.total),
    outstanding: sum(sales, sale => Math.max(0, Number(sale.total) - Number(sale.paidAmount))),
    outstandingRows,
    expenseTotal: sum(expenses, expense => expense.amount),
    realised,
    invoices: documents.filter(document => document.kind === 'invoice').length,
    receipts: documents.filter(document => document.kind === 'receipt').length
  };
}

const asksForHelp = text => /\b(how do i|how do we|how can i|how to|where do i|where can i|what button|which button)\b/.test(text);

/* An instruction to record something belongs to the assistant, which prepares
   the card; this module only answers questions. */
const asksToRecord = text => /\b(record|log|enter|save|file|issue|register|mark|create|add)\b/.test(text)
  || /^(i|we)\s+(just\s+)?(received|collected|got paid|was paid)\b/.test(text)
  || /\b(i|we)\s+just\s+(received|collected)\b/.test(text)
  || /\b(paid|transferred|deposited|settled)\b[^?]*\b(\d|₦|naira)/.test(text)
  || /\b(paid|transferred|deposited)\s+(me|us)\b/.test(text);

const PAYMENT_TALK = /\b(owe|owes|owing|outstanding|unpaid|balance|due|left|paid|pay|payment|receipt|receipts|invoice|invoice's|deposit|part.?paid)\b/;

/** Finds the sale a question names, by invoice number or by buyer. */
export function findNamedSale(text, sales = []) {
  const clean = String(text || '').toLowerCase();
  const byNumber = sales.filter(sale => {
    const number = String(sale?.invoiceNumber || '').toLowerCase().trim();
    return number && clean.replace(/\s+/g, '').includes(number.replace(/\s+/g, ''));
  });
  if (byNumber.length) return byNumber.length === 1 ? byNumber[0] : null;

  const full = sales.filter(sale => {
    const name = String(sale?.buyerName || '').toLowerCase().trim();
    return name && clean.includes(name);
  });
  if (full.length) return full.length === 1 ? full[0] : null;

  const partial = sales.filter(sale => String(sale?.buyerName || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some(word => word.length >= 3 && new RegExp(`\\b${word}\\b`).test(clean)));
  return partial.length === 1 ? partial[0] : null;
}

function describeSale(sale, vehicles, snapshot) {
  const vehicle = vehicles.find(item => item.id === sale.vehicleId);
  const total = Number(sale.total) || 0;
  const paid = Number(sale.paidAmount) || 0;
  const due = Math.max(0, Number((total - paid).toFixed(2)));
  const payments = Array.isArray(sale.payments) ? sale.payments : [];
  const receipts = snapshot.documents.filter(document => document.kind === 'receipt' && (document.saleId === sale.id));
  const lines = [
    `${sale.buyerName || 'Buyer'} — ${vehicle ? nameOf(vehicle) : 'vehicle removed from stock'} · invoice ${sale.invoiceNumber || 'not issued'}${sale.date ? ` · ${sale.date}` : ''}`,
    `Total ${money(total)} · paid ${money(paid)} · ${due > 0.004 ? `${money(due)} still due` : 'fully paid'}`
  ];
  if (payments.length) {
    const last = payments[payments.length - 1];
    lines.push(`${payments.length} payment${payments.length === 1 ? '' : 's'} recorded; last ${money(last.amount)} on ${last.date || 'no date'} by ${last.method || 'method not recorded'}.`);
  } else if (paid > 0) {
    lines.push('No individual payments recorded yet.');
  }
  if (receipts.length) lines.push(`Receipts issued: ${receipts.length}${due > 0.004 ? ' — a further receipt is issued for each new payment.' : '.'}`);
  return lines.join('\n');
}

export function answerDeskQuestion(question, state, options = {}) {
  const text = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (asksForHelp(text)) return null;
  if (asksToRecord(text)) return null;

  const now = options.now instanceof Date ? options.now : new Date();
  const snapshot = deskSnapshot(state, { today: options.today || now.toISOString().slice(0, 10) });

  /* A named vehicle: "where is the Camry", "tell me about the RX 350". */
  const vehicle = snapshot.vehicles.find(item => {
    const model = String(item.model || '').toLowerCase().trim();
    const vin = String(item.vin || '').toLowerCase().trim();
    if (vin && text.includes(vin)) return true;
    return Boolean(model) && text.includes(model);
  });
  if (vehicle && /\b(where|which|about|status|tell me|how much|when|price|cost|sold|sell)\b/.test(text)) {
    const days = daysOnLot(vehicle, snapshot.today);
    const sale = snapshot.sales.find(item => item.vehicleId === vehicle.id);
    const parts = [
      `${nameOf(vehicle)} — ${vehicle.status || 'available'}${vehicle.vin ? ` · VIN ${vehicle.vin}` : ''}`,
      `Asking ${money(vehicle.askingPrice)} · landed cost ${money(landedCost(vehicle))}`,
      vehicle.arrivalDate ? `Arrived ${vehicle.arrivalDate}${days == null ? '' : ` · ${days} day${days === 1 ? '' : 's'} on lot`}` : 'No arrival date recorded'
    ];
    if (sale) parts.push(`Sold to ${sale.buyerName} on ${sale.date} for ${money(sale.total)}; ${money(sale.paidAmount)} received, ${money(Math.max(0, Number(sale.total) - Number(sale.paidAmount)))} still due.`);
    return parts.join('\n');
  }

  /* A named buyer or invoice: "what does Aisha still owe", "balance on AGI-INV-2026-0001". */
  const named = findNamedSale(text, snapshot.sales);
  if (named && PAYMENT_TALK.test(text)) return describeSale(named, snapshot.vehicles, snapshot);

  if (!/\b(stock|vehicles?|cars?|inventory|sales?|sold|sell|owes?|owed|owing|outstanding|unpaid|balances?|received|collect|profit|margin|expenses?|invoices?|receipts?|documents?|desk|lot)\b/.test(text)) return null;

  if (/\b(how many (cars|vehicles)|stock count|what'?s? in stock|what is in stock|list (my )?stock|inventory list|how many (available|reserved|sold))\b/.test(text)) {
    if (!snapshot.vehicles.length) return 'No vehicles on this desk yet. Add the first one from Inventory.';
    const counts = `Stock: ${snapshot.vehicles.length} vehicle${snapshot.vehicles.length === 1 ? '' : 's'} — ${snapshot.countByStatus('available')} available, ${snapshot.countByStatus('reserved')} reserved, ${snapshot.countByStatus('sold')} sold.`;
    if (/\b(list|what'?s? in stock|what is in stock|show)\b/.test(text)) {
      const rows = snapshot.open.slice(0, 6).map(item => `• ${nameOf(item)} — ${item.status}, ask ${money(item.askingPrice)}`);
      return [counts, rows.length ? rows.join('\n') : 'Nothing available or reserved right now.'].join('\n');
    }
    return counts;
  }

  if (/\b(stock|inventory|vehicles?).*\b(worth|value)\b|\bhow much is my (stock|inventory)\b/.test(text)) {
    if (!snapshot.open.length) return 'No unsold stock, so nothing is tied up in vehicles right now.';
    return `Unsold stock: ${snapshot.open.length} vehicle${snapshot.open.length === 1 ? '' : 's'}.\nLanded cost ${money(snapshot.stockCost)} · asking price ${money(snapshot.stockAsking)}.`;
  }

  if (/\b(who owes|owes me|outstanding|unpaid|balance(s)? due|debtors?)\b/.test(text)) {
    if (!snapshot.outstandingRows.length) return 'Nothing is outstanding: every sale on this desk is fully paid.';
    const rows = snapshot.outstandingRows.slice(0, 5).map(sale => {
      const car = snapshot.vehicles.find(item => item.id === sale.vehicleId);
      const left = Number(sale.total) - Number(sale.paidAmount);
      return `• ${sale.buyerName} — ${car ? nameOf(car) : 'vehicle removed'} — ${money(left)} left of ${money(sale.total)}`;
    });
    const more = snapshot.outstandingRows.length > 5 ? `\n…and ${snapshot.outstandingRows.length - 5} more in Sales.` : '';
    return `Outstanding: ${money(snapshot.outstanding)} across ${snapshot.outstandingRows.length} sale${snapshot.outstandingRows.length === 1 ? '' : 's'}.\n${rows.join('\n')}${more}`;
  }

  if (/\b(received|collected|cash in|money in|how much.*paid)\b/.test(text)) {
    if (!snapshot.sales.length) return 'No sales recorded yet, so nothing has been received.';
    return `Cash received to date: ${money(snapshot.received)} of ${money(snapshot.soldValue)} sold.${snapshot.outstanding ? `\nStill due: ${money(snapshot.outstanding)}.` : ''}`;
  }

  if (/\b(profit|margin|gross)\b/.test(text)) {
    if (!snapshot.sales.length) return 'No sales yet, so there is no realised profit to show.';
    return `Estimated realised gross profit: ${money(snapshot.realised)}.\nThat is sale price minus landed cost and vehicle expenses for ${snapshot.sales.length} sold vehicle${snapshot.sales.length === 1 ? '' : 's'}. Unsold stock is not included.`;
  }

  if (/\bexpenses?\b|\bspend\b/.test(text)) {
    if (!snapshot.expenses.length) return 'No expenses recorded on this desk yet.';
    return `Expenses recorded: ${snapshot.expenses.length} totalling ${money(snapshot.expenseTotal)}.`;
  }

  if (/\b(invoices?|receipts?|documents?)\b/.test(text)) {
    if (!snapshot.documents.length) return 'No documents yet. An invoice is created with a sale, and a receipt when a payment is recorded.';
    return `Documents on this desk: ${snapshot.invoices} invoice${snapshot.invoices === 1 ? '' : 's'} and ${snapshot.receipts} receipt${snapshot.receipts === 1 ? '' : 's'}. Open any of them from Documents.`;
  }

  if (/\b(sales?|sold|sell)\b/.test(text)) {
    const month = monthOf(text, now);
    const rows = month ? snapshot.sales.filter(sale => String(sale.date).slice(0, 7) === month.key) : snapshot.sales;
    if (!rows.length) {
      return month ? `No sales recorded for ${month.label}.` : 'No sales recorded on this desk yet.';
    }
    const value = sum(rows, sale => sale.total);
    const paid = sum(rows, sale => sale.paidAmount);
    const due = value - paid;
    return `${month ? `${month.label}: ` : 'All sales: '}${rows.length} sale${rows.length === 1 ? '' : 's'} worth ${money(value)}.\nReceived ${money(paid)}${due > 0.004 ? ` · still due ${money(due)}` : ' · fully paid'}.`;
  }

  return null;
}
