// The WhatsApp inbox: one "ticket" (conversation) per customer.
//   - who to answer first (queue)
//   - tags (intent, urgency, customer value, order stage)
//   - follow-ups for quiet customers, only inside WhatsApp's 24-hour window,
//     max 2 per customer, and only after the owner taps "Send".
import { getDb, nextId, save, round2 } from '../store.js';
import { nowIso, nowMs, minutesBetween, hhmm } from '../clock.js';
import { orbyte } from '../orbyte/index.js';
import { send } from '../whatsapp/client.js';
import { draftFollowUp, INTENT_LABEL, INTENTS, URGENCY } from '../ai/tagger.js';

const { crm, people, audit, catalog } = orbyte;
export const VALUES = ['new', 'repeat', 'vip'];
export const STAGES = [null, 'awaiting_confirm', 'pending_approval', 'to_ship', 'delivered', 'paid'];
const FOLLOW_INTENTS = ['inquiry', 'comparing', 'considering'];
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const settings = () => getDb().settings;

// ------------------------------------------------------------------ tickets
export function findConversation(id) {
  return getDb().conversations.find((c) => c.id === id) || null;
}
export function conversationForPhone(phone) {
  return getDb().conversations.find((c) => c.phone === String(phone)) || null;
}

export function ensureConversation(phone, channel, customer, profileName) {
  const db = getDb();
  let c = conversationForPhone(phone);
  if (!c) {
    c = {
      id: nextId('conversation', 'T', 4),
      phone: String(phone),
      customerId: customer?.id || null,
      name: customer?.name || profileName || `+${phone}`,
      channel,
      status: 'answered', // 'waiting' = customer is waiting for us
      waitingFor: null, // 'reply' | 'approval'
      firstUnansweredAt: null,
      lastCustomerAt: null,
      lastBusinessAt: null,
      unanswered: 0,
      lastText: '',
      recent: [],
      tags: { intent: 'inquiry', urgency: 'normal', value: valueTag(customer), orderStage: null },
      tagEngine: null,
      summary: '',
      suggestedReply: '',
      replyTimesMin: [],
      followUp: { status: 'none', count: 0, dueAt: null, draft: null, lastSentAt: null, replied: false, history: [] },
      createdAt: nowIso(),
    };
    db.conversations.push(c);
  }
  c.channel = channel || c.channel;
  if (customer) { c.customerId = customer.id; c.name = customer.name; c.tags.value = valueTag(customer); }
  save();
  return c;
}

export function valueTag(customer) {
  if (!customer || customer.isLead) return 'new';
  const db = getDb();
  const v = db.settings.value;
  const done = db.orders.filter((o) => o.customerId === customer.id && ['invoiced', 'paid'].includes(o.status));
  const spend = done.reduce((s, o) => s + o.total, 0);
  if (spend >= v.vipSpend) return 'vip';
  if (done.length >= v.repeatOrders) return 'repeat';
  return 'new';
}

/** Every customer message goes through here (text, voice, photo, button tap). */
export function recordCustomerMessage(c, { text, type }) {
  const t = nowIso();
  if (c.status !== 'waiting') {
    c.status = 'waiting';
    c.waitingFor = 'reply';
    c.firstUnansweredAt = t; // spam does NOT move this: the clock starts at the FIRST unanswered message
    c.unanswered = 0;
  }
  c.unanswered += 1;
  c.lastCustomerAt = t;
  if (type !== 'button') {
    c.lastText = cut(text, 300);
    c.recent = [...c.recent, cut(text, 300)].slice(-10);
  }
  const fu = c.followUp;
  if (['scheduled', 'awaiting_approval'].includes(fu.status)) {
    fu.status = 'cancelled';
    audit.log({ actor: c.name, actorType: 'customer', action: 'followup.cancelled', detail: 'Customer wrote first — follow-up not needed', data: { conversation: c.id } });
  }
  if (fu.lastSentAt && !fu.replied && hoursSince(fu.lastSentAt) <= settings().followUp.convertWithinHours) {
    fu.replied = true;
    audit.log({ actor: c.name, actorType: 'customer', action: 'followup.replied', detail: `Replied ${minutesBetween(fu.lastSentAt)} min after our follow-up`, data: { conversation: c.id } });
  }
  save();
}

