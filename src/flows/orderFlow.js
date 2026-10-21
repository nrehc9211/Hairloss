// The automated journey:
//   trigger (WhatsApp message) -> data (AI tags it + reads any order) -> logic (rules + queue)
//   -> approval (owner taps a button, logged) -> outcome (reply / order / invoice / follow-up)
// Two lanes after tagging:
//   ordering  -> extract order -> customer confirms -> owner approves -> invoice + packing list
//   everything else -> waits in the Orbyte inbox with an AI-suggested reply; quiet customers
//                      get a follow-up draft that the owner must approve (max 2, inside 24h)
import { getDb, nextId, save, round2 } from '../store.js';
import { nowIso, nowMs, todayIso, prettyDate, diffDays } from '../clock.js';
import { orbyte } from '../orbyte/index.js';
import { send, downloadMedia } from '../whatsapp/client.js';
import { extractOrder, transcribe, imageToText } from '../ai/index.js';
import { classify } from '../ai/tagger.js';
import { parseOrderText } from '../ai/parser.js';
import { evaluateOrder, applyEdits } from '../rules/engine.js';
import { createInvoice } from '../invoice/index.js';
import * as inbox from '../inbox/index.js';
import { config } from '../config.js';

const { crm, catalog, people, audit, sales, connect } = orbyte;
const rm = (n) => `RM${Number(n).toFixed(2)}`;
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const ICON = { text: '💬', audio: '🎤', image: '📷', button: '🔘' };
const HANDOFF_RE = /(cakap dengan boss|nak cakap boss|^boss\??$|human|manusia|operator|(talk|speak) (to|with) (a |the )?(human|person|boss|owner)|找老板|真人)/i;
const SKIP_RE = /^(buang|skip|remove|tak payah|no|tidak|不要)$/i;

const STAFF_HELP =
  'OrderLah — how to use:\n• Tap a button on an order card: Approve / Edit / Reject\n• Tap a button on a follow-up card: Send / Edit / Don\'t follow up\n• Type "summary" for the last 7 days';

function sess(phone) {
  const db = getDb();
  db.sessions[phone] = db.sessions[phone] || {};
  return db.sessions[phone];
}
const customerLabel = (phone) => crm.findCustomerByPhone(phone)?.name || `+${phone}`;
const linesText = (lines) => lines.map((l) => `• ${l.qty} × ${l.name} @ ${rm(l.unitPrice)} = ${rm(l.amount)}`).join('\n');
const channelOf = (order) => (order.channel === 'seed' ? 'sim' : order.channel);
const convOf = (order) => {
  const c = crm.getCustomer(order.customerId);
  return c ? inbox.conversationForPhone(c.phone) : null;
};

async function media(msg) {
  if (msg.mediaBase64) return [Buffer.from(msg.mediaBase64, 'base64'), msg.mimeType];
  const m = await downloadMedia(msg.mediaId);
  return [m.buffer, m.mimeType];
}

// ---------------------------------------------------------------------------
// ENTRY POINT — every inbound message (real WhatsApp or simulator) comes here
// ---------------------------------------------------------------------------
export async function handleIncoming(msg, channel = 'sim') {
  const db = getDb();
  db.messages.push({
    id: nextId('message', 'M', 6), ts: nowIso(), direction: 'in', from: String(msg.from), channel,
    type: msg.type, text: msg.text || msg.caption || msg.transcript || '', buttonId: msg.buttonId || null,
    hasMedia: Boolean(msg.mediaId || msg.mediaBase64),
  });
  save();
  const staff = people.findStaffByPhone(msg.from);
  if (staff) return handleStaff(staff, msg, channel);
  return handleCustomer(msg, channel);
}

