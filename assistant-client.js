/**
 * Browser client for the dealership support assistant.
 *
 * Configuration is injected by the deployment at runtime, never committed:
 *
 *   window.AKINLOWO_ASSISTANT = {
 *     endpoint: 'https://<project-ref>.supabase.co/functions/v1/dealership-assistant',
 *     getAccessToken: async () => '<short-lived Supabase user access token>'
 *   };
 *
 * There is deliberately no API key here: the Groq key lives only in the Edge
 * Function's server-side secrets. Only the text the person types is sent, plus
 * a short in-memory conversation history; saved records never leave the page.
 */

export const ASSISTANT_MAX_CHARS = 1200;
export const ASSISTANT_MAX_HISTORY = 8;
export const ASSISTANT_TIMEOUT_MS = 30000;

export const ASSISTANT_COPY = Object.freeze({
  notConfigured: 'The assistant is not connected on this deployment. Nothing is sent.',
  signedOut: 'Sign in to use the assistant. Nothing has been sent.',
  notAuthorised: 'This account is not authorised to use the assistant.',
  unavailable: 'The assistant service is unavailable right now. Try again shortly.',
  busy: 'The assistant is busy. Wait a moment and try again.',
  timedOut: 'The assistant took too long to reply. Try again.',
  offline: 'The assistant could not be reached. Check your connection and try again.',
  tooLong: `Messages are limited to ${ASSISTANT_MAX_CHARS} characters.`,
  empty: 'Type a message first.',
  rejected: 'That message could not be sent. Try shortening it and sending again.'
});

export const ASSISTANT_SUGGESTIONS = Object.freeze([
  'Sell the 2021 Camry to Aisha Bello for 24.5m, 10m paid by transfer',
  'Add a 2019 Lexus RX 350 to stock, asking 32.5m',
  'How do I record a part payment and get a receipt?',
  'What do the exchange rates mean?'
]);

export function isAllowedEndpoint(value, location = globalThis.location) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const pageHref = typeof location?.href === 'string' ? location.href : 'https://localhost/';
  let url;
  try {
    url = new URL(value.trim(), pageHref);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function readAssistantConfig(scope = globalThis) {
  const raw = scope?.AKINLOWO_ASSISTANT;
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  if (!isAllowedEndpoint(endpoint, scope?.location)) return null;
  if (typeof raw.getAccessToken !== 'function') return null;
  return { endpoint, getAccessToken: raw.getAccessToken };
}

/** Keeps only role/content pairs, caps the history and never sends app state. */
export function buildRequestMessages(history, message) {
  const items = Array.isArray(history) ? history : [];
  const clean = [];
  for (const item of items.slice(-ASSISTANT_MAX_HISTORY)) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, ASSISTANT_MAX_CHARS) : '';
    if (content) clean.push({ role: item.role, content });
  }
  while (clean.length > 0 && clean[0].role !== 'user') clean.shift();
  return [...clean, { role: 'user', content: String(message ?? '').trim().slice(0, ASSISTANT_MAX_CHARS) }];
}

/**
 * The server may propose one desk action. This module repeats the checks the
 * desk will make, so a malformed action is dropped before it reaches the UI.
 */
export const ASSISTANT_ACTION_TYPES = Object.freeze(['create_sale', 'add_vehicle', 'record_payment', 'open_document']);