export function applyTags(c, r) {
  const before = { intent: c.tags.intent, urgency: c.tags.urgency };
  c.tags.intent = r.intent;
  c.tags.urgency = r.urgency;
  c.summary = r.summary || c.summary;
  c.suggestedReply = r.reply || c.suggestedReply;
  c.tagEngine = r.engine;
  c.products = r.products || [];
  audit.log({
    actor: r.engine === 'keywords' ? 'Keyword tagger' : `AI (${r.engine})`, actorType: 'ai', action: 'inbox.tagged',
    detail: `${c.name}: ${INTENT_LABEL[r.intent]} · ${r.urgency}${r.error ? ` — model error, used keywords: ${r.error}` : ''}`,
    before, after: { intent: r.intent, urgency: r.urgency }, data: { conversation: c.id },
  });
  if (r.intent === 'not_interested') stopFollowUps(c, 'Customer said no');
  save();
}

/** We (bot or human) answered: the customer is no longer waiting. */
export function markAnswered(c, { by = 'OrderLah', human = false, follow = true } = {}) {
  if (!c) return;
  const t = nowIso();
  if (c.status === 'waiting' && c.firstUnansweredAt && human) c.replyTimesMin.push(minutesBetween(c.firstUnansweredAt));
  c.status = 'answered';
  c.waitingFor = null;
  c.firstUnansweredAt = null;
  c.unanswered = 0;
  c.lastBusinessAt = t;
  c.lastAnsweredBy = by;
  if (follow) scheduleFollowUp(c);
  save();
}

/** Customer is now waiting for the owner to approve their order. */
export function markWaitingApproval(c) {
  if (!c) return;
  if (c.status !== 'waiting') { c.status = 'waiting'; c.firstUnansweredAt = nowIso(); }
  c.waitingFor = 'approval';
  save();
}

export function setOrderStage(c, stage) {
  if (!c) return;
  c.tags.orderStage = stage;
  if (['to_ship', 'delivered', 'paid'].includes(stage)) c.tags.intent = 'ordered';
  const cust = c.customerId ? crm.getCustomer(c.customerId) : null;
  c.tags.value = valueTag(cust);
  save();
}

// ------------------------------------------------------------------ queue
const hoursSince = (iso) => (nowMs() - Date.parse(iso)) / 3600e3;

export function priority(c) {
  const q = settings().queue;
  const wait = c.firstUnansweredAt ? minutesBetween(c.firstUnansweredAt) : 0;
  let score = wait;
  if (c.tags.urgency === 'urgent') score += q.urgentBonus;
  if (c.tags.intent === 'ordering' || c.waitingFor === 'approval') score += q.orderingBonus;
  if (c.tags.value === 'vip') score += q.vipBonus;
  else if (c.tags.value === 'repeat') score += q.repeatBonus;
  return { wait, score };
}

export function queue() {
  const convs = getDb().conversations;
  const waiting = convs
    .filter((c) => c.status === 'waiting')
    .map((c) => ({ ...c, ...priority(c) }))
    .sort((a, b) => b.score - a.score || Date.parse(a.firstUnansweredAt) - Date.parse(b.firstUnansweredAt));
  const followUps = convs
    .filter((c) => c.status !== 'waiting' && ['scheduled', 'awaiting_approval'].includes(c.followUp.status))
    .sort((a, b) => (a.followUp.status === 'awaiting_approval' ? -1 : 0) - (b.followUp.status === 'awaiting_approval' ? -1 : 0) || Date.parse(a.followUp.dueAt) - Date.parse(b.followUp.dueAt));
  const others = convs.filter((c) => !waiting.find((w) => w.id === c.id) && !followUps.includes(c))
    .sort((a, b) => Date.parse(b.lastCustomerAt || b.createdAt) - Date.parse(a.lastCustomerAt || a.createdAt));
  return { waiting, followUps, others };
}

