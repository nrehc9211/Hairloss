// Business logic: the automated journey
//   trigger (WhatsApp message) -> data (customer, order) -> logic (AI + checks)
//   -> approval (owner, logged) -> outcome (invoice sent, payment tracked, delivery updates)
import { now, audit, getSettings, tx } from './db.js';
import { understand } from './ai.js';
import * as whatsapp from './whatsapp.js';
import * as orbyte from './orbyte.js';
import * as rag from './rag.js';
import { reply as R, detectLang, isNativeLang } from './replies.js';
import { translateReply } from './translate.js';

const rm = n => `RM${Number(n).toFixed(2)}`;
const HOUR = 3600_000;

export const ORDER_STATUSES = {
  pending_approval: 'Waiting for owner approval',
  awaiting_payment: 'Invoice sent - awaiting payment',
  paid: 'Paid - ready to pack',
  packing: 'Packing',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// ------------------------------------------------------------------ messaging

export function upsertCustomer(db, phone, profileName) {
  let c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  if (!c) {
    db.prepare('INSERT INTO customers (phone, name, created_at) VALUES (?, ?, ?)').run(phone, profileName || null, now());
    c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  } else if (!c.name && profileName) {
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(profileName, c.id);
    c.name = profileName;
  }
  return c;
}

function saveMessage(db, customerId, direction, sender, body, extra = {}) {
  const ts = now();
  const r = db.prepare(`INSERT INTO messages (customer_id, direction, sender, body, intent, wa_message_id, delivery, translation_en, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(customerId, direction, sender, body, extra.intent ?? null, extra.waId ?? null, extra.delivery ?? null, extra.translationEn ?? null, ts);
  db.prepare('UPDATE customers SET last_activity_at = ? WHERE id = ?').run(ts, customerId);
  return Number(r.lastInsertRowid);
}

// Automatic messages are built in English, Malay or Chinese. For customers who write in
// another language (e.g. Tamil), they are translated by the AI first; the English original
// is kept so the owner can read it. Owner replies are sent exactly as typed.
export async function sendToCustomer(db, customerId, body, sender, { translate = sender !== 'owner', translationEn: knownEnglish = null } = {}) {
  const c = db.prepare('SELECT phone, lang FROM customers WHERE id = ?').get(customerId);
  let text = body;
  let translationEn = knownEnglish;
  if (translate && c.lang && !isNativeLang(c.lang)) {
    const t = await translateReply(body, c.lang);
    if (t.translated) {
      text = t.text;
      translationEn = body;
    } else {
      audit(db, 'system', 'translation_skipped', 'customer', customerId, `Sent in English (${c.lang}): ${t.problem}`);
    }
  }
  const result = await whatsapp.sendText(c.phone, text);
  const id = saveMessage(db, customerId, 'out', sender, text, { ...result, translationEn });
  return { id, ...result };
}

export async function handleInbound(db, { phone, profileName, text, waId }) {
  if (waId && db.prepare('SELECT 1 FROM messages WHERE wa_message_id = ?').get(waId)) return { duplicate: true };
  const customer = upsertCustomer(db, phone, profileName);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const result = await understand(text, products);

  const msgId = saveMessage(db, customer.id, 'in', 'customer', text, { intent: result.intent, waId, translationEn: result.english });
  db.prepare('UPDATE customers SET last_inbound_at = ?, followup_sent_at = NULL WHERE id = ?').run(now(), customer.id);

  // Reply in the customer's language. Messages with no language clues (e.g. "2 original",
  // or a name and address) use the language the customer last wrote in.
  // Languages without templates (Tamil, Indonesian, Japanese...) can only be recognised by the AI.
  const detected = detectLang(text);
  let lang = null;
  if (result.language && !isNativeLang(result.language)) {
    // Malay and Indonesian look alike: trust the Malay word check for Malay messages.
    lang = result.language === 'id' && detected.sure && detected.lang === 'ms' ? 'ms' : result.language;
  } else if (detected.sure) {
    lang = detected.lang;
  }
  if (lang) db.prepare('UPDATE customers SET lang = ? WHERE id = ?').run(lang, customer.id);
  const ctx = { lang: lang || customer.lang || 'en' };
  let reply = buildReply(db, customer.id, msgId, text, result, ctx);
  // One message, two questions ("how much is cheese? is it halal?"): answer the first,
  // and send the other part to the owner's Inbox with an FAQ draft.
  if (result.otherQuestion && !ctx.draftForEscalation) {
    ctx.draftForEscalation = escalate(db, customer.id, msgId, result.otherQuestion, 'Customer also asked this in the same message');
    reply = [reply, R.alsoChecking(ctx.lang)].filter(Boolean).join('\n\n');
  }
  if (reply) await sendToCustomer(db, customer.id, reply, 'ai');
  // Questions the routine replies can't answer: prepare an FAQ draft in the background,
  // after the "checking with the owner" reply has gone out.
  if (ctx.draftForEscalation) startDraft(db, ctx.draftForEscalation);
  return { intent: result.intent, engine: result.engine, lang: ctx.lang };
}

function buildReply(db, customerId, msgId, text, result, ctx = {}) {
  const s = getSettings(db);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const customer = () => db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);

  // Remember any name / address the customer gives us.
  if (result.name || result.address) {
    tx(db, () => {
      if (result.name) db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(result.name, customerId);
      if (result.address) db.prepare('UPDATE customers SET address = ? WHERE id = ?').run(result.address, customerId);
      const c = customer();
      db.prepare(`UPDATE orders SET customer_name = ?, address = ?, updated_at = ? WHERE customer_id = ? AND status = 'pending_approval'`)
        .run(c.name, c.address, now(), customerId);
      audit(db, 'ai', 'customer_details_captured', 'customer', customerId, [result.name && `name: ${result.name}`, result.address && `address: ${result.address}`].filter(Boolean).join('; '));
    });
  }

  const lang = ctx.lang || 'en';
  const promo = { minQty: s.discount_min_qty, pct: s.discount_pct, freeMin: s.free_delivery_min };
  switch (result.intent) {
    case 'greeting':
      return R.greeting(lang, { name: customer().name, business: s.business_name, products });
    case 'thanks':
      return R.thanks(lang);
    case 'price':
      if (result.items.length) {
        const q = quote(db, result.items);
        return R.quote(lang, { ...q, discountPct: s.discount_pct });
      }
      return R.priceInfo(lang, { products, ...promo });
    case 'delivery':
      return R.delivery(lang, { info: s[`delivery_info_${lang}`] || s.delivery_info, fee: s.delivery_fee, freeMin: s.free_delivery_min });
    case 'discount':
      return R.discount(lang, promo);
    case 'order':
    case 'details': {
      if (result.intent === 'order' && result.items.length) {
        const order = createOrder(db, customerId, msgId, result.items);
        const c = customer();
        return R.orderReceived(lang, { ...order, discountPct: s.discount_pct, missingName: !c.name, missingAddress: !c.address });
      }
      const c = customer();
      const pending = db.prepare(`SELECT code FROM orders WHERE customer_id = ? AND status = 'pending_approval' ORDER BY id DESC LIMIT 1`).get(customerId);
      if (pending) return R.detailsSavedForOrder(lang, { name: c.name, code: pending.code });
      return R.detailsSaved(lang, { name: c.name });
    }
    case 'payment': {
      const inv = db.prepare(`SELECT i.* FROM invoices i JOIN orders o ON o.id = i.order_id
        WHERE o.customer_id = ? AND i.status = 'approved' AND i.payment_status = 'unpaid' ORDER BY i.id DESC LIMIT 1`).get(customerId);
      if (!inv) {
        escalate(db, customerId, msgId, text, 'Customer says they paid but no unpaid invoice was found');
        return R.paymentNoInvoice(lang);
      }
      db.prepare(`UPDATE invoices SET payment_status = 'reported' WHERE id = ?`).run(inv.id);
      audit(db, 'customer', 'payment_reported', 'invoice', inv.id, text);
      return R.paymentNoted(lang, { invoiceNo: inv.invoice_no });
    }
    case 'order_status': {
      const o = db.prepare(`SELECT * FROM orders WHERE customer_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1`).get(customerId);
      if (!o) return R.noOrderFound(lang);
      return R.orderStatus(lang, { code: o.code, status: o.status });
    }
    default:
      ctx.draftForEscalation = escalate(db, customerId, msgId, text, 'AI could not answer this confidently');
      return R.holding(lang);
  }
}

const customerLang = (db, customerId) => db.prepare('SELECT lang FROM customers WHERE id = ?').get(customerId)?.lang || 'en';


function escalate(db, customerId, msgId, question, reason) {
  const r = db.prepare('INSERT INTO escalations (customer_id, message_id, question, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(customerId, msgId, question, reason, now());
  audit(db, 'ai', 'escalated_to_owner', 'customer', customerId, question);
  return Number(r.lastInsertRowid);
}

// ------------------------------------------------------------------ FAQ drafts (RAG)
// The AI searches the shop's FAQ and current settings and drafts an answer for the
// owner. By default the owner must approve every draft (Inbox -> Send draft).
// With the setting rag_auto_send = 1, only drafts that passed every check
// (status "ready") are sent automatically.

const pendingDrafts = new Set();
export const waitForDrafts = () => Promise.allSettled([...pendingDrafts]);

export function startDraft(db, escalationId) {
  const setDraft = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE escalations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), escalationId);
  };
  if (!rag.isAvailable()) {
    setDraft({ draft_status: 'unavailable', draft_reason: 'Add GEMINI_API_KEY to get AI draft answers' });
    return null;
  }
  setDraft({ draft_status: 'pending', draft_reply: null, draft_flags: null, draft_sources: null, draft_reason: null, draft_missing: null, draft_reply_en: null });

  const job = (async () => {
    const e = db.prepare(`SELECT e.*, c.name FROM escalations e JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`).get(escalationId);
    try {
      const d = await rag.draftAnswer(db, e.question, { customerId: e.customer_id, customerName: e.name });
      setDraft({
        draft_status: d.status,
        draft_reply: d.reply,
        draft_flags: JSON.stringify(d.flags),
        draft_sources: JSON.stringify(d.sources),
        draft_reason: d.reason || null,
        draft_missing: d.missingInfo || null,
        draft_reply_en: d.replyEnglish || null,
      });
      audit(db, 'ai', 'faq_draft_prepared', 'escalation', escalationId, `${d.status}${d.flags.length ? ` (${d.flags.join(', ')})` : ''}`);

      const stillOpen = db.prepare(`SELECT status FROM escalations WHERE id = ?`).get(escalationId).status === 'open';
      if (stillOpen && d.status === 'ready' && getSettings(db).rag_auto_send === '1') {
        await sendToCustomer(db, e.customer_id, d.reply, 'ai', { translate: false }); // already in the customer's language
        db.prepare(`UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(now(), escalationId);
        audit(db, 'ai', 'faq_answer_auto_sent', 'escalation', escalationId, d.reply.slice(0, 120));
      }
    } catch (err) {
      console.warn('[rag] draft failed:', err.message);
      setDraft({ draft_status: 'failed', draft_reason: err.message.slice(0, 200) });
    }
  })();
  pendingDrafts.add(job);
  job.finally(() => pendingDrafts.delete(job));
  return job;
}

