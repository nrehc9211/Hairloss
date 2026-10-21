import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './http.js';
import { config, waEnabled } from './config.js';
import { initStore, resetStore, getDb, save, saveNow } from './store.js';
import { getOffsetMs, advanceHours, todayIso, nowIso } from './clock.js';
import { parseWebhook, verifySignature } from './whatsapp/webhook.js';
import { handleIncoming, recordPayment, runReminders, sendWeeklySummary, computeSummary, approveOrder } from './flows/orderFlow.js';
import * as inbox from './inbox/index.js';
import { orbyte } from './orbyte/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Scripted demo: three customers write at once, one of them spams. */
export const SCENARIO = [
  { from: '60120000012', name: 'Mei Ling', text: 'Do you still have cheesecake? How much?', minutesAgo: 35 },
  { from: '60120000011', name: 'Aina', text: 'I want 2 chocolate cakes for Saturday, urgent please', minutesAgo: 22 },
  { from: '60120000014', name: 'Kevin', text: 'How much is the red velvet? Shopee is a bit cheaper', minutesAgo: 18 },
  { from: '60120000013', name: 'Ali', text: 'hello', minutesAgo: 9 },
  { from: '60120000013', name: 'Ali', text: 'hi??', minutesAgo: 8 },
  { from: '60120000013', name: 'Ali', text: 'got pandan cake?', minutesAgo: 8 },
  { from: '60120000013', name: 'Ali', text: '??', minutesAgo: 1 },
  { from: '60120000013', name: 'Ali', text: 'please reply', minutesAgo: 0 },
];

export async function runScenario() {
  for (const s of SCENARIO) {
    await handleIncoming({ from: s.from, name: s.name, type: 'text', text: s.text }, 'sim');
    // Aina taps "Correct" on her order summary, so her order now waits for the owner
    const pending = getDb().orders.find((o) => o.status === 'awaiting_confirm' && orbyte.crm.getCustomer(o.customerId)?.phone === s.from);
    if (pending) await handleIncoming({ from: s.from, type: 'button', buttonId: `confirm:${pending.id}`, text: '✅ Correct' }, 'sim');
  }
  // Backdate the first unanswered message so the queue shows realistic waits (demo only).
  const firstAgo = {};
  for (const s of SCENARIO) firstAgo[s.from] = Math.max(firstAgo[s.from] ?? 0, s.minutesAgo);
  for (const c of getDb().conversations) {
    const ago = firstAgo[c.phone];
    if (ago == null) continue;
    const shift = (iso) => (iso ? new Date(Date.parse(iso) - ago * 60e3).toISOString() : iso);
    c.firstUnansweredAt = shift(c.firstUnansweredAt);
  }
  save();
  return { sent: SCENARIO.length };
}

function publicConversation(c) {
  const { wait, score } = inbox.priority(c);
  const msgs = getDb().messages
    .filter((m) => (m.direction === 'in' && m.from === c.phone) || (m.direction === 'out' && m.to === c.phone))
    .slice(-30)
    .map(({ id, ts, direction, type, text, caption, filename, url, buttons }) => ({ id, ts, direction, type, text: text || caption || (filename ? `📄 ${filename}` : ''), url, buttons }));
  const order = [...getDb().orders].reverse().find((o) => o.customerId === c.customerId && o.channel !== 'seed');
  return { ...c, wait, score, messages: msgs, latestOrder: order ? { id: order.id, status: order.status, total: order.total, invoiceId: order.invoiceId } : null };
}

