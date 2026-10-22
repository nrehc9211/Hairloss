// SQLite database (Node's built-in node:sqlite, no install needed).
// Every WhatsApp message, order, invoice and owner decision is stored here.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'smartdesk.db');

// file: path to the database, or ':memory:' for tests.
export function openDb({ reset = false, file = DB_FILE } = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (reset && fs.existsSync(file)) fs.rmSync(file);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  createSchema(db);
  migrate(db);
  seed(db);
  return db;
}

// Columns added after the first release. Existing databases get them on start-up.
const ADDED_COLUMNS = {
  customers: {
    lang: 'TEXT',           // language code the customer last wrote in (en, ms, zh, ta, id, ...)
  },
  messages: {
    translation_en: 'TEXT', // English meaning, for the owner, when the message is in another language
  },
  escalations: {
    draft_status: 'TEXT',   // pending | ready | needs_review | unavailable | failed
    draft_reply: 'TEXT',    // AI draft answer from the FAQ, for the owner to approve
    draft_flags: 'TEXT',    // JSON list of safety flags
    draft_sources: 'TEXT',  // JSON list of knowledge-base entries used
    draft_reason: 'TEXT',   // note for the owner
    draft_missing: 'TEXT',  // what the FAQ should contain to answer this
    draft_reply_en: 'TEXT', // English meaning of a draft written in another language
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

export const now = () => new Date().toISOString();

function createSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sku        TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    keywords   TEXT NOT NULL,           -- comma separated words customers use
    price      REAL NOT NULL,
    stock      INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS customers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    phone              TEXT UNIQUE NOT NULL,
    name               TEXT,
    address            TEXT,
    created_at         TEXT NOT NULL,
    last_inbound_at    TEXT,
    last_activity_at   TEXT,
    followup_sent_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customers(id),
    direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
    sender        TEXT NOT NULL CHECK (sender IN ('customer','ai','owner','system')),
    body          TEXT NOT NULL,
    intent        TEXT,
    wa_message_id TEXT,
    delivery      TEXT,                 -- sent | simulated | failed
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, id);

  CREATE TABLE IF NOT EXISTS escalations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    message_id   INTEGER NOT NULL REFERENCES messages(id),
    question     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE NOT NULL,
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    source_message_id INTEGER REFERENCES messages(id),
    status          TEXT NOT NULL,
    subtotal        REAL NOT NULL DEFAULT 0,
    discount        REAL NOT NULL DEFAULT 0,
    delivery_fee    REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL DEFAULT 0,
    customer_name   TEXT,
    address         TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER REFERENCES products(id),
    name        TEXT NOT NULL,
    qty         INTEGER NOT NULL,
    unit_price  REAL NOT NULL,
    line_total  REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no      TEXT UNIQUE,         -- assigned on approval
    order_id        INTEGER UNIQUE NOT NULL REFERENCES orders(id),
    status          TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    amount          REAL NOT NULL,
    payment_status  TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','reported','paid')),
    due_date        TEXT,
    created_at      TEXT NOT NULL,
    approved_at     TEXT,
    approved_by     TEXT,
    rejected_reason TEXT,
    paid_at         TEXT,
    last_reminder_at TEXT,
    reminder_count  INTEGER NOT NULL DEFAULT 0,
    orbyte_ref      TEXT,
    orbyte_sync     TEXT                 -- synced | mock | failed
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor      TEXT NOT NULL,            -- owner | ai | system | customer
    action     TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  INTEGER,
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  `);
}

const DEFAULT_SETTINGS = {
  business_name: 'Mak Teh Kek Lapis',
  owner_name: 'Owner',
  delivery_info: 'Delivery takes 2-3 working days within Klang Valley and 3-5 working days to other states. Sabah & Sarawak 5-7 working days.',
  delivery_info_ms: 'Penghantaran mengambil masa 2-3 hari bekerja dalam Lembah Klang dan 3-5 hari bekerja ke negeri lain. Sabah & Sarawak 5-7 hari bekerja.',
  delivery_info_zh: '巴生谷地区2-3个工作日送达，其他州属3-5个工作日，沙巴和砂拉越5-7个工作日。',
  delivery_fee: '10',
  free_delivery_min: '150',
  discount_min_qty: '3',
  discount_pct: '10',
  payment_terms_days: '3',
  bank_details: 'Maybank 5123 4567 8901 (Mak Teh Enterprise)',
  followup_hours: '48',
  payment_reminder_hours: '24',
  max_qty_per_order: '20',
  rag_auto_send: '0',          // 1 = send confident FAQ answers without waiting for the owner
};

function seed(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO products (sku, name, keywords, price, stock) VALUES (?, ?, ?, ?, ?)');
    ins.run('KL-ORI', 'Kek Lapis Original', PRODUCT_ALIASES['KL-ORI'], 45, 30);
    ins.run('KL-PRU', 'Kek Lapis Prune', PRODUCT_ALIASES['KL-PRU'], 55, 20);
    ins.run('KL-CHS', 'Kek Lapis Cheese', PRODUCT_ALIASES['KL-CHS'], 60, 15);
    ins.run('KL-HOR', 'Kek Lapis Horlicks', PRODUCT_ALIASES['KL-HOR'], 58, 12);
    ins.run('KL-MIL', 'Kek Lapis Milo', PRODUCT_ALIASES['KL-MIL'], 58, 0);
  }
  // Existing shops get the Malay and Chinese names added to their keywords.
  const get = db.prepare('SELECT keywords FROM products WHERE sku = ?');
  const set = db.prepare('UPDATE products SET keywords = ? WHERE sku = ?');
  for (const [sku, aliases] of Object.entries(PRODUCT_ALIASES)) {
    const row = get.get(sku);
    if (!row) continue;
    const have = row.keywords.split(',').map((k) => k.trim()).filter(Boolean);
    const merged = [...new Set([...have, ...aliases.split(',')])].join(',');
    if (merged !== row.keywords) set.run(merged, sku);
  }
}

// Words customers use for each flavour, in English, Malay and Chinese.
const PRODUCT_ALIASES = {
  'KL-ORI': 'original,ori,classic,biasa,asli,原味,传统',
  'KL-PRU': 'prune,prun,西梅',
  'KL-CHS': 'cheese,keju,芝士,奶酪',
  'KL-HOR': 'horlicks,horlick,好立克',
  'KL-MIL': 'milo,美禄',
};

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function audit(db, actor, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor, action, entity, entityId ?? null, detail ?? null, now());
}

// Small helper so multi-step writes either fully happen or not at all.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
