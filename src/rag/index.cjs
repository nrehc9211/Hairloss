'use strict';
// OrderLah RAG: answers customer questions from the business's own documents.
//
//   const { createRag } = require('./src/rag/index.cjs');
//   const rag = createRag();
//   await rag.build(['data/catalogue.json']);        // once, or whenever documents change
//   const draft = await rag.ask('berapa kek coklat 8 inci?', { customerName: 'Aina' });
//
// The result is a DRAFT for the owner to approve; this module never sends anything.

const fs = require('node:fs');
const path = require('node:path');
const { loadFile } = require('./chunk.cjs');
const { buildKeywordIndex, keywordSearch } = require('./keyword.cjs');
const { vectorSearch, defaultEmbedder } = require('./embeddings.cjs');
const { complete, parseJson, ANSWER_SYSTEM_PROMPT, buildAnswerPrompt } = require('./llm.cjs');
const { appendLog } = require('./log.cjs');

const TOP_K = 5;
const RRF_K = 60; // standard constant for reciprocal rank fusion
const PRICE_PATTERN = /RM\s?(\d+(?:[.,]\d{1,2})?)/gi;

function prices(text) {
  return [...String(text).matchAll(PRICE_PATTERN)].map((m) => Number(m[1].replace(',', '.')).toFixed(2));
}

// Merge keyword and semantic rankings: items ranked high in either list rise to the top.
function fuse(lists, k) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) || 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
}

function createRag(options = {}) {
  const indexPath = options.indexPath || path.join('data', 'rag-index.json');
  const logPath = options.logPath || path.join('data', 'rag-log.jsonl');
  const llm = options.llm || complete;
  // options.embed: a function, null (keyword search only) or undefined (pick automatically)
  const embedFn = options.embed !== undefined ? options.embed : defaultEmbedder()?.embed || null;
  let state = null; // { chunks, vectors, keyword }

  function load() {
    if (state) return state;
    if (!fs.existsSync(indexPath)) throw new Error(`No index at ${indexPath}. Run: npm run rag:build`);
    const saved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    state = { ...saved, keyword: buildKeywordIndex(saved.chunks) };
    return state;
  }

  async function build(files) {
    const chunks = [];
    for (const file of files) chunks.push(...(await loadFile(file)));
    return buildChunks(chunks, files.map((f) => path.basename(f)));
  }

  // Build from chunks prepared elsewhere (e.g. live shop data from the database).
  async function buildChunks(chunks, sourceNames = []) {
    let vectors = null;
    if (embedFn) {
      try {
        const embedded = await embedFn(chunks.map((c) => c.text), 'document');
        vectors = Object.fromEntries(chunks.map((c, i) => [c.id, embedded[i]]));
      } catch (err) {
        console.warn('[rag] embeddings failed, using keyword search only:', err.message);
      }
    }
    const saved = { builtAt: new Date().toISOString(), files: sourceNames, chunks, vectors };
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(saved));
    state = { ...saved, keyword: buildKeywordIndex(chunks) };
    return { chunks: chunks.length, semantic: Boolean(vectors) };
  }

  async function retrieve(question, k = TOP_K) {
    const { chunks, vectors, keyword } = load();
    const lists = [keywordSearch(keyword, question, k * 2)];
    if (vectors && embedFn) {
      try {
        const [queryVector] = await embedFn([question], 'query');
        lists.push(vectorSearch(vectors, queryVector, k * 2));
      } catch (err) {
        console.warn('[rag] query embedding failed, using keyword search only:', err.message);
      }
    }
    const byId = new Map(chunks.map((c) => [c.id, c]));
    return fuse(lists, k).map((hit) => ({ ...byId.get(hit.id), score: hit.score }));
  }

  async function ask(question, { customerId = null, customerName = null } = {}) {
    const sources = await retrieve(question);
    const raw = await llm({ system: ANSWER_SYSTEM_PROMPT, user: buildAnswerPrompt(question, sources, customerName) });
    const result = parseJson(raw);
    const flags = [];

    // Guard 1: every price in the reply must appear in the retrieved sources.
    const sourcePrices = new Set(sources.flatMap((s) => prices(s.text)));
    const unknownPrices = prices(result.reply).filter((p) => !sourcePrices.has(p));
    if (unknownPrices.length) flags.push(`PRICE_NOT_IN_SOURCE: RM${unknownPrices.join(', RM')}`);

    // Guard 2: the model may only cite sources it was actually given.
    const givenIds = new Set(sources.map((s) => s.id));
    const citedIds = (result.source_ids || []).filter((id) => givenIds.has(id));
    if (citedIds.length !== (result.source_ids || []).length) flags.push('CITED_UNKNOWN_SOURCE');
    if (result.answerable && citedIds.length === 0) flags.push('ANSWER_WITHOUT_SOURCE');

    if (!result.answerable) flags.push('NOT_IN_DOCUMENTS');
    const needsOwner = Boolean(result.needs_owner) || flags.length > 0;
    const draft = {
      question,
      customerId,
      customerName,
      reply: result.reply,
      replyEnglish: result.reply_english || '',
      language: result.language,
      answerable: Boolean(result.answerable),
      confidence: flags.some((f) => f !== 'NOT_IN_DOCUMENTS') ? 'low' : result.confidence,
      sources: citedIds,
      retrieved: sources.map((s) => s.id),
      status: !needsOwner && result.confidence === 'high' ? 'ready' : 'needs_review',
      flags,
      reason: result.reason || '',
      missingInfo: result.missing_info || '',
      at: new Date().toISOString(),
    };
    appendLog(logPath, draft);
    return draft;
  }

  return { build, buildChunks, load, retrieve, ask, indexPath, logPath };
}

module.exports = { createRag, prices, fuse };