// ---------------------------------------------------------------------------
// CUSTOMER SIDE
// ---------------------------------------------------------------------------
async function handleCustomer(msg, channel) {
  const from = String(msg.from);
  const session = sess(from);
  const known = crm.findCustomerByPhone(from);
  const conv = inbox.ensureConversation(from, channel, known, msg.name);

  if (msg.type === 'button') {
    inbox.recordCustomerMessage(conv, { text: msg.text || '[button]', type: 'button' });
    const [kind, orderId, idx, sku] = String(msg.buttonId || '').split(':');
    if (kind === 'confirm') return customerConfirmed(orderId, conv);
    if (kind === 'change') return customerWantsChange(orderId, conv);
    if (kind === 'pick') return resolvePick(orderId, Number(idx), sku, from);
    if (kind === 'skip') return resolvePick(orderId, Number(idx), null, from);
    if (kind === 'handoff') return handoff(from, channel, msg.text);
    return { handled: 'unknown_button' };
  }
  const typed = (msg.text || '').trim();
  if (msg.type === 'text' && HANDOFF_RE.test(typed)) {
    inbox.recordCustomerMessage(conv, { text: typed, type: 'text' });
    return handoff(from, channel, typed);
  }
  if (msg.type === 'text' && session.awaitingClarify && SKIP_RE.test(typed)) {
    inbox.recordCustomerMessage(conv, { text: typed, type: 'text' });
    return resolvePick(session.awaitingClarify.orderId, session.awaitingClarify.index, null, from);
  }

  // 1. TRIGGER -> text
  let text = typed;
  try {
    if (msg.type === 'audio') text = msg.transcript ?? (await transcribe(...(await media(msg))));
    if (msg.type === 'image') {
      let ocr = msg.ocrText ?? '';
      if (!ocr && (msg.mediaId || msg.mediaBase64)) {
        try { ocr = await imageToText(...(await media(msg))); } catch (e) { if (!msg.caption) throw e; }
      }
      text = [msg.caption, ocr].filter(Boolean).join('\n');
    }
  } catch (err) {
    inbox.recordCustomerMessage(conv, { text: `(${msg.type})`, type: msg.type });
    await send(from, {
      type: 'buttons',
      text: `Sorry, we couldn't read this ${msg.type === 'audio' ? 'voice note' : 'photo'} 🙏\nCould you type it? Example: "2 chocolate cakes, deliver tomorrow".`,
      buttons: [{ id: 'handoff', title: 'Talk to the owner' }],
    }, channel);
    return { handled: 'media_error', error: err.message };
  }

  inbox.recordCustomerMessage(conv, { text, type: msg.type });

  // Human mode: the owner asked to talk; the bot only logs and forwards.
  if (session.humanUntil && Date.parse(session.humanUntil) > nowMs()) {
    const { approver } = people.getApprover();
    await send(approver.phone, { type: 'text', text: `💬 ${conv.name}: "${cut(text || '(media)', 300)}"` }, channel);
    return { handled: 'forwarded_to_human' };
  }

  // 2. DATA -> every chat gets tags (intent, urgency) + a suggested reply
  const customer = known || crm.createLead(from, msg.name);
  if (!known) inbox.ensureConversation(from, channel, customer);
  const tags = await classify({ text, recent: conv.recent.slice(0, -1), customerName: customer.name, catalog: catalog.list(), business: getDb().business });
  inbox.applyTags(conv, tags);

  if (tags.intent === 'ordered') return answerOrderStatus(conv, customer);
  if (tags.intent !== 'ordering') return { handled: 'queued_for_reply', conversation: conv.id, intent: tags.intent };

  // 3. ORDER LANE
  const extraction = await extractOrder({ text, catalog: catalog.list(), todayIso: todayIso() });
  if (!extraction.items.length) return { handled: 'queued_for_reply', conversation: conv.id, intent: tags.intent };

  const db = getDb();
  const order = {
    id: nextId('order', 'ORD-'), customerId: customer.id, channel, status: 'received', createdAt: nowIso(),
    source: { type: msg.type, text }, extraction, lines: [], unknown: [], total: 0, flags: [], approverId: null,
    urgent: tags.urgency === 'urgent',
  };
  db.orders.push(order);
  audit.log({ orderId: order.id, actor: customer.name, actorType: 'customer', action: 'order.received', detail: `${ICON[msg.type] || ''} "${cut(text, 160)}"` });
  audit.log({
    orderId: order.id, actorType: 'ai', action: 'ai.extracted',
    actor: extraction.engine === 'rules' ? 'Rule parser' : `AI (${extraction.engine})`,
    detail: extraction.items.map((i) => `${i.qty} × ${i.sku || '?'} (${Math.round(i.confidence * 100)}%)`).join(', ') + (extraction.error ? ` — AI error, used rule parser: ${extraction.error}` : ''),
    data: extraction,
  });
  inbox.noteOrderCreated(conv, order);
  return evaluateAndRoute(order);
}

async function answerOrderStatus(conv, customer) {
  const order = [...getDb().orders].reverse().find((o) => o.customerId === customer.id && o.channel !== 'seed' && !['rejected', 'cancelled'].includes(o.status));
  if (!order) return { handled: 'queued_for_reply', conversation: conv.id, intent: 'ordered' };
  const status = order.deliveredAt ? 'has been delivered ✅'
    : ['invoiced', 'paid'].includes(order.status) ? `is being prepared, delivery on ${prettyDate(order.deliveryDate)} 🎂`
      : 'is being checked by the owner 🙏';
  await send(customer.phone, { type: 'text', text: `Hi ${customer.name}! Order ${order.id} ${status}` }, conv.channel);
  audit.log({ orderId: order.id, actor: 'OrderLah bot', actorType: 'system', action: 'inbox.status_answered', detail: `Answered order status for ${customer.name}` });
  inbox.markAnswered(conv, { by: 'OrderLah bot', follow: false });
  return { handled: 'status_answered', order };
}