export function buildApp() {
  const app = createApp();

  // ---------------- WhatsApp Cloud API webhook ----------------
  app.get('/webhook', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.wa.verifyToken;
    if (ok) return res.send(req.query['hub.challenge']);
    return res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // answer fast; WhatsApp retries slow webhooks
    const msgs = parseWebhook(req.body);
    (async () => {
      for (const m of msgs) {
        try { await handleIncoming(m, 'wa'); } catch (err) { console.error('[webhook] failed:', err); }
      }
    })();
  });

  // ---------------- Simulator (no WhatsApp needed) ----------------
  app.post('/api/sim/send', async (req, res) => {
    const { from, type = 'text', text, buttonId, title, transcript, caption, mediaBase64, mimeType, name } = req.body;
    if (!from) return res.json({ error: 'from is required' }, 400);
    const msg = { from: String(from).replace(/\D/g, ''), type, name, text: type === 'button' ? title : text, buttonId, transcript, caption, mediaBase64, mimeType };
    const result = await handleIncoming(msg, 'sim');
    res.json({ ok: true, handled: result?.handled });
  });

  app.get('/api/sim/messages', (req, res) => {
    const since = req.query.since || '';
    res.json(getDb().messages.filter((m) => m.channel === 'sim' && m.id > since));
  });

  // ---------------- Inbox (the new main screen) ----------------
  app.get('/api/inbox', (_req, res) => {
    const db = getDb();
    const q = inbox.queue();
    res.json({
      now: nowIso(),
      today: todayIso(),
      clockOffsetMs: getOffsetMs(),
      mode: { whatsapp: waEnabled() ? 'cloud' : 'simulator-only', ai: config.ai.provider },
      stats: inbox.inboxStats(),
      approverToday: orbyte.people.getApprover(),
      followUpSettings: db.settings.followUp,
      waiting: q.waiting.map(publicConversation),
      followUps: q.followUps.map(publicConversation),
      others: q.others.map(publicConversation),
    });
  });

  const withConv = (fn) => async (req, res) => {
    const c = inbox.findConversation(req.params.id);
    if (!c) return res.json({ error: 'conversation not found' }, 404);
    const owner = orbyte.people.byRole('owner');
    const r = await fn(c, req.body || {}, owner);
    res.json(r, r?.ok === false ? 400 : 200);
  };
  app.post('/api/inbox/:id/reply', withConv((c, b, owner) => inbox.replyFromInbox(c, { text: b.text, by: owner.name, usedSuggestion: Boolean(b.usedSuggestion) })));
  app.post('/api/inbox/:id/tag', withConv((c, b, owner) => inbox.editTag(c, b.group, b.value, owner.name)));
  app.post('/api/inbox/:id/followup/send', withConv((c, b, owner) => inbox.sendFollowUp(c, { by: owner.name, text: b.text, edited: Boolean(b.text && b.text !== c.followUp.draft) })));
  app.post('/api/inbox/:id/followup/stop', withConv((c, _b, owner) => { inbox.stopFollowUps(c, 'Owner stopped follow-up in Orbyte inbox', owner.name); return { ok: true }; }));
  app.post('/api/orders/:id/approve', async (req, res) => {
    const r = await approveOrder(req.params.id, orbyte.people.byRole('owner'));
    res.json({ ok: r.handled === 'approved', handled: r.handled }, r.handled === 'approved' ? 200 : 400);
  });

  // ---------------- Orders dashboard ----------------
  app.get('/api/state', (_req, res) => {
    const db = getDb();
    const name = (id) => db.customers.find((c) => c.id === id)?.name || id;
    res.json({
      today: todayIso(),
      clockOffsetMs: getOffsetMs(),
      mode: { whatsapp: waEnabled() ? 'cloud' : 'simulator-only', ai: config.ai.provider },
      business: db.business,
      settings: db.settings,
      staff: db.staff.map((s) => ({ ...s, onLeave: orbyte.people.isOnLeave(s.id) })),
      approverToday: orbyte.people.getApprover(),
      customers: db.customers,
      orders: [...db.orders].reverse().map((o) => ({ ...o, customerName: name(o.customerId) })),
      invoices: [...db.invoices].reverse().map((i) => ({ ...i, customerName: name(i.customerId) })),
      audit: [...db.audit].reverse().slice(0, 300),
      summary: computeSummary(),
    });
  });

  app.post('/api/settings', (req, res) => {
    const db = getDb();
    const { autoApprove, customerConfirm, followUpEnabled } = req.body || {};
    const owner = orbyte.people.byRole('owner');
    if (autoApprove) {
      db.settings.autoApprove = {
        enabled: Boolean(autoApprove.enabled),
        maxTotal: Math.max(0, Number(autoApprove.maxTotal) || 0),
        trustedOnly: autoApprove.trustedOnly !== false,
      };
      orbyte.audit.log({
        actor: owner?.name || 'Owner', actorType: 'staff', action: 'settings.auto_approve',
        detail: db.settings.autoApprove.enabled
          ? `Auto-approve ON: ${db.settings.autoApprove.trustedOnly ? 'trusted customers, ' : ''}no flags, ≤ RM${db.settings.autoApprove.maxTotal}`
          : 'Auto-approve OFF: every order needs a human',
      });
    }
    if (typeof customerConfirm === 'boolean') db.settings.customerConfirm = customerConfirm;
    if (typeof followUpEnabled === 'boolean') {
      db.settings.followUp.enabled = followUpEnabled;
      orbyte.audit.log({ actor: owner?.name || 'Owner', actorType: 'staff', action: 'settings.follow_up', detail: followUpEnabled ? 'Follow-ups ON' : 'Follow-ups OFF' });
    }
    save();
    res.json(db.settings);
  });

  // mock Orbyte eLeave: put a staff member on leave today
  app.post('/api/demo/leave', (req, res) => {
    const db = getDb();
    const { staffId, onLeave } = req.body;
    const t = todayIso();
    db.leave = db.leave.filter((l) => !(l.staffId === staffId && l.from <= t && t <= l.to));
    if (onLeave) db.leave.push({ staffId, from: t, to: t, status: 'approved', source: 'Orbyte eLeave (mock)' });
    const s = db.staff.find((x) => x.id === staffId);
    orbyte.audit.log({ actor: 'Orbyte eLeave', actorType: 'connect', action: 'leave.updated', detail: `${s?.name} ${onLeave ? 'on approved leave today' : 'back at work'}` });
    save();
    res.json({ ok: true, approverToday: orbyte.people.getApprover() });
  });

  // demo clock: jump forward, then run the jobs (follow-ups + payment reminders)
  app.post('/api/demo/advance', async (req, res) => {
    const hours = Number(req.body?.hours ?? (Number(req.body?.days || 1) * 24));
    advanceHours(hours);
    getDb().clockOffsetMs = getOffsetMs();
    const followUps = await inbox.runFollowUps();
    const remindersSent = await runReminders();
    saveNow();
    res.json({ now: nowIso(), today: todayIso(), followUps, remindersSent });
  });
  app.post('/api/demo/scenario', async (_req, res) => res.json(await runScenario()));
  app.post('/api/demo/followups', async (_req, res) => res.json({ followUps: await inbox.runFollowUps() }));
  app.post('/api/demo/reminders', async (_req, res) => res.json({ remindersSent: await runReminders() }));
  app.post('/api/demo/summary', async (_req, res) => res.json(await sendWeeklySummary()));
  app.post('/api/demo/reset', (_req, res) => { resetStore(); res.json({ ok: true }); });

  // ---------------- Payments (mock Orbyte Connect Payments) ----------------
  app.get('/pay/:invoiceId', (_req, res) => res.sendFile(path.resolve(here, '../public/pay.html')));
  app.get('/api/invoices/:id', (req, res) => {
    const db = getDb();
    const inv = db.invoices.find((i) => i.id === req.params.id);
    if (!inv) return res.json({ error: 'not found' }, 404);
    res.json({ ...inv, customer: db.customers.find((c) => c.id === inv.customerId), business: db.business });
  });
  // A real payment gateway would call this. The pay page calls it to simulate a payment.
  app.post('/api/payments/webhook', async (req, res) => {
    try { res.json(await recordPayment(req.body.invoiceId, { method: req.body.method })); } catch (err) { res.json({ error: err.message }, 400); }
  });

  app.get('/health', (_req, res) => res.json({ ok: true, now: nowIso(), whatsapp: waEnabled(), ai: config.ai.provider }));

  app.static('/invoices/', path.join(config.dataDir, 'invoices'));
  app.static('/', path.resolve(here, '../public'));
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  initStore();
  buildApp().listen(config.port, () => {
    console.log(`\nOrderLah running on ${config.baseUrl}`);
    console.log(`  Inbox     : ${config.baseUrl}/inbox.html`);
    console.log(`  Simulator : ${config.baseUrl}/simulator.html`);
    console.log(`  Orders    : ${config.baseUrl}/dashboard.html`);
    console.log(`  WhatsApp  : ${waEnabled() ? 'Cloud API ON (webhook at /webhook)' : 'OFF — simulator only'}`);
    console.log(`  AI        : ${config.ai.provider}\n`);
  });
  // jobs: follow-ups every minute, payment reminders every hour
  setInterval(() => inbox.runFollowUps().catch((e) => console.error('[follow-ups]', e)), 60e3);
  setInterval(() => runReminders().catch((e) => console.error('[reminders]', e)), 3600e3);
}
