import {
  ASSISTANT_MAX_CHARS,
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_SUGGESTIONS,
  createAssistantClient,
  isAllowedEndpoint
} from './assistant-client.js';
import { AUTH_COPY, createAuthClient, readAuthConfig } from './auth-client.js';
import { answerDeskQuestion } from './desk-insights.js';

/**
 * Floating assistant panel with an optional sign-in gate.
 *
 * Two deployment modes are supported:
 * 1. App-owned auth: window.AKINLOWO_SUPABASE = { url, anonKey } enables a
 *    Supabase Auth sign-in form inside the panel; the token is refreshed by
 *    the app and the assistant endpoint is derived from the project URL.
 * 2. Host-owned session: window.AKINLOWO_ASSISTANT = { endpoint,
 *    getAccessToken } keeps the earlier contract, with no gate in this app.
 *
 * With neither, the panel stays in a labelled "Not configured" state.
 *
 * Conversation history lives in memory only, is cleared on sign-out and is
 * never written to storage. Records on this device are never read into it.
 */

let client = null;
let auth = null;
let configured = false;
let injectedToken = null;
let busy = false;
let signingIn = false;
let ready = false;
let initialised = false;
const history = [];

const el = id => document.getElementById(id);

export function setAssistant(open) {
  const panel = el('assistant-panel');
  const trigger = document.querySelector('[data-action="toggle-assistant"]');
  if (!panel || !trigger) return;
  panel.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (!open) return;
  if (isGated()) el('assistant-email')?.focus();
  else if (configured) el('assistant-input')?.focus();
  else panel.querySelector('[data-action="close-assistant"]')?.focus();
}

export function initAssistantPanel(scope = globalThis) {
  if (initialised) return;
  const form = el('assistant-form');
  const input = el('assistant-input');
  if (!form || !input) return;
  initialised = true;

  const authConfig = readAuthConfig(scope);
  auth = authConfig ? createAuthClient({ config: authConfig }) : null;

  const rawAssistant = scope?.AKINLOWO_ASSISTANT;
  const rawEndpoint = typeof rawAssistant?.endpoint === 'string' ? rawAssistant.endpoint.trim() : '';
  let endpoint = rawEndpoint && isAllowedEndpoint(rawEndpoint, scope?.location) ? rawEndpoint : '';
  if (!endpoint && auth) endpoint = auth.config.endpoint;

  injectedToken = typeof rawAssistant?.getAccessToken === 'function' ? rawAssistant.getAccessToken : null;
  const getAccessToken = injectedToken ?? (auth ? () => auth.getAccessToken() : null);
  configured = Boolean(endpoint && getAccessToken);
  client = createAssistantClient({ config: configured ? { endpoint, getAccessToken } : null });

  form.addEventListener('submit', event => {
    event.preventDefault();
    void sendMessage(input.value);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  el('assistant-suggestions')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-assistant-suggestion]');
    if (!chip) return;
    void sendMessage(chip.dataset.assistantSuggestion ?? '');
  });

  el('assistant-log')?.addEventListener('click', event => {
    const card = event.target.closest('.assistant-action');
    if (!card) return;
    if (event.target.closest('[data-assistant-dismiss]')) {
      card.remove();
      return;
    }
    if (event.target.closest('[data-assistant-approve]') || event.target.closest('[data-assistant-open]')) {
      void runActionCard(card, actionByCard.get(card));
    }
  });

  el('assistant-auth-form')?.addEventListener('submit', event => {
    event.preventDefault();
    void signIn();
  });

  el('assistant-signout')?.addEventListener('click', () => { void signOut(); });

  // The desk owns the session: signing in there must open the assistant, and
  // signing out here must lock the whole app.
  document.addEventListener('akinlowo:signed-in', () => {
    history.length = 0;
    ready = false;
    refreshGate();
  });

  document.addEventListener('akinlowo:signed-out', () => {
    if (isGated()) return;
    history.length = 0;
    ready = false;
    refreshGate();
  });

  refreshGate();
}

function currentSession() {
  return auth && !injectedToken ? auth.getSession() : null;
}

