import { formatNaira, calculateSale, nextDocumentNumber, transitionVehicleStatus, landedCost, makeId, welcomeMessage, lagosDateTime, rateFreshness, RATE_CURRENCIES, LAGOS_TIME_ZONE } from './core.js';
import { FX_SOURCE, fetchRates, cacheIsFresh } from './fx.js';
import { readAuthConfig, createAuthClient, AUTH_COPY } from './auth-client.js';
import { createDeskStore, normalizeDeskState, readLegacyState, clearLegacyState, stateHasRecords } from './desk-store.js';
import { initAssistantPanel, setAssistant } from './assistant-panel.js';

const business = {
  name: 'AKINLOWO GLOBAL INVESTMENTS AND AUTOS', rc: 'RC 1554770',
  address: '27 Street B3, Kuchiyako Ext Kuje Abuja Nigeria',
  phones: ['+234-70-3392-1599', '+234-90-1696-0025'], email: 'natureautomobiles@outlook.com'
};
const today = () => new Date().toISOString().slice(0, 10);
const emptyState = () => ({
  settings: { vatEnabled: false, vatRate: 7.5 }, counters: { invoice: 0, receipt: 0 },
  vehicles: [], sales: [], expenses: [], suppliers: [], documents: []
});
const authConfig = readAuthConfig();
const auth = authConfig ? createAuthClient({ config: authConfig }) : null;
const deskStore = authConfig && auth
  ? createDeskStore({ url: authConfig.url, anonKey: authConfig.anonKey, getToken: () => auth.getAccessToken() })
  : null;
let state = normalizeDeskState(emptyState());
let currentRoute = location.hash.slice(1) || 'dashboard';
const titleMap = { dashboard: 'Overview', inventory: 'Inventory', sales: 'Sales', finance: 'Finance', suppliers: 'Suppliers', documents: 'Invoices & receipts', settings: 'Settings' };
const view = document.getElementById('view');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const money = value => formatNaira(Number(value) || 0);
const SAVE_DELAY_MS = 400;
let saveTimer = null;
let savingNow = false;
let saveFailed = false;

function setSaveStatus(text, kind = '') {
  const el = document.getElementById('desk-save');
  if (!el) return;
  el.textContent = text;
  if (kind) el.dataset.state = kind; else delete el.dataset.state;
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!deskStore) return false;
  if (savingNow) { saveTimer = setTimeout(() => { void flushSave(); }, SAVE_DELAY_MS); return false; }
  savingNow = true;
  setSaveStatus('Saving…', 'saving');
  try {
    await deskStore.save(state);
    saveFailed = false;
    setSaveStatus('All changes saved', 'saved');
    return true;
  } catch (error) {
    saveFailed = true;
    setSaveStatus('Not saved · retry', 'error');
    if (error?.code === 'auth') {
      lockDesk(AUTH_COPY.expired, true);
    } else {
      toast(error?.message || 'Could not save to the dealership database');
    }
    return false;
  } finally {
    savingNow = false;
  }
}

function save() {
  setSaveStatus('Saving…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushSave(); }, SAVE_DELAY_MS);
}

/* Closing or reloading within the debounce window would otherwise drop the
 * last change; send it once more without waiting for a response. */
window.addEventListener('pagehide', () => {
  if (!deskStore || !saveTimer || document.body.classList.contains('desk-locked')) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  deskStore.save(state, { keepalive: true }).catch(() => {});
});
const vehicleName = v => `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim();
const statusClass = s => `status-${String(s).toLowerCase().replaceAll(' ', '-')}`;
const statusPill = s => `<span class="status-pill ${statusClass(s)}">${escapeHtml(s)}</span>`;
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function setRoute(route) { currentRoute = titleMap[route] ? route : 'dashboard'; location.hash = currentRoute; render(); }
function openModal(title, description, formHtml) {
  modalContent.innerHTML = `<div class="modal-head"><div><h2>${title}</h2><p>${description}</p></div><button class="icon-button" type="button" aria-label="Close" data-action="close-modal">×</button></div>${formHtml}`;
  modal.showModal();
}
function closeModal() { modal.close(); modalContent.innerHTML = ''; }
function stat(label, value, sub, icon) { return `<article class="card stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></article>`; }
function empty(title, detail, action = '') { return `<div class="empty"><strong>${title}</strong>${detail}${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`; }
function lastSixMonths() { const out=[]; const now=new Date(); for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);out.push({key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,label:d.toLocaleString('en',{month:'short'})});} return out; }
function chartMarkup() {
  const months=lastSixMonths(); const values=months.map(m=>state.sales.filter(s=>String(s.date).slice(0,7)===m.key).reduce((a,s)=>a+s.basePrice,0)); const max=Math.max(...values,1);
  return `<div class="chart">${months.map((m,i)=>`<div class="chart-col"><div class="bar-wrap"><span class="bar" title="Sales ${money(values[i])}" style="height:${Math.max(2,values[i]/max*100)}%"></span><span class="bar alt" title="Cash received ${money(state.sales.filter(s=>String(s.date).slice(0,7)===m.key).reduce((a,s)=>a+s.paidAmount,0))}" style="height:${Math.max(2,state.sales.filter(s=>String(s.date).slice(0,7)===m.key).reduce((a,s)=>a+s.paidAmount,0)/max*100)}%"></span></div><span class="chart-label">${m.label}</span></div>`).join('')}</div><div class="legend"><span><i></i>sale value</span><span><i class="purple"></i>cash received</span></div>`;
}
/* ---------- Lagos welcome ---------- */
function ownerNameFromState() {
  const candidates = [state?.settings?.ownerName, state?.ownerName, business?.ownerName];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function heroMarkup() {
  const welcome = welcomeMessage(new Date(), ownerNameFromState());
  return `<section class="hero" aria-label="Welcome">
    <div class="hero-copy">
      <p class="hero-kicker"><i></i>Africa/Lagos · ${escapeHtml(welcome.timeLabel)}</p>
      <h2>${escapeHtml(welcome.title)}</h2>
      <p class="hero-sub">${escapeHtml(welcome.subtitle)} ${welcome.name ? 'Your stock, sales and balances are summarised from the records saved to your dealership database.' : 'Stock, sales and balances below are summarised from the records saved to your dealership database.'}</p>
    </div>
    <div class="hero-side">
      <span class="hero-date">${escapeHtml(welcome.dateLabel)}</span>
      <span class="hero-clock">West Africa Time · UTC+1</span>
      <button class="hero-cta" type="button" data-action="new-sale">＋ Record a sale</button>
    </div>
  </section>`;
}

/* ---------- Indicative daily NGN rates ---------- */
let rates = null;
let ratesStatus = 'loading';
let ratesError = '';
let ratesRequest = null;

const rateMoney = value => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));

function rateTimestamp(ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: LAGOS_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(ms)) + ' WAT';
  } catch {
    return 'time unavailable';
  }
}

function ratesBodyMarkup() {
  const freshness = rates ? rateFreshness({ lastUpdated: rates.lastUpdated, nextUpdate: rates.nextUpdate }) : { state: 'unavailable' };
  const offline = ratesStatus === 'error';
  let chipClass = '';
  let chipText = 'Current';
  if (!rates) {
    chipClass = ratesStatus === 'loading' ? 'is-loading' : 'is-down';
    chipText = ratesStatus === 'loading' ? 'Checking rates' : 'Unavailable';
  } else if (freshness.state === 'stale') {
    chipClass = 'is-stale';
    chipText = 'Stale';
  } else if (offline) {
    chipClass = 'is-stale';
    chipText = 'Saved copy';
  }

  const updated = rates ? rateTimestamp(rates.lastUpdated) : 'not available yet';
  const tiles = rates
    ? `<div class="rates-grid">${RATE_CURRENCIES.map(({ code, name }) => `<div class="rate-tile"><div class="rate-code"><span>${code}</span><span>1 ${code} → NGN</span></div><div class="rate-value">${escapeHtml(rateMoney(rates.ngn[code]))}</div><div class="rate-name">${escapeHtml(name)}</div></div>`).join('')}</div>`
    : `<p class="small-note" style="margin:0">${ratesStatus === 'loading' ? 'Requesting the daily rate feed. Naira rates appear here when the provider responds.' : 'The daily rate feed could not be reached, so no rates are shown rather than guessed figures.'} ${offline ? escapeHtml(ratesError) : ''}</p>`;

  const retry = offline || freshness.state === 'stale' || !rates
    ? '<button class="button button-quiet button-small rates-retry" type="button" data-action="refresh-rates">Retry feed</button>'
    : '';

  return `<div class="rates-head">
      <div class="rates-title">
        <h2 id="rates-title">Indicative exchange rates <span class="status-chip ${chipClass}">${chipText}</span></h2>
        <p>CAD, USD, CNY and EUR into naira, from one daily provider feed</p>
      </div>
      <div class="rates-meta">
        <span class="rates-updated" aria-live="polite">Provider last updated <b>${escapeHtml(updated)}</b></span>
        ${offline ? '<span class="rates-updated">Showing the last rates loaded in this session</span>' : ''}
        ${retry}
      </div>
    </div>
    ${tiles}
    <div class="rates-foot">
      <span class="rates-attribution">Source: <a href="${FX_SOURCE.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(FX_SOURCE.attribution)}</a> · <a href="${FX_SOURCE.termsUrl}" target="_blank" rel="noopener noreferrer">provider terms</a></span>
      <span>Indicative daily reference rates only — not guaranteed transaction rates.</span>
    </div>`;
}