// LOGIC -> rules decide: clarify / needs approval / auto-approve
function reprice(order) {
  const customer = crm.getCustomer(order.customerId);
  const r = evaluateOrder({
    extraction: order.extraction, customer, catalog: catalog.list(),
    averages: sales.averages(customer.id), openInvoices: sales.openInvoices(customer.id),
    settings: getDb().settings, todayIso: todayIso(),
  });
  Object.assign(order, { lines: r.lines, unknown: r.unknown, total: r.total, deliveryDate: r.deliveryDate, flags: r.flags, decision: r.decision });
  audit.log({
    orderId: order.id, actor: 'Rules engine', actorType: 'system', action: 'rules.evaluated',
    detail: `${rm(r.total)} · ${r.flags.length ? r.flags.map((f) => f.code).join(', ') : 'no flags'} → ${r.decision}`,
    data: { flags: r.flags, decision: r.decision },
  });
  save();
  return customer;
}

async function evaluateAndRoute(order) {
  const customer = reprice(order);
  const conv = convOf(order);
  if (order.decision === 'clarify') return askCustomerToClarify(order, customer);

  if (getDb().settings.customerConfirm) {
    // Accuracy step: the customer checks the summary before anyone packs anything.
    order.status = 'awaiting_confirm';
    inbox.setOrderStage(conv, 'awaiting_confirm');
    audit.log({ orderId: order.id, actor: 'OrderLah bot', actorType: 'system', action: 'customer.confirm_asked', detail: 'Sent order summary for the customer to check' });
    await send(customer.phone, {
      type: 'buttons',
      text: `Order ${order.id} — is this correct? 🙏\n${linesText(order.lines)}\nTotal: ${rm(order.total)}\nDelivery: ${prettyDate(order.deliveryDate)}`,
      buttons: [{ id: `confirm:${order.id}`, title: '✅ Correct' }, { id: `change:${order.id}`, title: '✏️ Change' }],
    }, order.channel);
    inbox.markAnswered(conv, { by: 'OrderLah bot', follow: false });
    save();
    return { handled: 'confirm_asked', order };
  }
  await send(customer.phone, { type: 'text', text: `Thank you ${customer.name}! 🙏 Order ${order.id} received, the owner is checking it now.` }, order.channel);
  return proceedToApproval(order, customer);
}

async function proceedToApproval(order, customer) {
  const conv = convOf(order);
  if (order.decision === 'auto_approve') {
    const a = getDb().settings.autoApprove;
    audit.log({
      orderId: order.id, actor: 'Auto-approve rule', actorType: 'system', action: 'approval.auto',
      detail: `No flags, ${customer.trusted ? 'trusted customer, ' : ''}total ${rm(order.total)} ≤ ${rm(a.maxTotal)} — rule switched on by owner`,
    });
    return finalizeApproved(order, { name: 'Auto-approve rule' });
  }
  inbox.markWaitingApproval(conv);
  inbox.setOrderStage(conv, 'pending_approval');
  return requestApproval(order, customer);
}

async function customerConfirmed(orderId, conv) {
  const order = findOrder(orderId);
  if (!order || order.status !== 'awaiting_confirm') return { handled: 'stale_button' };
  const customer = crm.getCustomer(order.customerId);
  audit.log({ orderId, actor: customer.name, actorType: 'customer', action: 'customer.confirmed', detail: 'Customer confirmed the order summary' });
  await send(customer.phone, { type: 'text', text: 'Thank you! 🙏 The owner is checking it now, your invoice will follow shortly.' }, order.channel);
  return proceedToApproval(order, customer);
}

async function customerWantsChange(orderId, conv) {
  const order = findOrder(orderId);
  if (!order || order.status !== 'awaiting_confirm') return { handled: 'stale_button' };
  order.status = 'cancelled';
  const customer = crm.getCustomer(order.customerId);
  audit.log({ orderId, actor: customer.name, actorType: 'customer', action: 'customer.change_requested', detail: 'Customer asked to change the order — summary cancelled' });
  await send(customer.phone, { type: 'text', text: 'Sure! Please type your order again 😊 Example: "2 chocolate cakes, 1 cheesecake, deliver Saturday"' }, order.channel);
  inbox.setOrderStage(conv, null);
  inbox.markAnswered(conv, { by: 'OrderLah bot', follow: false });
  save();
  return { handled: 'change_requested', order };
}