export function readAction(value) {
  if (!value || typeof value !== 'object' || !ASSISTANT_ACTION_TYPES.includes(value.type)) return null;
  const text = (input, max = 120) => (typeof input === 'string' ? input.trim().slice(0, max) : '');
  const money = input => {
    const amount = Number(input);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
  };
  if (value.type === 'create_sale') {
    const buyerName = text(value.buyerName, 80);
    const vehicle = text(value.vehicle, 80);
    const price = money(value.price);
    if (!buyerName || !vehicle || !price) return null;
    return {
      type: 'create_sale',
      buyerName,
      vehicle,
      price,
      amountPaid: money(value.amountPaid) || 0,
      paymentMethod: text(value.paymentMethod, 20) || 'Bank transfer',
      buyerPhone: text(value.buyerPhone, 40),
      saleDate: text(value.saleDate, 10)
    };
  }
  if (value.type === 'add_vehicle') {
    const make = text(value.make, 40);
    const model = text(value.model, 60);
    const year = Number(value.year);
    if (!make || !model || !Number.isInteger(year) || year < 1950 || year > 2100) return null;
    return {
      type: 'add_vehicle',
      make,
      model,
      year,
      vin: text(value.vin, 32).toUpperCase(),
      color: text(value.color, 30),
      condition: text(value.condition, 20) || 'Tokunbo',
      mileage: money(value.mileage) || 0,
      askingPrice: money(value.askingPrice) || 0,
      acquisitionCost: money(value.acquisitionCost) || 0,
      clearing: money(value.clearing) || 0,
      transport: money(value.transport) || 0,
      repairs: money(value.repairs) || 0,
      arrivalDate: text(value.arrivalDate, 10)
    };
  }
  if (value.type === 'record_payment') {
    const amount = money(value.amount);
    const buyerName = text(value.buyerName, 80);
    const invoiceNumber = text(value.invoiceNumber, 32).toUpperCase();
    if (!amount || (!buyerName && !invoiceNumber)) return null;
    return {
      type: 'record_payment',
      amount,
      buyerName,
      invoiceNumber,
      paymentMethod: text(value.paymentMethod, 20) || 'Bank transfer',
      paymentDate: text(value.paymentDate, 10)
    };
  }
  const number = text(value.number, 32).toUpperCase();
  const buyerName = text(value.buyerName, 80);
  if (!number && !buyerName) return null;
  return {
    type: 'open_document',
    number,
    buyerName,
    kind: value.kind === 'invoice' || value.kind === 'receipt' ? value.kind : ''
  };
}

export function describeStatus(status, payload) {
  const bodyError = payload?.error;
  if (status === 401) return { code: 'signed-out', message: ASSISTANT_COPY.signedOut };
  if (status === 403) return { code: 'not-authorised', message: ASSISTANT_COPY.notAuthorised };
  if (status === 404 || status === 405 || status === 503) return { code: 'not-configured', message: ASSISTANT_COPY.notConfigured };
  if (status === 413) return { code: 'too-long', message: ASSISTANT_COPY.tooLong };
  if (status === 429) return { code: 'busy', message: ASSISTANT_COPY.busy };
  if (status === 400) return { code: 'rejected', message: ASSISTANT_COPY.rejected };
  if (Number(status) >= 500) return { code: 'unavailable', message: ASSISTANT_COPY.unavailable };
  // Never surface raw provider or server text to the interface.
  return { code: bodyError?.code ? 'rejected' : 'unavailable', message: ASSISTANT_COPY.unavailable };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createAssistantClient({
  config = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = ASSISTANT_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  return {
    get configured() {
      return Boolean(config?.endpoint && typeof config?.getAccessToken === 'function');
    },

    async send(text, history = []) {
      if (!config) return { ok: false, code: 'not-configured', message: ASSISTANT_COPY.notConfigured };
      const message = typeof text === 'string' ? text.trim() : '';
      if (!message) return { ok: false, code: 'empty', message: ASSISTANT_COPY.empty };
      if (message.length > ASSISTANT_MAX_CHARS) return { ok: false, code: 'too-long', message: ASSISTANT_COPY.tooLong };

      let token;
      try {
        token = await config.getAccessToken();
      } catch {
        return { ok: false, code: 'signed-out', message: ASSISTANT_COPY.signedOut };
      }
      if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, code: 'signed-out', message: ASSISTANT_COPY.signedOut };
      }
      if (typeof fetchImpl !== 'function') {
        return { ok: false, code: 'unavailable', message: ASSISTANT_COPY.unavailable };
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || ASSISTANT_TIMEOUT_MS)) : null;

      try {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token.trim()}`
          },
          body: JSON.stringify({ messages: buildRequestMessages(history, message) }),
          signal: controller?.signal
        });

        if (!response || response.ok !== true) {
          const payload = response ? await readJson(response) : null;
          return { ok: false, ...describeStatus(response?.status ?? 0, payload) };
        }

        const payload = await readJson(response);
        const reply = typeof payload?.reply === 'string' ? payload.reply.trim() : '';
        const action = readAction(payload?.action);
        if (!reply && !action) return { ok: false, code: 'empty-reply', message: ASSISTANT_COPY.unavailable };
        return { ok: true, reply: reply.slice(0, 6000), action, sentAt: now() };
      } catch (error) {
        const aborted = error?.name === 'AbortError';
        const offline = error?.name === 'TypeError';
        return {
          ok: false,
          code: aborted ? 'timed-out' : offline ? 'offline' : 'unavailable',
          message: aborted ? ASSISTANT_COPY.timedOut : offline ? ASSISTANT_COPY.offline : ASSISTANT_COPY.unavailable
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}