// Owner approves a draft: sends it (or their edited version) and resolves the question.
export async function sendDraft(db, escalationId, { text, actor = 'owner' } = {}) {
  const e = db.prepare('SELECT * FROM escalations WHERE id = ?').get(escalationId);
  if (!e) throw httpError(404, 'Question not found');
  if (e.status !== 'open') throw httpError(409, 'This question is already resolved');
  if (text == null && JSON.parse(e.draft_flags || '[]').includes('NOT_IN_DOCUMENTS')) {
    throw httpError(409, "Your FAQ doesn't answer this question, so there is no draft to send. Please write your own reply.");
  }
  const body = (text ?? e.draft_reply ?? '').trim();
  if (!body) throw httpError(400, 'There is no draft to send');
  const edited = text != null && text.trim() !== (e.draft_reply || '').trim();
  const result = await sendToCustomer(db, e.customer_id, body, 'owner', { translationEn: edited ? null : e.draft_reply_en });
  db.prepare(`UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(now(), escalationId);
  audit(db, actor, edited ? 'faq_draft_edited_and_sent' : 'faq_draft_approved_and_sent', 'escalation', escalationId, body.slice(0, 120));
  return result;
}

// ------------------------------------------------------------------ orders

function quote(db, items) {
  const s = getSettings(db);
  const lines = [];
  let subtotal = 0, qtyTotal = 0;
  for (const { product, qty } of items) {
    const line = product.price * qty;
    subtotal += line; qtyTotal += qty;
    lines.push(`• ${qty} x ${product.name} @ ${rm(product.price)} = ${rm(line)}`);
  }
  const discount = qtyTotal >= Number(s.discount_min_qty) ? round(subtotal * Number(s.discount_pct) / 100) : 0;
  const deliveryFee = subtotal - discount >= Number(s.free_delivery_min) ? 0 : Number(s.delivery_fee);
  return { lines, subtotal, discount, deliveryFee, total: round(subtotal - discount + deliveryFee), qtyTotal };
}

const round = n => Math.round(n * 100) / 100;

function createOrder(db, customerId, msgId, items) {
  const q = quote(db, items);
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    const ts = now();
    const r = db.prepare(`INSERT INTO orders (code, customer_id, source_message_id, status, subtotal, discount, delivery_fee, total, customer_name, address, created_at, updated_at)
      VALUES ('TMP', ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(customerId, msgId, q.subtotal, q.discount, q.deliveryFee, q.total, c.name, c.address, ts, ts);
    const orderId = Number(r.lastInsertRowid);
    const code = `ORD-${String(orderId).padStart(4, '0')}`;
    db.prepare('UPDATE orders SET code = ? WHERE id = ?').run(code, orderId);
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, name, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)');
    for (const { product, qty } of items) ins.run(orderId, product.id, product.name, qty, product.price, product.price * qty);
    db.prepare(`INSERT INTO invoices (order_id, status, amount, created_at) VALUES (?, 'pending', ?, ?)`).run(orderId, q.total, ts);
    audit(db, 'ai', 'order_created', 'order', orderId, `${code} ${rm(q.total)} from WhatsApp`);
    const outOfStock = items.filter(i => i.product.stock < i.qty).map(i => i.product.name);
    return { id: orderId, code, lines: q.lines, discount: q.discount, deliveryFee: q.deliveryFee, total: q.total, outOfStock };
  });
}

