// Gemini support, tested against a local mock of the Gemini API (no key or internet needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AI_INTEGRATIONS_ANTHROPIC_API_KEY', 'AI_INTEGRATIONS_ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'GEMINI_THINKING_LEVEL', 'GEMINI_EMBEDDINGS', 'VOYAGE_API_KEY',
  'AI_PROVIDER', 'AI_ENGINE', 'WA_TOKEN', 'WA_PHONE_NUMBER_ID']) delete process.env[k];

const require = createRequire(import.meta.url);
const { gemini, geminiEmbed } = require('../src/rag/gemini.cjs');
const { providerInfo } = require('../src/rag/llm.cjs');
const ai = await import('../src/ai.js');
const { openDb } = await import('../src/db.js');
const svc = await import('../src/service.js');
const rag = await import('../src/rag.js');

// ---- mock Gemini API ------------------------------------------------------
const mock = { requests: [], next: [] };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    mock.requests.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (mock.next.length) return Promise.resolve(mock.next.shift()(body)).then((r) => reply(...r)).catch(() => {});

    if (req.url.endsWith(':batchEmbedContents')) {
      // Fake meaning (in any language, like real embeddings): dimension 0 = storage/shelf life, 1 = greeting card, 2 = everything else
      const vec = (t) => [/simpan|peti sejuk|kept|keeps|fridge|freezer|சேமி|குளிர்சாதன/i.test(t) ? 1 : 0, /greeting card|ucapan/i.test(t) ? 1 : 0, 0.1];
      return reply(200, { embeddings: body.requests.map((r) => ({ values: vec(r.content.parts[0].text) })) });
    }
    const system = body.systemInstruction.parts[0].text;
    const user = body.contents[0].parts[0].text;
    let out;
    if (system.startsWith('You translate')) {
      // Fake Tamil translation that keeps every number, unless the test asks it to break them.
      out = { translation: mock.breakNumbers ? `TA ${user.replace(/\d/g, '')}` : `TA ${user}` };
    } else if (system.startsWith('You classify') && /no-language-field/.test(user)) {
      out = { intent: 'unknown', items: [], confidence: 0.9 }; // a lighter model that leaves fields out
    } else if (system.startsWith('You classify') && /[\u0B80-\u0BFF]/.test(user)) {
      out = /சேமி/.test(user)
        ? { intent: 'unknown', items: [], language: 'ta', english: 'How long can the cake be stored in the fridge?', confidence: 0.9 }
        : { intent: 'price', items: [], language: 'ta', english: 'What is the price of kek lapis?', confidence: 0.9 };
    } else if (system.startsWith('You classify') && /halal的吗/.test(user)) {
      out = { intent: 'price', items: [{ sku: 'KL-CHS', qty: 1 }], language: 'zh', english: 'How much is cheese? Is it halal?', other_question: 'halal的吗', confidence: 0.9 };
    } else if (system.startsWith('You classify') && /berapa harga/.test(user)) {
      out = { intent: 'price', items: [], language: 'id', english: 'How much is the kek lapis?', confidence: 0.9 };
    } else if (system.startsWith('You classify')) {
      out = /dua kotak original/.test(user)
        ? { intent: 'order', items: [{ sku: 'KL-ORI', qty: 2 }, { sku: 'KL-CHS', qty: 1 }], name: null, address: null, confidence: 0.95 }
        : { intent: 'unknown', items: [], name: null, address: null, confidence: 0.9 };
    } else {
      const src = [...user.matchAll(/<source id="([^"]+)">\n([\s\S]*?)\n<\/source>/g)].find((m) => /room temperature/.test(m[2]));
      const tamil = /[\u0B80-\u0BFF]/.test(user.split('<message>')[1] || '');
      out = tamil
        ? { reply: 'குளிர்சாதனப் பெட்டியில் 2 வாரங்கள் வைக்கலாம்.', reply_english: 'It keeps 2 weeks in the fridge.', language: 'ta',
          answerable: Boolean(src), confidence: 'high', source_ids: src ? [src[1]] : [], needs_owner: false, reason: '', missing_info: '' }
        : { reply: 'Boleh! Kek lapis tahan 7 hari pada suhu bilik dan 2 minggu dalam peti sejuk.', language: 'ms',
        answerable: Boolean(src), confidence: 'high', source_ids: src ? [src[1]] : [], needs_owner: false, reason: '', missing_info: '' };
    }
    reply(200, { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(out) }] }, finishReason: 'STOP' }] });
  });
});
await new Promise((r) => server.listen(0, r));
test.after(() => server.close());

