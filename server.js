// Orbyte SmartDesk server - zero dependencies (Node >= 22.5).
//   node server.js           start on http://localhost:3000
//   node server.js --reset   wipe the database and start fresh
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getSettings, audit } from './src/db.js';
import * as svc from './src/service.js';
import * as whatsapp from './src/whatsapp.js';
import * as orbyte from './src/orbyte.js';
import { engineName } from './src/ai.js';

const PORT = Number(process.env.PORT || 3000);
const db = openDb({ reset: process.argv.includes('--reset') });
const PUBLIC = path.resolve('public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

// ---------------------------------------------------------------- WhatsApp webhook
route('GET', '/webhook/whatsapp', ({ query }) => {
  const challenge = whatsapp.verifyWebhook(query);
  if (challenge === null) throw svc.httpError(403, 'Verification failed');
  return { raw: challenge };
});
route('POST', '/webhook/whatsapp', async ({ body }) => {
  for (const m of whatsapp.parseWebhook(body)) await svc.handleInbound(db, m);
  return { ok: true };
});

// Customer simulator - same pipeline as the real webhook
route('POST', '/api/simulate/inbound', async ({ body }) => {
  if (!body.phone || !body.text?.trim()) throw svc.httpError(400, 'phone and text are required');
  return svc.handleInbound(db, { phone: body.phone.replace(/\D/g, ''), profileName: body.name || null, text: body.text.trim(), waId: null });
});
route('GET', '/api/simulate/chat/:phone', ({ params }) => {
  const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(params.phone.replace(/\D/g, ''));
  return c ? db.prepare('SELECT * FROM messages WHERE customer_id = ? ORDER BY id').all(c.id) : [];
});

// ---------------------------------------------------------------- dashboard
route('GET', '/api/dashboard', () => {
  const one = sql => db.prepare(sql).get();
  return {
    settings: getSettings(db),
    integrations: { whatsapp: whatsapp.isLive() ? 'live' : 'simulated', orbyte: orbyte.isLive() ? 'live' : 'mock', ai: engineName() },
    openQuestions: one(`SELECT COUNT(*) n FROM escalations WHERE status = 'open'`).n,
    pendingInvoices: one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM invoices WHERE status = 'pending'`),
    outstanding: one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM invoices WHERE status = 'approved' AND payment_status != 'paid'`),
    overdue: one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM invoices WHERE status = 'approved' AND payment_status = 'unpaid' AND due_date <= '${new Date().toISOString()}'`),
    paymentReported: one(`SELECT COUNT(*) n FROM invoices WHERE payment_status = 'reported'`).n,
    collected: one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM invoices WHERE payment_status = 'paid'`),
    toPack: one(`SELECT COUNT(*) n FROM orders WHERE status IN ('paid','packing')`).n,
    aiReplies: one(`SELECT COUNT(*) n FROM messages WHERE sender = 'ai'`).n,
    ownerReplies: one(`SELECT COUNT(*) n FROM messages WHERE sender = 'owner'`).n,
    autoMessages: one(`SELECT COUNT(*) n FROM messages WHERE sender IN ('ai','system')`).n,
    followups: one(`SELECT COUNT(*) n FROM audit_log WHERE action = 'followup_sent'`).n,
    reminders: one(`SELECT COUNT(*) n FROM audit_log WHERE action = 'payment_reminder_sent'`).n,
    customers: one(`SELECT COUNT(*) n FROM customers`).n,
    intents: db.prepare(`SELECT intent, COUNT(*) n FROM messages WHERE direction = 'in' GROUP BY intent ORDER BY n DESC`).all(),
    recent: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 12').all(),
  };
});

// ---------------------------------------------------------------- inbox
route('GET', '/api/escalations', ({ query }) => db.prepare(`
  SELECT e.*, c.phone, c.name FROM escalations e JOIN customers c ON c.id = e.customer_id
  WHERE e.status = ? ORDER BY e.created_at ${query.get('status') === 'resolved' ? 'DESC' : 'ASC'}`).all(query.get('status') || 'open'));
route('POST', '/api/escalations/:id/resolve', ({ params }) => (svc.resolveEscalation(db, Number(params.id)), { ok: true }));

route('GET', '/api/customers', () => db.prepare(`
  SELECT c.*, (SELECT body FROM messages m WHERE m.customer_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
         (SELECT COUNT(*) FROM escalations e WHERE e.customer_id = c.id AND e.status = 'open') AS open_questions
  FROM customers c ORDER BY c.last_activity_at DESC`).all());