function isGated() {
  const gate = el('assistant-auth');
  return Boolean(gate && !gate.hidden);
}

function refreshGate({ announcement = '' } = {}) {
  const session = currentSession();
  const signedIn = Boolean(injectedToken) || Boolean(session);
  const gated = configured && !signedIn;

  const gate = el('assistant-auth');
  if (gate) gate.hidden = !gated;
  const log = el('assistant-log');
  if (log) log.hidden = gated;
  const compose = el('assistant-form');
  if (compose) compose.hidden = gated;
  const signout = el('assistant-signout');
  if (signout) signout.hidden = gated || !auth || Boolean(injectedToken);

  renderIntro();
  renderSuggestions();
  const suggestions = el('assistant-suggestions');
  if (suggestions) suggestions.hidden = gated || !configured;

  if (!configured) {
    setStatus('off', 'Not configured', 'No assistant endpoint is configured for this deployment.');
  } else if (gated) {
    setStatus('off', 'Sign-in required', 'Sign in to the desk to use the assistant.');
  } else if (injectedToken) {
    setStatus('ready', 'Ready', 'Messages are checked against your signed-in session.');
  } else {
    setStatus(ready ? 'ready' : 'ready', ready ? 'Connected' : 'Ready', `Signed in as ${session?.user?.email || 'this account'}.`);
  }

  syncComposer();
  if (gated) hideAuthError();
  if (announcement) appendBubble('assistant', announcement);
}

function renderIntro() {
  const log = el('assistant-log');
  if (!log) return;
  log.replaceChildren();
  if (configured) {
    appendBubble(
      'assistant',
      'Ask about your own records — stock, what is owed, sales, profit — and I answer from the desk on this screen, without sending anything. Ask how to use the desk, or tell me what to record: a sale with its invoice and receipt, a new vehicle, or a payment. I prepare the record and you approve it on the card; nothing is saved until you do.'
    );
    appendBubble('assistant', 'Only the words you type are sent to the assistant service. Your vehicles, sales, customers, documents and every other saved record are never sent with a message.');
  } else {
    appendBubble('assistant', 'The assistant is not connected in this deployment. No messages are sent, and nothing on this page leaves your browser.');
  }
}

function renderSuggestions() {
  const holder = el('assistant-suggestions');
  if (!holder) return;
  holder.replaceChildren();
  if (!configured) return;
  for (const suggestion of ASSISTANT_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'assistant-chip';
    chip.dataset.assistantSuggestion = suggestion;
    chip.textContent = suggestion;
    holder.append(chip);
  }
}

async function signIn() {
  const form = el('assistant-auth-form');
  if (!auth || !form || signingIn) return;
  signingIn = true;
  const button = el('assistant-auth-submit');
  const data = new FormData(form);
  const email = String(data.get('email') ?? '');
  const password = String(data.get('password') ?? '');

  hideAuthError();
  if (button) {
    button.disabled = true;
    button.textContent = 'Signing in…';
  }
  const result = await auth.signIn(email, password);
  signingIn = false;
  if (button) {
    button.disabled = false;
    button.textContent = 'Sign in';
  }

  if (!result.ok) {
    showAuthError(result.message);
    if (result.code === 'offline' || result.code === 'unavailable') {
      setStatus('error', 'Sign-in unavailable', 'The sign-in service could not be reached.');
    }
    return;
  }

  form.reset();
  history.length = 0;
  ready = false;
  refreshGate({ announcement: `Signed in as ${result.session.user.email || 'this account'}. Ask a question whenever you are ready.` });
  el('assistant-input')?.focus();
}

async function signOut() {
  if (!auth || busy || signingIn) return;
  const button = el('assistant-signout');
  if (button) button.disabled = true;
  await auth.signOut();
  if (button) button.disabled = false;
  history.length = 0;
  ready = false;
  refreshGate({ announcement: 'Signed out. Sign in again to use the assistant.' });
  document.dispatchEvent(new CustomEvent('akinlowo:signed-out'));
  el('assistant-email')?.focus();
}

