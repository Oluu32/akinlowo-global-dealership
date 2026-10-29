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
