import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOrderText } from '../src/ai/parser.js';

const { catalog } = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));
const T = '2026-10-21'; // Wednesday
const pick = (text) => parseOrderText(text, catalog, T).items.map((i) => [i.sku, i.qty]);

test('Manglish, number before item', () => {
  assert.deepEqual(pick('nak 2 kek coklat utk sabtu, urgent ya'), [['KEK-COKLAT', 2]]);
});
test('several items, number after item', () => {
  assert.deepEqual(pick('red velvet x2\ncheesecake 1\ncupcake 3 kotak'), [['KEK-RV', 2], ['CHEESECAKE', 1], ['CUPCAKE', 3]]);
});
test('Chinese order with 两 and 个', () => {
  assert.deepEqual(pick('我要两个芝士蛋糕和一盒布朗尼'), [['CHEESECAKE', 2], ['BROWNIES', 1]]);
});
test('Malay number words incl. sebiji / sekotak', () => {
  assert.deepEqual(pick('esok nak tiga kek coklat dengan sekotak cupcake'), [['KEK-COKLAT', 3], ['CUPCAKE', 1]]);
});
test('cake size is not a quantity', () => {
  assert.deepEqual(pick('cheesecake 6 inci 2 biji'), [['CHEESECAKE', 2]]);
});
test('times are not quantities', () => {
  assert.deepEqual(pick('hantar sebelum pukul 10 pagi: 2 brownies'), [['BROWNIES', 2]]);
});
test('unknown product becomes a null sku', () => {
  const r = parseOrderText('tambah 3 tong lagi', catalog, T);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].sku, null);
});
test('greeting is not an order', () => {
  assert.equal(parseOrderText('hi boss, apa khabar', catalog, T).isOrder, false);
});
test('delivery words and weekdays', () => {
  assert.equal(parseOrderText('2 kek coklat esok', catalog, T).deliveryDate, '2026-10-22');
  assert.equal(parseOrderText('2 kek coklat lusa', catalog, T).deliveryDate, '2026-10-23');
  assert.equal(parseOrderText('2 kek coklat utk sabtu', catalog, T).deliveryDate, '2026-10-24');
  assert.equal(parseOrderText('周五要一个红丝绒', catalog, T).deliveryDate, '2026-10-23');
});
test('owner edits: set to zero / remove', () => {
  assert.deepEqual(pick('kek coklat 3, cheesecake 0'), [['KEK-COKLAT', 3], ['CHEESECAKE', 0]]);
  assert.deepEqual(pick('buang brownies'), [['BROWNIES', 0]]);
});
test('English orders with plurals', () => {
  assert.deepEqual(pick('I want 2 chocolate cakes and two cheesecakes'), [['KEK-COKLAT', 2], ['CHEESECAKE', 2]]);
  assert.deepEqual(pick('ok I will take one red velvet tomorrow'), [['KEK-RV', 1]]);
});
