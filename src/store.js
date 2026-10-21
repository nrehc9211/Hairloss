// Tiny JSON-file database. In the real product this data lives in Orbyte
// (CRM, People, Connect). Swap the functions in src/orbyte/index.js, not this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { addDays, todayIso, setOffsetMs, nowIso } from './clock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(here, '../data/seed.json');

let db = null;
let file = null;
let persist = true;
let saveTimer = null;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function initStore({ dataDir = config.dataDir, persist: p = config.persist, fresh = false } = {}) {
  persist = p;
  file = path.join(dataDir, 'db.json');
  if (persist) fs.mkdirSync(dataDir, { recursive: true });
  if (!fresh && persist && fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!db.conversations || !db.version || db.version < 2) return resetStore(); // old v1 data
    setOffsetMs(db.clockOffsetMs || 0);
    applyStaffPhones(db);
  } else {
    resetStore();
  }
  return db;
}

/** OWNER_PHONE / SUPERVISOR_PHONE / STAFF_PHONE in .env replace the demo numbers, so cards reach real phones. */
function applyStaffPhones(d) {
  for (const s of d.staff) {
    const phone = config.staffPhones[s.role];
    if (phone) s.phone = phone;
  }
}

export function resetStore() {
  setOffsetMs(0);
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const today = todayIso();
  const catalog = Object.fromEntries(seed.catalog.map((c) => [c.sku, c]));
  const customers = Object.fromEntries(seed.customers.map((c) => [c.id, c]));

  const orders = [];
  const invoices = [];
  seed.history.forEach((h, i) => {
    const cust = customers[h.customerId];
    const date = addDays(today, -h.daysAgo);
    const lines = Object.entries(h.lines).map(([sku, qty]) => {
      const unitPrice = cust.prices?.[sku] ?? catalog[sku].price;
      return { sku, name: catalog[sku].name, unit: catalog[sku].unit, qty, unitPrice, amount: round2(qty * unitPrice) };
    });
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    const orderId = `ORD-${String(i + 1).padStart(4, '0')}`;
    const invoiceId = `INV-${String(i + 1).padStart(4, '0')}`;
    orders.push({
      id: orderId, customerId: cust.id, channel: 'seed', status: h.paid ? 'paid' : 'invoiced',
      createdAt: `${date}T09:00:00.000Z`, deliveryDate: addDays(date, 1), deliveredAt: `${addDays(date, 1)}T03:00:00.000Z`,
      lines, total, flags: [], source: { type: 'text', text: '(past order)' }, invoiceId,
    });
    invoices.push({
      id: invoiceId, orderId, customerId: cust.id, issueDate: date,
      dueDate: addDays(date, cust.paymentTermsDays), lines, total,
      status: h.paid ? 'paid' : 'unpaid', paidAt: h.paid ? `${addDays(date, 3)}T10:00:00.000Z` : null,
      remindersSent: [], pdfUrl: null, paymentUrl: null,
    });
  });

  db = {
    version: 2,
    business: seed.business,
    settings: seed.settings,
    staff: seed.staff,
    leave: seed.leave,
    customers: seed.customers,
    catalog: seed.catalog,
    orders,
    invoices,
    conversations: [],
    audit: [],
    messages: [],
    sessions: {},
    counters: { order: orders.length, invoice: invoices.length, message: 0, audit: 0, conversation: 0, customer: seed.customers.length },
    clockOffsetMs: 0,
    createdAt: nowIso(),
  };
  applyStaffPhones(db);
  saveNow();
  return db;
}

export const getDb = () => {
  if (!db) throw new Error('Store not initialised. Call initStore() first.');
  return db;
};

export function nextId(kind, prefix, pad = 4) {
  const d = getDb();
  d.counters[kind] = (d.counters[kind] || 0) + 1;
  return `${prefix}${String(d.counters[kind]).padStart(pad, '0')}`;
}

export function save() {
  if (!persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 50);
}

export function saveNow() {
  if (!persist || !db) return;
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}
