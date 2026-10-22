'use strict';
// Offline tests: Claude and Voyage are replaced with fakes, so no API keys or internet needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chunkCatalogue, chunkText } = require('../src/rag/chunk.cjs');
const { buildKeywordIndex, keywordSearch } = require('../src/rag/keyword.cjs');
const { createRag, prices, fuse } = require('../src/rag/index.cjs');
const { readLog } = require('../src/rag/log.cjs');
const { buildReport } = require('../src/rag/report.cjs');

for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'VOYAGE_API_KEY', 'AI_PROVIDER']) delete process.env[k];

const CATALOGUE = path.join(__dirname, 'fixtures', 'catalogue.sample.json');
const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-'));
  return { indexPath: path.join(dir, 'index.json'), logPath: path.join(dir, 'log.jsonl') };
}

// Fake Claude: returns whatever JSON the test sets up.
function fakeLlm(response) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return JSON.stringify(typeof response === 'function' ? response(args) : response);
  };
  fn.calls = calls;
  return fn;
}

test('catalogue becomes one chunk per product, FAQ entry and business info', () => {
  const chunks = chunkCatalogue(catalogue, 'catalogue.json');
  assert.equal(chunks.length, 1 + catalogue.items.length + catalogue.faq.length);
  const choc = chunks.find((c) => c.id === 'catalogue.json#P001');
  assert.match(choc.text, /RM120\.00/);
  assert.match(choc.text, /kek coklat/);
});

test('long text is split into chunks under the size limit', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(10)).join('\n\n');
  const chunks = chunkText(text, 'notes.txt');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.text.length <= 1000));
});

test('keyword search finds products by Malay, English and Chinese names', () => {
  const index = buildKeywordIndex(chunkCatalogue(catalogue, 'c'));
  assert.equal(keywordSearch(index, 'berapa kek coklat 8 inch?')[0].id, 'c#P001');
  assert.equal(keywordSearch(index, 'roti kaya ada?')[0].id, 'c#P004');
  assert.equal(keywordSearch(index, '芝士蛋糕多少钱')[0].id, 'c#P003');
});

test('prices are normalised for comparison', () => {
  assert.deepEqual(prices('RM85 or RM 120.00, or RM2.5'), ['85.00', '120.00', '2.50']);
});

test('fusion ranks items found by both searches highest', () => {
  const fused = fuse([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]], 3);
  assert.equal(fused[0].id, 'b');
});

test('a correct, sourced answer is ready for one-tap approval', async () => {
  const llm = fakeLlm({
    reply: 'Hi! Kek coklat 8 inci RM120 ya.',
    language: 'mixed',
    answerable: true,
    confidence: 'high',
    source_ids: ['catalogue.sample.json#P001'],
    needs_owner: false,
    reason: '',
    missing_info: '',
  });
  const rag = createRag({ ...tempPaths(), llm, embed: null });
  await rag.build([CATALOGUE]);
  const draft = await rag.ask('berapa kek coklat 8 inci?', { customerName: 'Aina' });
  assert.equal(draft.status, 'ready');
  assert.deepEqual(draft.flags, []);
  assert.match(llm.calls[0].user, /Chocolate Cake/); // the right product reached Claude
  assert.equal(readLog(rag.logPath).length, 1);
});

test('a price that is not in the documents is flagged for the owner', async () => {
  const llm = fakeLlm({
    reply: 'Kek coklat RM99 sahaja!',
    language: 'ms',
    answerable: true,
    confidence: 'high',
    source_ids: ['catalogue.sample.json#P001'],
    needs_owner: false,
  });
  const rag = createRag({ ...tempPaths(), llm, embed: null });
  await rag.build([CATALOGUE]);
  const draft = await rag.ask('kek coklat berapa?');
  assert.equal(draft.status, 'needs_review');
  assert.equal(draft.confidence, 'low');
  assert.ok(draft.flags.some((f) => f.startsWith('PRICE_NOT_IN_SOURCE')));
});

test('citing a source that was never retrieved is flagged', async () => {
  const llm = fakeLlm({ reply: 'Yes', answerable: true, confidence: 'high', source_ids: ['made-up#X'], needs_owner: false });
  const rag = createRag({ ...tempPaths(), llm, embed: null });
  await rag.build([CATALOGUE]);
  const draft = await rag.ask('cheesecake ada?');
  assert.ok(draft.flags.includes('CITED_UNKNOWN_SOURCE'));
  assert.equal(draft.status, 'needs_review');
});

test('semantic search is used when an embedding function is provided', async () => {
  // Fake embeddings: "chocolate" meaning lives in dimension 0.
  const embed = async (texts) => texts.map((t) => (/coklat|chocolate|choc/i.test(t) ? [1, 0] : [0, 1]));
  const llm = fakeLlm({ reply: 'ok', answerable: true, confidence: 'high', source_ids: [], needs_owner: false });
  const rag = createRag({ ...tempPaths(), llm, embed });
  const built = await rag.build([CATALOGUE]);
  assert.equal(built.semantic, true);
  const hits = await rag.retrieve('something choc please');
  assert.equal(hits[0].id, 'catalogue.sample.json#P001');
});

test('unanswered questions become hypotheses in the report', async () => {
  const llm = fakeLlm({
    reply: 'Thanks for asking! We will check and get back to you.',
    language: 'en',
    answerable: false,
    confidence: 'low',
    source_ids: [],
    needs_owner: true,
    missing_info: 'halal certification status',
  });
  const rag = createRag({ ...tempPaths(), llm, embed: null });
  await rag.build([CATALOGUE]);
  await rag.ask('Is your cake halal?');
  await rag.ask('ada sijil halal?');
  const draft = await rag.ask('halal ke?');
  assert.ok(draft.flags.includes('NOT_IN_DOCUMENTS'));

  const report = await buildReport(readLog(rag.logPath), { businessName: 'Dapur Lina Cakes' });
  assert.match(report, /Not answerable from documents \| 3 \| 100%/);
  assert.match(report, /halal certification status/);
  assert.match(report, /\*\*How to test:\*\*/);
});

test('Claude credentials: own key first, then Replit AI Integrations', () => {
  const { anthropicConfig } = require('../src/rag/llm.cjs');
  const saved = { ...process.env };
  try {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
      'AI_INTEGRATIONS_ANTHROPIC_API_KEY', 'AI_INTEGRATIONS_ANTHROPIC_BASE_URL']) delete process.env[k];
    assert.throws(() => anthropicConfig(), /No Claude credentials/);

    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = 'replit-key';
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = 'http://localhost:1106/anthropic';
    assert.equal(anthropicConfig().provider, 'replit');
    assert.equal(anthropicConfig().model, 'claude-sonnet-5');

    process.env.ANTHROPIC_API_KEY = 'own-key';
    assert.equal(anthropicConfig().provider, 'anthropic');
  } finally {
    process.env = saved;
  }
});