export function getOrder(db, id) {
  const order = db.prepare(`SELECT o.*, c.phone FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(id);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  order.invoice = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(id);
  order.source_message = order.source_message_id ? db.prepare('SELECT * FROM messages WHERE id = ?').get(order.source_message_id) : null;
  order.status_label = ORDER_STATUSES[order.status];
  order.checks = computeChecks(db, order);
  order.history = db.prepare(`SELECT * FROM audit_log WHERE (entity = 'order' AND entity_id = ?) OR (entity = 'invoice' AND entity_id = ?) ORDER BY id`).all(id, order.invoice?.id ?? -1);
  return order;
}

// What the owner should look at before approving an invoice.
export function computeChecks(db, order) {
  const s = getSettings(db);
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  add('Customer name', order.customer_name ? 'pass' : 'fail', order.customer_name || 'Missing - ask customer for their name');
  add('Delivery address', order.address ? 'pass' : 'fail', order.address || 'Missing - ask customer for delivery address');

  const priceIssues = [], stockIssues = [];
  let subtotal = 0, qty = 0;
  for (const it of order.items) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    subtotal += it.qty * it.unit_price; qty += it.qty;
    if (!p) { priceIssues.push(`${it.name} not in catalog`); continue; }
    if (p.price !== it.unit_price) priceIssues.push(`${it.name}: order ${rm(it.unit_price)} vs catalog ${rm(p.price)}`);
    if (order.status === 'pending_approval' && p.stock < it.qty) stockIssues.push(`${it.name}: need ${it.qty}, have ${p.stock}`);
  }
  add('Prices match catalog', priceIssues.length ? 'fail' : 'pass', priceIssues.join('; ') || 'All unit prices match current price list');
  if (order.status === 'pending_approval') add('Stock available', stockIssues.length ? 'fail' : 'pass', stockIssues.join('; ') || 'Enough stock for all items');

  const expectedDiscount = qty >= Number(s.discount_min_qty) ? round(subtotal * Number(s.discount_pct) / 100) : 0;
  const expectedTotal = round(subtotal - order.discount + order.delivery_fee);
  const totalOk = Math.abs(expectedTotal - order.total) < 0.01 && Math.abs(expectedDiscount - order.discount) < 0.01;
  add('Total recalculated', totalOk ? 'pass' : 'fail', `${rm(subtotal)} - ${rm(order.discount)} discount + ${rm(order.delivery_fee)} delivery = ${rm(order.total)}`);

  add('Order size', qty > Number(s.max_qty_per_order) ? 'warn' : 'pass', `${qty} box(es)${qty > Number(s.max_qty_per_order) ? ` - above usual limit of ${s.max_qty_per_order}, confirm capacity` : ''}`);

  const dup = db.prepare(`SELECT code FROM orders WHERE customer_id = ? AND id != ? AND status != 'cancelled' AND created_at >= ?`)
    .get(order.customer_id, order.id, new Date(Date.parse(order.created_at) - 24 * HOUR).toISOString());
  add('Duplicate check', dup ? 'warn' : 'pass', dup ? `Same customer also has ${dup.code} in the last 24h` : 'No other order from this customer in 24h');

  const openQ = db.prepare(`SELECT COUNT(*) AS n FROM escalations WHERE customer_id = ? AND status = 'open'`).get(order.customer_id).n;
  add('Unanswered questions', openQ ? 'warn' : 'pass', openQ ? `${openQ} open question(s) from this customer in the Inbox` : 'None');
  return checks;
}

// ------------------------------------------------------------------ approvals (human control)

export async function approveInvoice(db, invoiceId, { actor = 'owner', override = false } = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) throw httpError(404, 'Invoice not found');
  if (inv.status !== 'pending') throw httpError(409, `Invoice is already ${inv.status}`);
  const order = getOrder(db, inv.order_id);
  const failed = order.checks.filter(c => c.status === 'fail');
  if (failed.length && !override) throw httpError(422, `Checks failed: ${failed.map(f => f.label).join(', ')}`, { checks: order.checks });

  const s = getSettings(db);
  const ts = now();
  const due = new Date(Date.now() + Number(s.payment_terms_days) * 24 * HOUR).toISOString();
  const invoiceNo = tx(db, () => {
    const year = new Date().getFullYear();
    const seq = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?`).get(`INV-${year}-%`).n + 1;
    const no = `INV-${year}-${String(seq).padStart(4, '0')}`;
    db.prepare(`UPDATE invoices SET status = 'approved', invoice_no = ?, approved_at = ?, approved_by = ?, due_date = ? WHERE id = ?`)
      .run(no, ts, actor, due, invoiceId);
    db.prepare(`UPDATE orders SET status = 'awaiting_payment', updated_at = ? WHERE id = ?`).run(ts, order.id);
    for (const it of order.items) db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?').run(it.qty, it.product_id);
    audit(db, actor, override && failed.length ? 'invoice_approved_with_override' : 'invoice_approved', 'invoice', invoiceId,
      `${no} for ${order.code} ${rm(order.total)}${failed.length ? ` (overrode: ${failed.map(f => f.label).join(', ')})` : ''}`);
    return no;
  });

  const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const sync = await orbyte.syncInvoice(fresh, order, order.items);
  db.prepare('UPDATE invoices SET orbyte_ref = ?, orbyte_sync = ? WHERE id = ?').run(sync.ref, sync.status, invoiceId);
  audit(db, 'system', `orbyte_sync_${sync.status}`, 'invoice', invoiceId, sync.ref);

  const body = R.invoice(customerLang(db, order.customer_id), {
    invoiceNo, business: s.business_name, code: order.code, items: order.items,
    discount: order.discount, deliveryFee: order.delivery_fee, total: order.total, due, bank: s.bank_details,
  });
  await sendToCustomer(db, order.customer_id, body, 'system');
  return { invoice_no: invoiceNo, orbyte: sync };
}