// ------------------------------------------------------------------ follow-ups
export function scheduleFollowUp(c) {
  const st = settings().followUp;
  const fu = c.followUp;
  if (!st.enabled || fu.status === 'stopped') return;
  if (!FOLLOW_INTENTS.includes(c.tags.intent) || !c.lastCustomerAt) {
    if (fu.status === 'scheduled') fu.status = 'none';
    return;
  }
  if (fu.count >= st.maxPerCustomer) { fu.status = 'done'; return; }
  const base = Date.parse(c.lastBusinessAt || nowIso());
  let due = base + st.delayHours[c.tags.intent] * 3600e3;
  const deadline = Date.parse(c.lastCustomerAt) + st.windowHours * 3600e3 - st.safetyMinutes * 60e3;
  if (due > deadline) {
    if (fu.count === 0 && deadline - base >= 60 * 60e3) due = deadline;
    else {
      fu.status = 'done';
      audit.log({ actor: 'Follow-up rules', actorType: 'system', action: 'followup.skipped', detail: `${c.name}: no time left inside the 24-hour window`, data: { conversation: c.id } });
      return;
    }
  }
  fu.status = 'scheduled';
  fu.dueAt = new Date(due).toISOString();
  audit.log({
    actor: 'Follow-up rules', actorType: 'system', action: 'followup.scheduled',
    detail: `${c.name} (${INTENT_LABEL[c.tags.intent]}): follow-up ${fu.count + 1}/${st.maxPerCustomer} at ${hhmm(fu.dueAt)}, inside 24h window`,
    data: { conversation: c.id, dueAt: fu.dueAt },
  });
}

export function stopFollowUps(c, reason, actor = 'OrderLah') {
  if (c.followUp.status === 'stopped') return;
  c.followUp.status = 'stopped';
  audit.log({ actor, actorType: actor === 'OrderLah' ? 'system' : 'staff', action: 'followup.stopped', detail: `${c.name}: ${reason}`, data: { conversation: c.id } });
  save();
}

const followUpCard = (c, draft) => [
  `🔔 Follow-up: ${c.name} (${INTENT_LABEL[c.tags.intent]})`,
  `Last message ${hhmm(c.lastCustomerAt)}: "${cut(c.lastText, 120)}"`,
  '',
  'Draft:',
  `"${draft}"`,
  '',
  `AI draft · only sent when you tap Send · ${c.followUp.count + 1}/${settings().followUp.maxPerCustomer}`,
].join('\n');

/** The job: drafts due follow-ups and asks the approver on WhatsApp. Runs every minute. */
export async function runFollowUps() {
  const db = getDb();
  const st = db.settings.followUp;
  const out = [];
  for (const c of db.conversations) {
    const fu = c.followUp;
    if (fu.status !== 'scheduled' || Date.parse(fu.dueAt) > nowMs()) continue;
    if (hoursSince(c.lastCustomerAt) >= st.windowHours) {
      fu.status = 'expired';
      audit.log({ actor: 'Follow-up rules', actorType: 'system', action: 'followup.expired', detail: `${c.name}: 24-hour window closed`, data: { conversation: c.id } });
      continue;
    }
    const d = await draftFollowUp({
      intent: c.tags.intent, customerName: c.name, lastCustomerText: c.lastText, products: c.products || [],
      attempt: fu.count + 1, catalog: catalog.list(), business: db.business,
    });
    fu.draft = d.message;
    fu.status = 'awaiting_approval';
    fu.draftedAt = nowIso();
    const { approver, reason } = people.getApprover();
    audit.log({ actor: d.engine === 'template' ? 'Template' : `AI (${d.engine})`, actorType: 'ai', action: 'followup.drafted', detail: `${c.name}: "${cut(d.message, 120)}" → sent to ${approver.name} for approval${reason ? ` (${reason})` : ''}`, data: { conversation: c.id } });
    await send(approver.phone, {
      type: 'buttons',
      text: followUpCard(c, d.message),
      buttons: [
        { id: `fu_send:${c.id}`, title: '✅ Send' },
        { id: `fu_edit:${c.id}`, title: '✏️ Edit' },
        { id: `fu_stop:${c.id}`, title: "🚫 Don't follow up" },
      ],
    }, c.channel);
    out.push({ conversation: c.id, name: c.name, draft: d.message });
  }
  save();
  return out;
}

