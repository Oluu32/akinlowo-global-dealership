import {
  ASSISTANT_MAX_CHARS,
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_SUGGESTIONS,
  createAssistantClient,
  readAssistantConfig
} from './assistant-client.js';

/**
 * Floating assistant panel.
 *
 * The panel is only wired to a chat endpoint when the deployment injects
 * window.AKINLOWO_ASSISTANT. Without it the panel stays open as a labelled,
 * disabled shell and no request is made.
 *
 * Conversation history lives in this module's memory only: it is never written
 * to localStorage, never exported, and is discarded when the page reloads.
 */

let client = null;
let configured = false;
let busy = false;
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
  if (configured) el('assistant-input')?.focus();
  else panel.querySelector('[data-action="close-assistant"]')?.focus();
}

export function initAssistantPanel(scope = globalThis) {
  if (initialised) return;
  const form = el('assistant-form');
  const input = el('assistant-input');
  if (!form || !input) return;
  initialised = true;

  const config = readAssistantConfig(scope);
  configured = Boolean(config);
  client = createAssistantClient({ config });

  renderIntro();
  renderSuggestions();
  setStatus(
    configured ? 'ready' : 'off',
    configured ? 'Ready' : 'Not configured',
    configured ? 'Messages are checked against your signed-in session.' : 'No assistant endpoint is configured for this deployment.'
  );
  syncComposer();

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
}

function renderIntro() {
  const log = el('assistant-log');
  if (!log) return;
  log.replaceChildren();
  appendBubble(
    'assistant',
    configured
      ? 'Ask me how to use this desk — invoices, receipts, VAT, payments, stock or the rate panel. I cannot see your saved records and I cannot change anything for you.'
      : 'The assistant is not connected in this deployment. No messages are sent, and nothing on this page leaves your browser.'
  );
  if (configured) {
    appendBubble('assistant', 'Only the words you type are sent to the assistant service. Your vehicles, sales, customers, documents and every other saved record stay in this browser.');
  }
}

function renderSuggestions() {
  const holder = el('assistant-suggestions');
  if (!holder) return;
  holder.replaceChildren();
  if (!configured) {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  for (const suggestion of ASSISTANT_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'assistant-chip';
    chip.dataset.assistantSuggestion = suggestion;
    chip.textContent = suggestion;
    holder.append(chip);
  }
}

async function sendMessage(raw) {
  const input = el('assistant-input');
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (busy) return;

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
    setStatus('ready', 'Connected', 'Replies come from the dealership assistant service.');
  } else {
    appendError(result.message);
    applyFailure(result);
    if (input && !input.value) input.value = message;
  }

  syncComposer();
  scrollToLatest();
}

function applyFailure(result) {
  switch (result.code) {
    case 'signed-out':
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
  const disabled = !configured || busy;
  input.disabled = disabled;
  send.disabled = disabled;
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