function ratesCardMarkup() {
  return `<section class="card rates-card" id="rates-panel" aria-labelledby="rates-title">${ratesBodyMarkup()}</section>`;
}

function paintRates() {
  const host = document.getElementById('rates-panel');
  if (!host) return;
  host.innerHTML = ratesBodyMarkup();
}

async function loadRates(force = false) {
  if (ratesRequest) return ratesRequest;
  if (!force && cacheIsFresh(rates)) {
    ratesStatus = 'ready';
    paintRates();
    return undefined;
  }
  if (!rates) ratesStatus = 'loading';
  paintRates();
  ratesRequest = (async () => {
    try {
      const fresh = await fetchRates();
      rates = fresh;
      ratesError = '';
      ratesStatus = 'ready';
    } catch (error) {
      ratesError = error?.message || 'The rate request failed';
      ratesStatus = 'error';
    } finally {
      ratesRequest = null;
      paintRates();
    }
  })();
  return ratesRequest;
}

/* ---------- Overview ---------- */
function renderDashboard() {
  const available=state.vehicles.filter(v=>v.status==='available').length, reserved=state.vehicles.filter(v=>v.status==='reserved').length;
  const stockValue=state.vehicles.filter(v=>v.status!=='sold').reduce((a,v)=>a+landedCost(v),0);
  const outstanding=state.sales.reduce((a,s)=>a+Math.max(0,s.total-s.paidAmount),0);
  const received=state.sales.reduce((a,s)=>a+s.paidAmount,0);
  const profit=state.sales.reduce((a,s)=>a+(s.basePrice-(landedCost(state.vehicles.find(v=>v.id===s.vehicleId)||{})+(Number(s.vehicleExpense)||0))),0);
  const recent=[...state.sales].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  const mix=[['Available',available,'#4274c4'],['Reserved',reserved,'#9376cb'],['Sold',state.vehicles.filter(v=>v.status==='sold').length,'#4a9b78']]; const max=Math.max(...mix.map(x=>x[1]),1);
  view.innerHTML=`${heroMarkup()}<div class="grid stats-grid">${stat('Available stock',available,`${reserved} reserved · ${state.vehicles.filter(v=>v.status==='sold').length} sold`,'▤')}${stat('Inventory landed cost',money(stockValue),'Cost basis of unsold vehicles','₦')}${stat('Cash received',money(received),'Payments recorded on this desk','↗')}${stat('Outstanding balances',money(outstanding),`${state.sales.filter(s=>s.total>s.paidAmount).length} sale(s) with balance due`,'◷')}</div>
  ${ratesCardMarkup()}
  <div class="grid split-grid"><section class="card panel"><div class="panel-title"><h3>Sales activity</h3><span>Last 6 months · NGN</span></div>${chartMarkup()}</section><section class="card panel"><div class="panel-title"><h3>Stock position</h3><span>${state.vehicles.length} vehicle(s)</span></div><div class="mix-list">${mix.map(([label,n])=>`<div><div class="mix-row"><span>${label}</span><strong>${n}</strong></div><div class="mix-track"><span style="width:${Math.round(n/max*100)}%"></span></div></div>`).join('')}<div class="mix-row"><span>Estimated realized gross profit</span><strong>${money(profit)}</strong></div></div></section></div>
  <div class="section-head"><div><h2>Recent sales</h2><p>Sales and document balances from saved records</p></div><button class="button button-quiet" data-route="sales">Open sales →</button></div>
  <section class="card table-card${recent.length?' has-record-cards':''}">${recent.length?`<div class="table-scroll"><table><thead><tr><th>Sale / buyer</th><th>Vehicle</th><th>Date</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead><tbody>${recent.map(s=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};return `<tr><td class="primary-cell">${escapeHtml(s.buyerName)}<span class="secondary-cell">${escapeHtml(s.invoiceNumber)}</span></td><td>${escapeHtml(vehicleName(v))}</td><td>${escapeHtml(s.date)}</td><td class="money">${money(s.total)}</td><td class="money">${money(s.total-s.paidAmount)}</td><td>${statusPill(s.paidAmount>=s.total?'paid':s.paidAmount?'part-paid':'due')}</td></tr>`}).join('')}</tbody></table></div><div class="record-cards">${recent.map(s=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};return `<article class="record-card"><div class="record-card-head"><div><h3>${escapeHtml(s.buyerName)}</h3><p class="record-card-sub">${escapeHtml(vehicleName(v)||'Vehicle removed')} · ${escapeHtml(s.invoiceNumber)}</p></div>${statusPill(s.paidAmount>=s.total?'paid':s.paidAmount?'part-paid':'due')}</div><dl class="record-card-grid"><div><dt>Sale date</dt><dd>${escapeHtml(s.date)}</dd></div><div><dt>Total</dt><dd class="money">${money(s.total)}</dd></div><div><dt>Paid</dt><dd class="money">${money(s.paidAmount)}</dd></div><div><dt>Balance due</dt><dd class="money">${money(s.total-s.paidAmount)}</dd></div></dl></article>`}).join('')}</div>`:empty('No sales recorded yet','Add a sale when you are ready to create your first invoice.', '<button class="button button-primary" data-action="new-sale">Create sale</button>')}</section>`;
  void loadRates();
}

