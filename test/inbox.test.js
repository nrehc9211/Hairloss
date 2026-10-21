import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initStore, getDb } from '../src/store.js';
import { handleIncoming } from '../src/flows/orderFlow.js';
import * as inbox from '../src/inbox/index.js';
import { advanceHours, setOffsetMs } from '../src/clock.js';
import { runScenario } from '../src/server.js';

const LINA = '60110000001';
const KEVIN = '60120000014';
const FARAH = '60120000015';
const say = (from, text, name) => handleIncoming({ from, type: 'text', text, name }, 'sim');
const tap = (from, buttonId) => handleIncoming({ from, type: 'button', buttonId }, 'sim');
const lastTo = (phone) => getDb().messages.filter((m) => m.direction === 'out' && m.to === phone).at(-1);

test.beforeEach(() => { setOffsetMs(0); initStore({ fresh: true, persist: false }); });
test.after(() => setOffsetMs(0));

test('queue: urgent order first, spammer does not jump the line', async () => {
  await runScenario();
  const q = inbox.queue().waiting.map((c) => c.name);
  assert.deepEqual(q, ['Aina', 'Mei Ling', 'Kevin', 'Ali']);
  const ali = inbox.conversationForPhone('60120000013');
  assert.equal(ali.unanswered, 5);
  assert.equal(inbox.priority(ali).wait, 9, 'wait counts from the FIRST unanswered message');
});

test('tags + suggested reply; owner reply clears the ticket and schedules a follow-up', async () => {
  await say(KEVIN, 'How much is the red velvet? Shopee is a bit cheaper', 'Kevin');
  const c = inbox.conversationForPhone(KEVIN);
  assert.equal(c.tags.intent, 'comparing');
  assert.match(c.suggestedReply, /reserve/);
  await inbox.replyFromInbox(c, { text: c.suggestedReply, by: 'Kak Lina', usedSuggestion: true });
  assert.equal(c.status, 'answered');
  assert.equal(c.followUp.status, 'scheduled');
});

test('follow-up: drafted after the delay, owner approves on WhatsApp, customer orders -> won back', async () => {
  await say(KEVIN, 'Shopee is a bit cheaper', 'Kevin');
  const c = inbox.conversationForPhone(KEVIN);
  await inbox.replyFromInbox(c, { text: 'Our cakes are fresh today 😊', by: 'Kak Lina', usedSuggestion: false });
  assert.equal((await inbox.runFollowUps()).length, 0, 'not due yet');
  advanceHours(3);
  const drafted = await inbox.runFollowUps();
  assert.equal(drafted.length, 1);
  assert.equal(c.followUp.status, 'awaiting_approval');
  const card = lastTo(LINA);
  assert.match(card.text, /Follow-up: Kevin/);
  assert.equal(getDb().messages.filter((m) => m.direction === 'out' && m.to === KEVIN).length, 1, 'nothing sent to Kevin before approval');

  await tap(LINA, `fu_send:${c.id}`);
  assert.equal(c.followUp.count, 1);
  assert.equal(lastTo(KEVIN).text, c.followUp.history[0].text);

  await say(KEVIN, 'ok I will take one red velvet tomorrow', 'Kevin');
  assert.equal(c.followUp.replied, true);
  const order = getDb().orders.at(-1);
  assert.ok(order.fromFollowUp);
  await tap(KEVIN, `confirm:${order.id}`);
  await tap(LINA, `approve:${order.id}`);
  const s = inbox.inboxStats();
  assert.equal(s.wonOrders, 1);
  assert.equal(s.wonRM, 75);
});

test('follow-up rules: owner can edit, max 2, never outside 24 hours', async () => {
  await say(FARAH, 'ok let me think about it first', 'Farah');
  const c = inbox.conversationForPhone(FARAH);
  await inbox.replyFromInbox(c, { text: 'No problem 😊', by: 'Kak Lina' });
  advanceHours(20);
  await inbox.runFollowUps();
  await tap(LINA, `fu_edit:${c.id}`);
  await say(LINA, 'Hi Farah! Saturday slot is still open 😊');
  assert.equal(lastTo(FARAH).text, 'Hi Farah! Saturday slot is still open 😊');
  assert.ok(getDb().audit.some((a) => a.action === 'followup.sent' && /edited/.test(a.detail)));
  // only ~3 hours left in the 24h window and 20h delay -> no second follow-up
  assert.equal(c.followUp.status, 'done');
});

test('customer writes first -> scheduled follow-up cancelled; "never mind" stops follow-ups', async () => {
  await say(KEVIN, 'got red velvet?', 'Kevin');
  const c = inbox.conversationForPhone(KEVIN);
  await inbox.replyFromInbox(c, { text: 'Yes, RM75 😊', by: 'Kak Lina' });
  assert.equal(c.followUp.status, 'scheduled');
  await say(KEVIN, 'never mind, thank you', 'Kevin');
  assert.equal(c.followUp.status, 'stopped');
  await inbox.replyFromInbox(c, { text: 'Alright 🙏', by: 'Kak Lina' });
  assert.equal(c.followUp.status, 'stopped');
});

test('window closes -> expired, nothing sent', async () => {
  await say(KEVIN, 'got cupcakes?', 'Kevin');
  const c = inbox.conversationForPhone(KEVIN);
  await inbox.replyFromInbox(c, { text: 'Yes 😊', by: 'Kak Lina' });
  advanceHours(30);
  await inbox.runFollowUps();
  assert.equal(c.followUp.status, 'expired');
});

test('owner fixes a tag -> logged as a training example', async () => {
  await say(KEVIN, 'hmm', 'Kevin');
  const c = inbox.conversationForPhone(KEVIN);
  inbox.editTag(c, 'intent', 'considering', 'Kak Lina');
  assert.equal(c.tags.intent, 'considering');
  assert.ok(getDb().audit.some((a) => a.action === 'inbox.tag_edited'));
});