route('GET', '/api/customers/:id', ({ params }) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(params.id));
  if (!c) throw svc.httpError(404, 'Customer not found');
  c.messages = db.prepare('SELECT * FROM messages WHERE customer_id = ? ORDER BY id').all(c.id);
  c.escalations = db.prepare(`SELECT * FROM escalations WHERE customer_id = ? AND status = 'open' ORDER BY id`).all(c.id);
  c.orders = db.prepare('SELECT id, code, status, total, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  return c;
});
route('POST', '/api/customers/:id/reply', async ({ params, body }) => {
  const id = Number(params.id);
  const result = await svc.ownerReply(db, id, body.text);
  if (body.resolve) for (const e of db.prepare(`SELECT id FROM escalations WHERE customer_id = ? AND status = 'open'`).all(id)) svc.resolveEscalation(db, e.id);
  return result;
});
route('PATCH', '/api/customers/:id', ({ params, body }) => {
  const id = Number(params.id);
  db.prepare('UPDATE customers SET name = COALESCE(?, name), address = COALESCE(?, address) WHERE id = ?').run(body.name ?? null, body.address ?? null, id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  db.prepare(`UPDATE orders SET customer_name = ?, address = ? WHERE customer_id = ? AND status = 'pending_approval'`).run(c.name, c.address, id);
  audit(db, 'owner', 'customer_details_edited', 'customer', id, `${c.name} / ${c.address}`);
  return c;
});

// ---------------------------------------------------------------- orders
route('GET', '/api/orders', ({ query }) => {
  const status = query.get('status');
  return db.prepare(`SELECT o.*, c.phone, i.status AS invoice_status, i.invoice_no, i.payment_status,
      (SELECT GROUP_CONCAT(qty || 'x ' || name, ', ') FROM order_items WHERE order_id = o.id) AS summary
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN invoices i ON i.order_id = o.id
    ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC`).all(...(status ? [status] : []))
    .map(o => ({ ...o, status_label: svc.ORDER_STATUSES[o.status] }));
});
route('GET', '/api/orders/:id', ({ params }) => {
  const o = svc.getOrder(db, Number(params.id));
  if (!o) throw svc.httpError(404, 'Order not found');
  return o;
});
route('POST', '/api/orders/:id/status', async ({ params, body }) => (await svc.updateOrderStatus(db, Number(params.id), body.status, body.actor || 'staff'), { ok: true }));

// ---------------------------------------------------------------- invoices
route('GET', '/api/invoices', ({ query }) => {
  const status = query.get('status') || 'pending';
  return db.prepare(`SELECT i.*, o.code AS order_code, o.customer_name, o.status AS order_status, c.phone,
      (SELECT GROUP_CONCAT(qty || 'x ' || name, ', ') FROM order_items WHERE order_id = o.id) AS summary
    FROM invoices i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id
    WHERE i.status = ? ORDER BY ${status === 'pending' ? 'i.created_at ASC' : 'i.id DESC'}`).all(status)
    .map(inv => {
      if (status !== 'pending') return inv;
      const checks = svc.getOrder(db, inv.order_id).checks;
      return { ...inv, checks_failed: checks.filter(c => c.status === 'fail').length, checks_warn: checks.filter(c => c.status === 'warn').length };
    });
});
route('POST', '/api/invoices/:id/approve', ({ params, body }) => svc.approveInvoice(db, Number(params.id), { override: Boolean(body.override) }));
route('POST', '/api/invoices/:id/reject', async ({ params, body }) => (await svc.rejectInvoice(db, Number(params.id), body), { ok: true }));
route('POST', '/api/invoices/:id/paid', async ({ params }) => (await svc.markPaid(db, Number(params.id)), { ok: true }));

// ---------------------------------------------------------------- settings, products, audit, automation
route('GET', '/api/settings', () => ({ settings: getSettings(db), products: db.prepare('SELECT * FROM products ORDER BY id').all() }));
route('PUT', '/api/settings', ({ body }) => {
  const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const [k, v] of Object.entries(body)) up.run(String(v), k);
  audit(db, 'owner', 'settings_updated', 'settings', null, Object.keys(body).join(', '));
  return getSettings(db);
});
route('PUT', '/api/products/:id', ({ params, body }) => {
  db.prepare('UPDATE products SET price = ?, stock = ?, active = ? WHERE id = ?').run(Number(body.price), Number(body.stock), body.active ? 1 : 0, Number(params.id));
  audit(db, 'owner', 'product_updated', 'product', Number(params.id), `RM${body.price}, stock ${body.stock}`);
  return { ok: true };
});
route('GET', '/api/audit', () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all());
route('POST', '/api/automations/run', () => svc.runAutomations(db));
route('POST', '/api/demo/time-travel', ({ body }) => (svc.timeTravel(db, Number(body.hours) || 49), { ok: true }));

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  try {
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (r) {
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        body = raw ? JSON.parse(raw) : {};
      }
      const result = await r.handler({ params, query: url.searchParams, body });
      return result?.raw !== undefined ? send(200, result.raw, 'text/plain') : send(200, result);
    }
    if (req.method !== 'GET') return send(404, { error: 'Not found' });
    // static files; unknown paths fall back to the SPA
    let file = path.join(PUBLIC, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (!err.status) console.error(err);
    send(err.status || 500, { error: err.message, ...(err.extra || {}) });
  }
});

// Background automations: follow-ups and payment reminders, every 5 minutes.
setInterval(() => svc.runAutomations(db).catch(e => console.error('[automations]', e)), 5 * 60_000);

server.listen(PORT, () => {
  console.log(`Orbyte SmartDesk running at http://localhost:${PORT}`);
  console.log(`  WhatsApp: ${whatsapp.isLive() ? 'LIVE' : 'simulated (set WA_TOKEN + WA_PHONE_NUMBER_ID)'}`);
  console.log(`  Orbyte:   ${orbyte.isLive() ? 'LIVE' : 'mock (set ORBYTE_API_URL + ORBYTE_API_KEY)'}`);
});
