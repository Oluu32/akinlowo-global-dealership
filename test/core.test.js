import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNaira, calculateSale, nextDocumentNumber, transitionVehicleStatus, landedCost } from '../core.js';

test('formats the default currency as Nigerian naira', () => {
  const value = formatNaira(1250000);
  assert.match(value, /₦/);
  assert.match(value, /1,250,000/);
});

test('calculates 7.5% VAT and the invoice total', () => {
  assert.deepEqual(calculateSale({ price: 1000000, vatRate: 7.5, vatEnabled: true, paid: 0 }), {
    base: 1000000, vat: 75000, total: 1075000, paid: 0, balance: 1075000
  });
});

test('leaves VAT off when disabled and calculates partial payment balance', () => {
  assert.deepEqual(calculateSale({ price: 100000, vatRate: 7.5, vatEnabled: false, paid: 25000 }), {
    base: 100000, vat: 0, total: 100000, paid: 25000, balance: 75000
  });
});

test('rejects payment above sale total and invalid VAT rate', () => {
  assert.throws(() => calculateSale({ price: 100, paid: 101 }), /exceed/);
  assert.throws(() => calculateSale({ price: 100, vatRate: 101 }), /allowed range/);
});

test('creates separate, increasing local invoice and receipt sequences', () => {
  assert.deepEqual(nextDocumentNumber(0, 'invoice', '2026-10-29'), { sequence: 1, number: 'AGI-INV-2026-0001' });
  assert.deepEqual(nextDocumentNumber(8, 'receipt', '2026-10-29'), { sequence: 9, number: 'AGI-RCT-2026-0009' });
});

test('allows stock transitions to sold and blocks reopening sold stock', () => {
  assert.equal(transitionVehicleStatus('available', 'sold'), 'sold');
  assert.equal(transitionVehicleStatus('available', 'reserved'), 'reserved');
  assert.throws(() => transitionVehicleStatus('sold', 'available'), /cannot be returned/);
});

test('adds vehicle costs into landed cost', () => {
  assert.equal(landedCost({ acquisitionCost: 100, clearing: 20, transport: 5, repairs: 10 }), 135);
});