function renderInventory() {
  const query=(document.getElementById('inventory-search')?.value||'').toLowerCase(); const filter=document.getElementById('inventory-filter')?.value||'all';
  const rows=state.vehicles.filter(v=>(filter==='all'||v.status===filter)&&`${vehicleName(v)} ${v.vin||''} ${v.color||''}`.toLowerCase().includes(query));
  view.innerHTML=`<div class="section-head"><div><h2>Vehicle stock</h2><p>Track acquisition costs, landed cost and availability</p></div><div class="toolbar"><input id="inventory-search" class="input search-input" placeholder="Search make, model or VIN" value="${escapeHtml(query)}" aria-label="Search inventory"><select id="inventory-filter" class="input filter-select" aria-label="Filter by status"><option value="all" ${filter==='all'?'selected':''}>All status</option><option value="available" ${filter==='available'?'selected':''}>Available</option><option value="reserved" ${filter==='reserved'?'selected':''}>Reserved</option><option value="sold" ${filter==='sold'?'selected':''}>Sold</option></select><button class="button button-primary" data-action="add-vehicle">＋ Add vehicle</button></div></div>
  <section class="card table-card${rows.length?' has-record-cards':''}">${rows.length?`<div class="table-scroll"><table><thead><tr><th>Vehicle</th><th>Condition / color</th><th>Arrival</th><th>Ask price</th><th>Landed cost</th><th>Est. margin</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map(v=>{const cost=landedCost(v);const days=Math.max(0,Math.floor((Date.now()-new Date(v.arrivalDate||today()))/86400000));return `<tr><td class="primary-cell">${escapeHtml(vehicleName(v))}<span class="secondary-cell">${escapeHtml(v.vin||'VIN not entered')}</span></td><td>${escapeHtml(v.condition||'—')}<span class="secondary-cell">${escapeHtml(v.color||'—')}</span></td><td>${escapeHtml(v.arrivalDate||'—')}<span class="secondary-cell">${days} days on lot</span></td><td class="money">${money(v.askingPrice)}</td><td class="money">${money(cost)}</td><td class="money">${money(Number(v.askingPrice)-cost)}</td><td>${statusPill(v.status)}</td><td><button class="button button-quiet button-small" data-action="edit-vehicle" data-id="${v.id}">Edit</button> <button class="button button-quiet button-small" data-action="delete-vehicle" data-id="${v.id}" aria-label="Delete ${escapeHtml(vehicleName(v))}">Delete</button></td></tr>`}).join('')}</tbody></table></div><div class="record-cards">${rows.map(v=>{const cost=landedCost(v);const margin=Number(v.askingPrice)-cost;const days=Math.max(0,Math.floor((Date.now()-new Date(v.arrivalDate||today()))/86400000));return `<article class="record-card"><div class="record-card-head"><div><h3>${escapeHtml(vehicleName(v))}</h3><p class="record-card-sub">${escapeHtml(v.vin||'VIN not entered')} · ${escapeHtml(v.condition||'—')} · ${escapeHtml(v.color||'—')}</p></div>${statusPill(v.status)}</div><dl class="record-card-grid"><div><dt>Ask price</dt><dd class="money">${money(v.askingPrice)}</dd></div><div><dt>Landed cost</dt><dd class="money">${money(cost)}</dd></div><div><dt>Est. margin</dt><dd class="money">${money(margin)}</dd></div><div><dt>Arrival</dt><dd>${escapeHtml(v.arrivalDate||'—')}<span class="record-card-note">${days} days on lot</span></dd></div></dl><div class="record-card-actions"><button class="button button-secondary button-small" data-action="edit-vehicle" data-id="${v.id}">Edit vehicle</button><button class="button button-quiet button-small" data-action="delete-vehicle" data-id="${v.id}" aria-label="Delete ${escapeHtml(vehicleName(v))}">Delete</button></div></article>`}).join('')}</div>`:empty(state.vehicles.length?'No matching vehicles':'No vehicles yet',state.vehicles.length?'Change the search or status filter to see your stock.':'Add your first vehicle to start the stock book.')}</section>`;
  document.getElementById('inventory-search').addEventListener('input',()=>renderInventory()); document.getElementById('inventory-filter').addEventListener('change',()=>renderInventory());
}
function renderSales() {
  const rows=[...state.sales].sort((a,b)=>b.date.localeCompare(a.date));
  const saleActions=(s,recs)=>`<button class="button button-secondary button-small" data-action="open-document" data-id="${s.invoiceDocId}">Invoice</button>${recs.length?`<button class="button button-secondary button-small" data-action="open-document" data-id="${recs.at(-1).id}">Latest receipt</button>`:''}${s.paidAmount<s.total?`<button class="button button-quiet button-small" data-action="record-payment" data-id="${s.id}">Record payment</button>`:''}<button class="button button-quiet button-small" data-action="delete-sale" data-id="${s.id}" aria-label="Delete the sale to ${escapeHtml(s.buyerName)}">Delete</button>`;
  view.innerHTML=`<div class="section-head"><div><h2>Sales ledger</h2><p>Every sale creates a payment-request invoice; recorded payments create separate proof-of-payment receipts</p></div><button class="button button-primary" data-action="new-sale">＋ New sale</button></div><section class="card table-card${rows.length?' has-record-cards':''}">${rows.length?`<div class="table-scroll"><table><thead><tr><th>Buyer</th><th>Vehicle</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Documents / action</th></tr></thead><tbody>${rows.map(s=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};const recs=state.documents.filter(d=>d.saleId===s.id&&d.kind==='receipt');return `<tr><td class="primary-cell">${escapeHtml(s.buyerName)}<span class="secondary-cell">${escapeHtml(s.buyerPhone||'No phone entered')}</span></td><td>${escapeHtml(vehicleName(v))}</td><td>${escapeHtml(s.date)}</td><td class="money">${money(s.total)}</td><td class="money">${money(s.paidAmount)}</td><td class="money">${money(s.total-s.paidAmount)}</td><td>${saleActions(s,recs)}</td></tr>`}).join('')}</tbody></table></div><div class="record-cards">${rows.map(s=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};const recs=state.documents.filter(d=>d.saleId===s.id&&d.kind==='receipt');return `<article class="record-card"><div class="record-card-head"><div><h3>${escapeHtml(s.buyerName)}</h3><p class="record-card-sub">${escapeHtml(vehicleName(v)||'Vehicle removed')} · ${escapeHtml(s.buyerPhone||'No phone entered')}</p></div>${statusPill(s.paidAmount>=s.total?'paid':s.paidAmount?'part-paid':'due')}</div><dl class="record-card-grid"><div><dt>Sale date</dt><dd>${escapeHtml(s.date)}</dd></div><div><dt>Total</dt><dd class="money">${money(s.total)}</dd></div><div><dt>Paid</dt><dd class="money">${money(s.paidAmount)}</dd></div><div><dt>Balance due</dt><dd class="money">${money(s.total-s.paidAmount)}</dd></div></dl><div class="record-card-actions">${saleActions(s,recs)}</div></article>`}).join('')}</div>`:empty('No sales yet','Create a sale to issue an invoice and reserve the vehicle.', '<button class="button button-primary" data-action="new-sale">Create first sale</button>')}</section>`;
}
function renderFinance() {
  const outputVat=state.sales.reduce((a,s)=>a+s.vatAmount,0), inputVat=state.expenses.reduce((a,e)=>a+(Number(e.inputVat)||0),0);
  const cashIn=state.sales.reduce((a,s)=>a+s.payments.reduce((b,p)=>b+p.amount,0),0);
  const expenseCash=state.expenses.reduce((a,e)=>a+Number(e.amount||0),0); const supplierCash=state.suppliers.reduce((a,s)=>a+s.payments.reduce((b,p)=>b+p.amount,0),0); const cashOut=expenseCash+supplierCash;
  const realised=state.sales.reduce((a,s)=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};return a+s.basePrice-landedCost(v)-Number(s.vehicleExpense||0)},0);
  const outstanding=state.sales.reduce((a,s)=>a+Math.max(0,s.total-s.paidAmount),0); const payable=state.suppliers.reduce((a,s)=>a+Math.max(0,s.balance),0);
  const tiles=[['Cash received',money(cashIn)],['Cash out recorded',money(cashOut)],['Sale balances due',money(outstanding)],['Supplier payables',money(payable)]];
  if(state.settings.vatEnabled===true)tiles.push(['Output VAT recorded',money(outputVat)],['Input VAT entered',money(inputVat)],['VAT difference',money(outputVat-inputVat)]);
  tiles.push(['Estimated gross profit',money(realised)],['Unsold stock cost',money(state.vehicles.filter(v=>v.status!=='sold').reduce((a,v)=>a+landedCost(v),0))]);
  view.innerHTML=`<div class="section-head"><div><h2>Money in and out</h2><p>Operational summaries from saved records</p></div><div class="toolbar"><button class="button button-secondary" data-action="export-csv">Export CSV</button><button class="button button-primary" data-action="add-expense">＋ Add expense</button></div></div>
  <div class="grid finance-grid">${tiles.map(([l,v])=>`<article class="card finance-card"><span>${l}</span><strong>${v}</strong></article>`).join('')}</div>
  <div class="grid two-panels"><section class="card panel"><div class="panel-title"><h3>Expense log</h3><button class="button button-quiet button-small" data-action="add-expense">Add expense</button></div>${state.expenses.length?`<div class="table-scroll"><table><thead><tr><th>Item</th><th>Date</th><th>Vehicle</th><th>Cash amount</th>${state.settings.vatEnabled===true?'<th>Input VAT</th>':''}<th></th></tr></thead><tbody>${[...state.expenses].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>`<tr><td class="primary-cell">${escapeHtml(e.description)}<span class="secondary-cell">${escapeHtml(e.category)}</span></td><td>${escapeHtml(e.date)}</td><td>${escapeHtml(vehicleName(state.vehicles.find(v=>v.id===e.vehicleId)||{})||'General')}</td><td class="money">${money(e.amount)}</td>${state.settings.vatEnabled===true?`<td class="money">${money(e.inputVat)}</td>`:''}<td><button class="button button-quiet button-small" data-action="delete-expense" data-id="${e.id}" aria-label="Delete ${escapeHtml(e.description)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:empty('No expenses entered','Vehicle and general expenses appear here.')}</section><section class="card panel"><div class="panel-title"><h3>Profit by completed sale</h3><span>Estimate before tax advice</span></div>${state.sales.length?`<div class="table-scroll"><table><thead><tr><th>Vehicle</th><th>Sale date</th><th>Landed cost</th><th>Sale price</th><th>Gross estimate</th></tr></thead><tbody>${state.sales.map(s=>{const v=state.vehicles.find(x=>x.id===s.vehicleId)||{};return `<tr><td>${escapeHtml(vehicleName(v))}</td><td>${escapeHtml(s.date)}</td><td class="money">${money(landedCost(v))}</td><td class="money">${money(s.basePrice)}</td><td class="money">${money(s.basePrice-landedCost(v)-Number(s.vehicleExpense||0))}</td></tr>`}).join('')}</tbody></table></div>`:empty('No realized sales yet','Gross estimates appear after sales are recorded.')}</section></div>
  <p class="small-note">${state.settings.vatEnabled===true?'VAT and profit':'Profit'} figures are arithmetic summaries of entered data. They are not tax filings, statutory accounts or professional accounting advice.</p>`;
}
function renderSuppliers() {
  const due=state.suppliers.reduce((a,s)=>a+Math.max(0,s.balance),0);
  view.innerHTML=`<div class="section-head"><div><h2>Supplier balances</h2><p>Track amounts owed and payments made · total open payable ${money(due)}</p></div><button class="button button-primary" data-action="add-supplier">＋ Add payable</button></div><section class="card table-card">${state.suppliers.length?`<div class="table-scroll"><table><thead><tr><th>Supplier</th><th>Reference</th><th>Due date</th><th>Original amount</th><th>Paid</th><th>Balance</th><th></th></tr></thead><tbody>${state.suppliers.map(s=>{const paid=s.payments.reduce((a,p)=>a+p.amount,0);return `<tr><td class="primary-cell">${escapeHtml(s.name)}</td><td>${escapeHtml(s.reference||'—')}</td><td>${escapeHtml(s.dueDate||'—')}</td><td class="money">${money(s.amount)}</td><td class="money">${money(paid)}</td><td class="money">${money(s.balance)}</td><td>${s.balance>0?`<button class="button button-quiet button-small" data-action="supplier-payment" data-id="${s.id}">Record payment</button> `:''}<button class="button button-quiet button-small" data-action="delete-supplier" data-id="${s.id}" aria-label="Delete the payable to ${escapeHtml(s.name)}">Delete</button></td></tr>`}).join('')}</tbody></table></div>`:empty('No supplier payables','Add a payable to start tracking supplier balances.')}</section><p class="small-note">This is a simple payable ledger. It does not reconcile bank balances or foreign-exchange movements.</p>`;
}
function renderDocuments() {
  const docs=[...state.documents].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  view.innerHTML=`<div class="section-head"><div><h2>Invoice and receipt register</h2><p>Invoices request payment; receipts record payments actually entered</p></div><button class="button button-primary" data-action="new-sale">＋ Create sale / invoice</button></div>${docs.length?`<div class="document-list">${docs.map(d=>{const s=state.sales.find(x=>x.id===d.saleId)||{};return `<article class="card document-row"><div><strong>${escapeHtml(d.number)} · ${d.kind==='invoice'?'Payment request invoice':'Payment receipt'}</strong><small>${escapeHtml(s.buyerName||'')} · ${escapeHtml(d.date)} · ${escapeHtml(vehicleName(state.vehicles.find(v=>v.id===s.vehicleId)||{}))}</small></div><div class="toolbar"><span class="money">${money(d.kind==='receipt'?d.paymentAmount:s.total)}</span><button class="button button-secondary button-small" data-action="open-document" data-id="${d.id}">Open / print</button></div></article>`}).join('')}</div>`:empty('No documents created','An invoice is generated when you record a sale. A receipt is generated only when a payment is recorded.')}`;
}
function renderSettings() {
  const vatOn=state.settings.vatEnabled===true;
  view.innerHTML=`<section class="card settings-card"><h3>Business defaults</h3><p>These settings apply to new sales on this desk.</p><form id="settings-form"><div class="form-grid"><div class="field"><label for="desk-owner">Name used in the overview greeting (optional)</label><input class="input" id="desk-owner" name="displayName" maxlength="60" value="${escapeHtml(state.settings.ownerName||'')}" placeholder="Left blank, the greeting stays generic"></div><div class="field"><label>Default currency</label><input class="input" value="Nigerian naira (NGN / ₦)" readonly></div><div class="field full"><label class="checkbox-row"><input type="checkbox" id="vat-enabled" name="vatEnabled" ${vatOn?'checked':''}> Track VAT on this desk (off by default)</label><span class="small-note">While this is off, sales have no VAT field and the finance screen shows no VAT figures. Turn it on only if you charge VAT; it is arithmetic only, not tax advice.</span></div><div class="field" id="vat-rate-field"${vatOn?'':' style="display:none"'}><label for="vat-rate">Default VAT rate (%)</label><input class="input" id="vat-rate" name="vatRate" type="number" min="0" max="100" step="0.01" value="${escapeHtml(state.settings.vatRate)}" ${vatOn?'':'disabled'}></div></div><div class="modal-actions"><button class="button button-primary">Save settings</button></div></form><div class="danger-zone"><h3>Desk data</h3><p>Delete every saved vehicle, sale, invoice, receipt, expense and supplier record from the dealership database. Settings and the document numbers already issued are kept, so no number is reused.</p><button class="button button-danger" data-action="clear-desk">Clear desk records</button></div></section><section class="card settings-card" style="margin-top:15px"><h3>Business identity on documents</h3><p><strong>${business.name}</strong><br>${business.rc}<br>${business.address}<br>${business.phones.join(' · ')}<br>${business.email}</p><span class="small-note">These details are included in generated print views. Verify them before issuing a customer document.</span></section>`;
  const vatInput=document.getElementById('vat-enabled'), rateField=document.getElementById('vat-rate-field'), rateInput=document.getElementById('vat-rate');
  vatInput?.addEventListener('change',()=>{const on=vatInput.checked; if(rateField) rateField.style.display=on?'':'none'; if(rateInput){rateInput.disabled=!on; if(on) rateInput.focus();}});
  document.getElementById('settings-form').addEventListener('submit',e=>{e.preventDefault(); const data=new FormData(e.currentTarget); const vatOn=data.has('vatEnabled'); const entered=String(data.get('vatRate')??'').trim(), saved=Number(state.settings.vatRate); const rate=vatOn?(entered===''?(Number.isFinite(saved)?saved:7.5):Number(entered)):saved; if(vatOn&&(!Number.isFinite(rate)||rate<0||rate>100)){toast('Enter a VAT rate from 0 to 100');return;}const owner=String(data.get('displayName')||'').trim(); if(owner) state.settings.ownerName=owner; else delete state.settings.ownerName; state.settings.vatEnabled=vatOn; state.settings.vatRate=Number.isFinite(rate)?rate:7.5;save();toast('Settings saved');render();});
}
function render() {
  document.getElementById('today-label').textContent=lagosDateTime(new Date()).dateLabel;
  document.getElementById('page-title').textContent=titleMap[currentRoute]||'Overview';
  document.querySelectorAll('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===currentRoute));
  ({dashboard:renderDashboard,inventory:renderInventory,sales:renderSales,finance:renderFinance,suppliers:renderSuppliers,documents:renderDocuments,settings:renderSettings}[currentRoute]||renderDashboard)();
}
function vehicleForm(vehicle={}) {
  const editing=!!vehicle.id; const statuses=['available','reserved','sold'];
  return `<form id="vehicle-form" class="modal-form"><input type="hidden" name="recordId" value="${escapeHtml(vehicle.id||'')}"><h3 class="form-section-title">Vehicle identity</h3><div class="form-grid"><div class="field"><label>Year *</label><input class="input" name="year" type="number" min="1950" max="2100" value="${escapeHtml(vehicle.year||'')}" required></div><div class="field"><label>Make *</label><input class="input" name="make" value="${escapeHtml(vehicle.make||'')}" required></div><div class="field"><label>Model *</label><input class="input" name="model" value="${escapeHtml(vehicle.model||'')}" required></div><div class="field"><label>VIN / chassis number</label><input class="input" name="vin" value="${escapeHtml(vehicle.vin||'')}" maxlength="32"></div><div class="field"><label>Mileage (km)</label><input class="input" name="mileage" type="number" min="0" value="${escapeHtml(vehicle.mileage||0)}"></div><div class="field"><label>Condition</label><select name="condition" class="input">${['Tokunbo','Nigerian Used','Brand New'].map(x=>`<option ${vehicle.condition===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Exterior colour</label><input class="input" name="color" value="${escapeHtml(vehicle.color||'')}"></div><div class="field"><label>Engine number</label><input class="input" name="engine" value="${escapeHtml(vehicle.engine||'')}"></div><div class="field"><label>Plate number</label><input class="input" name="plate" value="${escapeHtml(vehicle.plate||'')}"></div><div class="field"><label>Customs C-number</label><input class="input" name="cNumber" value="${escapeHtml(vehicle.cNumber||'')}"></div><div class="field"><label>Arrival date</label><input class="input" name="arrivalDate" type="date" value="${escapeHtml(vehicle.arrivalDate||today())}"></div><div class="field"><label>Status</label><select class="input" name="status">${statuses.map(s=>`<option value="${s}" ${vehicle.status===s?'selected':''}>${s}</option>`).join('')}</select></div></div><hr class="form-divider"><h3 class="form-section-title">NGN cost and price</h3><div class="form-grid">${[['askingPrice','Asking price (₦)'],['acquisitionCost','Acquisition cost (₦)'],['clearing','Clearing (₦)'],['transport','Transport (₦)'],['repairs','Repairs (₦)']].map(([name,label])=>`<div class="field"><label>${label} *</label><input class="input" name="${name}" type="number" min="0" step="0.01" value="${escapeHtml(vehicle[name]||0)}" required></div>`).join('')}</div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary">${editing?'Save vehicle':'Add vehicle'}</button></div></form>`;
}
function saleForm() {
  const cars=state.vehicles.filter(v=>['available','reserved'].includes(v.status));
  return `<form id="sale-form" class="modal-form"><h3 class="form-section-title">Select stock and buyer</h3><div class="form-grid"><div class="field full"><label>Vehicle *</label><select class="input" name="vehicleId" required>${cars.map(v=>`<option value="${v.id}">${escapeHtml(vehicleName(v))} · ${escapeHtml(v.status)} · ask ${money(v.askingPrice)}</option>`).join('')}</select>${cars.length?'':'<span class="error">No available or reserved cars. Add stock first.</span>'}</div><div class="field"><label>Buyer name *</label><input class="input" name="buyerName" required></div><div class="field"><label>Buyer phone</label><input class="input" name="buyerPhone" type="tel"></div><div class="field full"><label>Buyer address</label><input class="input" name="buyerAddress"></div><div class="field"><label>Sale date *</label><input class="input" name="date" type="date" value="${today()}" required></div><div class="field"><label>Sale price (₦) *</label><input class="input" name="price" type="number" min="0" step="0.01" required></div></div><hr class="form-divider"><h3 class="form-section-title">Payment and document</h3><div class="form-grid">${state.settings.vatEnabled===true?`<div class="field"><label class="checkbox-row"><input type="checkbox" name="vatEnabled"> Add VAT to this sale (optional, off by default)</label></div><div class="field"><label>VAT rate (%)</label><input class="input" name="vatRate" type="number" min="0" max="100" step="0.01" value="${escapeHtml(state.settings.vatRate)}"></div>`:''}<div class="field"><label>Amount received now (₦)</label><input class="input" name="paid" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Payment method</label><select class="input" name="paymentMethod"><option>Bank transfer</option><option>Cash</option><option>POS</option><option>Cheque</option><option>Other</option></select></div><div class="field full"><label>Sale terms</label><textarea class="input" name="terms" rows="3">${SALE_TERMS_DEFAULT}</textarea></div><div class="field full"><label>Accessories / remarks</label><textarea class="input" name="remarks" rows="2"></textarea></div></div><p class="small-note">A numbered invoice requests the full sale amount. Any payment you enter is recorded separately and creates its own receipt. Both numbers follow this desk's own sequence.</p><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" ${cars.length?'':'disabled'}>Create sale & invoice</button></div></form>`;
}
function expenseForm() { return `<form id="expense-form" class="modal-form"><div class="form-grid"><div class="field full"><label>Description *</label><input class="input" name="description" required></div><div class="field"><label>Category</label><select class="input" name="category"><option>Vehicle purchase</option><option>Clearing</option><option>Transport</option><option>Repairs</option><option>Office</option><option>Marketing</option><option>Other</option></select></div><div class="field"><label>Date *</label><input class="input" name="date" type="date" value="${today()}" required></div><div class="field"><label>Cash amount (₦) *</label><input class="input" name="amount" type="number" min="0" step="0.01" required></div>${state.settings.vatEnabled===true?'<div class="field"><label>Input VAT included (₦)</label><input class="input" name="inputVat" type="number" min="0" step="0.01" value="0"></div>':''}<div class="field full"><label>Related vehicle (optional)</label><select class="input" name="vehicleId"><option value="">General expense</option>${state.vehicles.map(v=>`<option value="${v.id}">${escapeHtml(vehicleName(v))}</option>`).join('')}</select></div></div><p class="small-note">${state.settings.vatEnabled===true?'Enter the cash amount and any input VAT from your own records. This desk does not determine tax eligibility.':'Enter the cash amount from your own records. This desk does not determine tax eligibility.'}</p><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary">Save expense</button></div></form>`; }
function supplierPaymentForm(supplier) {
  const remaining=Number(supplier.balance)||0;
  return `<form id="supplier-payment-form" class="modal-form"><input type="hidden" name="recordId" value="${escapeHtml(supplier.id)}"><div class="form-grid"><div class="field"><label>Payment amount (₦) *</label><input class="input" name="amount" type="number" min="0.01" max="${remaining}" step="0.01" required></div><div class="field"><label>Payment method</label><select class="input" name="method"><option>Bank transfer</option><option>Cash</option><option>POS</option><option>Cheque</option><option>Other</option></select></div><div class="field"><label>Payment date</label><input class="input" name="date" type="date" value="${today()}" required></div></div><p class="small-note">This records money paid to a supplier. It does not reverse the payable or reconcile a bank statement.</p><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary">Save payment</button></div></form>`;
}
function supplierForm() { return `<form id="supplier-form" class="modal-form"><div class="form-grid"><div class="field"><label>Supplier name *</label><input class="input" name="name" required></div><div class="field"><label>Reference / invoice number</label><input class="input" name="reference"></div><div class="field"><label>Amount due (₦) *</label><input class="input" name="amount" type="number" min="0" step="0.01" required></div><div class="field"><label>Due date</label><input class="input" name="dueDate" type="date"></div></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary">Save payable</button></div></form>`; }
function createDoc(kind,sale,paymentAmount=0) {
  const n=nextDocumentNumber(state.counters[kind]||0,kind,sale.date); state.counters[kind]=n.sequence;
  const doc={id:makeId(),kind,number:n.number,date:sale.date,createdAt:new Date().toISOString(),saleId:sale.id,paymentAmount:Number(paymentAmount)||0}; state.documents.push(doc); return doc;
}
const SALE_TERMS_DEFAULT='Vehicle sold in the condition inspected by the buyer. Please retain this document for your records.';
function recordPayment(sale,{amount,method,date}) {
  const remaining=Number((sale.total-sale.paidAmount).toFixed(2));
  if(!Number.isFinite(amount)||amount<=0||amount>remaining) throw new Error('Payment must be positive and no greater than the balance');
  sale.payments.push({id:makeId(),amount,date,method});
  sale.paidAmount=Number((sale.paidAmount+amount).toFixed(2));
  sale.paymentMethod=method;
  const doc=createDoc('receipt',{...sale,date},amount);
  sale.latestReceiptId=doc.id;
  save();
  return {sale,doc};
}
function recordSale(input) {
  const vehicle=input.vehicle, paid=Number(input.paid||0), rate=Number(input.vatRate||0), vatEnabled=input.vatEnabled===true;
  if(!vehicle||!['available','reserved'].includes(vehicle.status)) throw new Error('That vehicle is no longer available for sale');
  const calc=calculateSale({price:Number(input.price),vatRate:rate,vatEnabled,paid});
  const sale={id:makeId(),vehicleId:vehicle.id,buyerName:String(input.buyerName||'').trim(),buyerPhone:String(input.buyerPhone||'').trim(),buyerAddress:String(input.buyerAddress||'').trim(),date:String(input.date||today()),basePrice:calc.base,vatAmount:calc.vat,vatRate:vatEnabled?rate:0,total:calc.total,paidAmount:calc.paid,payments:[],paymentMethod:String(input.paymentMethod||'Bank transfer'),terms:String(input.terms||''),remarks:String(input.remarks||''),vehicleExpense:0};
  if(!sale.buyerName) throw new Error('Buyer name is required');
  if(calc.paid>0) sale.payments.push({id:makeId(),amount:calc.paid,date:sale.date,method:sale.paymentMethod});
  vehicle.status=transitionVehicleStatus(vehicle.status,'sold');
  state.sales.push(sale); const invoice=createDoc('invoice',sale); sale.invoiceDocId=invoice.id; sale.invoiceNumber=invoice.number;
  if(calc.paid>0){const receipt=createDoc('receipt',sale,calc.paid);sale.latestReceiptId=receipt.id;}
  save();return sale;
}
function submitSale(form) {
  const data=new FormData(form);
  return recordSale({vehicle:state.vehicles.find(v=>v.id===data.get('vehicleId')),buyerName:data.get('buyerName'),buyerPhone:data.get('buyerPhone'),buyerAddress:data.get('buyerAddress'),date:data.get('date'),price:Number(data.get('price')),paid:Number(data.get('paid')||0),vatEnabled:state.settings.vatEnabled===true&&data.has('vatEnabled'),vatRate:Number(data.get('vatRate')||0),paymentMethod:String(data.get('paymentMethod')),terms:String(data.get('terms')||''),remarks:String(data.get('remarks')||'')});
}
function documentPage(doc) {
  const sale=state.sales.find(s=>s.id===doc.saleId);if(!sale){toast('Document data was not found');return;}
  const vehicle=state.vehicles.find(v=>v.id===sale.vehicleId)||{};const receipt=doc.kind==='receipt';
  const rows=receipt?`<tr><td>Payment received · ${escapeHtml(doc.date)} · ${escapeHtml(sale.paymentMethod)}</td><td class="money">${money(doc.paymentAmount)}</td></tr>`:`<tr><td>Vehicle sale price</td><td class="money">${money(sale.basePrice)}</td></tr>${sale.vatAmount?`<tr><td>VAT (${escapeHtml(sale.vatRate)}%)</td><td class="money">${money(sale.vatAmount)}</td></tr>`:''}`;
  const heading=receipt?'PAYMENT RECEIPT':'VEHICLE SALE INVOICE'; const status=receipt?'Payment received':'Payment requested';
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} ${escapeHtml(doc.number)}</title><link rel="stylesheet" href="./styles.css"></head><body><div class="no-print" style="max-width:840px;margin:20px auto;display:flex;justify-content:flex-end;gap:8px"><button class="button button-secondary" onclick="window.close()">Close</button><button class="button button-primary" onclick="window.print()">Print / save as PDF</button></div><main class="receipt-shell"><div class="receipt-head"><div class="receipt-brand"><img src="./assets/akinlowo-global-mark.svg" alt="Akinlowo Global logo"><div><h2>${business.name}</h2><p>${business.rc}<br>${business.address}<br>${business.phones.join(' · ')}<br>${business.email}</p></div></div><div class="receipt-meta"><strong>${heading}</strong><p>${escapeHtml(doc.number)}<br>${escapeHtml(doc.date)}<br>${status}</p></div></div><div class="receipt-cols"><div><p class="receipt-label">Customer</p><div class="receipt-value"><strong>${escapeHtml(sale.buyerName)}</strong><br>${escapeHtml(sale.buyerAddress||'Address not supplied')}<br>${escapeHtml(sale.buyerPhone||'Phone not supplied')}</div></div><div><p class="receipt-label">Document record</p><div class="receipt-value">Payment method: ${escapeHtml(sale.paymentMethod)}<br>Sale reference: ${escapeHtml(sale.invoiceNumber)}<br>Currency: Nigerian naira (NGN)</div></div></div><section class="receipt-vehicle"><p class="receipt-label">Vehicle details</p><h3>${escapeHtml(vehicleName(vehicle))}</h3><div class="detail-grid">${[['VIN / chassis',vehicle.vin||'Not entered'],['Mileage',vehicle.mileage?`${vehicle.mileage.toLocaleString()} km`:'Not entered'],['Condition',vehicle.condition||'Not entered'],['Colour',vehicle.color||'Not entered'],['Engine number',vehicle.engine||'Not entered'],['Plate number',vehicle.plate||'Not entered'],['Customs C-number',vehicle.cNumber||'Not entered']].map(([l,v])=>`<div><small>${l}</small><strong>${escapeHtml(v)}</strong></div>`).join('')}</div></section><div class="table-scroll"><table class="receipt-table"><thead><tr><th>Description</th><th>Amount (NGN)</th></tr></thead><tbody>${rows}${receipt?'':`<tr><td>Total sale amount</td><td class="money">${money(sale.total)}</td></tr><tr><td>Payments received to date</td><td class="money">${money(sale.paidAmount)}</td></tr><tr><td>Balance due</td><td class="money">${money(sale.total-sale.paidAmount)}</td></tr>`}</tbody></table></div>${receipt?`<div class="receipt-total"><div><span>Sale total</span><strong>${money(sale.total)}</strong></div><div><span>Paid to date</span><strong>${money(sale.paidAmount)}</strong></div><div class="grand"><span>Balance due</span><strong>${money(sale.total-sale.paidAmount)}</strong></div></div>`:''}<div class="receipt-terms"><p class="receipt-label">Sale terms</p><div class="receipt-value">${escapeHtml(sale.terms||'No additional terms recorded.')}</div>${sale.remarks?`<p class="receipt-label" style="margin-top:13px">Accessories / remarks</p><div class="receipt-value">${escapeHtml(sale.remarks)}</div>`:''}</div><div class="signature-row"><div>Seller / authorised representative</div><div>Buyer acknowledgment</div></div><p class="small-note" style="margin-top:20px">This document is generated from records saved in the dealership database. It is not connected to government e-invoicing, payment processing or an accounting service. Confirm the details and payment status before use.</p></main></body></html>`;
  const win=window.open('','_blank');if(!win){toast('Allow pop-ups to open the print document');return;}win.document.open();win.document.write(html);win.document.close();
}
function recordSalePayment(id) {
  const sale=state.sales.find(s=>s.id===id);if(!sale)return; const remaining=Number((sale.total-sale.paidAmount).toFixed(2));
  openModal('Record customer payment',`Balance due ${money(remaining)}. A receipt will be generated for the amount received.`, `<form id="payment-form" class="modal-form"><input type="hidden" name="recordId" value="${sale.id}"><div class="form-grid"><div class="field"><label>Payment amount (₦) *</label><input class="input" name="amount" type="number" min="0.01" max="${remaining}" step="0.01" required></div><div class="field"><label>Payment method</label><select class="input" name="method"><option>Bank transfer</option><option>Cash</option><option>POS</option><option>Cheque</option><option>Other</option></select></div><div class="field"><label>Payment date</label><input class="input" name="date" type="date" value="${today()}" required></div></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary">Save payment & issue receipt</button></div></form>`);
}
function csvExport() {
  const rows=[['record_type','date','description','reference','amount_ngn','vat_ngn','balance_ngn']];
  state.sales.forEach(s=>rows.push(['sale',s.date,vehicleName(state.vehicles.find(v=>v.id===s.vehicleId)||{}),s.invoiceNumber,s.total,s.vatAmount,s.total-s.paidAmount]));
  state.expenses.forEach(e=>rows.push(['expense',e.date,e.description,'',e.amount,e.inputVat,'']));
  state.suppliers.forEach(s=>rows.push(['supplier_payable',s.dueDate,s.name,s.reference,s.amount,'',s.balance]));
  const csv=rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\r\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='akinlowo-financial-ledger.csv';a.click();URL.revokeObjectURL(a.href);toast('CSV exported');
}

document.addEventListener('click',e=>{
  const route=e.target.closest('[data-route]');if(route){e.preventDefault();setRoute(route.dataset.route);return;}
  const button=e.target.closest('[data-action]');if(!button)return;const {action,id}=button.dataset;
  if(action==='close-modal')closeModal();
  if(action==='toggle-assistant')setAssistant(document.getElementById('assistant-panel')?.hidden !== false);
  if(action==='close-assistant')setAssistant(false);
  if(action==='refresh-rates')void loadRates(true);
  if(action==='new-sale'){if(!state.vehicles.some(v=>['available','reserved'].includes(v.status))){toast('Add an available vehicle before creating a sale');return;}openModal('Create sale & invoice','Record the vehicle sale, buyer, optional VAT and any initial payment',saleForm());}
  if(action==='add-vehicle')openModal('Add vehicle','Enter vehicle identity and purchase/operating costs in NGN',vehicleForm());
  if(action==='edit-vehicle'){const v=state.vehicles.find(v=>v.id===id);if(v)openModal('Edit vehicle','Update this stock record',vehicleForm(v));}
  if(action==='delete-vehicle'){const v=state.vehicles.find(v=>v.id===id);if(!v)return;if(state.sales.some(s=>s.vehicleId===id)){toast('A sold vehicle linked to a sale cannot be deleted');return;}if(confirm(`Delete ${vehicleName(v)} from the stock book?`)){state.vehicles=state.vehicles.filter(x=>x.id!==id);save();render();toast('Vehicle deleted');}}
  if(action==='add-expense')openModal('Add expense','Enter a cash expense and any input VAT from your source records',expenseForm());
  if(action==='add-supplier')openModal('Add supplier payable','Record a supplier balance to pay',supplierForm());
  if(action==='record-payment')recordSalePayment(id);
  if(action==='delete-sale'){
    const sale=state.sales.find(s=>s.id===id);if(!sale)return;
    const vehicle=state.vehicles.find(v=>v.id===sale.vehicleId);
    if(!confirm(`Delete the sale to ${sale.buyerName} (${sale.invoiceNumber})? Its invoice and every receipt issued for it are removed, and ${vehicleName(vehicle)||'the vehicle'} returns to available stock. Invoice and receipt numbers already issued are not reused.`))return;
    state.sales=state.sales.filter(s=>s.id!==id);
    state.documents=state.documents.filter(d=>d.saleId!==id);
    if(vehicle&&vehicle.status==='sold')vehicle.status='available';
    save();render();toast('Sale deleted · vehicle back in stock');
  }
  if(action==='delete-expense'){
    const expense=state.expenses.find(e=>e.id===id);if(!expense)return;
    if(!confirm(`Delete the expense "${expense.description}" for ${money(expense.amount)}? Totals and VAT summaries update immediately.`))return;
    state.expenses=state.expenses.filter(e=>e.id!==id);save();render();toast('Expense deleted');
  }
  if(action==='delete-supplier'){
    const supplier=state.suppliers.find(x=>x.id===id);if(!supplier)return;
    const paid=supplier.payments?.length||0;
    if(!confirm(`Delete the payable to ${supplier.name} for ${money(supplier.amount)}? ${paid?`Its ${paid} recorded payment(s) go with it. `:''}No money movement is reversed; update your bank records yourself.`))return;
    state.suppliers=state.suppliers.filter(x=>x.id!==id);save();render();toast('Payable deleted');
  }
  if(action==='supplier-payment'){
    const supplier=state.suppliers.find(x=>x.id===id);if(!supplier)return;
    openModal('Record supplier payment',`Balance due ${money(supplier.balance)} to ${escapeHtml(supplier.name)}.`,supplierPaymentForm(supplier));
  }
  if(action==='open-document'){const d=state.documents.find(x=>x.id===id);if(d)documentPage(d);}
  if(action==='export-csv')csvExport();
  if(action==='clear-desk'){if(confirm('Delete every saved vehicle, sale, invoice, receipt, expense and supplier record? Settings and the document numbers already issued are kept. This cannot be undone.')){state={...state,vehicles:[],sales:[],expenses:[],suppliers:[],documents:[]};save();render();toast('Desk records cleared');}}
});

document.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target;
  try{
    if(f.id==='vehicle-form'){
      const d=new FormData(f), data=Object.fromEntries(d.entries()), existing=state.vehicles.find(v=>v.id===data.recordId);
      delete data.recordId;
      for(const k of ['year','mileage','askingPrice','acquisitionCost','clearing','transport','repairs'])data[k]=Number(data[k]||0);
      if(data.year<1950||data.year>2100||['askingPrice','acquisitionCost','clearing','transport','repairs'].some(k=>data[k]<0))throw new Error('Check the vehicle year and amounts');
      if(existing){if(existing.status==='sold'&&data.status!=='sold')throw new Error('A sold vehicle cannot be moved back to stock');Object.assign(existing,data);}else state.vehicles.push({...data,id:makeId()});
      save();closeModal();render();toast(existing?'Vehicle updated':'Vehicle added');
    }
    if(f.id==='sale-form'){const sale=submitSale(f);closeModal();render();toast(`Sale recorded · ${sale.invoiceNumber}`);}
    if(f.id==='payment-form'){
      const d=new FormData(f),sale=state.sales.find(s=>s.id===d.get('recordId'));if(!sale)throw new Error('Sale record not found');const {doc}=recordPayment(sale,{amount:Number(d.get('amount')),method:String(d.get('method')),date:String(d.get('date'))});closeModal();render();toast(`Payment saved · ${doc.number}`);
    }
    if(f.id==='expense-form'){const d=new FormData(f),item=Object.fromEntries(d.entries());item.id=makeId();item.amount=Number(item.amount);item.inputVat=Number(item.inputVat||0);if(item.amount<0||item.inputVat<0||item.inputVat>item.amount)throw new Error('Check expense and input VAT amounts');state.expenses.push(item);save();closeModal();render();toast('Expense saved');}
    if(f.id==='supplier-form'){const d=new FormData(f),item=Object.fromEntries(d.entries());item.id=makeId();item.amount=Number(item.amount);item.balance=item.amount;item.payments=[];if(item.amount<=0)throw new Error('Enter a payable amount greater than zero');state.suppliers.push(item);save();closeModal();render();toast('Supplier payable saved');}
    if(f.id==='supplier-payment-form'){
      const d=new FormData(f),supplier=state.suppliers.find(x=>x.id===d.get('recordId')),amount=Number(d.get('amount'));
      if(!supplier)throw new Error('That payable is no longer on the desk');
      if(!Number.isFinite(amount)||amount<=0||amount>supplier.balance)throw new Error('Payment must be positive and no greater than the balance');
      supplier.payments.push({id:makeId(),amount,date:String(d.get('date')),method:String(d.get('method'))});
      supplier.balance=Number((supplier.balance-amount).toFixed(2));
      save();closeModal();render();toast('Supplier payment recorded');
    }
  }catch(err){const old=f.querySelector('.error-message');if(old)old.remove();const note=document.createElement('p');note.className='error error-message';note.textContent=err.message||'Could not save this record';f.append(note);}
});
/* Read-only window onto the loaded desk for the assistant panel's own record
 * answers. It never sends anything; the panel computes locally. */