export async function rejectInvoice(db, invoiceId, { reason, notify, actor = 'owner' }) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) throw httpError(404, 'Invoice not found');
  if (inv.status !== 'pending') throw httpError(409, `Invoice is already ${inv.status}`);
  if (!reason?.trim()) throw httpError(400, 'A reason is required to reject');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(inv.order_id);
  tx(db, () => {
    db.prepare(`UPDATE invoices SET status = 'rejected', rejected_reason = ? WHERE id = ?`).run(reason, invoiceId);
    db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now(), order.id);
    audit(db, actor, 'invoice_rejected', 'invoice', invoiceId, reason);
  });
  if (notify) await sendToCustomer(db, order.customer_id, R.orderRejected(customerLang(db, order.customer_id), { code: order.code, reason }), 'owner');
}

export async function markPaid(db, invoiceId, actor = 'owner') {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.status !== 'approved') throw httpError(409, 'Only approved invoices can be marked paid');
  if (inv.payment_status === 'paid') throw httpError(409, 'Already paid');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(inv.order_id);
  tx(db, () => {
    db.prepare(`UPDATE invoices SET payment_status = 'paid', paid_at = ? WHERE id = ?`).run(now(), invoiceId);
    db.prepare(`UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?`).run(now(), order.id);
    audit(db, actor, 'payment_confirmed', 'invoice', invoiceId, `${inv.invoice_no} ${rm(inv.amount)}`);
  });
  await sendToCustomer(db, order.customer_id, R.paymentReceived(customerLang(db, order.customer_id), { invoiceNo: inv.invoice_no, code: order.code }), 'system');
}