/** Owner approved (optionally with their own text). */
export async function sendFollowUp(c, { by, text, edited = false }) {
  const fu = c.followUp;
  if (!['awaiting_approval', 'scheduled'].includes(fu.status)) return { ok: false, reason: `follow-up is ${fu.status}` };
  if (hoursSince(c.lastCustomerAt) >= settings().followUp.windowHours) {
    fu.status = 'expired';
    save();
    return { ok: false, reason: '24-hour window closed' };
  }
  const message = (text || fu.draft || '').trim();
  if (!message) return { ok: false, reason: 'empty message' };
  await send(c.phone, { type: 'text', text: message }, c.channel);
  fu.count += 1;
  fu.lastSentAt = nowIso();
  fu.replied = false;
  fu.history.push({ at: fu.lastSentAt, text: message, by, edited });
  fu.status = 'sent';
  audit.log({ actor: by, actorType: 'staff', action: 'followup.sent', detail: `${c.name} (${fu.count}/${settings().followUp.maxPerCustomer})${edited ? ' — edited by owner' : ' — AI draft approved'}: "${cut(message, 120)}"`, before: edited ? { draft: fu.draft } : undefined, after: edited ? { sent: message } : undefined, data: { conversation: c.id } });
  c.lastBusinessAt = fu.lastSentAt;
  scheduleFollowUp(c);
  save();
  return { ok: true };
}

/** Owner replies from the Orbyte inbox (often the AI suggestion, maybe edited). */
export async function replyFromInbox(c, { text, by, usedSuggestion }) {
  const message = String(text || '').trim();
  if (!message) return { ok: false, reason: 'empty message' };
  await send(c.phone, { type: 'text', text: message }, c.channel);
  const edited = usedSuggestion && message !== c.suggestedReply;
  audit.log({ actor: by, actorType: 'staff', action: 'inbox.replied', detail: `${c.name}: ${usedSuggestion ? (edited ? 'AI suggestion, edited' : 'AI suggestion') : 'typed reply'} — "${cut(message, 120)}"`, data: { conversation: c.id } });
  markAnswered(c, { by, human: true });
  return { ok: true };
}

export function editTag(c, group, value, by) {
  const allowed = { intent: INTENTS, urgency: URGENCY, value: VALUES };
  if (!allowed[group] || !allowed[group].includes(value)) return { ok: false, reason: 'bad tag' };
  const before = c.tags[group];
  if (before === value) return { ok: true };
  c.tags[group] = value;
  c.tagEditedBy = by;
  audit.log({ actor: by, actorType: 'staff', action: 'inbox.tag_edited', detail: `${c.name}: ${group} ${before} → ${value} (kept as training example)`, before: { [group]: before }, after: { [group]: value }, data: { conversation: c.id, lastText: c.lastText } });
  if (group === 'intent') {
    if (value === 'not_interested') stopFollowUps(c, 'Owner marked not interested', by);
    else if (c.status !== 'waiting') scheduleFollowUp(c);
  }
  save();
  return { ok: true };
}

/** Called when an order is created: was it won back by a follow-up? */
export function noteOrderCreated(c, order) {
  const fu = c?.followUp;
  if (!fu?.lastSentAt || hoursSince(fu.lastSentAt) > settings().followUp.convertWithinHours) return;
  order.fromFollowUp = { conversation: c.id, followUps: fu.count };
  fu.converted = true;
  audit.log({ orderId: order.id, actor: 'OrderLah', actorType: 'system', action: 'followup.converted', detail: `${c.name} ordered after ${fu.count} follow-up(s)`, data: { conversation: c.id } });
  save();
}

// ------------------------------------------------------------------ numbers for the dashboard
export function inboxStats() {
  const db = getDb();
  const convs = db.conversations;
  const waiting = convs.filter((c) => c.status === 'waiting');
  const waits = waiting.map((c) => minutesBetween(c.firstUnansweredAt));
  const replyTimes = convs.flatMap((c) => c.replyTimesMin);
  const followUpsSent = convs.reduce((s, c) => s + c.followUp.history.length, 0);
  const won = db.orders.filter((o) => o.fromFollowUp && ['invoiced', 'paid'].includes(o.status));
  return {
    waitingNow: waiting.length,
    longestWaitMin: waits.length ? Math.max(...waits) : 0,
    avgReplyMin: replyTimes.length ? Math.round(replyTimes.reduce((a, b) => a + b, 0) / replyTimes.length) : null,
    followUpsSent,
    followUpReplies: convs.filter((c) => c.followUp.replied).length,
    wonOrders: won.length,
    wonRM: round2(won.reduce((s, o) => s + o.total, 0)),
    tagged: convs.length,
    tagsEditedByHuman: db.audit.filter((a) => a.action === 'inbox.tag_edited').length,
  };
}