globalThis.AKINLOWO_DESK_READ = () => state;

/* ---------- Assistant desk actions: prepared by the assistant, applied here ---------- */
function matchStockVehicle(query) {
  const q=String(query||'').toLowerCase().replace(/\s+/g,' ').trim(); if(!q) return [];
  const tokens=q.split(' '), open=state.vehicles.filter(v=>['available','reserved'].includes(v.status));
  const scored=open.map(v=>{const name=vehicleName(v).toLowerCase(), vin=String(v.vin||'').toLowerCase(); const hay=`${name} ${vin} ${String(v.color||'').toLowerCase()} ${String(v.plate||'').toLowerCase()}`; const score=(vin&&vin===q)||name===q?3:tokens.every(t=>hay.includes(t))?2:0; return [v,score];}).filter(([,score])=>score>0);
  if(!scored.length) return [];
  const best=Math.max(...scored.map(([,score])=>score));
  return scored.filter(([,score])=>score===best).map(([v])=>v);
}
function findDeskDocument(action) {
  if(action.number){const key=String(action.number).toLowerCase(); return state.documents.find(d=>String(d.number).toLowerCase()===key)||null;}
  const name=String(action.buyerName||'').toLowerCase(); if(!name) return null;
  const saleIds=new Set(state.sales.filter(s=>String(s.buyerName||'').toLowerCase().includes(name)).map(s=>s.id));
  return state.documents.filter(d=>saleIds.has(d.saleId)&&(!action.kind||d.kind===action.kind)).sort((a,b)=>String(b.createdAt||b.date).localeCompare(String(a.createdAt||a.date)))[0]||null;
}
function applyDeskAction(action) {
  if(action.type==='create_sale'){
    const matches=matchStockVehicle(action.vehicle);
    if(!matches.length) throw new Error(`No available or reserved vehicle matches “${action.vehicle}”. Add it to stock first.`);
    if(matches.length>1) throw new Error(`“${action.vehicle}” matches more than one vehicle (${matches.map(v=>vehicleName(v)).join('; ')}). Record this sale from Sales so you can pick the right one.`);
    const sale=recordSale({vehicle:matches[0],buyerName:action.buyerName,buyerPhone:action.buyerPhone,date:action.saleDate||today(),price:action.price,paid:action.amountPaid,paymentMethod:action.paymentMethod,vatEnabled:false,vatRate:0,terms:SALE_TERMS_DEFAULT,remarks:''});
    render();
    return {message:`Sale saved · invoice ${sale.invoiceNumber}${sale.latestReceiptId?' and its receipt':''}.`,documentNumber:sale.invoiceNumber};
  }
  if(action.type==='add_vehicle'){
    const record={make:action.make,model:action.model,year:Number(action.year),vin:action.vin||'',color:action.color||'',condition:action.condition||'Tokunbo',mileage:Number(action.mileage)||0,askingPrice:Number(action.askingPrice)||0,acquisitionCost:Number(action.acquisitionCost)||0,clearing:Number(action.clearing)||0,transport:Number(action.transport)||0,repairs:Number(action.repairs)||0,arrivalDate:action.arrivalDate||today(),status:'available',engine:'',plate:'',cNumber:''};
    state.vehicles.push({...record,id:makeId()}); save(); render();
    return {message:`Stock updated · ${vehicleName(record)} added as available.`};
  }
  if(action.type==='record_payment'){
    const invoiceKey=String(action.invoiceNumber||'').toUpperCase();
    const name=String(action.buyerName||'').toLowerCase().trim();
    let matches=invoiceKey?state.sales.filter(s=>String(s.invoiceNumber||'').toUpperCase()===invoiceKey):[];
    if(!matches.length&&name){const exact=state.sales.filter(s=>String(s.buyerName||'').toLowerCase().trim()===name);matches=exact.length?exact:state.sales.filter(s=>String(s.buyerName||'').toLowerCase().includes(name));}
    if(!matches.length) throw new Error(`No sale on this desk matches ${action.invoiceNumber||action.buyerName}.`);
    if(matches.length>1) throw new Error(`That matches ${matches.length} sales. Record the payment from Sales so you can pick the right one.`);
    const sale=matches[0], remaining=Number((sale.total-sale.paidAmount).toFixed(2));
    if(action.amount>remaining) throw new Error(`${money(action.amount)} is more than the ${money(remaining)} balance on ${sale.invoiceNumber}. Record a smaller amount or open Sales.`);
    const {doc}=recordPayment(sale,{amount:action.amount,method:action.paymentMethod,date:action.paymentDate||today()});
    render();
    return {message:`Receipt ${doc.number} issued · ${money(action.amount)} against ${sale.invoiceNumber}. ${money(Math.max(0,sale.total-sale.paidAmount))} still due.`,documentNumber:doc.number};
  }
  if(action.type==='open_document'){
    const doc=findDeskDocument(action);
    if(!doc) throw new Error(action.number?`No invoice or receipt numbered ${action.number} is on this desk.`:`No ${action.kind||'invoice or receipt'} found for ${action.buyerName}.`);
    documentPage(doc);
    return {message:`Opened ${doc.number}.`};
  }
  throw new Error('The desk does not support that action.');
}
document.addEventListener('akinlowo:desk-action', event => {
  const detail=event.detail||{}, reply={id:detail.id,ok:false,message:''};
  try{
    if(document.body.classList.contains('desk-locked')) throw new Error('Sign in to the desk first.');
    Object.assign(reply,{ok:true},applyDeskAction(detail.action||{}));
  }catch(error){ reply.ok=false; reply.message=error?.message||'The desk could not complete that action.'; }
  document.dispatchEvent(new CustomEvent('akinlowo:desk-action-result',{detail:reply}));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') setAssistant(false); });
document.addEventListener('click', e => {
  const panel = document.getElementById('assistant-panel');
  if (!panel || panel.hidden) return;
  if (e.target.closest('#assistant-panel') || e.target.closest('[data-action="toggle-assistant"]')) return;
  if (e.target.closest('#modal')) return;
  setAssistant(false);
});
modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
window.addEventListener('hashchange',()=>{currentRoute=location.hash.slice(1)||'dashboard';if(!document.body.classList.contains('desk-locked'))render();});

/* ---------- Whole-desk sign-in gate and server storage ---------- */
const lockPanel = document.getElementById('desk-lock');
const lockForm = document.getElementById('desk-lock-form');
const lockStatusEl = document.getElementById('desk-lock-status');
const lockErrorEl = document.getElementById('desk-lock-error');
const lockSubmit = document.getElementById('desk-lock-submit');
const deskUserEl = document.getElementById('desk-user');
const deskSignout = document.getElementById('desk-signout');

function lockStatus(text, kind = '') {
  if (!lockStatusEl) return;
  lockStatusEl.textContent = text;
  if (kind) lockStatusEl.dataset.state = kind; else delete lockStatusEl.dataset.state;
}

function lockError(message) {
  if (!lockErrorEl) return;
  lockErrorEl.textContent = message;
  lockErrorEl.hidden = !message;
}

function lockDesk(message, isError = false) {
  document.body.classList.add('desk-locked');
  if (lockPanel) lockPanel.hidden = false;
  if (lockForm) lockForm.hidden = false;
  if (deskUserEl) deskUserEl.hidden = true;
  if (deskSignout) deskSignout.hidden = true;
  lockStatus(message, isError ? 'error' : '');
  lockError('');
  setAssistant(false);
  if (saveFailed) setSaveStatus('Not saved', 'error');
  document.getElementById('desk-lock-email')?.focus();
}

function unlockDesk(email) {
  document.body.classList.remove('desk-locked');
  if (lockPanel) lockPanel.hidden = true;
  if (deskUserEl) { deskUserEl.textContent = email || 'Signed in'; deskUserEl.hidden = false; }
  if (deskSignout) deskSignout.hidden = false;
  document.dispatchEvent(new CustomEvent('akinlowo:signed-in'));
}

async function enterDesk() {
  const email = auth?.getSession()?.user?.email ?? '';
  lockStatus('Loading your desk from the dealership database…', 'busy');
  try {
    const loaded = await deskStore.load();
    if (loaded?.state?.initialised) {
      state = loaded.state;
    } else {
      const legacy = readLegacyState();
      if (legacy && stateHasRecords(legacy)) {
        state = normalizeDeskState(legacy);
        state.initialised = true;
        await deskStore.save(state);
        const removed = clearLegacyState();
        if (removed.length) toast('Records kept on this device were uploaded to the dealership database.');
      } else {
        state = normalizeDeskState(emptyState());
        state.initialised = true;
        await deskStore.save(state);
      }
    }
    state.initialised = true;
    saveFailed = false;
    unlockDesk(email);
    setSaveStatus('All changes saved', 'saved');
    render();
    void loadRates();
  } catch (error) {
    if (error?.code === 'auth') {
      auth.clearSession();
      lockDesk(AUTH_COPY.expired, true);
      return;
    }
    lockDesk(`The desk could not be loaded. ${error?.message || 'Try again in a moment.'}`, true);
  }
}

lockForm?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth) return;
  const data = new FormData(lockForm);
  lockError('');
  lockSubmit.disabled = true;
  lockSubmit.textContent = 'Signing in…';
  lockStatus('Checking your account…', 'busy');
  const result = await auth.signIn(String(data.get('email') ?? ''), String(data.get('password') ?? ''));
  lockSubmit.disabled = false;
  lockSubmit.textContent = 'Sign in';
  if (!result.ok) {
    lockStatus('Sign-in failed', 'error');
    lockError(result.message);
    return;
  }
  lockForm.reset();
  await enterDesk();
});

async function endDeskSession(message = 'Signed out. Sign in to reopen the desk.') {
  clearTimeout(saveTimer);
  saveTimer = null;
  state = normalizeDeskState(emptyState());
  closeModal();
  setSaveStatus('');
  lockDesk(message);
}

deskSignout?.addEventListener('click', async () => {
  await auth?.signOut();
  document.dispatchEvent(new CustomEvent('akinlowo:signed-out'));
});

document.addEventListener('akinlowo:signed-out', () => {
  if (document.body.classList.contains('desk-locked')) return;
  void endDeskSession();
});

document.getElementById('desk-save')?.addEventListener('click', () => { if (saveFailed) void flushSave(); });
window.addEventListener('online', () => { if (saveFailed) void flushSave(); });

function bootDesk() {
  if (!authConfig || !auth || !deskStore) {
    lockDesk('This deployment is not connected to a dealership database, so the desk cannot open.', true);
    if (lockForm) lockForm.hidden = true;
    return;
  }
  if (!auth.hasSession()) {
    lockDesk('Sign in to open the dealership desk.');
    return;
  }
  void enterDesk();
}

initAssistantPanel();
bootDesk();