export async function updateOrderStatus(db, orderId, status, actor = 'staff') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'Order not found');
  const flow = ['paid', 'packing', 'out_for_delivery', 'delivered'];
  if (!['packing', 'out_for_delivery', 'delivered'].includes(status) || flow.indexOf(status) !== flow.indexOf(order.status) + 1) {
    throw httpError(409, `Cannot move order from "${order.status}" to "${status}"`);
  }
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), orderId);
  audit(db, actor, `order_${status}`, 'order', orderId, order.code);
  await sendToCustomer(db, order.customer_id, R.orderUpdate(customerLang(db, order.customer_id), status, order.code), 'system');
}

export async function ownerReply(db, customerId, body) {
  if (!body?.trim()) throw httpError(400, 'Message is empty');
  const result = await sendToCustomer(db, customerId, body.trim(), 'owner');
  audit(db, 'owner', 'owner_replied', 'customer', customerId, body.trim().slice(0, 120));
  return result;
}

export function resolveEscalation(db, id) {
  db.prepare(`UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'`).run(now(), id);
  audit(db, 'owner', 'question_resolved', 'escalation', id, null);
}

// ------------------------------------------------------------------ scheduled automations

export async function runAutomations(db) {
  const s = getSettings(db);
  const out = { followups: 0, paymentReminders: 0, escalated: 0 };
  const nowMs = Date.now();

  // 1) Customers who asked something, got an answer, then went quiet (no order).
  const quietBefore = new Date(nowMs - Number(s.followup_hours) * HOUR).toISOString();
  const quiet = db.prepare(`
    SELECT c.* FROM customers c
    WHERE c.last_inbound_at IS NOT NULL AND c.last_inbound_at <= ? AND c.followup_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', c.last_inbound_at, '-7 days'))
      AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.customer_id = c.id AND e.status = 'open')
      AND (SELECT direction FROM messages m WHERE m.customer_id = c.id ORDER BY m.id DESC LIMIT 1) = 'out'`).all(quietBefore);
  for (const c of quiet) {
    await sendToCustomer(db, c.id, R.followUp(c.lang || 'en', { name: c.name, business: s.business_name, minQty: s.discount_min_qty, pct: s.discount_pct }), 'ai');
    db.prepare('UPDATE customers SET followup_sent_at = ? WHERE id = ?').run(now(), c.id);
    audit(db, 'ai', 'followup_sent', 'customer', c.id, `No reply for ${s.followup_hours}h`);
    out.followups++;
  }

  // 2) Overdue invoices: remind up to 3 times, then hand to the owner.
  const overdue = db.prepare(`SELECT i.*, o.customer_id, o.code FROM invoices i JOIN orders o ON o.id = i.order_id
    WHERE i.status = 'approved' AND i.payment_status = 'unpaid' AND i.due_date <= ?`).all(now());
  const gap = Number(s.payment_reminder_hours) * HOUR;
  for (const inv of overdue) {
    if (inv.last_reminder_at && nowMs - Date.parse(inv.last_reminder_at) < gap) continue;
    if (inv.reminder_count >= 3) {
      const open = db.prepare(`SELECT 1 FROM escalations WHERE customer_id = ? AND status = 'open' AND reason LIKE ?`).get(inv.customer_id, `%${inv.invoice_no}%`);
      if (!open) {
        const lastMsg = db.prepare('SELECT id FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(inv.customer_id);
        escalate(db, inv.customer_id, lastMsg.id, `Invoice ${inv.invoice_no} (${rm(inv.amount)}) still unpaid after 3 reminders`, `Payment overdue: ${inv.invoice_no}`);
        out.escalated++;
      }
      continue;
    }
    await sendToCustomer(db, inv.customer_id, R.paymentReminder(customerLang(db, inv.customer_id), { invoiceNo: inv.invoice_no, code: inv.code, amount: inv.amount, bank: s.bank_details }), 'ai');
    db.prepare('UPDATE invoices SET last_reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?').run(now(), inv.id);
    audit(db, 'ai', 'payment_reminder_sent', 'invoice', inv.id, `Reminder #${inv.reminder_count + 1}`);
    out.paymentReminders++;
  }
  return out;
}

// Demo helper: pretend time has passed by shifting stored timestamps back.
export function timeTravel(db, hours) {
  const shift = v => (v ? new Date(Date.parse(v) - hours * HOUR).toISOString() : v);
  tx(db, () => {
    for (const c of db.prepare('SELECT id, last_inbound_at, last_activity_at, followup_sent_at FROM customers').all()) {
      db.prepare('UPDATE customers SET last_inbound_at = ?, last_activity_at = ?, followup_sent_at = ? WHERE id = ?')
        .run(shift(c.last_inbound_at), shift(c.last_activity_at), shift(c.followup_sent_at), c.id);
    }
    for (const i of db.prepare('SELECT id, due_date, last_reminder_at FROM invoices').all()) {
      db.prepare('UPDATE invoices SET due_date = ?, last_reminder_at = ? WHERE id = ?').run(shift(i.due_date), shift(i.last_reminder_at), i.id);
    }
    for (const o of db.prepare('SELECT id, created_at FROM orders').all()) {
      db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(shift(o.created_at), o.id);
    }
    audit(db, 'system', 'demo_time_travel', 'system', null, `+${hours}h`);
  });
}

export function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}
