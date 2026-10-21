import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyByKeywords, classify, templateReply, draftFollowUp } from '../src/ai/tagger.js';

const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));
const { catalog, business } = seed;
const tag = (t) => { const r = classifyByKeywords(t, catalog); return [r.intent, r.urgency]; };

test('keyword tagger: the five demo customers', () => {
  assert.deepEqual(tag('I want 2 chocolate cakes for Saturday, urgent please'), ['ordering', 'urgent']);
  assert.deepEqual(tag('Do you still have cheesecake? How much?'), ['inquiry', 'normal']);
  assert.deepEqual(tag('How much is the red velvet? Shopee is a bit cheaper'), ['comparing', 'normal']);
  assert.deepEqual(tag('ok let me think about it first'), ['considering', 'normal']);
  assert.deepEqual(tag('please reply'), ['inquiry', 'normal']);
});
test('keyword tagger: no, status', () => {
  assert.equal(tag('never mind, thank you')[0], 'not_interested');
  assert.equal(tag('when will my order arrive?')[0], 'ordered');
  assert.equal(tag('do you know the price?')[1], 'normal', '"know" is not "now"');
});
test('keyword tagger still understands Malay and Chinese', () => {
  assert.deepEqual(tag('nak 2 kek coklat utk sabtu, urgent ya'), ['ordering', 'urgent']);
  assert.equal(tag('berapa harga red velvet? shopee lagi murah sikit')[0], 'comparing');
  assert.equal(tag('tak jadi la, terima kasih')[0], 'not_interested');
  assert.equal(tag('我要两个芝士蛋糕')[0], 'ordering');
  assert.equal(tag('今天要，急')[1], 'urgent');
});
test('a price question that names a product is an inquiry, not an order', () => {
  assert.equal(tag('how much is the chocolate cake?')[0], 'inquiry');
});
test('suggested replies are in English and quote catalog prices', () => {
  const en = templateReply({ intent: 'inquiry', products: ['KEK-RV'], customerName: 'Kevin', catalog });
  assert.match(en, /RM75/);
  const fromChinese = templateReply({ intent: 'inquiry', products: ['CHEESECAKE'], customerName: 'Mei Ling', catalog });
  assert.match(fromChinese, /RM80/);
  assert.doesNotMatch(fromChinese, /[一-鿿]/);
});
test('classify falls back to keywords when no model is set', async () => {
  const r = await classify({ text: 'Shopee is cheaper', recent: [], customerName: 'Kevin', catalog, business });
  assert.equal(r.intent, 'comparing');
  assert.equal(r.engine, 'keywords');
  assert.ok(r.reply.length > 10);
});
test('follow-up drafts: first is specific, second is soft', async () => {
  const a = await draftFollowUp({ intent: 'comparing', customerName: 'Kevin', lastCustomerText: 'Shopee is cheaper', attempt: 1, catalog, business });
  const b = await draftFollowUp({ intent: 'comparing', customerName: 'Kevin', lastCustomerText: 'Shopee is cheaper', attempt: 2, catalog, business });
  assert.match(a.message, /reserve/);
  assert.notEqual(a.message, b.message);
});
