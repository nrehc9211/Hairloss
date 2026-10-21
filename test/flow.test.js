import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initStore, getDb } from '../src/store.js';
import { handleIncoming, recordPayment, runReminders } from '../src/flows/orderFlow.js';
import { conversationForPhone } from '../src/inbox/index.js';

const AH_SENG = '60120000001';
const KAFE = '60120000002';
const AINA = '60120000011';
const LINA = '60110000001';
const FAIZAL = '60110000002';
const RAVI = '60110000003';

const outTo = (phone) => getDb().messages.filter((m) => m.direction === 'out' && m.to === phone);
const lastTo = (phone) => outTo(phone).at(-1);
const btn = (msg, prefix) => msg.buttons.find((b) => b.id.startsWith(prefix));
const actions = (orderId) => getDb().audit.filter((a) => a.orderId === orderId).map((a) => a.action);
const say = (from, text, name) => handleIncoming({ from, type: 'text', text, name }, 'sim');
const tap = (from, buttonId) => handleIncoming({ from, type: 'button', buttonId }, 'sim');

test.beforeEach(() => { initStore({ fresh: true, persist: false }); });

test('order lane: message -> customer confirms -> owner edits + approves -> invoice -> delivered -> paid', async () => {
  await say(AH_SENG, 'boss tomorrow I want 12 chocolate cakes and 2 cheesecakes');
  const order = getDb().orders.at(-1);
  assert.equal(order.status, 'awaiting_confirm');
  const summary = lastTo(AH_SENG);
  assert.equal(summary.type, 'buttons');
  await tap(AH_SENG, btn(summary, 'confirm:').id);
  assert.equal(order.status, 'pending_approval');
  assert.equal(conversationForPhone(AH_SENG).waitingFor, 'approval');

  const card = lastTo(LINA);
  assert.match(card.text, /Unusual qty/);
  await tap(LINA, btn(card, 'edit:').id);
  await say(LINA, 'chocolate cake 3');
  assert.equal(order.lines.find((l) => l.sku === 'KEK-COKLAT').qty, 3);
  await tap(LINA, btn(lastTo(LINA), 'approve:').id);

  assert.equal(order.status, 'invoiced');
  const inv = getDb().invoices.find((i) => i.id === order.invoiceId);
  assert.equal(fs.readFileSync(inv.pdfFile).subarray(0, 4).toString(), '%PDF');
  assert.ok(outTo(AH_SENG).some((m) => m.type === 'document'));
  assert.ok(outTo(AH_SENG).some((m) => m.text?.includes('/pay/')));
  assert.equal(conversationForPhone(AH_SENG).status, 'answered');
  assert.equal(conversationForPhone(AH_SENG).tags.orderStage, 'to_ship');

  await tap(RAVI, `delivered:${order.id}`);
  await recordPayment(inv.id);
  assert.equal(order.status, 'paid');
  const a = actions(order.id);
  for (const step of ['order.received', 'ai.extracted', 'rules.evaluated', 'customer.confirm_asked', 'customer.confirmed', 'approval.requested', 'order.edited', 'approval.approved', 'invoice.issued', 'order.delivered', 'payment.received']) {
    assert.ok(a.includes(step), `audit has ${step}`);
  }
});

test('customer taps Change -> summary cancelled, they can resend', async () => {
  await say(AINA, 'I want 2 chocolate cakes for Saturday', 'Aina');
  const order = getDb().orders.at(-1);
  await tap(AINA, `change:${order.id}`);
  assert.equal(order.status, 'cancelled');
  assert.match(lastTo(AINA).text, /type your order again/);
});

test('unknown item -> customer picks -> continues', async () => {
  await say(AH_SENG, 'I want 2 chocolate cakes and 3 more barrels');
  const order = getDb().orders.at(-1);
  assert.equal(order.status, 'awaiting_customer');
  const q = lastTo(AH_SENG);
  await tap(AH_SENG, q.buttons.find((b) => b.id.startsWith('pick:')).id);
  assert.equal(order.status, 'awaiting_confirm');
  assert.ok(actions(order.id).includes('customer.clarified'));
});

test('owner on leave -> approval goes to the supervisor', async () => {
  const db = getDb();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
  db.leave.push({ staffId: 'u1', from: today, to: today, status: 'approved' });
  await say(AH_SENG, 'I want 2 chocolate cakes tomorrow');
  await tap(AH_SENG, `confirm:${db.orders.at(-1).id}`);
  assert.equal(db.orders.at(-1).approverId, 'u2');
  assert.match(lastTo(FAIZAL).text, /leave/);
});

test('auto-approve when the owner switched it on (after customer confirms)', async () => {
  getDb().settings.autoApprove = { enabled: true, maxTotal: 300, trustedOnly: true };
  await say(AH_SENG, 'I want 2 chocolate cakes tomorrow');
  const order = getDb().orders.at(-1);
  await tap(AH_SENG, `confirm:${order.id}`);
  assert.equal(order.status, 'invoiced');
  assert.ok(actions(order.id).includes('approval.auto'));
});

test('overdue customer is flagged and gets one reminder', async () => {
  await say(KAFE, 'I want 2 brownies tomorrow');
  assert.ok(getDb().orders.at(-1).flags.some((f) => f.code === 'OVERDUE'));
  const sent = await runReminders();
  assert.ok(sent.some((s) => s.customer === 'Kafe Bunga'));
  assert.equal((await runReminders()).length, 0);
});

test('no payment reminder on the same day the invoice was sent', async () => {
  await say(AINA, 'I want 1 pandan cake tomorrow', 'Aina');
  await tap(AINA, `confirm:${getDb().orders.at(-1).id}`);
  await tap(LINA, `approve:${getDb().orders.at(-1).id}`);
  const sent = await runReminders();
  assert.ok(!sent.some((s) => s.customer === 'Aina'));
});

test('new number -> lead; reject notifies the customer', async () => {
  await say('60129999999', 'I want 1 pandan cake tomorrow', 'Warung Mak Teh');
  const order = getDb().orders.at(-1);
  assert.ok(order.flags.some((f) => f.code === 'NEW_CUSTOMER'));
  await tap('60129999999', `confirm:${order.id}`);
  await tap(LINA, `reject:${order.id}`);
  assert.equal(order.status, 'rejected');
  assert.match(lastTo('60129999999').text, /can't process/);
});

test('voice note, order status question, handoff to a human', async () => {
  await handleIncoming({ from: AH_SENG, type: 'audio', transcript: 'tomorrow I want three chocolate cakes and two cheesecakes' }, 'sim');
  assert.equal(getDb().orders.at(-1).lines.length, 2);
  await say(AH_SENG, 'when will my order arrive?');
  assert.match(lastTo(AH_SENG).text, /ORD-/);
  await say(AH_SENG, 'can I talk to the boss');
  assert.match(lastTo(LINA).text, /wants to talk/);
  await say(AH_SENG, 'I need to change my address');
  assert.match(lastTo(LINA).text, /change my address/);
});

test('customers can still write in Malay or Chinese; replies are in English', async () => {
  await say(AINA, 'nak 2 kek coklat utk sabtu', 'Aina');
  assert.equal(getDb().orders.at(-1).lines[0].sku, 'KEK-COKLAT');
  assert.match(lastTo(AINA).text, /is this correct/);
  await say('60120000012', '我要两个芝士蛋糕', 'Mei Ling');
  assert.equal(getDb().orders.at(-1).lines[0].qty, 2);
});
