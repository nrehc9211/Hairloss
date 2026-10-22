// Business logic: the automated journey
//   trigger (WhatsApp message) -> data (customer, order) -> logic (AI + checks)
//   -> approval (owner, logged) -> outcome (invoice sent, payment tracked, delivery updates)
import { now, audit, getSettings, tx } from './db.js';
import { understand } from './ai.js';
import * as whatsapp from './whatsapp.js';
import * as orbyte from './orbyte.js';

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
  const r = db.prepare(`INSERT INTO messages (customer_id, direction, sender, body, intent, wa_message_id, delivery, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(customerId, direction, sender, body, extra.intent ?? null, extra.waId ?? null, extra.delivery ?? null, ts);
  db.prepare('UPDATE customers SET last_activity_at = ? WHERE id = ?').run(ts, customerId);
  return Number(r.lastInsertRowid);
}

export async function sendToCustomer(db, customerId, body, sender) {
  const c = db.prepare('SELECT phone FROM customers WHERE id = ?').get(customerId);
  const result = await whatsapp.sendText(c.phone, body);
  const id = saveMessage(db, customerId, 'out', sender, body, result);
  return { id, ...result };
}

export async function handleInbound(db, { phone, profileName, text, waId }) {
  if (waId && db.prepare('SELECT 1 FROM messages WHERE wa_message_id = ?').get(waId)) return { duplicate: true };
  const customer = upsertCustomer(db, phone, profileName);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const result = await understand(text, products);

  const msgId = saveMessage(db, customer.id, 'in', 'customer', text, { intent: result.intent, waId });
  db.prepare('UPDATE customers SET last_inbound_at = ?, followup_sent_at = NULL WHERE id = ?').run(now(), customer.id);

  const reply = buildReply(db, customer.id, msgId, text, result);
  if (reply) await sendToCustomer(db, customer.id, reply, 'ai');
  return { intent: result.intent, engine: result.engine };
}

function buildReply(db, customerId, msgId, text, result) {
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

  switch (result.intent) {
    case 'greeting':
      return `Hi${customer().name ? ' ' + customer().name : ''}! Welcome to ${s.business_name}. 🍰\n\n${priceList(products)}\n\nJust tell us what you'd like, e.g. "2 Original and 1 Cheese".`;
    case 'thanks':
      return `You're welcome! Let us know if you need anything else. 😊`;
    case 'price':
      if (result.items.length) {
        const q = quote(db, result.items);
        return `Here's your quote:\n${q.lines.join('\n')}\nSubtotal: ${rm(q.subtotal)}${q.discount ? `\nDiscount (${s.discount_pct}%): -${rm(q.discount)}` : ''}\nDelivery: ${q.deliveryFee ? rm(q.deliveryFee) : 'FREE'}\nTotal: ${rm(q.total)}\n\nReply "order" with the items to confirm.`;
      }
      return `${priceList(products)}\n\nOrder ${s.discount_min_qty}+ boxes and get ${s.discount_pct}% off. Free delivery above ${rm(s.free_delivery_min)}.`;
    case 'delivery':
      return `${s.delivery_info}\nDelivery fee is ${rm(s.delivery_fee)}, FREE for orders above ${rm(s.free_delivery_min)}.`;
    case 'discount':
      return `Current promo: ${s.discount_pct}% off when you order ${s.discount_min_qty} boxes or more (any flavour mix). Free delivery for orders above ${rm(s.free_delivery_min)}. 🎉`;
    case 'order':
    case 'details': {
      if (result.intent === 'order' && result.items.length) {
        const order = createOrder(db, customerId, msgId, result.items);
        const c = customer();
        const missing = [!c.name && 'your name', !c.address && 'your delivery address'].filter(Boolean);
        let msg = `Thank you! We've received order ${order.code}:\n${order.lines.join('\n')}` +
          `${order.discount ? `\nDiscount (${s.discount_pct}%): -${rm(order.discount)}` : ''}\nDelivery: ${order.deliveryFee ? rm(order.deliveryFee) : 'FREE'}\nTotal: ${rm(order.total)}`;
        if (order.outOfStock.length) msg += `\n\n⚠️ ${order.outOfStock.join(', ')} may be out of stock - the owner will confirm.`;
        msg += missing.length
          ? `\n\nTo prepare your invoice, please send ${missing.join(' and ')} like this:\nName: ...\nAddress: ...`
          : `\n\nThe owner will review it and send your invoice shortly.`;
        return msg;
      }
      const c = customer();
      const pending = db.prepare(`SELECT code FROM orders WHERE customer_id = ? AND status = 'pending_approval' ORDER BY id DESC LIMIT 1`).get(customerId);
      if (pending) return `Thanks ${c.name || ''}! Details saved for order ${pending.code}. The owner will send your invoice shortly.`;
      return `Thanks ${c.name || ''}, your details are saved. What would you like to order?`;
    }
    case 'payment': {
      const inv = db.prepare(`SELECT i.* FROM invoices i JOIN orders o ON o.id = i.order_id
        WHERE o.customer_id = ? AND i.status = 'approved' AND i.payment_status = 'unpaid' ORDER BY i.id DESC LIMIT 1`).get(customerId);
      if (!inv) {
        escalate(db, customerId, msgId, text, 'Customer says they paid but no unpaid invoice was found');
        return `Thank you! Let me check this with the owner and get back to you shortly.`;
      }
      db.prepare(`UPDATE invoices SET payment_status = 'reported' WHERE id = ?`).run(inv.id);
      audit(db, 'customer', 'payment_reported', 'invoice', inv.id, text);
      return `Thank you! We've noted your payment for invoice ${inv.invoice_no}. The owner will verify it and we'll start packing right away. 📦`;
    }
    case 'order_status': {
      const o = db.prepare(`SELECT * FROM orders WHERE customer_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1`).get(customerId);
      if (!o) return `We couldn't find an order under this number yet. Would you like to place one?`;
      return `Order ${o.code}: ${ORDER_STATUSES[o.status]}.`;
    }
    default:
      escalate(db, customerId, msgId, text, 'AI could not answer this confidently');
      return `Thanks for your message! I'm checking this with the owner and will get back to you shortly. 🙏`;
  }
}

