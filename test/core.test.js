import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNaira, calculateSale, nextDocumentNumber, transitionVehicleStatus, landedCost, lagosDateTime, welcomeMessage, crossRate, rateFreshness } from '../core.js';

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
  assert.throws(() => calculateSale({ price: 100, vatEnabled: false, paid: 101 }), /exceed/);
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

test('reads the welcome from Africa/Lagos rather than the device clock zone', () => {
  const parts = lagosDateTime(new Date('2026-10-31T08:30:00Z'));
  assert.equal(parts.hour, 9);
  assert.equal(parts.timeLabel, '09:30 WAT');
  assert.equal(parts.dateLabel, 'Saturday, 31 October 2026');
  assert.equal(parts.isoDate, '2026-10-31');

  const acrossMidnight = lagosDateTime(new Date('2026-10-31T23:30:00Z'));
  assert.equal(acrossMidnight.hour, 0);
  assert.equal(acrossMidnight.dateLabel, 'Sunday, 1 November 2026');
});

test('greets by Lagos hour and only names the owner when app data has a name', () => {
  const generic = welcomeMessage(new Date('2026-10-31T08:30:00Z'));
  assert.equal(generic.title, 'Good morning');
  assert.equal(generic.name, '');
  assert.equal(generic.timezone, 'Africa/Lagos');

  const named = welcomeMessage(new Date('2026-10-31T14:00:00Z'), '  Adewale  ');
  assert.equal(named.title, 'Good afternoon, Adewale');
  assert.equal(named.name, 'Adewale');

  assert.equal(welcomeMessage(new Date('2026-10-31T05:00:00Z')).title, 'Good morning');
  assert.equal(welcomeMessage(new Date('2026-10-31T19:00:00Z')).title, 'Good evening');
  assert.equal(welcomeMessage(new Date('2026-10-31T21:30:00Z')).title, 'Working late');
  assert.equal(welcomeMessage(new Date('2026-10-31T00:15:00Z')).title, 'Working late');
});

test('builds NGN cross rates from the USD-based table', () => {
  const rates = { USD: 1, NGN: 1345.473177, CAD: 1.396601, CNY: 6.669566, EUR: 0.895588 };
  assert.equal(Math.round(crossRate(rates, 'USD') * 100) / 100, 1345.47);
  assert.equal(Math.round(crossRate(rates, 'CAD') * 100) / 100, 963.39);
  assert.equal(Math.round(crossRate(rates, 'CNY') * 100) / 100, 201.73);
  assert.equal(Math.round(crossRate(rates, 'EUR') * 100) / 100, 1502.33);
  assert.equal(crossRate({ USD: 2, NGN: 1000 }, 'USD'), 500);
  assert.throws(() => crossRate(rates, 'GBP'), /GBP/);
  assert.throws(() => crossRate({ NGN: 0, USD: 1 }, 'USD'), /NGN/);
  assert.throws(() => crossRate(null, 'USD'), /USD/);
});

test('marks a daily feed stale or unavailable without guessing a rate', () => {
  const lastUpdated = 1_793_404_951_000;
  const nextUpdate = lastUpdated + 24 * 60 * 60 * 1000;
  assert.equal(rateFreshness({ lastUpdated, nextUpdate, now: lastUpdated + 60 * 60 * 1000 }).state, 'current');
  assert.equal(rateFreshness({ lastUpdated, nextUpdate, now: lastUpdated + 37 * 60 * 60 * 1000 }).state, 'stale');
  assert.equal(rateFreshness({ lastUpdated, nextUpdate, now: nextUpdate + 8 * 60 * 60 * 1000 }).state, 'stale');
  assert.equal(rateFreshness({ lastUpdated: 0, now: 1 }).state, 'unavailable');
  assert.equal(rateFreshness({}).state, 'unavailable');
});
