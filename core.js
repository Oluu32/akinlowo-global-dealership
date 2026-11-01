export function formatNaira(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError('Amount must be a finite number');
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(amount);
}

export function calculateSale({ price, vatRate = 7.5, vatEnabled = true, paid = 0 }) {
  const base = Number(price);
  const rate = Number(vatRate);
  const received = Number(paid);
  if (![base, rate, received].every(Number.isFinite) || base < 0 || received < 0 || rate < 0 || rate > 100) {
    throw new RangeError('Price, VAT rate, or payment is outside the allowed range');
  }
  const vat = vatEnabled ? Math.round((base * rate / 100 + Number.EPSILON) * 100) / 100 : 0;
  const total = Math.round((base + vat + Number.EPSILON) * 100) / 100;
  if (received > total) throw new RangeError('Payment cannot exceed the sale total');
  return { base, vat, total, paid: received, balance: Math.max(0, Math.round((total - received + Number.EPSILON) * 100) / 100) };
}

export function nextDocumentNumber(sequence, kind, date = new Date()) {
  if (!['invoice', 'receipt'].includes(kind)) throw new TypeError('Document kind must be invoice or receipt');
  const next = Number(sequence) + 1;
  if (!Number.isInteger(next) || next < 1) throw new RangeError('Sequence must be a non-negative integer');
  const year = new Date(date).getFullYear();
  const prefix = kind === 'invoice' ? 'AGI-INV' : 'AGI-RCT';
  return { sequence: next, number: `${prefix}-${year}-${String(next).padStart(4, '0')}` };
}

export function transitionVehicleStatus(current, next) {
  const allowed = ['available', 'reserved', 'sold'];
  if (!allowed.includes(current) || !allowed.includes(next)) throw new TypeError('Unknown vehicle status');
  if (current === 'sold' && next !== 'sold') throw new Error('A sold vehicle cannot be returned to stock from this workflow');
  return next;
}

export function landedCost(vehicle) {
  return ['acquisitionCost', 'clearing', 'transport', 'repairs'].reduce((sum, key) => sum + Math.max(0, Number(vehicle[key]) || 0), 0);
}

export function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Lagos-time welcome. All dashboard greetings follow Africa/Lagos
 * (WAT, UTC+1, no daylight saving) regardless of device time zone.
 * ------------------------------------------------------------------ */
export const LAGOS_TIME_ZONE = 'Africa/Lagos';

export function lagosDateTime(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new TypeError('A valid date is required');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value ?? '';
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  const minute = get('minute');
  return {
    hour: Number(hour), minute: Number(minute),
    dateLabel: `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}`,
    timeLabel: `${hour}:${minute} WAT`,
    clock: `${hour}:${minute}`,
    isoDate: `${get('year')}-${monthNumber(get('month'))}-${String(get('day')).padStart(2, '0')}`
  };
}

function monthNumber(name) {
  const index = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(name);
  if (index < 0) throw new RangeError('Unrecognised month from the Lagos formatter');
  return String(index + 1).padStart(2, '0');
}

export function salutationForHour(hour) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new RangeError('Hour must be an integer from 0 to 23');
  if (h < 5 || h >= 22) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Owner name is only used when the app data actually contains one;
 * otherwise the greeting stays generic. No name is invented here.
 */
export function welcomeMessage(date = new Date(), ownerName = '') {
  const { hour, dateLabel, timeLabel, clock } = lagosDateTime(date);
  const salutation = salutationForHour(hour);
  const name = typeof ownerName === 'string' ? ownerName.trim() : '';
  return {
    salutation, name, hour, dateLabel, timeLabel, clock,
    title: name ? `${salutation}, ${name}` : salutation,
    subtitle: name ? 'Welcome back to your dealership desk.' : 'Welcome back to the Akinlowo Global dealership desk.',
    timezone: LAGOS_TIME_ZONE
  };
}

/* ------------------------------------------------------------------ *
 * Indicative NGN cross rates from a USD-based daily feed.
 * NGN per 1 target unit = NGN/USD (source) / target/USD (source).
 * ------------------------------------------------------------------ */
export const RATE_CURRENCIES = Object.freeze([
  { code: 'USD', name: 'US dollar' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'EUR', name: 'Euro' }
]);

export function crossRate(rates, target, base = 'NGN') {
  const targetRate = Number(rates?.[target]);
  const baseRate = Number(rates?.[base]);
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new RangeError(`No usable ${target} rate was supplied`);
  if (!Number.isFinite(baseRate) || baseRate <= 0) throw new RangeError(`No usable ${base} rate was supplied`);
  return baseRate / targetRate;
}

export const RATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function rateFreshness({ lastUpdated, nextUpdate, now = Date.now(), maxAgeMs = RATE_MAX_AGE_MS } = {}) {
  const updated = Number(lastUpdated);
  const current = Number(now);
  if (!Number.isFinite(updated) || updated <= 0 || !Number.isFinite(current)) return { state: 'unavailable', ageMs: null };
  const ageMs = current - updated;
  if (ageMs > maxAgeMs) return { state: 'stale', ageMs };
  const next = Number(nextUpdate);
  if (Number.isFinite(next) && next > 0 && current > next + 6 * 60 * 60 * 1000) return { state: 'stale', ageMs };
  return { state: 'current', ageMs };
}