function useGemini() {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  mock.requests.length = 0;
  mock.next.length = 0;
}

// ---- tests ------------------------------------------------------------------
test('Gemini request: model, key, system prompt, JSON output, low thinking; thought parts are skipped', async () => {
  useGemini();
  mock.next.push(() => [200, { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: '{"ok":true}' }] } }] }]);
  const text = await gemini({ system: 'SYS', user: 'USER' });
  assert.equal(text, '{"ok":true}');
  const r = mock.requests[0];
  assert.equal(r.url, '/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(r.key, 'test-key');
  assert.equal(r.body.systemInstruction.parts[0].text, 'SYS');
  assert.equal(r.body.contents[0].parts[0].text, 'USER');
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.body.generationConfig.thinkingConfig.thinkingLevel, 'low');
});

test('if a model rejects the thinking setting, Gemini is retried without it', async () => {
  useGemini();
  mock.next.push(() => [400, { error: { message: 'thinkingLevel is not supported for this model' } }]);
  mock.next.push(() => [200, { candidates: [{ content: { parts: [{ text: '{"ok":1}' }] } }] }]);
  assert.equal(await gemini({ system: 's', user: 'u' }), '{"ok":1}');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[1].body.generationConfig.thinkingConfig, undefined);
});

test('Gemini embeddings: batch request with the right task type', async () => {
  useGemini();
  const vectors = await geminiEmbed(['kek simpan peti sejuk', 'hello'], 'query');
  assert.equal(vectors.length, 2);
  const r = mock.requests[0];
  assert.equal(r.url, '/v1beta/models/gemini-embedding-001:batchEmbedContents');
  assert.equal(r.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  assert.equal(r.body.requests[0].outputDimensionality, 768);
});

test('provider choice: Gemini when its key is set, Claude otherwise, none when forced to rules', () => {
  useGemini();
  assert.equal(providerInfo().provider, 'gemini');
  process.env.ANTHROPIC_API_KEY = 'x';
  assert.equal(providerInfo().provider, 'gemini', 'Gemini wins when both keys are set');
  process.env.AI_PROVIDER = 'anthropic';
  assert.equal(providerInfo().provider, 'anthropic');
  process.env.AI_PROVIDER = 'rules';
  assert.equal(providerInfo(), null);
  delete process.env.AI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  assert.equal(providerInfo(), null);
});

test('Gemini reads a Malay order from WhatsApp and SmartDesk creates the order', async () => {
  useGemini();
  const db = openDb({ file: ':memory:' });
  const r = await svc.handleInbound(db, { phone: '60111', profileName: 'Aisyah', text: 'Salam, nak dua kotak original dan satu cheese', waId: null });
  assert.equal(r.engine, 'gemini');
  assert.equal(r.intent, 'order');
  const items = db.prepare('SELECT name, qty FROM order_items ORDER BY id').all().map((i) => `${i.qty} ${i.name}`);
  assert.deepEqual(items, ['2 Kek Lapis Original', '1 Kek Lapis Cheese']);
  assert.match(ai.engineName(), /^Gemini \(gemini-3\.8-flash\)$/);
});

test('if Gemini fails, the keyword engine takes over and the dashboard says so', async () => {
  useGemini();
  for (let i = 0; i < 3; i++) mock.next.push(() => [503, { error: { message: 'This model is currently experiencing high demand.' } }]);
  const result = await ai.understand('I want 2 original', [{ id: 1, sku: 'KL-ORI', name: 'Kek Lapis Original', keywords: 'original,ori', price: 45, stock: 10 }]);
  assert.equal(result.engine, 'rules');
  assert.equal(result.intent, 'order');
  assert.match(ai.engineName(), /last call failed/);
});

test('full flow on Gemini: FAQ question -> Gemini classifies -> meaning search -> Gemini drafts in Malay', async () => {
  useGemini();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdesk-gemini-'));
  rag.configure({ knowledgeDir: path.resolve('knowledge'), indexPath: path.join(dir, 'i.json'), logPath: path.join(dir, 'l.jsonl'), llm: undefined, embed: undefined });
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60122', profileName: 'Mei', text: 'Kek ni boleh simpan dalam peti sejuk berapa lama?', waId: null });
  await svc.waitForDrafts();

  const e = db.prepare('SELECT * FROM escalations ORDER BY id DESC LIMIT 1').get();
  assert.equal(e.draft_status, 'ready');
  assert.match(e.draft_reply, /peti sejuk/);
  assert.ok(mock.requests.some((r) => r.url.endsWith(':batchEmbedContents')), 'meaning-based search was used');
  const status = await rag.status(db);
  assert.equal(status.search, 'keyword + semantic');
});

// ---- any language -------------------------------------------------------------
const { keepsProtectedTokens } = await import('../src/translate.js');
const { reply: R } = await import('../src/replies.js');

const lastOut = (db, phone) => db.prepare(`SELECT m.* FROM messages m JOIN customers c ON c.id = m.customer_id
  WHERE c.phone = ? AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1`).get(phone);

test('a Tamil customer gets the reply translated to Tamil; the owner sees the English for both', async () => {
  useGemini();
  const db = openDb({ file: ':memory:' });
  const r = await svc.handleInbound(db, { phone: '60140', profileName: 'Kavitha', text: 'கேக் லாபிஸ் விலை என்ன?', waId: null });
  assert.equal(r.lang, 'ta');
  const out = lastOut(db, '60140');
  assert.match(out.body, /^TA Our kek lapis/);
  assert.match(out.body, /RM45\.00/);
  assert.match(out.translation_en, /^Our kek lapis/);
  const inbound = db.prepare(`SELECT translation_en FROM messages WHERE direction = 'in'`).get();
  assert.equal(inbound.translation_en, 'What is the price of kek lapis?');

  // Later automatic messages (e.g. order updates) are translated too.
  await svc.sendToCustomer(db, out.customer_id, R.paymentReceived('ta', { invoiceNo: 'INV-2026-0007', code: 'ORD-0007' }), 'system');
  assert.match(lastOut(db, '60140').body, /^TA .*INV-2026-0007/);
});

test('if a translation changes any number or code, the English reply is sent instead', async () => {
  useGemini();
  mock.breakNumbers = true;
  try {
    const db = openDb({ file: ':memory:' });
    await svc.handleInbound(db, { phone: '60141', profileName: null, text: 'கேக் லாபிஸ் விலை என்ன?', waId: null });
    const out = lastOut(db, '60141');
    assert.match(out.body, /^Our kek lapis/);
    assert.match(out.body, /RM45\.00/);
    assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'translation_skipped'`).get());
  } finally {
    mock.breakNumbers = false;
  }
});

test('owner replies are sent exactly as typed, never translated', async () => {
  useGemini();
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60142', profileName: null, text: 'கேக் லாபிஸ் விலை என்ன?', waId: null });
  const c = db.prepare(`SELECT id FROM customers WHERE phone = '60142'`).get();
  await svc.ownerReply(db, c.id, 'Thank you! See you soon.');
  assert.equal(lastOut(db, '60142').body, 'Thank you! See you soon.');
});

test('Malay messages stay Malay even if the AI calls them Indonesian', async () => {
  useGemini();
  const db = openDb({ file: ':memory:' });
  const r = await svc.handleInbound(db, { phone: '60143', profileName: null, text: 'berapa harga kek lapis?', waId: null });
  assert.equal(r.lang, 'ms');
  assert.match(lastOut(db, '60143').body, /^Kek lapis kami/);
});

test('FAQ drafts in another language come with an English version for the owner', async () => {
  useGemini();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdesk-ta-'));
  rag.configure({ knowledgeDir: path.resolve('knowledge'), indexPath: path.join(dir, 'i.json'), logPath: path.join(dir, 'l.jsonl'), llm: undefined, embed: undefined });
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60144', profileName: null, text: 'கேக்கை குளிர்சாதனப் பெட்டியில் எவ்வளவு நாள் சேமிக்கலாம்?', waId: null });
  await svc.waitForDrafts();
  const e = db.prepare('SELECT * FROM escalations ORDER BY id DESC LIMIT 1').get();
  assert.match(e.draft_reply, /குளிர்சாதனப்/);
  assert.equal(e.draft_reply_en, 'It keeps 2 weeks in the fridge.');
  await svc.sendDraft(db, e.id);
  assert.equal(lastOut(db, '60144').translation_en, 'It keeps 2 weeks in the fridge.');
});

test('translation check: numbers, codes and RM must all survive', () => {
  const src = 'Invoice INV-2026-0001: 2 x Kek Lapis Original = RM90.00. Pay to Maybank 5123 4567 8901.';
  assert.deepEqual(keepsProtectedTokens(src, 'விலைப்பட்டியல் INV-2026-0001: 2 x Kek Lapis Original = RM90.00. Maybank 5123 4567 8901'), []);
  assert.deepEqual(keepsProtectedTokens(src, 'INV-2026-0001: 2 x = RM90.00 Maybank 5123 4567'), ['8901']);
  assert.ok(keepsProtectedTokens(src, 'INV-2026-0001 2 90.00 5123 4567 8901').includes('RM'));
});

test('without an AI key, a Tamil message is still recognised and answered in English (not the previous language)', async () => {
  delete process.env.GEMINI_API_KEY;
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60145', profileName: null, text: '蛋糕多少钱?', waId: null });
  const r = await svc.handleInbound(db, { phone: '60145', profileName: null, text: 'கேக் லாபிஸ் விலை என்ன?', waId: null });
  assert.equal(r.engine, 'rules');
  assert.equal(r.lang, 'ta');
  assert.match(lastOut(db, '60145').body, /[A-Za-z]/);
  assert.doesNotMatch(lastOut(db, '60145').body, /[\u3400-\u9fff]/, 'not answered in Chinese');
  assert.equal(R.thanks('ta'), R.thanks('en'));
});

test('if Gemini is too slow, the customer gets the keyword-engine reply instead of waiting', async () => {
  useGemini();
  process.env.AI_REPLY_TIMEOUT_MS = '300';
  mock.next.push(() => new Promise((r) => setTimeout(() => r([200, { candidates: [] }]), 1500)));
  try {
    const started = Date.now();
    const db = openDb({ file: ':memory:' });
    const r = await svc.handleInbound(db, { phone: '60160', profileName: null, text: 'How much is the kek lapis?', waId: null });
    assert.ok(Date.now() - started < 1200, 'did not wait for the slow AI');
    assert.equal(r.engine, 'rules');
    assert.equal(r.intent, 'price');
    assert.match(ai.engineName(), /took too long/);
  } finally {
    delete process.env.AI_REPLY_TIMEOUT_MS;
  }
});

test('busy Gemini (503): one retry, then the fallback model, before giving up', async () => {
  useGemini();
  mock.next.push(() => [503, { error: { message: 'high demand' } }]);
  assert.equal(await gemini({ system: 's', user: 'u' }).then((t) => typeof t), 'string');
  assert.equal(mock.requests.length, 2, 'retried once on the same model');

  useGemini();
  mock.next.push(() => [503, { error: { message: 'high demand' } }]);
  mock.next.push(() => [503, { error: { message: 'high demand' } }]);
  await gemini({ system: 's', user: 'u' });
  assert.equal(mock.requests.length, 3);
  assert.match(mock.requests[2].url, /gemini-3\.5-flash:generateContent$/, 'third try uses the fallback model');
});

test('a wrong key or model name is not retried, and the error message is readable', async () => {
  useGemini();
  mock.next.push(() => [404, { error: { code: 404, message: 'models/gemini-x is not found', status: 'NOT_FOUND' } }]);
  await assert.rejects(gemini({ system: 's', user: 'u' }), /Gemini API failed \(404\): models\/gemini-x is not found$/);
  assert.equal(mock.requests.length, 1);
});

test('no connection to Gemini: retried, then the keyword engine answers', async () => {
  useGemini();
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1'; // nothing listens here
  const result = await ai.understand('How much is the kek lapis?', [{ id: 1, sku: 'KL-ORI', name: 'Kek Lapis Original', keywords: 'original', price: 45, stock: 10 }]);
  assert.equal(result.engine, 'rules');
  assert.match(ai.engineName(), /Could not reach Gemini/);
});

test('two questions in one message: the price is answered and the halal part goes to the owner with a draft', async () => {
  useGemini();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdesk-mixed-'));
  rag.configure({ knowledgeDir: path.resolve('knowledge'), indexPath: path.join(dir, 'i.json'), logPath: path.join(dir, 'l.jsonl'), llm: undefined, embed: undefined });
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60170', profileName: null, text: 'Cheese的多少啊 halal的吗', waId: null });
  await svc.waitForDrafts();
  const out = lastOut(db, '60170').body;
  assert.match(out, /RM60\.00/);
  assert.match(out, /关于您的另一个问题/);
  const e = db.prepare('SELECT * FROM escalations ORDER BY id DESC LIMIT 1').get();
  assert.equal(e.question, 'halal的吗');
  assert.ok(['ready', 'needs_review'].includes(e.draft_status));
});

test('a Tamil message is recognised even if the AI leaves out the language', async () => {
  useGemini();
  const db = openDb({ file: ':memory:' });
  const r = await svc.handleInbound(db, { phone: '60171', profileName: null, text: 'கேக் no-language-field', waId: null });
  assert.equal(r.lang, 'ta');
});

test('the second question is caught even when the AI misses it or the keyword engine answers', async () => {
  // AI answered the price but did not report the halal part
  useGemini();
  let db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60180', profileName: null, text: 'ori berapa harga, ada halal tak?', waId: null });
  let e = db.prepare('SELECT question FROM escalations ORDER BY id DESC LIMIT 1').get();
  assert.equal(e.question, 'ada halal tak');
  assert.match(lastOut(db, '60180').body, /RM45\.00[\s\S]*soalan anda yang satu lagi/);

  // no AI at all: the keyword engine quotes the price, the halal part still reaches the owner
  delete process.env.GEMINI_API_KEY;
  db = openDb({ file: ':memory:' });
  const r = await svc.handleInbound(db, { phone: '60181', profileName: null, text: 'ori的多少 halal的吗', waId: null });
  assert.equal(r.engine, 'rules');
  e = db.prepare('SELECT question FROM escalations ORDER BY id DESC LIMIT 1').get();
  assert.equal(e.question, 'halal的吗');
  assert.match(lastOut(db, '60181').body, /RM45\.00[\s\S]*关于您的另一个问题/);
});

test('routine messages without an owner topic do not create extra questions', async () => {
  delete process.env.GEMINI_API_KEY;
  const db = openDb({ file: ':memory:' });
  await svc.handleInbound(db, { phone: '60182', profileName: null, text: 'How much is the cheese one?', waId: null });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM escalations').get().n, 0);
});
