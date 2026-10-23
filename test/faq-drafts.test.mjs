// FAQ drafts (RAG) in the WhatsApp reply flow. Runs offline: in-memory database,
// simulated WhatsApp, and a fake Claude, so no keys or internet are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'AI_INTEGRATIONS_ANTHROPIC_API_KEY',
  'AI_INTEGRATIONS_ANTHROPIC_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER', 'VOYAGE_API_KEY',
  'WA_TOKEN', 'WA_PHONE_NUMBER_ID']) delete process.env[k];

const { openDb } = await import('../src/db.js');
const svc = await import('../src/service.js');
const rag = await import('../src/rag.js');

const KNOWLEDGE = path.resolve('knowledge');
const PHONE = '60123456789';

// Fake Claude: answers from whichever source contains `keyword`, like the real prompt asks.
function fakeClaude({ keyword, reply, answerable = true, confidence = 'high', missing = '' }) {
  const calls = [];
  const llm = async ({ user }) => {
    calls.push(user);
    const sources = [...user.matchAll(/<source id="([^"]+)">\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ id: m[1], text: m[2] }));
    const used = keyword ? sources.filter((s) => s.text.toLowerCase().includes(keyword)).map((s) => s.id) : [];
    return JSON.stringify({
      reply, language: 'en', answerable, confidence, source_ids: used.slice(0, 1),
      needs_owner: false, reason: '', missing_info: missing,
    });
  };
  llm.calls = calls;
  return llm;
}

function setup(llm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdesk-'));
  rag.configure({ knowledgeDir: KNOWLEDGE, indexPath: path.join(dir, 'index.json'), logPath: path.join(dir, 'log.jsonl'), llm, embed: null });
  return openDb({ file: ':memory:' });
}

async function customerSays(db, text) {
  const r = await svc.handleInbound(db, { phone: PHONE, profileName: 'Aisyah', text, waId: null });
  await svc.waitForDrafts();
  return r;
}

const chat = (db) => db.prepare('SELECT sender, body FROM messages ORDER BY id').all();
const openQuestion = (db) => db.prepare(`SELECT * FROM escalations ORDER BY id DESC LIMIT 1`).get();

const BIRTHDAY = fakeClaude({ keyword: 'greeting card', reply: 'Yes! We include a free greeting card with your message. A printed sticker on the box is RM3.00.' });

test('an unanswered question gets a holding reply and a draft for the owner', async () => {
  const db = setup(BIRTHDAY);
  await customerSays(db, 'Can you write Happy Birthday on the box?');

  const msgs = chat(db);
  assert.equal(msgs.length, 2, 'only the holding reply is sent');
  assert.match(msgs[1].body, /checking this with the owner/);

  const e = openQuestion(db);
  assert.equal(e.status, 'open');
  assert.equal(e.draft_status, 'ready');
  assert.match(e.draft_reply, /greeting card/);
  assert.deepEqual(JSON.parse(e.draft_flags), []);
  assert.equal(JSON.parse(e.draft_sources).length, 1);
});

test('auto-send (when switched on) sends only drafts that passed every check', async () => {
  const db = setup(BIRTHDAY);
  db.prepare(`UPDATE settings SET value = '1' WHERE key = 'rag_auto_send'`).run();
  await customerSays(db, 'Can you write Happy Birthday on the box?');

  const msgs = chat(db);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].sender, 'ai');
  assert.match(msgs[2].body, /greeting card/);
  assert.equal(openQuestion(db).status, 'resolved');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'faq_answer_auto_sent'`).get());
});

test('a draft with a price that is not in the shop data is never auto-sent', async () => {
  const db = setup(fakeClaude({ keyword: 'greeting card', reply: 'Sure, the sticker is RM9.00.' }));
  db.prepare(`UPDATE settings SET value = '1' WHERE key = 'rag_auto_send'`).run();
  await customerSays(db, 'Can you write Happy Birthday on the box?');

  const e = openQuestion(db);
  assert.equal(e.status, 'open');
  assert.equal(e.draft_status, 'needs_review');
  assert.ok(JSON.parse(e.draft_flags).some((f) => f.startsWith('PRICE_NOT_IN_SOURCE')));
  assert.equal(chat(db).length, 2, 'nothing extra was sent to the customer');
});

test('a question the FAQ cannot answer is flagged and shows what is missing', async () => {
  const db = setup(fakeClaude({ reply: 'Thanks for asking! Let me check with the owner.', answerable: false, confidence: 'low', missing: 'halal certification status' }));
  await customerSays(db, 'Is it halal certified?');

  const e = openQuestion(db);
  assert.equal(e.draft_status, 'needs_review');
  assert.ok(JSON.parse(e.draft_flags).includes('NOT_IN_DOCUMENTS'));
  assert.equal(e.draft_missing, 'halal certification status');

  await assert.rejects(svc.sendDraft(db, e.id), /write your own reply/);

  const report = await rag.report(db);
  assert.match(report, /Mak Teh Kek Lapis/);
  assert.match(report, /halal certification status/);
});

test('owner approves a draft as is, or edits it first; both are logged', async () => {
  const db = setup(BIRTHDAY);
  await customerSays(db, 'Can you write Happy Birthday on the box?');
  const first = openQuestion(db);
  await svc.sendDraft(db, first.id);
  assert.equal(chat(db).at(-1).sender, 'owner');
  assert.match(chat(db).at(-1).body, /greeting card/);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'faq_draft_approved_and_sent'`).get());
  await assert.rejects(svc.sendDraft(db, first.id), /already resolved/);

  await customerSays(db, 'Can you write Selamat Hari Raya on the box?');
  await svc.sendDraft(db, openQuestion(db).id, { text: 'Boleh! Free greeting card included 😊' });
  assert.equal(chat(db).at(-1).body, 'Boleh! Free greeting card included 😊');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'faq_draft_edited_and_sent'`).get());
});

test('routine questions keep their template replies and never call the AI', async () => {
  const llm = fakeClaude({ reply: 'should not be used' });
  const db = setup(llm);
  await customerSays(db, 'How much is the kek lapis?');
  assert.equal(llm.calls.length, 0);
  assert.match(chat(db)[1].body, /Kek Lapis Original - RM45\.00/);
});

test('without an API key the Inbox works exactly as before', async () => {
  const db = setup(undefined);
  await customerSays(db, 'Is it halal certified?');
  const e = openQuestion(db);
  assert.equal(e.status, 'open');
  assert.equal(e.draft_status, 'unavailable');
  assert.equal(e.draft_reply, null);
});

test('drafts use the current prices: the index rebuilds after the owner changes a price', async () => {
  const llm = fakeClaude({ keyword: 'original', reply: 'ok' });
  const db = setup(llm);
  await rag.draftAnswer(db, 'kek lapis original for corporate gift?');
  assert.match(llm.calls.at(-1), /RM45\.00/);

  db.prepare(`UPDATE products SET price = 50 WHERE sku = 'KL-ORI'`).run();
  await rag.draftAnswer(db, 'kek lapis original for corporate gift?');
  assert.match(llm.calls.at(-1), /RM50\.00/);
  assert.doesNotMatch(llm.calls.at(-1), /RM45\.00/);
});

test('an existing database gets the new draft columns on start-up', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smartdesk-db-')), 'old.db');
  openDb({ file }).close();
  const old = new DatabaseSync(file);
  old.exec('ALTER TABLE escalations DROP COLUMN draft_reply');
  old.close();
  const db = openDb({ file });
  const cols = db.prepare('PRAGMA table_info(escalations)').all().map((c) => c.name);
  assert.ok(cols.includes('draft_reply'));
  db.close();
});