function priceList(products) {
  return 'Our kek lapis (per box):\n' + products.map(p => `• ${p.name} - ${rm(p.price)}${p.stock <= 0 ? ' (sold out)' : ''}`).join('\n');
}

function escalate(db, customerId, msgId, question, reason) {
  db.prepare('INSERT INTO escalations (customer_id, message_id, question, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(customerId, msgId, question, reason, now());
  audit(db, 'ai', 'escalated_to_owner', 'customer', customerId, question);
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

  const body = `🧾 Invoice ${invoiceNo} - ${s.business_name}\nOrder ${order.code}\n${order.items.map(i => `• ${i.qty} x ${i.name} = ${rm(i.line_total)}`).join('\n')}` +
    `${order.discount ? `\nDiscount: -${rm(order.discount)}` : ''}\nDelivery: ${order.delivery_fee ? rm(order.delivery_fee) : 'FREE'}\nTOTAL: ${rm(order.total)}` +
    `\n\nPlease pay by ${new Date(due).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })} to:\n${s.bank_details}\nReply "paid" once you've transferred. Thank you! 🙏`;
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
  if (notify) await sendToCustomer(db, order.customer_id, `Sorry, we're unable to proceed with order ${order.code}: ${reason}`, 'owner');
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
  await sendToCustomer(db, order.customer_id, `✅ Payment received for ${inv.invoice_no}. Thank you! We'll pack your order ${order.code} now.`, 'system');
}

const STATUS_MESSAGES = {
  packing: code => `📦 Your order ${code} is being packed.`,
  out_for_delivery: code => `🚚 Your order ${code} is out for delivery!`,
  delivered: code => `🎉 Order ${code} has been delivered. Enjoy your kek lapis! We'd love your feedback.`,
};

export async function updateOrderStatus(db, orderId, status, actor = 'staff') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'Order not found');
  const flow = ['paid', 'packing', 'out_for_delivery', 'delivered'];
  if (!STATUS_MESSAGES[status] || flow.indexOf(status) !== flow.indexOf(order.status) + 1) {
    throw httpError(409, `Cannot move order from "${order.status}" to "${status}"`);
  }
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), orderId);
  audit(db, actor, `order_${status}`, 'order', orderId, order.code);
  await sendToCustomer(db, order.customer_id, STATUS_MESSAGES[status](order.code), 'system');
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
    await sendToCustomer(db, c.id, `Hi${c.name ? ' ' + c.name : ''}! Just checking in from ${s.business_name} 😊 Still thinking about some kek lapis? Reply with what you'd like and we'll get it ready. Order ${s.discount_min_qty}+ boxes for ${s.discount_pct}% off!`, 'ai');
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
    await sendToCustomer(db, inv.customer_id, `Friendly reminder: invoice ${inv.invoice_no} for order ${inv.code} (${rm(inv.amount)}) is now due. Please transfer to ${s.bank_details} and reply "paid". Thank you! 🙏`, 'ai');
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
