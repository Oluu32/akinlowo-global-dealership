import test from 'node:test';
import assert from 'node:assert/strict';
import { answerDeskQuestion, deskSnapshot } from '../desk-insights.js';

const now = new Date('2026-11-01T09:00:00Z');

const STATE = {
  vehicles: [
    { id: 'v1', make: 'Toyota', model: 'Camry', year: 2021, vin: 'JT2BF22K1W0123456', arrivalDate: '2026-09-12', askingPrice: 24500000, acquisitionCost: 18000000, clearing: 1600000, transport: 400000, repairs: 250000, status: 'sold' },
    { id: 'v2', make: 'Lexus', model: 'RX 350', year: 2019, vin: '2T2BZMCA0KC123456', arrivalDate: '2026-10-02', askingPrice: 32500000, acquisitionCost: 24000000, clearing: 2100000, transport: 500000, repairs: 0, status: 'reserved' },
    { id: 'v3', make: 'Honda', model: 'Accord', year: 2020, arrivalDate: '2026-10-20', askingPrice: 19800000, acquisitionCost: 14500000, clearing: 1200000, transport: 320000, repairs: 180000, status: 'available' }
  ],
  sales: [
    { id: 's1', vehicleId: 'v1', buyerName: 'Chinedu Okafor', date: '2026-10-28', basePrice: 24500000, total: 24500000, paidAmount: 24500000, vehicleExpense: 0 },
    { id: 's2', vehicleId: 'v2', buyerName: 'Aisha Bello', date: '2026-10-30', basePrice: 32500000, total: 32500000, paidAmount: 12000000, vehicleExpense: 0 }
  ],
  expenses: [{ id: 'e1', amount: 5000000 }, { id: 'e2', amount: 1200000 }],
  suppliers: [],
  documents: [
    { id: 'd1', kind: 'invoice', number: 'AGI-INV-2026-0001', saleId: 's1' },
    { id: 'd2', kind: 'invoice', number: 'AGI-INV-2026-0002', saleId: 's2' },
    { id: 'd3', kind: 'receipt', number: 'AGI-RCT-2026-0001', saleId: 's1' }
  ]
};

const ask = question => answerDeskQuestion(question, STATE, { now, today: '2026-11-01' });

test('the snapshot matches the figures the dashboard shows', () => {
  const snapshot = deskSnapshot(STATE, { today: '2026-11-01' });
  assert.equal(snapshot.stockCost, 42800000);
  assert.equal(snapshot.stockAsking, 52300000);
  assert.equal(snapshot.received, 36500000);
  assert.equal(snapshot.outstanding, 20500000);
  assert.equal(snapshot.realised, 10150000);
  assert.equal(snapshot.expenseTotal, 6200000);
  assert.equal(snapshot.invoices, 2);
  assert.equal(snapshot.receipts, 1);
});

test('answers a stock count with the status split', () => {
  const answer = ask('How many cars do I have?');
  assert.match(answer, /3 vehicles/);
  assert.match(answer, /1 available, 1 reserved, 1 sold/);
});

test('lists what is in stock and leaves sold vehicles out', () => {
  const answer = ask('What is in stock?');
  assert.match(answer, /Lexus RX 350/);
  assert.match(answer, /Honda Accord/);
  assert.equal(answer.includes('Camry'), false);
});

test('answers stock value with cost and asking price', () => {
  const answer = ask("What's my stock worth?");
  assert.match(answer, /₦42,800,000/);
  assert.match(answer, /₦52,300,000/);
});

test('names who owes money and the total', () => {
  const answer = ask('Who owes me money?');
  assert.match(answer, /₦20,500,000/);
  assert.match(answer, /Aisha Bello/);
  assert.match(answer, /Lexus RX 350/);
  assert.equal(answer.includes('Chinedu'), false);
});

test('answers cash received and profit from the same state', () => {
  assert.match(ask('How much have I received?'), /₦36,500,000/);
  assert.match(ask('What is my gross profit?'), /₦10,150,000/);
});

test('reads a month out of the question', () => {
  const answer = ask('What did I sell in October?');
  assert.match(answer, /October 2026/);
  assert.match(answer, /2 sales worth ₦57,000,000/);
  assert.match(answer, /₦20,500,000/);
  assert.equal(ask('What did I sell in August?'), 'No sales recorded for August 2026.');
});

test('answers document and expense counts', () => {
  assert.match(ask('How many invoices do I have?'), /2 invoices and 1 receipt/);
  assert.match(ask('How much have I spent on expenses?'), /2 totalling ₦6,200,000/);
});

test('describes one vehicle by name', () => {
  const answer = ask('Tell me about the Accord');
  assert.match(answer, /2020 Honda Accord/);
  assert.match(answer, /available/);
  assert.match(answer, /₦19,800,000/);
  assert.match(answer, /12 days on lot/);
});

test('leaves how-to and unrelated questions to the assistant service', () => {
  assert.equal(ask('How do I create an invoice?'), null);
  assert.equal(ask('How do I record a part payment?'), null);
  assert.equal(ask('What is a VIN?'), null);
  assert.equal(ask(''), null);
  assert.equal(ask('hello there'), null);
});

test('an empty desk still answers plainly', () => {
  const empty = { vehicles: [], sales: [], expenses: [], documents: [] };
  const answer = answerDeskQuestion('How many vehicles are in stock?', empty, { now, today: '2026-11-01' });
  assert.match(answer, /No vehicles on this desk yet/);
  assert.match(answerDeskQuestion('Who owes me money?', empty, { now }), /Nothing is outstanding/);
  assert.match(answerDeskQuestion('What is my stock worth?', empty, { now }), /No unsold stock/);
});

test('answers a balance question about a named buyer or invoice', () => {
  const state = {
    ...STATE,
    sales: STATE.sales.map(sale => sale.id === 's2'
      ? { ...sale, invoiceNumber: 'AGI-INV-2026-0002', payments: [{ amount: 12000000, date: '2026-10-30', method: 'Bank transfer' }] }
      : { ...sale, invoiceNumber: 'AGI-INV-2026-0001', payments: [{ amount: 24500000, date: '2026-10-28', method: 'Cash' }] })
  };
  const askNamed = question => answerDeskQuestion(question, state, { now, today: '2026-11-01' });

  const byName = askNamed('What does Aisha still owe?');
  assert.match(byName, /Aisha Bello/);
  assert.match(byName, /2019 Lexus RX 350/);
  assert.match(byName, /AGI-INV-2026-0002/);
  assert.match(byName, /₦20,500,000\.00 still due/);
  assert.match(byName, /last ₦12,000,000\.00 on 2026-10-30 by Bank transfer/);

  const byInvoice = askNamed('How much is left on agi-inv-2026-0002?');
  assert.match(byInvoice, /Aisha Bello/);
  assert.match(byInvoice, /₦20,500,000\.00 still due/);

  const settled = askNamed('Is Chinedu paid up?');
  assert.match(settled, /fully paid/);
});

test('does not answer a balance question when the name matches several sales', () => {
  const state = {
    ...STATE,
    sales: [
      { ...STATE.sales[0], buyerName: 'Aisha Bello' },
      { ...STATE.sales[1], buyerName: 'Aisha Mohammed' }
    ]
  };
  assert.equal(answerDeskQuestion('What does Aisha owe?', state, { now }), null);
});

test('leaves a payment instruction to the assistant, which prepares it', () => {
  assert.equal(ask('Record a payment of 5m from Aisha'), null);
});
