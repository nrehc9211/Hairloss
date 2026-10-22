// Orbyte SmartDesk front-end (plain JS, hash routing, polls the API every few seconds).
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
// Only touch the DOM when content changed, so polling never interrupts a click.
const setHTML = (el, html) => { if (el && el.innerHTML !== html) { el.innerHTML = html; return true; } return false; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rm = n => 'RM' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
const ago = iso => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="card">${html}</div>`;
  m.classList.remove('hidden');
  m.onclick = e => { if (e.target === m) closeModal(); };
  return m;
}
const closeModal = () => $('#modal').classList.add('hidden');

const ORDER_BADGE = {
  pending_approval: 'warn', awaiting_payment: '', paid: 'ok', packing: '', out_for_delivery: '', delivered: 'ok', cancelled: 'grey',
};
const statusBadge = o => `<span class="badge ${ORDER_BADGE[o.status] ?? ''}">${esc(o.status_label || o.status)}</span>`;
function paymentBadge(inv) {
  if (inv.payment_status === 'paid') return '<span class="badge ok">Paid</span>';
  if (inv.payment_status === 'reported') return '<span class="badge warn">Customer says paid - verify</span>';
  if (inv.due_date && Date.parse(inv.due_date) < Date.now()) return '<span class="badge bad">Overdue</span>';
  return '<span class="badge">Unpaid</span>';
}
const senderTag = m => m.sender === 'customer' ? '' : `<span class="tag ${m.sender}">${m.sender === 'ai' ? 'AI auto-reply' : m.sender === 'owner' ? 'You' : 'System'}</span>`;

// ------------------------------------------------------------------ router
const pages = {};
let current = null, pollTimer = null;

async function router() {
  const [, page = 'dashboard', id] = location.hash.split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  clearInterval(pollTimer);
  current = pages[page] || pages.dashboard;
  try {
    await current.render(id);
  } catch (e) { view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
  if (current.refresh) pollTimer = setInterval(() => current.refresh(id).catch(() => {}), 3000);
}
window.addEventListener('hashchange', router);

async function refreshBadges() {
  try {
    const d = await api('/api/dashboard');
    $('#nav-inbox').textContent = d.openQuestions || '';
    $('#nav-invoices').textContent = (d.pendingInvoices.n + d.paymentReported) || '';
    $('#biz-name').innerHTML = `${esc(d.settings.business_name)}<br><span class="small">WhatsApp: ${d.integrations.whatsapp} · Orbyte: ${d.integrations.orbyte}</span>`;
  } catch {}
}
setInterval(refreshBadges, 4000);

// ------------------------------------------------------------------ dashboard
pages.dashboard = {
  async render() {
    const d = await api('/api/dashboard');
    const minutesSaved = d.autoMessages * 2 + d.followups * 3 + d.reminders * 3;
    view.innerHTML = `
      <div class="row"><div><h1>Good day, ${esc(d.settings.owner_name)} 👋</h1>
      <p class="sub">Here is what SmartDesk handled for ${esc(d.settings.business_name)} and what needs you.</p></div>
      <div class="spacer"></div><button class="btn" id="run-auto">Run follow-ups & reminders now</button></div>

      <div class="grid kpis">
        <a class="card kpi ${d.openQuestions ? 'alert' : ''}" href="#/inbox"><div class="label">Questions for you</div><div class="value">${d.openQuestions}</div><div class="hint">AI couldn't answer these</div></a>
        <a class="card kpi ${d.pendingInvoices.n ? 'alert' : ''}" href="#/invoices"><div class="label">Invoices to approve</div><div class="value">${d.pendingInvoices.n}</div><div class="hint">${rm(d.pendingInvoices.amt)}</div></a>
        <a class="card kpi" href="#/invoices"><div class="label">Outstanding</div><div class="value">${rm(d.outstanding.amt)}</div><div class="hint">${d.outstanding.n} invoice(s)${d.paymentReported ? ` · ${d.paymentReported} to verify` : ''}</div></a>
        <a class="card kpi ${d.overdue.n ? 'alert' : ''}" href="#/invoices"><div class="label">Overdue</div><div class="value">${rm(d.overdue.amt)}</div><div class="hint">${d.overdue.n} invoice(s) · auto-reminded</div></a>
        <div class="card kpi"><div class="label">Collected</div><div class="value">${rm(d.collected.amt)}</div><div class="hint">${d.collected.n} paid invoice(s)</div></div>
        <a class="card kpi" href="#/orders"><div class="label">To pack / deliver</div><div class="value">${d.toPack}</div><div class="hint">for packing & delivery staff</div></a>
      </div>

      <div class="grid two">
        <div class="card">
          <h2>Recent activity</h2>
          ${d.recent.length ? `<table><tbody>${d.recent.map(a => `<tr><td class="small muted" style="width:120px">${fmtTime(a.created_at)}</td><td><span class="tag ${a.actor === 'ai' ? 'ai' : a.actor === 'owner' ? 'owner' : 'system'}">${esc(a.actor)}</span> ${esc(a.action.replace(/_/g, ' '))} <span class="muted">${esc(a.detail || '')}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No activity yet. Try the Customer Simulator.</div>'}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card">
            <h2>Automation impact</h2>
            <div class="kv">
              <dt>Auto messages</dt><dd>${d.autoMessages}</dd>
              <dt>Your replies</dt><dd>${d.ownerReplies}</dd>
              <dt>Follow-ups sent</dt><dd>${d.followups}</dd>
              <dt>Pay reminders</dt><dd>${d.reminders}</dd>
              <dt>Time saved (est.)</dt><dd>${minutesSaved >= 60 ? (minutesSaved / 60).toFixed(1) + ' h' : minutesSaved + ' min'}</dd>
            </div>
            <p class="small muted">Estimate: 2 min per auto-reply, 3 min per follow-up/reminder.</p>
          </div>
          <div class="card integr">
            <h2>Connections</h2>
            <div><span>WhatsApp Business</span><span class="badge ${d.integrations.whatsapp === 'live' ? 'ok' : 'warn'}">${d.integrations.whatsapp}</span></div>
            <div><span>Orbyte invoices</span><span class="badge ${d.integrations.orbyte === 'live' ? 'ok' : 'warn'}">${d.integrations.orbyte}</span></div>
            <div><span>AI engine</span><span class="small">${esc(d.integrations.ai)}</span></div>
          </div>
          <div class="card">
            <h2>Sustainable Development Goals</h2>
            <div class="sdg"><span style="background:#a21942">SDG 8 Decent work & growth</span><span style="background:#fd6925">SDG 9 Innovation</span><span style="background:#bf8b2e">SDG 12 Less waste (paperless)</span></div>
          </div>
        </div>
      </div>`;
    $('#run-auto').onclick = async () => {
      const r = await api('/api/automations/run', { method: 'POST' });
      toast(`Sent ${r.followups} follow-up(s), ${r.paymentReminders} payment reminder(s)${r.escalated ? `, ${r.escalated} escalated to you` : ''}`);
      this.render();
    };
  },
};

// ------------------------------------------------------------------ inbox
const inbox = { tab: 'open', customerId: null, lastCount: -1 };
pages.inbox = {
  async render(id) {
    if (id) inbox.customerId = Number(id);
    view.innerHTML = `
      <h1>Inbox</h1><p class="sub">The AI answers routine questions. Questions it can't answer wait here, oldest first. Replies you send go straight to the customer's WhatsApp.</p>
      <div class="inbox">
        <div class="card qlist">
          <div class="qlist-head chips" style="margin:0">
            <span class="chip ${inbox.tab === 'open' ? 'active' : ''}" data-tab="open">Needs reply</span>
            <span class="chip ${inbox.tab === 'all' ? 'active' : ''}" data-tab="all">All chats</span>
            <span class="chip ${inbox.tab === 'resolved' ? 'active' : ''}" data-tab="resolved">Resolved</span>
          </div>
          <div class="qlist-body" id="qlist"></div>
        </div>
        <div class="card chat" id="chat"><div class="empty" style="margin:auto">Select a question to open the WhatsApp chat.</div></div>
      </div>`;
    view.querySelectorAll('[data-tab]').forEach(c => c.onclick = () => { inbox.tab = c.dataset.tab; this.render(); });
    await this.refresh();
  },
  async refresh() {
    const list = $('#qlist');
    if (!list) return;
    if (inbox.tab === 'all') {
      const customers = await api('/api/customers');
      setHTML(list, customers.length ? customers.map(c => `
        <div class="qitem ${c.id === inbox.customerId ? 'active' : ''}" data-cid="${c.id}">
          <div class="who">${esc(c.name || '+' + c.phone)} ${c.open_questions ? `<span class="badge bad">${c.open_questions}</span>` : ''}<time>${c.last_activity_at ? ago(c.last_activity_at) : ''}</time></div>
          <div class="q muted">${esc(c.last_message || '')}</div></div>`).join('') : '<div class="empty">No chats yet</div>');
    } else {
      const items = await api('/api/escalations?status=' + inbox.tab);
      setHTML(list, items.length ? items.map(e => `
        <div class="qitem ${e.customer_id === inbox.customerId ? 'active' : ''}" data-cid="${e.customer_id}">
          <div class="who">${esc(e.name || '+' + e.phone)}<time title="${fmtTime(e.created_at)}">${ago(e.created_at)}</time></div>
          <div class="q">${esc(e.question)}</div>
          <div class="small muted" style="margin-top:4px">${esc(e.reason)}</div></div>`).join('')
        : `<div class="empty">${inbox.tab === 'open' ? '🎉 All caught up. No unanswered questions.' : 'Nothing here yet'}</div>`);
    }
    list.querySelectorAll('[data-cid]').forEach(el => el.onclick = () => { inbox.customerId = Number(el.dataset.cid); inbox.lastCount = -1; this.refresh(); });
    if (inbox.customerId) await this.loadChat();
  },
  async loadChat() {
    const c = await api('/api/customers/' + inbox.customerId);
    const chat = $('#chat');
    const flagged = new Set(c.escalations.map(e => e.message_id));
    const fresh = !chat.dataset.cid || Number(chat.dataset.cid) !== c.id;
    if (fresh) {
      chat.dataset.cid = c.id;
      chat.innerHTML = `
        <div class="chat-head">
          <div class="avatar">${esc((c.name || '?')[0].toUpperCase())}</div>
          <div><div style="font-weight:600">${esc(c.name || 'Unknown customer')}</div><div class="small muted">+${esc(c.phone)} · ${esc(c.address || 'no address yet')}</div></div>
          <div class="spacer"></div>
          <span id="chat-orders"></span>
          <button class="btn sm" id="edit-cust">Edit details</button>
        </div>
        <div id="esc-banner"></div>
        <div class="chat-body" id="chat-body"></div>
        <div class="chat-foot">
          <textarea id="reply" placeholder="Type a reply to send on WhatsApp…"></textarea>
          <div><label class="row small" style="gap:6px;margin-bottom:6px;white-space:nowrap"><input type="checkbox" id="resolve" checked style="width:auto"> Mark resolved</label>
          <button class="btn primary" id="send" style="width:100%">Send</button></div>
        </div>`;
      $('#send').onclick = async () => {
        const text = $('#reply').value.trim();
        if (!text) return;
        $('#send').disabled = true;
        try {
          await api(`/api/customers/${c.id}/reply`, { method: 'POST', body: { text, resolve: $('#resolve').checked } });
          $('#reply').value = '';
          toast('Sent to WhatsApp');
          inbox.lastCount = -1;
          await this.refresh();
        } catch (e) { toast(e.message, true); }
        $('#send').disabled = false;
      };
      $('#reply').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').click(); } };
      $('#edit-cust').onclick = () => editCustomer(c, () => { chat.dataset.cid = ''; this.loadChat(); });
      inbox.lastCount = -1;
    }
    $('#chat-orders').innerHTML = c.orders.slice(0, 3).map(o => `<a class="badge" href="#/orders/${o.id}">${o.code}</a>`).join(' ');
    $('#esc-banner').innerHTML = c.escalations.length ? `<div class="esc-banner">⚠ ${c.escalations.length} unanswered question(s) - highlighted below.</div>` : '';
    const key = c.messages.length + ':' + c.escalations.length;
    if (key === inbox.lastCount) return;
    inbox.lastCount = key;
    const body = $('#chat-body');
    body.innerHTML = c.messages.map(m => `
      <div class="bubble ${m.direction} ${flagged.has(m.id) ? 'flag' : ''}">${senderTag(m)}${esc(m.body)}
        <div class="meta">${m.direction === 'in' && m.intent ? `<span class="tag intent">${esc(m.intent)}</span>` : ''}${fmtTime(m.created_at)}${m.direction === 'out' ? (m.delivery === 'sent' ? ' ✓✓' : m.delivery === 'failed' ? ' ⚠ failed' : ' ✓') : ''}</div></div>`).join('');
    body.scrollTop = body.scrollHeight;
  },
};

function editCustomer(c, done) {
  const m = modal(`<h2>Customer details</h2>
    <label>Name</label><input id="m-name" value="${esc(c.name || '')}">
    <label style="margin-top:10px">Delivery address</label><textarea id="m-addr" rows="3">${esc(c.address || '')}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn" id="m-cancel">Cancel</button><button class="btn primary" id="m-save">Save</button></div>`);
  $('#m-cancel', m).onclick = closeModal;
  $('#m-save', m).onclick = async () => {
    await api('/api/customers/' + c.id, { method: 'PATCH', body: { name: $('#m-name').value.trim() || null, address: $('#m-addr').value.trim() || null } });
    closeModal(); toast('Customer updated'); done();
  };
}

// ------------------------------------------------------------------ orders
const ordersState = { status: '' };
pages.orders = {
  async render(id) {
    if (id) return orderDetail(Number(id));
    const filters = [['', 'All'], ['pending_approval', 'Awaiting approval'], ['awaiting_payment', 'Awaiting payment'], ['paid', 'Paid - to pack'], ['packing', 'Packing'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']];
    view.innerHTML = `<h1>Orders</h1><p class="sub">Every order captured from WhatsApp, with where it is right now.</p>
      <div class="chips">${filters.map(([k, l]) => `<span class="chip ${ordersState.status === k ? 'active' : ''}" data-s="${k}">${l}</span>`).join('')}</div>
      <div class="card" style="padding:0"><table><thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Invoice</th><th>Created</th></tr></thead><tbody id="orders"></tbody></table></div>`;
    view.querySelectorAll('[data-s]').forEach(c => c.onclick = () => { ordersState.status = c.dataset.s; this.render(); });
    await this.refresh();
  },
  async refresh(id) {
    if (id) return;
    const rows = await api('/api/orders' + (ordersState.status ? '?status=' + ordersState.status : ''));
    const tb = $('#orders');
    if (!tb) return;
    setHTML(tb, rows.length ? rows.map(o => `
      <tr class="click" data-id="${o.id}"><td class="mono"><b>${o.code}</b></td><td>${esc(o.customer_name || '+' + o.phone)}</td>
      <td class="small">${esc(o.summary)}</td><td><b>${rm(o.total)}</b></td><td>${statusBadge(o)}</td>
      <td class="small">${o.invoice_no ? esc(o.invoice_no) : `<span class="muted">${o.invoice_status || '-'}</span>`}</td><td class="small muted">${fmtTime(o.created_at)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">No orders</td></tr>');
    tb.querySelectorAll('[data-id]').forEach(r => r.onclick = () => location.hash = '#/orders/' + r.dataset.id);
  },
};

const FLOW = ['pending_approval', 'awaiting_payment', 'paid', 'packing', 'out_for_delivery', 'delivered'];
const FLOW_LABEL = ['Approval', 'Payment', 'Paid', 'Packing', 'On the way', 'Delivered'];
const NEXT_ACTION = { paid: ['packing', 'Start packing'], packing: ['out_for_delivery', 'Mark out for delivery'], out_for_delivery: ['delivered', 'Mark delivered'] };

async function orderDetail(id) {
  const o = await api('/api/orders/' + id);
  const inv = o.invoice;
  const idx = FLOW.indexOf(o.status);
  const failed = o.checks.filter(c => c.status === 'fail').length;
  view.innerHTML = `
    <div class="row"><a href="#/orders">← Orders</a></div>
    <div class="row" style="margin:8px 0 16px"><h1 class="mono">${o.code}</h1>${statusBadge(o)}<div class="spacer"></div>
      ${NEXT_ACTION[o.status] ? `<button class="btn primary" id="next">${NEXT_ACTION[o.status][1]}</button>` : ''}</div>
    ${o.status !== 'cancelled' ? `<div class="card" style="margin-bottom:16px"><div class="steps">${FLOW.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}">${FLOW_LABEL[i]}</div>`).join('')}</div></div>` : ''}
    <div class="grid two">
      <div class="grid" style="align-content:start">
        <div class="card">
          <h2>Order details</h2>
          <dl class="kv">
            <dt>Order ID</dt><dd class="mono">${o.code}</dd>
            <dt>Name</dt><dd>${esc(o.customer_name) || '<span class="badge bad">missing</span>'}</dd>
            <dt>WhatsApp</dt><dd><a href="#/inbox/${o.customer_id}">+${esc(o.phone)}</a></dd>
            <dt>Address</dt><dd>${esc(o.address) || '<span class="badge bad">missing</span>'}</dd>
            <dt>Status</dt><dd>${esc(o.status_label)}</dd>
            <dt>Created</dt><dd>${fmtTime(o.created_at)}</dd>
          </dl>
          <table style="margin-top:14px"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th style="text-align:right">Amount</th></tr></thead><tbody>
            ${o.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${rm(i.unit_price)}</td><td style="text-align:right">${rm(i.line_total)}</td></tr>`).join('')}
            <tr><td colspan="3" class="muted">Subtotal</td><td style="text-align:right">${rm(o.subtotal)}</td></tr>
            ${o.discount ? `<tr><td colspan="3" class="muted">Discount</td><td style="text-align:right">-${rm(o.discount)}</td></tr>` : ''}
            <tr><td colspan="3" class="muted">Delivery</td><td style="text-align:right">${o.delivery_fee ? rm(o.delivery_fee) : 'FREE'}</td></tr>
            <tr><td colspan="3"><b>Total</b></td><td style="text-align:right;font-size:18px"><b>${rm(o.total)}</b></td></tr>
          </tbody></table>
        </div>
        ${o.source_message ? `<div class="card"><h2>Original WhatsApp message</h2><div class="bubble in" style="max-width:100%;background:#f6f7f9">${esc(o.source_message.body)}<div class="meta">${fmtTime(o.source_message.created_at)}</div></div></div>` : ''}
        <div class="card"><h2>History</h2><ul class="timeline">${o.history.map(h => `<li><b>${esc(h.action.replace(/_/g, ' '))}</b> <span class="muted">by ${esc(h.actor)} · ${fmtTime(h.created_at)}</span><div class="small muted">${esc(h.detail || '')}</div></li>`).join('')}</ul></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card">
          <h2>Checks before approving</h2>
          <ul class="checks">${o.checks.map(c => `<li><span class="ic ${c.status}">${c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕'}</span><div><b>${esc(c.label)}</b><div class="small muted">${esc(c.detail)}</div></div></li>`).join('')}</ul>
        </div>
        <div class="card">
          <h2>Invoice</h2>
          ${invoiceBox(inv, failed)}
        </div>
      </div>
    </div>`;
  bindInvoiceActions(inv, () => orderDetail(id));
  if ($('#next')) $('#next').onclick = async () => {
    try { await api(`/api/orders/${id}/status`, { method: 'POST', body: { status: NEXT_ACTION[o.status][0] } }); toast('Status updated - customer notified on WhatsApp'); orderDetail(id); }
    catch (e) { toast(e.message, true); }
  };
}

function invoiceBox(inv, failed) {
  if (!inv) return '<div class="muted">No invoice</div>';
  if (inv.status === 'pending') return `
    <p class="muted small">Draft prepared automatically. Nothing is sent to the customer until you approve.</p>
    <div style="font-size:24px;font-weight:700;margin-bottom:12px">${rm(inv.amount)}</div>
    ${failed ? `<p class="badge bad" style="margin-bottom:10px">${failed} check(s) failed</p>` : ''}
    <div class="row"><button class="btn ok" data-approve="${inv.id}">Approve & send invoice</button><button class="btn bad" data-reject="${inv.id}">Reject</button></div>`;
  if (inv.status === 'rejected') return `<span class="badge grey">Rejected</span><p class="small">${esc(inv.rejected_reason)}</p>`;
  return `<dl class="kv">
      <dt>Invoice no.</dt><dd class="mono">${esc(inv.invoice_no)}</dd>
      <dt>Amount</dt><dd>${rm(inv.amount)}</dd>
      <dt>Approved</dt><dd>${fmtTime(inv.approved_at)} by ${esc(inv.approved_by)}</dd>
      <dt>Due date</dt><dd>${fmtDate(inv.due_date)}</dd>
      <dt>Payment</dt><dd>${paymentBadge(inv)}</dd>
      <dt>Reminders</dt><dd>${inv.reminder_count}</dd>
      <dt>Orbyte</dt><dd class="small">${esc(inv.orbyte_ref || '-')} <span class="badge ${inv.orbyte_sync === 'synced' ? 'ok' : inv.orbyte_sync === 'failed' ? 'bad' : 'grey'}">${esc(inv.orbyte_sync || '')}</span></dd>
    </dl>
    ${inv.payment_status !== 'paid' ? `<div class="row" style="margin-top:12px"><button class="btn ok" data-paid="${inv.id}">Confirm payment received</button></div>` : ''}`;
}

function bindInvoiceActions(_, reload) {
  view.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => approve(Number(b.dataset.approve), reload));
  view.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => reject(Number(b.dataset.reject), reload));
  view.querySelectorAll('[data-paid]').forEach(b => b.onclick = async () => {
    try { await api(`/api/invoices/${b.dataset.paid}/paid`, { method: 'POST' }); toast('Payment confirmed - customer notified'); reload(); refreshBadges(); }
    catch (e) { toast(e.message, true); }
  });
}

async function approve(id, reload, override = false) {
  try {
    const r = await api(`/api/invoices/${id}/approve`, { method: 'POST', body: { override } });
    toast(`${r.invoice_no} approved and sent to customer on WhatsApp`);
    reload(); refreshBadges();
  } catch (e) {
    if (e.status !== 422) return toast(e.message, true);
    const fails = e.data.checks.filter(c => c.status === 'fail');
    const m = modal(`<h2>Some checks failed</h2>
      <ul class="checks">${fails.map(c => `<li><span class="ic fail">✕</span><div><b>${esc(c.label)}</b><div class="small muted">${esc(c.detail)}</div></div></li>`).join('')}</ul>
      <p class="small muted">Best practice: fix these first (e.g. ask the customer in the Inbox). If you approve anyway, the override is recorded in the activity log.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="m-cancel">Go back</button><button class="btn bad" id="m-ok">Approve anyway</button></div>`);
    $('#m-cancel', m).onclick = closeModal;
    $('#m-ok', m).onclick = () => { closeModal(); approve(id, reload, true); };
  }
}

function reject(id, reload) {
  const m = modal(`<h2>Reject invoice</h2>
    <label>Reason (saved in the activity log)</label><textarea id="m-reason" rows="3" placeholder="e.g. Out of stock for this week"></textarea>
    <label class="row" style="gap:6px;margin-top:10px"><input type="checkbox" id="m-notify" checked style="width:auto"> Tell the customer on WhatsApp</label>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn" id="m-cancel">Cancel</button><button class="btn bad" id="m-ok">Reject</button></div>`);
  $('#m-cancel', m).onclick = closeModal;
  $('#m-ok', m).onclick = async () => {
    try {
      await api(`/api/invoices/${id}/reject`, { method: 'POST', body: { reason: $('#m-reason').value, notify: $('#m-notify').checked } });
      closeModal(); toast('Invoice rejected'); reload(); refreshBadges();
    } catch (e) { toast(e.message, true); }
  };
}

// ------------------------------------------------------------------ invoices
pages.invoices = {
  async render() {
    view.innerHTML = `<h1>Invoices</h1><p class="sub">Invoices are drafted automatically from WhatsApp orders. You approve each one before it is sent.</p>
      <div class="card" style="padding:0;margin-bottom:20px"><div style="padding:16px 18px 0"><h2>Waiting for your approval</h2></div>
        <table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Amount</th><th>Checks</th><th>Received</th><th></th></tr></thead><tbody id="pending"></tbody></table></div>
      <div class="card" style="padding:0;margin-bottom:20px"><div style="padding:16px 18px 0"><h2>Approved invoices</h2></div>
        <table><thead><tr><th>Invoice no.</th><th>Order</th><th>Customer</th><th>Amount</th><th>Due date</th><th>Payment</th><th>Orbyte</th><th></th></tr></thead><tbody id="approved"></tbody></table></div>
      <details class="card"><summary style="cursor:pointer;font-weight:600">Rejected invoices</summary><table style="margin-top:10px"><tbody id="rejected"></tbody></table></details>`;
    await this.refresh();
  },
  async refresh() {
    const [pending, approved, rejected] = await Promise.all(['pending', 'approved', 'rejected'].map(s => api('/api/invoices?status=' + s)));
    if (!$('#pending')) return;
    setHTML($('#pending'), pending.length ? pending.map(i => `
      <tr><td class="mono"><a href="#/orders/${i.order_id}">${i.order_code}</a></td><td>${esc(i.customer_name || '+' + i.phone)}</td><td class="small">${esc(i.summary)}</td>
      <td><b>${rm(i.amount)}</b></td>
      <td>${i.checks_failed ? `<span class="badge bad">${i.checks_failed} failed</span>` : '<span class="badge ok">All passed</span>'} ${i.checks_warn ? `<span class="badge warn">${i.checks_warn} warning</span>` : ''}</td>
      <td class="small muted">${ago(i.created_at)}</td>
      <td style="white-space:nowrap"><a class="btn sm" href="#/orders/${i.order_id}">Review</a> <button class="btn sm ok" data-approve="${i.id}">Approve</button></td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">Nothing waiting for approval 🎉</td></tr>');
    setHTML($('#approved'), approved.length ? approved.map(i => `
      <tr><td class="mono"><b>${esc(i.invoice_no)}</b></td><td class="mono"><a href="#/orders/${i.order_id}">${i.order_code}</a></td><td>${esc(i.customer_name || '+' + i.phone)}</td>
      <td><b>${rm(i.amount)}</b></td><td class="small">${fmtDate(i.due_date)}${i.reminder_count ? `<div class="muted">${i.reminder_count} reminder(s) sent</div>` : ''}</td>
      <td>${paymentBadge(i)}</td><td class="small muted">${esc(i.orbyte_ref || '')}</td>
      <td>${i.payment_status !== 'paid' ? `<button class="btn sm ok" data-paid="${i.id}">Mark paid</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No approved invoices yet</td></tr>');
    setHTML($('#rejected'), rejected.length ? rejected.map(i => `<tr><td class="mono">${i.order_code}</td><td>${esc(i.customer_name || '')}</td><td>${rm(i.amount)}</td><td class="small muted">${esc(i.rejected_reason)}</td></tr>`).join('') : '<tr><td class="empty">None</td></tr>');
    bindInvoiceActions(null, () => this.refresh());
  },
};

// ------------------------------------------------------------------ activity
pages.activity = {
  async render() {
    const rows = await api('/api/audit');
    view.innerHTML = `<h1>Activity log</h1><p class="sub">Every automatic action and every approval, with who did it and when.</p>
      <div class="card" style="padding:0"><table><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td class="small muted" style="white-space:nowrap">${fmtTime(a.created_at)}</td><td><span class="tag ${a.actor === 'ai' ? 'ai' : a.actor === 'owner' ? 'owner' : 'system'}">${esc(a.actor)}</span></td>
        <td>${esc(a.action.replace(/_/g, ' '))}</td><td class="small">${a.entity === 'order' ? `<a href="#/orders/${a.entity_id}">order #${a.entity_id}</a>` : esc(a.entity + (a.entity_id ? ' #' + a.entity_id : ''))}</td><td class="small muted">${esc(a.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No activity yet</td></tr>'}
      </tbody></table></div>`;
  },
};

// ------------------------------------------------------------------ settings
pages.settings = {
  async render() {
    const { settings: s, products } = await api('/api/settings');
    const field = (k, label, type = 'text') => `<div><label>${label}</label>${type === 'area' ? `<textarea data-k="${k}" rows="3">${esc(s[k])}</textarea>` : `<input data-k="${k}" type="${type}" value="${esc(s[k])}">`}</div>`;
    view.innerHTML = `<h1>Settings</h1><p class="sub">The AI answers customers using exactly these details, so replies are always consistent.</p>
      <div class="card" style="margin-bottom:16px"><h2>Business & AI answers</h2>
        <div class="form-grid">
          ${field('business_name', 'Business name')}${field('owner_name', 'Owner name')}
          ${field('delivery_info', 'Delivery info (AI answer)', 'area')}${field('bank_details', 'Bank details on invoice', 'area')}
          ${field('delivery_fee', 'Delivery fee (RM)', 'number')}${field('free_delivery_min', 'Free delivery above (RM)', 'number')}
          ${field('discount_min_qty', 'Discount from (boxes)', 'number')}${field('discount_pct', 'Discount (%)', 'number')}
          ${field('payment_terms_days', 'Payment due after (days)', 'number')}${field('max_qty_per_order', 'Flag orders above (boxes)', 'number')}
          ${field('followup_hours', 'Follow up quiet customers after (hours)', 'number')}${field('payment_reminder_hours', 'Payment reminder every (hours)', 'number')}
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="save-settings">Save settings</button></div>
      </div>
      <div class="card" style="padding:0;margin-bottom:16px"><div style="padding:16px 18px 0"><h2>Products</h2></div>
        <table><thead><tr><th>SKU</th><th>Name</th><th>Customer keywords</th><th>Price (RM)</th><th>Stock</th><th>Active</th><th></th></tr></thead><tbody>
        ${products.map(p => `<tr data-pid="${p.id}"><td class="mono">${p.sku}</td><td>${esc(p.name)}</td><td class="small muted">${esc(p.keywords)}</td>
          <td><input data-f="price" type="number" step="0.01" value="${p.price}" style="width:90px"></td><td><input data-f="stock" type="number" value="${p.stock}" style="width:80px"></td>
          <td><input data-f="active" type="checkbox" ${p.active ? 'checked' : ''} style="width:auto"></td><td><button class="btn sm" data-save>Save</button></td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><h2>Demo tools</h2>
        <p class="small muted">For presentations: pretend 2 days have passed, then run the automations to see follow-ups and payment reminders.</p>
        <div class="row"><button class="btn" id="tt">⏩ Skip ahead 49 hours</button><button class="btn" id="run">Run follow-ups & reminders now</button></div>
      </div>`;
    $('#save-settings').onclick = async () => {
      const body = {};
      view.querySelectorAll('[data-k]').forEach(i => body[i.dataset.k] = i.value);
      await api('/api/settings', { method: 'PUT', body });
      toast('Settings saved'); refreshBadges();
    };
    view.querySelectorAll('[data-pid]').forEach(tr => $('[data-save]', tr).onclick = async () => {
      await api('/api/products/' + tr.dataset.pid, { method: 'PUT', body: { price: $('[data-f=price]', tr).value, stock: $('[data-f=stock]', tr).value, active: $('[data-f=active]', tr).checked } });
      toast('Product saved');
    });
    $('#tt').onclick = async () => { await api('/api/demo/time-travel', { method: 'POST', body: { hours: 49 } }); toast('Moved 49 hours ahead'); };
    $('#run').onclick = async () => {
      const r = await api('/api/automations/run', { method: 'POST' });
      toast(`Sent ${r.followups} follow-up(s), ${r.paymentReminders} payment reminder(s)${r.escalated ? `, ${r.escalated} escalated` : ''}`);
    };
  },
};

// ------------------------------------------------------------------ customer simulator
const sim = { phone: localStorage.getItem('sim-phone') || '60123456789', name: localStorage.getItem('sim-name') || 'Aisyah', count: -1 };
const SAMPLES = [
  'Hi', 'How much is the kek lapis?', 'How long does delivery take to Penang?', 'Got any discount?',
  'I want 2 original and 1 cheese', 'Name: Aisyah Rahman\nAddress: 12, Jalan Mawar 3, 40000 Shah Alam, Selangor',
  'Can you write Happy Birthday on the box?', 'Is it halal certified?', 'Dah transfer', 'Where is my order?',
];
pages.simulator = {
  async render() {
    view.innerHTML = `<h1>Customer Simulator</h1><p class="sub">Acts as a customer's WhatsApp. Messages go through the same pipeline as the real WhatsApp webhook.</p>
      <div class="sim">
        <div class="phone"><div class="screen">
          <div class="wa-head"><div class="avatar" style="background:#128c7e">MT</div><div><b id="wa-biz">Business</b><div class="small" style="opacity:.8">WhatsApp Business</div></div></div>
          <div class="wa-body" id="wa-body"></div>
          <div class="wa-foot"><input id="wa-input" placeholder="Message"><button id="wa-send">➤</button></div>
        </div></div>
        <div class="grid" style="align-content:start">
          <div class="card"><h2>Customer</h2><div class="form-grid">
            <div><label>WhatsApp number</label><input id="sim-phone" value="${esc(sim.phone)}"></div>
            <div><label>WhatsApp profile name</label><input id="sim-name" value="${esc(sim.name)}"></div></div>
            <p class="small muted">Change the number to act as a different customer.</p></div>
          <div class="card samples"><h2>Try these messages</h2>${SAMPLES.map(s => `<button class="btn" data-sample="${esc(s)}">${esc(s.replace(/\n/g, ' / '))}</button>`).join('')}</div>
        </div>
      </div>`;
    api('/api/settings').then(r => $('#wa-biz') && ($('#wa-biz').textContent = r.settings.business_name));
    const save = () => {
      sim.phone = $('#sim-phone').value.replace(/\D/g, '');
      sim.name = $('#sim-name').value;
      localStorage.setItem('sim-phone', sim.phone); localStorage.setItem('sim-name', sim.name);
      sim.count = -1; this.refresh();
    };
    $('#sim-phone').onchange = save; $('#sim-name').onchange = save;
    const send = async text => {
      if (!text.trim()) return;
      $('#wa-input').value = '';
      const body = $('#wa-body');
      body.insertAdjacentHTML('beforeend', `<div class="bubble mine">${esc(text)}<div class="meta">sending…</div></div>`);
      body.scrollTop = body.scrollHeight;
      try { await api('/api/simulate/inbound', { method: 'POST', body: { phone: sim.phone, name: sim.name, text } }); }
      catch (e) { toast(e.message, true); }
      sim.count = -1; this.refresh(); refreshBadges();
    };
    $('#wa-send').onclick = () => send($('#wa-input').value);
    $('#wa-input').onkeydown = e => { if (e.key === 'Enter') send($('#wa-input').value); };
    view.querySelectorAll('[data-sample]').forEach(b => b.onclick = () => send(b.dataset.sample));
    sim.count = -1;
    await this.refresh();
  },
  async refresh() {
    const msgs = await api('/api/simulate/chat/' + sim.phone);
    const body = $('#wa-body');
    if (!body || msgs.length === sim.count) return;
    sim.count = msgs.length;
    body.innerHTML = msgs.map(m => `<div class="bubble ${m.direction === 'in' ? 'mine' : 'theirs'}">${esc(m.body)}<div class="meta">${fmtTime(m.created_at)}</div></div>`).join('')
      || '<div class="empty small">Send a message to start the chat</div>';
    body.scrollTop = body.scrollHeight;
  },
};

refreshBadges();
router();