function showAuthError(message) {
  const note = el('assistant-auth-error');
  if (!note) return;
  note.textContent = message;
  note.hidden = false;
}

function hideAuthError() {
  const note = el('assistant-auth-error');
  if (!note) return;
  note.hidden = true;
  note.textContent = '';
}

async function sendMessage(raw) {
  const input = el('assistant-input');
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (busy || isGated()) return;

  if (!configured) {
    setStatus('off', 'Not configured', 'No assistant endpoint is configured for this deployment.');
    return;
  }
  if (!message) {
    setStatus('warn', 'Empty message', 'Type a message before sending.');
    input?.focus();
    return;
  }
  if (message.length > ASSISTANT_MAX_CHARS) {
    setStatus('warn', 'Message too long', `Keep messages under ${ASSISTANT_MAX_CHARS} characters.`);
    return;
  }

  // Record questions are answered from the state already on this screen, so
  // the figures are exact and nothing about the records is transmitted.
  const local = deskAnswer(message);
  if (local) {
    if (input) input.value = '';
    appendBubble('user', message);
    appendBubble('assistant', local);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: local });
    if (history.length > ASSISTANT_MAX_HISTORY) history.splice(0, history.length - ASSISTANT_MAX_HISTORY);
    ready = true;
    setStatus('ready', 'Answered here', 'Read from the records already open on this desk. Nothing was sent.');
    syncComposer();
    return;
  }

  busy = true;
  if (input) input.value = '';
  appendBubble('user', message);
  const pending = appendPending();
  syncComposer();
  setStatus('busy', 'Sending', 'Waiting for the assistant service.');

  const result = await client.send(message, history.slice(-ASSISTANT_MAX_HISTORY));
  pending?.remove();
  busy = false;

  if (result.ok) {
    if (result.reply) appendBubble('assistant', result.reply);
    if (result.action) appendActionCard(result.action);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply || 'Prepared an action card for approval.' });
    if (history.length > ASSISTANT_MAX_HISTORY) history.splice(0, history.length - ASSISTANT_MAX_HISTORY);
    ready = true;
    setStatus('ready', 'Connected', currentSession()?.user?.email ? `Signed in as ${currentSession().user.email}.` : 'Replies come from the dealership assistant service.');
  } else {
    applyFailure(result);
    if (!result.code || !['signed-out', 'not-authorised'].includes(result.code)) appendError(result.message);
    if (input && !input.value) input.value = message;
  }

  syncComposer();
  scrollToLatest();
}

function applyFailure(result) {
  switch (result.code) {
    case 'signed-out':
      if (auth && !injectedToken) {
        auth.clearSession();
        history.length = 0;
        ready = false;
        refreshGate();
        showAuthError(AUTH_COPY.expired);
        setStatus('off', 'Sign-in required', 'Your session ended. Sign in again to continue.');
        return;
      }
      setStatus('off', 'Sign-in required', 'Your session was not accepted. Sign in again to use the assistant.');
      break;
    case 'not-configured':
      setStatus('off', 'Not connected', 'The assistant endpoint is not available on this deployment.');
      break;
    case 'not-authorised':
      setStatus('off', 'No access', 'This account is not authorised to use the assistant.');
      break;
    case 'busy':
      setStatus('warn', 'Busy', 'Too many messages right now. Wait a moment, then try again.');
      break;
    case 'too-long':
      setStatus('warn', 'Message too long', `Keep messages under ${ASSISTANT_MAX_CHARS} characters.`);
      break;
    case 'offline':
      setStatus('error', 'Offline', 'The assistant could not be reached. Check your connection.');
      break;
    default:
      setStatus('error', ready ? 'Interrupted' : 'Unavailable', 'The assistant did not reply. Your records are unchanged.');
  }
}