function similarity(a, b) {
  const grams = (s) => { const t = ` ${s.toLowerCase()} `; const g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
  const A = grams(a); const B = grams(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

async function askCustomerToClarify(order, customer) {
  const index = 0;
  const u = order.unknown[index];
  const word = u.raw.replace(/^\d+(\.\d+)?\s*/, '');
  const scored = catalog.list()
    .map((c) => ({ c, score: Math.max(similarity(word, c.name), ...(c.aliases || []).map((a) => similarity(word, a))) }))
    .sort((a, b) => b.score - a.score);
  // Nothing looks similar? Offer what this customer usually orders instead.
  const usual = Object.entries(sales.averages(customer.id)).map(([sku]) => catalog.get(sku)).filter(Boolean);
  const suggestions = (scored[0].score >= 0.15 || !usual.length ? scored.map((x) => x.c) : usual).slice(0, 2);
  order.status = 'awaiting_customer';
  sess(customer.phone).awaitingClarify = { orderId: order.id, index };
  audit.log({ orderId: order.id, actor: 'OrderLah bot', actorType: 'system', action: 'customer.clarify_asked', detail: `Asked which product "${u.raw}" means` });
  await send(customer.phone, {
    type: 'buttons',
    text: `Order ${order.id}: "${u.raw}" — which one do you mean? 🤔\n(Type "boss" to talk to us)`,
    buttons: [
      ...suggestions.map((c) => ({ id: `pick:${order.id}:${index}:${c.sku}`, title: c.name })),
      { id: `skip:${order.id}:${index}`, title: 'Remove this item' },
    ],
  }, order.channel);
  inbox.markAnswered(convOf(order), { by: 'OrderLah bot', follow: false });
  save();
  return { handled: 'clarify', order };
}

async function resolvePick(orderId, index, sku, from) {
  const order = getDb().orders.find((o) => o.id === orderId);
  if (!order || order.status !== 'awaiting_customer') return { handled: 'stale_button' };
  const u = order.unknown[index];
  const pos = order.extraction.items.findIndex((i) => !i.sku && i.raw === u.raw);
  if (pos !== -1) {
    if (sku) order.extraction.items[pos] = { ...order.extraction.items[pos], sku, confidence: 1 };
    else order.extraction.items.splice(pos, 1);
  }
  sess(from).awaitingClarify = null;
  audit.log({ orderId, actor: customerLabel(from), actorType: 'customer', action: 'customer.clarified', detail: sku ? `"${u.raw}" = ${catalog.get(sku)?.name}` : `Removed "${u.raw}"` });
  if (!order.extraction.items.length) {
    order.status = 'cancelled';
    await send(from, { type: 'text', text: `Order ${orderId} is cancelled. Send a new order anytime 🙏` }, order.channel);
    inbox.markAnswered(convOf(order), { by: 'OrderLah bot', follow: false });
    save();
    return { handled: 'cancelled', order };
  }
  return evaluateAndRoute(order);
}

async function handoff(from, channel, text) {
  const session = sess(from);
  session.humanUntil = new Date(nowMs() + 2 * 3600e3).toISOString();
  const { approver } = people.getApprover();
  audit.log({ actor: customerLabel(from), actorType: 'customer', action: 'handoff.requested', detail: `Asked for a human: "${cut(text, 120)}"` });
  await send(from, { type: 'text', text: `Sure! ${approver.name} will contact you shortly 🙏` }, channel);
  await send(approver.phone, { type: 'text', text: `🙋 ${customerLabel(from)} (+${from}) wants to talk to you.\nMessage: "${cut(text || '-', 200)}"\nThe bot stops replying to this customer for 2 hours.` }, channel);
  save();
  return { handled: 'handoff' };
}

// ---------------------------------------------------------------------------
// APPROVAL — the human stays in control
// ---------------------------------------------------------------------------
function approvalCard(order, customer, reason) {
  const flags = order.flags.length
    ? order.flags.map((f) => `${f.severity === 'critical' ? '⛔' : f.severity === 'warning' ? '⚠️' : 'ℹ️'} ${f.message}`).join('\n')
    : '✅ No issues found';
  return [
    `🧾 New order ${order.id}${order.urgent ? ' · ⏰ URGENT' : ''}`,
    `${customer.name}${customer.isLead ? ' (new customer)' : ''}`,
    `Delivery: ${prettyDate(order.deliveryDate)}`,
    '',
    linesText(order.lines),
    `Total: ${rm(order.total)}`,
    '',
    flags,
    '',
    `Original ${ICON[order.source.type] || ''}: "${cut(order.source.text, 160)}"`,
    getDb().settings.customerConfirm ? '✔️ Customer confirmed the summary' : '',
    reason ? `↪️ ${reason}` : '',
  ].filter((x, i, arr) => !(x === '' && arr[i - 1] === '')).join('\n').trim();
}

async function requestApproval(order, customer) {
  const { approver, reason } = people.getApprover();
  order.status = 'pending_approval';
  order.approverId = approver.id;
  audit.log({ orderId: order.id, actor: 'OrderLah', actorType: 'system', action: 'approval.requested', detail: `Sent to ${approver.name}${reason ? ` — ${reason}` : ''}` });
  await send(approver.phone, {
    type: 'buttons',
    text: approvalCard(order, customer, reason),
    buttons: [
      { id: `approve:${order.id}`, title: '✅ Approve' },
      { id: `edit:${order.id}`, title: '✏️ Edit' },
      { id: `reject:${order.id}`, title: '❌ Reject' },
    ],
  }, order.channel);
  save();
  return { handled: 'approval_requested', order };
}

async function handleStaff(staff, msg, channel) {
  const s = sess(staff.phone);
  if (msg.type === 'button') {
    const [kind, id] = String(msg.buttonId || '').split(':');
    if (kind === 'approve') return approve(id, staff, channel);
    if (kind === 'edit') return startEdit(id, staff, channel);
    if (kind === 'reject') return reject(id, staff, channel);
    if (kind === 'delivered') return markDelivered(id, staff, channel);
    if (kind === 'fu_send') return followUpSend(id, staff, channel);
    if (kind === 'fu_edit') return followUpStartEdit(id, staff, channel);
    if (kind === 'fu_stop') return followUpStop(id, staff, channel);
  }
  const text = (msg.text || '').trim();
  if (s.awaitingFollowUpEdit) {
    const convId = s.awaitingFollowUpEdit;
    s.awaitingFollowUpEdit = null;
    if (/^(batal|cancel)$/i.test(text)) {
      save();
      await send(staff.phone, { type: 'text', text: 'Edit cancelled. The original draft is still waiting.' }, channel);
      return { handled: 'fu_edit_cancelled' };
    }
    return followUpSend(convId, staff, channel, text);
  }
  if (s.awaitingEdit) {
    if (/^(batal|cancel)$/i.test(text)) {
      s.awaitingEdit = null;
      save();
      await send(staff.phone, { type: 'text', text: 'Edit cancelled.' }, channel);
      return { handled: 'edit_cancelled' };
    }
    return applyBossEdit(s.awaitingEdit, staff, text, channel);
  }
  if (/^(summary|ringkasan|report|laporan)$/i.test(text)) return sendWeeklySummary(staff, channel);
  await send(staff.phone, { type: 'text', text: STAFF_HELP }, channel);
  return { handled: 'staff_help' };
}

// follow-up buttons on the owner's phone
async function followUpSend(convId, staff, channel, editedText) {
  const c = inbox.findConversation(convId);
  if (!c) return { handled: 'stale_button' };
  const r = await inbox.sendFollowUp(c, { by: staff.name, text: editedText, edited: Boolean(editedText) });
  await send(staff.phone, { type: 'text', text: r.ok ? `✅ Follow-up sent to ${c.name}.` : `Not sent: ${r.reason}.` }, channel);
  return { handled: r.ok ? 'followup_sent' : 'followup_not_sent', reason: r.reason };
}
async function followUpStartEdit(convId, staff, channel) {
  const c = inbox.findConversation(convId);
  if (!c || c.followUp.status !== 'awaiting_approval') return { handled: 'stale_button' };
  sess(staff.phone).awaitingFollowUpEdit = convId;
  save();
  await send(staff.phone, { type: 'text', text: `✏️ Type the follow-up message for ${c.name}. It will be sent right away.\nType "cancel" to cancel.` }, channel);
  return { handled: 'fu_edit_started' };
}
async function followUpStop(convId, staff, channel) {
  const c = inbox.findConversation(convId);
  if (!c) return { handled: 'stale_button' };
  inbox.stopFollowUps(c, 'Owner tapped "Don\'t follow up"', staff.name);
  await send(staff.phone, { type: 'text', text: `🚫 No follow-ups for ${c.name}.` }, channel);
  return { handled: 'followup_stopped' };
}

function findOrder(id) {
  return getDb().orders.find((o) => o.id === id);
}

export async function approveOrder(orderId, staff) {
  return approve(orderId, staff, 'sim', { quiet: true });
}

async function approve(orderId, staff, channel, { quiet = false } = {}) {
  const order = findOrder(orderId);
  if (!order || order.status !== 'pending_approval') {
    if (!quiet) await send(staff.phone, { type: 'text', text: `Order ${orderId} was already handled (${order?.status || 'not found'}).` }, channel);
    return { handled: 'stale_button' };
  }
  if (!people.canApprove(staff)) {
    if (!quiet) await send(staff.phone, { type: 'text', text: 'Only the owner or a supervisor can approve.' }, channel);
    return { handled: 'not_allowed' };
  }
  audit.log({ orderId, actor: staff.name, actorType: 'staff', action: 'approval.approved', detail: `Approved ${rm(order.total)}${quiet ? ' in Orbyte inbox' : ' on WhatsApp'}` });
  const { invoice } = await finalizeApproved(order, staff);
  if (!quiet) await send(staff.phone, { type: 'text', text: `✅ ${orderId} approved. Invoice ${invoice.id} (${rm(invoice.total)}) sent to ${crm.getCustomer(order.customerId).name}.` }, channel);
  return { handled: 'approved', order, invoice };
}

async function startEdit(orderId, staff, channel) {
  const order = findOrder(orderId);
  if (!order || order.status !== 'pending_approval') return { handled: 'stale_button' };
  sess(staff.phone).awaitingEdit = orderId;
  save();
  await send(staff.phone, { type: 'text', text: `✏️ Type the changes for ${orderId}.\nExample: "chocolate cake 3, cheesecake 0" (0 = remove)\nType "cancel" to cancel.` }, channel);
  return { handled: 'edit_started' };
}

async function applyBossEdit(orderId, staff, text, channel) {
  const order = findOrder(orderId);
  const customer = crm.getCustomer(order.customerId);
  const edits = parseOrderText(text, catalog.list(), todayIso()).items.filter((i) => i.sku);
  if (!edits.length) {
    await send(staff.phone, { type: 'text', text: 'Sorry, I didn\'t understand that change. Example: "chocolate cake 3, cheesecake 0". Type "cancel" to cancel.' }, channel);
    return { handled: 'edit_not_understood' };
  }
  const before = Object.fromEntries(order.lines.map((l) => [l.sku, l.qty]));
  const after = applyEdits(order.lines, edits, customer, catalog.list());
  order.extraction = { ...order.extraction, items: after.map((l) => ({ sku: l.sku, raw: l.raw, qty: l.qty, unit: l.unit, confidence: 1 })) };
  sess(staff.phone).awaitingEdit = null;
  audit.log({
    orderId, actor: staff.name, actorType: 'staff', action: 'order.edited', detail: `"${cut(text, 80)}"`,
    before, after: Object.fromEntries(after.map((l) => [l.sku, l.qty])),
  });
  reprice(order);
  return requestApproval(order, customer);
}

async function reject(orderId, staff, channel) {
  const order = findOrder(orderId);
  if (!order || order.status !== 'pending_approval') return { handled: 'stale_button' };
  order.status = 'rejected';
  const customer = crm.getCustomer(order.customerId);
  audit.log({ orderId, actor: staff.name, actorType: 'staff', action: 'approval.rejected', detail: 'Rejected on WhatsApp' });
  await send(customer.phone, { type: 'text', text: `Sorry, we can't process order ${orderId} right now 🙏 ${staff.name} will contact you.` }, order.channel);
  await send(staff.phone, { type: 'text', text: `❌ ${orderId} rejected. The customer has been told.` }, channel);
  const conv = convOf(order);
  inbox.setOrderStage(conv, null);
  inbox.markAnswered(conv, { by: staff.name, human: true, follow: false });
  save();
  return { handled: 'rejected', order };
}

// ---------------------------------------------------------------------------
// OUTCOME — invoice, payment link, accounting sync, packing list
// ---------------------------------------------------------------------------
export async function finalizeApproved(order, actor) {
  const customer = crm.getCustomer(order.customerId);
  order.status = 'approved';
  order.approvedAt = nowIso();
  order.approvedBy = actor.name;
  const invoice = await createInvoice(order, customer);
  order.invoiceId = invoice.id;
  order.status = 'invoiced';
  audit.log({ orderId: order.id, invoiceId: invoice.id, actor: 'OrderLah', actorType: 'system', action: 'invoice.issued', detail: `${invoice.id} · ${rm(invoice.total)} · due ${invoice.dueDate}` });

  const acc = connect.accounting.pushInvoice(invoice);
  invoice.accountingRef = acc.ref;
  audit.log({ orderId: order.id, invoiceId: invoice.id, actor: 'Orbyte Connect', actorType: 'connect', action: 'connect.accounting.synced', detail: `Pushed to accounting as ${acc.ref}` });

  const ch = channelOf(order);
  await send(customer.phone, {
    type: 'text',
    text: `✅ Order ${order.id} confirmed!\nDelivery: ${prettyDate(order.deliveryDate)}\nTotal: ${rm(invoice.total)}\n\nPay here:\n${invoice.paymentUrl}`,
  }, ch);
  await send(customer.phone, { type: 'document', url: invoice.pdfUrl, filename: `${invoice.id}.pdf`, caption: `Invoice ${invoice.id}` }, ch);

  const packer = people.byRole('staff');
  if (packer) {
    await send(packer.phone, {
      type: 'buttons',
      text: `📦 Packing list ${order.id}${order.urgent ? ' · ⏰ URGENT' : ''}\n${customer.name} · deliver ${prettyDate(order.deliveryDate)}\n${order.lines.map((l) => `• ${l.qty} ${l.unit} ${l.name}`).join('\n')}`,
      buttons: [{ id: `delivered:${order.id}`, title: '🚚 Delivered' }],
    }, ch);
  }
  const conv = convOf(order);
  inbox.setOrderStage(conv, 'to_ship');
  inbox.markAnswered(conv, { by: actor.name, human: actor.name !== 'Auto-approve rule', follow: false });
  save();
  return { order, invoice };
}

async function markDelivered(orderId, staff, channel) {
  const order = findOrder(orderId);
  if (!order || order.deliveredAt) return { handled: 'stale_button' };
  order.deliveredAt = nowIso();
  audit.log({ orderId, actor: staff.name, actorType: 'staff', action: 'order.delivered', detail: 'Marked delivered on WhatsApp' });
  await send(crm.getCustomer(order.customerId).phone, { type: 'text', text: `🚚 Order ${orderId} has been delivered. Thank you!` }, channelOf(order));
  await send(staff.phone, { type: 'text', text: `Noted ✅ ${orderId} delivered.` }, channel);
  if (order.status !== 'paid') inbox.setOrderStage(convOf(order), 'delivered');
  save();
  return { handled: 'delivered', order };
}

// ---------------------------------------------------------------------------
// AFTER THE SALE — payment matched, reminders, weekly summary
// ---------------------------------------------------------------------------
export async function recordPayment(invoiceId, { method = 'DuitNow (simulated)' } = {}) {
  const db = getDb();
  const invoice = db.invoices.find((i) => i.id === invoiceId);
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.status === 'paid') return { invoice, already: true };
  invoice.status = 'paid';
  invoice.paidAt = nowIso();
  invoice.paymentMethod = method;
  const order = db.orders.find((o) => o.id === invoice.orderId);
  if (order) order.status = 'paid';
  const customer = crm.getCustomer(invoice.customerId);
  audit.log({ orderId: invoice.orderId, invoiceId, actor: 'Orbyte Connect Payments', actorType: 'connect', action: 'payment.received', detail: `${rm(invoice.total)} via ${method} — matched to ${invoiceId} automatically` });
  const ch = order ? channelOf(order) : 'sim';
  await send(customer.phone, { type: 'text', text: `Thank you! 🙏 Payment of ${rm(invoice.total)} for ${invoiceId} received.` }, ch);
  const owner = people.byRole('owner');
  await send(owner.phone, { type: 'text', text: `💰 ${rm(invoice.total)} received from ${customer.name} (${invoiceId}).` }, ch);
  if (order) inbox.setOrderStage(convOf(order), 'paid');
  save();
  return { invoice };
}

export async function runReminders(today = todayIso()) {
  const db = getDb();
  const st = db.settings.reminders;
  const sent = [];
  for (const inv of db.invoices) {
    if (inv.status !== 'unpaid') continue;
    const daysLeft = diffDays(inv.dueDate, today);
    let stage = null;
    let late = 0;
    const overdueStages = [...st.overdueStages].sort((a, b) => b - a);
    for (const n of overdueStages) {
      if (-daysLeft >= n && !inv.remindersSent.includes(`overdue_${n}`)) { stage = `overdue_${n}`; late = -daysLeft; break; }
    }
    // no "due soon" nudge on the same day the invoice was sent (cash customers have 0-day terms)
    if (!stage && daysLeft >= 0 && daysLeft <= st.dueSoonDays && inv.issueDate < today && !inv.remindersSent.includes('due_soon')) stage = 'due_soon';
    if (!stage) continue;

    // mark this stage and every earlier stage as done, so a fast-forward does not spam
    const all = ['due_soon', ...[...st.overdueStages].sort((a, b) => a - b).map((n) => `overdue_${n}`)];
    for (const s of all.slice(0, all.indexOf(stage) + 1)) if (!inv.remindersSent.includes(s)) inv.remindersSent.push(s);

    const customer = crm.getCustomer(inv.customerId);
    const order = db.orders.find((o) => o.id === inv.orderId);
    const ch = order ? channelOf(order) : 'sim';
    const url = inv.paymentUrl || connect.payments.createLink(inv);
    inv.paymentUrl = url;
    const text = stage === 'due_soon'
      ? `Friendly reminder 🙏 Invoice ${inv.id} (${rm(inv.total)}) is due on ${inv.dueDate}.\nPay here: ${url}`
      : `Hi ${customer.name}, invoice ${inv.id} (${rm(inv.total)}) is ${late} day${late === 1 ? '' : 's'} overdue.\nPay here: ${url}\nAny problem? Type "boss" to talk to us.`;
    const msg = ch === 'wa' && config.wa.reminderTemplate
      ? { type: 'template', name: config.wa.reminderTemplate, params: [customer.name, inv.id, rm(inv.total), url], fallbackText: text }
      : { type: 'text', text };
    await send(customer.phone, msg, ch);
    audit.log({ orderId: inv.orderId, invoiceId: inv.id, actor: 'Reminder job', actorType: 'system', action: 'reminder.sent', detail: `${stage} → ${customer.name}` });
    sent.push({ invoiceId: inv.id, stage, customer: customer.name, total: inv.total, channel: ch });
  }
  if (sent.length) {
    const owner = people.byRole('owner');
    await send(owner.phone, { type: 'text', text: `🔔 ${sent.length} payment reminder(s) sent today (${rm(round2(sent.reduce((s, x) => s + x.total, 0)))}):\n${sent.map((x) => `• ${x.customer} — ${x.invoiceId}`).join('\n')}` }, sent[0].channel);
  }
  save();
  return sent;
}

export function computeSummary(today = todayIso(), days = 7) {
  const db = getDb();
  const from = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 864e5).toISOString().slice(0, 10);
  const inRange = (iso) => iso && iso.slice(0, 10) >= from && iso.slice(0, 10) <= today;
  const invoices = db.invoices.filter((i) => inRange(i.issueDate));
  const sales7 = round2(invoices.reduce((s, i) => s + i.total, 0));
  const collected = round2(db.invoices.filter((i) => i.status === 'paid' && inRange(i.paidAt)).reduce((s, i) => s + i.total, 0));
  const open = db.invoices.filter((i) => i.status === 'unpaid');
  const outstanding = round2(open.reduce((s, i) => s + i.total, 0));
  const overdue = open.filter((i) => diffDays(today, i.dueDate) > 0);
  const byCust = {};
  invoices.forEach((i) => { byCust[i.customerId] = (byCust[i.customerId] || 0) + i.total; });
  const topId = Object.entries(byCust).sort((a, b) => b[1] - a[1])[0]?.[0];
  const orders = db.orders.filter((o) => inRange(o.createdAt) && o.channel !== 'seed');
  const handledByBot = orders.filter((o) => ['invoiced', 'paid'].includes(o.status)).length;
  const ib = inbox.inboxStats();
  return {
    from, to: today, sales: sales7, collected, outstanding, overdueCount: overdue.length,
    overdueTotal: round2(overdue.reduce((s, i) => s + i.total, 0)), topCustomer: topId ? crm.getCustomer(topId).name : null,
    ordersViaWhatsApp: orders.length, invoicedAutomatically: handledByBot,
    followUpsSent: ib.followUpsSent, wonOrders: ib.wonOrders, wonRM: ib.wonRM,
  };
}

export async function sendWeeklySummary(staff = people.byRole('owner'), channel = 'sim') {
  const s = computeSummary();
  await send(staff.phone, {
    type: 'text',
    text: `📊 Summary ${s.from} → ${s.to}\nSales: ${rm(s.sales)}\nCollected: ${rm(s.collected)}\nUnpaid: ${rm(s.outstanding)} (${s.overdueCount} overdue)\nWhatsApp orders: ${s.ordersViaWhatsApp}\nFollow-ups sent: ${s.followUpsSent} · orders after follow-up: ${s.wonOrders} (${rm(s.wonRM)})\nTop customer: ${s.topCustomer || '-'}`,
  }, channel);
  return s;
}
