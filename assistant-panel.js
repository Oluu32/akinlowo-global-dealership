import {
  ASSISTANT_MAX_CHARS,
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_SUGGESTIONS,
  createAssistantClient,
  isAllowedEndpoint
} from './assistant-client.js';
import { AUTH_COPY, createAuthClient, readAuthConfig } from './auth-client.js';

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
  const fab = document.querySelector('[data-action="toggle-assistant"]');
  if (!panel || !fab) return;
  panel.hidden = !open;
  fab.setAttribute('aria-expanded', String(open));
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

  el('assistant-auth-form')?.addEventListener('submit', event => {
    event.preventDefault();
    void signIn();
  });

  el('assistant-signout')?.addEventListener('click', () => { void signOut(); });

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
    setStatus('off', 'Sign-in required', 'Records stay in this browser; signing in only unlocks the assistant.');
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
      'Ask me how to use this desk — invoices, receipts, VAT, payments, stock or the rate panel. I cannot see your saved records and I cannot change anything for you.'
    );
    appendBubble('assistant', 'Only the words you type are sent to the assistant service. Your vehicles, sales, customers, documents and every other saved record stay in this browser.');
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
    appendBubble('assistant', result.reply);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply });
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

function setStatus(kind, label, note) {
  const pill = el('assistant-status');
  if (pill) {
    pill.textContent = label;
    pill.className = `assistant-state is-${kind}`;
  }
  const noteEl = el('assistant-status-note');
  if (noteEl) noteEl.textContent = note;
  const fab = document.querySelector('.assistant-fab');
  if (fab) {
    fab.setAttribute('aria-label', configured
      ? 'Open the dealership assistant'
      : 'Open the assistant panel (not configured)');
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

function scrollToLatest() {
  const log = el('assistant-log');
  if (log) log.scrollTop = log.scrollHeight;
}