function syncComposer() {
  const input = el('assistant-input');
  const send = el('assistant-send');
  if (!input || !send) return;
  const disabled = !configured || busy || isGated();
  input.disabled = disabled;
  send.disabled = disabled;
  const signout = el('assistant-signout');
  if (signout) signout.disabled = busy;
  input.placeholder = configured
    ? busy ? 'Waiting for a reply…' : 'Ask about invoices, receipts, VAT or stock'
    : 'Messaging is disabled — assistant not configured';
  send.textContent = busy ? 'Sending…' : 'Send';
}

/* ------------------------------------------------------------------ *
 * Desk actions. The assistant only prepares; the desk writes after the
 * person presses Approve, and reports back what it did.
 * ------------------------------------------------------------------ */
const actionByCard = new WeakMap();
const DESK_ACTION_TIMEOUT_MS = 6000;

function naira(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function summariseAction(action) {
  if (action.type === 'create_sale') {
    return {
      kicker: 'Sale ready for approval',
      title: action.vehicle,
      rows: [
        ['Buyer', action.buyerName],
        ['Price', naira(action.price)],
        ['Paid now', naira(action.amountPaid)],
        ['Method', action.paymentMethod],
        ['Balance', naira(Math.max(0, action.price - action.amountPaid))]
      ],
      note: 'Approve to record the sale, issue the invoice and, if a payment is entered, its receipt. VAT is not added by the assistant.'
    };
  }
  if (action.type === 'add_vehicle') {
    return {
      kicker: 'Stock ready for approval',
      title: `${action.year} ${action.make} ${action.model}`,
      rows: [
        ['Asking price', naira(action.askingPrice)],
        ['Acquisition', naira(action.acquisitionCost)],
        ['Clearing / transport / repairs', `${naira(action.clearing)} · ${naira(action.transport)} · ${naira(action.repairs)}`],
        ['VIN', action.vin || 'Not given'],
        ['Condition', action.condition]
      ],
      note: 'Approve to add this vehicle to available stock. Fill in anything missing afterwards from Inventory.'
    };
  }
  if (action.type === 'record_payment') {
    return {
      kicker: 'Payment ready for approval',
      title: action.invoiceNumber || action.buyerName,
      rows: [
        ['Amount', naira(action.amount)],
        ['Method', action.paymentMethod],
        ['For', action.invoiceNumber ? `invoice ${action.invoiceNumber}` : action.buyerName]
      ],
      note: 'Approve to record this payment and issue its receipt. The desk refuses an amount larger than the balance still due.'
    };
  }
  return {
    kicker: 'Open a saved document',
    title: action.number || `${action.buyerName} · ${action.kind || 'latest document'}`,
    rows: action.number ? [['Number', action.number]] : [['Buyer', action.buyerName], ['Document', action.kind || 'Latest invoice or receipt']],
    note: 'Opens the stored invoice or receipt in its print view. Nothing is changed.'
  };
}

function appendActionCard(action) {
  const log = el('assistant-log');
  if (!log) return null;
  const summary = summariseAction(action);
  const card = document.createElement('section');
  card.className = 'assistant-action';

  const kicker = document.createElement('p');
  kicker.className = 'assistant-action-kicker';
  kicker.textContent = summary.kicker;

  const title = document.createElement('h3');
  title.textContent = summary.title;

  const list = document.createElement('dl');
  list.className = 'assistant-action-list';
  for (const [label, value] of summary.rows) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    row.append(term, detail);
    list.append(row);
  }

  const note = document.createElement('p');
  note.className = 'assistant-action-note';
  note.textContent = summary.note;

  const buttons = document.createElement('div');
  buttons.className = 'assistant-action-buttons';
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'button button-primary button-small';
  primary.setAttribute(action.type === 'open_document' ? 'data-assistant-open' : 'data-assistant-approve', '');
  primary.textContent = action.type === 'open_document' ? 'Open document' : 'Approve and save';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-quiet button-small';
  dismiss.setAttribute('data-assistant-dismiss', '');
  dismiss.textContent = 'Dismiss';
  buttons.append(primary, dismiss);

  card.append(kicker, title, list, note, buttons);
  actionByCard.set(card, action);
  log.append(card);
  scrollToLatest(true);
  return card;
}

