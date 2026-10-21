import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateOrder, applyEdits } from '../src/rules/engine.js';

const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));
const { catalog, settings } = seed;
const ahSeng = seed.customers[0];
const T = '2026-10-21'; // Wednesday
const ex = (items, deliveryDate = null) => ({ items: items.map(([sku, qty, confidence = 0.9]) => ({ sku, qty, confidence, raw: `${qty} ${sku}` })), deliveryDate });
const base = { catalog, settings, todayIso: T, customer: ahSeng, averages: { 'KEK-COKLAT': 3 }, openInvoices: [] };
const codes = (r) => r.flags.map((f) => f.code);

test('uses the customer price, never an AI price', () => {
  const r = evaluateOrder({ ...base, extraction: ex([['KEK-COKLAT', 2]]) });
  assert.equal(r.lines[0].unitPrice, 60);
  assert.equal(r.total, 120);
  assert.equal(r.decision, 'needs_approval');
  assert.deepEqual(r.flags, []);
});
test('unusual quantity is flagged', () => {
  assert.ok(codes(evaluateOrder({ ...base, extraction: ex([['KEK-COKLAT', 12]]) })).includes('QTY_ANOMALY'));
});
test('unknown item -> ask the customer', () => {
  const r = evaluateOrder({ ...base, extraction: { items: [{ sku: null, qty: 3, raw: '3 tong', confidence: 0.3 }], deliveryDate: null } });
  assert.equal(r.decision, 'clarify');
});
test('overdue and credit limit', () => {
  const r = evaluateOrder({ ...base, openInvoices: [{ total: 2950, dueDate: '2026-09-01' }], extraction: ex([['KEK-COKLAT', 2]]) });
  assert.ok(codes(r).includes('OVERDUE'));
  assert.ok(codes(r).includes('CREDIT_LIMIT'));
});
test('Sunday delivery moves to Monday', () => {
  const r = evaluateOrder({ ...base, extraction: ex([['KEK-COKLAT', 2]], '2026-10-25') });
  assert.equal(r.deliveryDate, '2026-10-26');
  assert.ok(codes(r).includes('DELIVERY_DATE'));
});
test('auto-approve only when the owner turned it on, trusted, no flags, under limit', () => {
  const on = { ...settings, autoApprove: { enabled: true, maxTotal: 300, trustedOnly: true } };
  assert.equal(evaluateOrder({ ...base, settings: on, extraction: ex([['KEK-COKLAT', 2]]) }).decision, 'auto_approve');
  assert.equal(evaluateOrder({ ...base, settings: on, extraction: ex([['KEK-COKLAT', 6]]) }).decision, 'needs_approval');
  assert.equal(evaluateOrder({ ...base, settings: on, customer: { ...ahSeng, trusted: false }, extraction: ex([['KEK-COKLAT', 2]]) }).decision, 'needs_approval');
});
test('owner edit changes qty, adds and removes lines', () => {
  const r = evaluateOrder({ ...base, extraction: ex([['KEK-COKLAT', 4], ['CHEESECAKE', 1]]) });
  const next = applyEdits(r.lines, [{ sku: 'KEK-COKLAT', qty: 3 }, { sku: 'CHEESECAKE', qty: 0 }, { sku: 'BROWNIES', qty: 2 }], ahSeng, catalog);
  assert.deepEqual(next.map((l) => [l.sku, l.qty]), [['KEK-COKLAT', 3], ['BROWNIES', 2]]);
});