function requestDeskAction(action) {
  return new Promise(resolve => {
    const id = `desk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('akinlowo:desk-action-result', onResult);
      resolve(value);
    };
    const onResult = event => {
      if (event.detail?.id === id) finish(event.detail);
    };
    const timer = setTimeout(() => finish({ ok: false, message: 'The desk did not answer. Try again from its own screens.' }), DESK_ACTION_TIMEOUT_MS);
    document.addEventListener('akinlowo:desk-action-result', onResult);
    document.dispatchEvent(new CustomEvent('akinlowo:desk-action', { detail: { id, action } }));
  });
}

function setCardBusy(card, busy) {
  for (const button of card.querySelectorAll('button')) button.disabled = busy;
  const primary = card.querySelector('[data-assistant-approve], [data-assistant-open]');
  if (primary && busy) primary.textContent = 'Saving…';
}

function showCardResult(card, result, action) {
  card.classList.add(result.ok ? 'is-done' : 'is-failed');
  const note = card.querySelector('.assistant-action-note');
  if (note) note.textContent = result.ok ? (result.message || 'Saved to the desk.') : (result.message || 'The desk could not complete that.');
  const buttons = card.querySelector('.assistant-action-buttons');
  if (!buttons) return;
  buttons.replaceChildren();
  if (result.ok && result.documentNumber) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'button button-secondary button-small';
    open.textContent = `Open ${result.documentNumber}`;
    open.addEventListener('click', async () => {
      const opened = await requestDeskAction({ type: 'open_document', number: result.documentNumber, buyerName: '', kind: '' });
      if (!opened.ok) note.textContent = opened.message;
    });
    buttons.append(open);
  }
  if (!result.ok) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button-quiet button-small';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => { void runActionCard(card, action); });
    buttons.append(retry);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-quiet button-small';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => card.remove());
  buttons.append(dismiss);
  scrollToLatest(true);
}

async function runActionCard(card, action) {
  if (!action) return;
  card.classList.remove('is-done', 'is-failed');
  setCardBusy(card, true);
  const result = await requestDeskAction(action);
  setCardBusy(card, false);
  showCardResult(card, result, action);
}

function setStatus(kind, label, note) {
  const pill = el('assistant-status');
  if (pill) {
    pill.textContent = label;
    pill.className = `assistant-state is-${kind}`;
  }
  const noteEl = el('assistant-status-note');
  if (noteEl) noteEl.textContent = note;
  const trigger = document.querySelector('.assistant-trigger');
  if (trigger) {
    trigger.setAttribute('aria-label', configured
      ? 'Open the dealership assistant'
      : 'Open the assistant panel (not configured)');
  }
}

function deskAnswer(message) {
  const read = globalThis.AKINLOWO_DESK_READ;
  if (typeof read !== 'function') return '';
  try {
    return answerDeskQuestion(message, read()) || '';
  } catch {
    return '';
  }
}

function appendBubble(role, text) {
  const log = el('assistant-log');
  if (!log) return null;
  const bubble = document.createElement('p');
  bubble.className = role === 'user' ? 'assistant-bubble assistant-bubble-user' : 'assistant-bubble';
  bubble.textContent = text;
  log.append(bubble);
  scrollToLatest();
  return bubble;
}

function appendError(message) {
  const log = el('assistant-log');
  if (!log) return;
  const bubble = document.createElement('p');
  bubble.className = 'assistant-bubble assistant-bubble-error';
  bubble.textContent = message;
  log.append(bubble);
  scrollToLatest();
}

function appendPending() {
  const log = el('assistant-log');
  if (!log) return null;
  const bubble = document.createElement('p');
  bubble.className = 'assistant-bubble assistant-bubble-pending';
  bubble.setAttribute('aria-label', 'Waiting for the assistant');
  for (let i = 0; i < 3; i += 1) bubble.append(document.createElement('span'));
  log.append(bubble);
  scrollToLatest();
  return bubble;
}

function scrollToLatest(instant = false) {
  const log = el('assistant-log');
  if (!log) return;
  if (instant) log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
  else log.scrollTop = log.scrollHeight;
}
