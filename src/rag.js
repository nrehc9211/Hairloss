// FAQ answers (RAG) for questions the routine replies can't handle.
//
// Knowledge base = files in knowledge/ (faq.json, plus any .md / .txt / .pdf you add)
//                + live shop facts from the database (settings and products),
// so a draft never quotes an old price. The index rebuilds itself whenever
// any of these change.
//
// Drafts need an AI key (GEMINI_API_KEY, or ANTHROPIC_API_KEY). Without one, isAvailable() is false
// and SmartDesk works exactly as before: the question just waits in the Inbox.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getSettings } from './db.js';

const require = createRequire(import.meta.url);
const { createRag } = require('./rag/index.cjs');
const { chunkCatalogue, loadFile } = require('./rag/chunk.cjs');
const { providerInfo, complete } = require('./rag/llm.cjs');
const { defaultEmbedder } = require('./rag/embeddings.cjs');
const { readLog } = require('./rag/log.cjs');
const { buildReport } = require('./rag/report.cjs');

let options = {
  knowledgeDir: path.resolve('knowledge'),
  indexPath: path.resolve('data', 'rag-index.json'),
  logPath: path.resolve('data', 'rag-log.jsonl'),
  llm: undefined, // tests inject a fake
  embed: undefined,
};
let rag = null;
let signature = null;
let lastBuild = null;

// Tests (and future setups) can point at other folders or a fake AI.
export function configure(overrides = {}) {
  options = { ...options, ...overrides };
  rag = null;
  signature = null;
  lastBuild = null;
}

function instance() {
  if (!rag) {
    rag = createRag({ indexPath: options.indexPath, logPath: options.logPath, llm: options.llm, embed: options.embed });
  }
  return rag;
}

export function isAvailable() {
  return Boolean(options.llm || providerInfo());
}

function knowledgeFiles() {
  if (!fs.existsSync(options.knowledgeDir)) return [];
  return fs.readdirSync(options.knowledgeDir)
    .filter((f) => /\.(json|md|txt|csv|pdf)$/i.test(f))
    .map((f) => path.join(options.knowledgeDir, f))
    .sort();
}

const rm = (n) => `RM${Number(n).toFixed(2)}`;

// Turns the owner's current settings and products into searchable facts.
function shopFacts(db) {
  const s = getSettings(db);
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();
  return {
    business: {
      name: s.business_name,
      currency: 'RM',
      delivery: `${s.delivery_info} Delivery fee ${rm(s.delivery_fee)}, free for orders above ${rm(s.free_delivery_min)}.`,
      discount: `${s.discount_pct}% off when ordering ${s.discount_min_qty} boxes or more (any flavour mix).`,
      payment: `Bank transfer to ${s.bank_details}. Payment is due ${s.payment_terms_days} days after the invoice.`,
    },
    items: products.map((p) => ({
      id: p.sku,
      name: p.name,
      aliases: p.keywords.split(',').map((k) => k.trim()),
      price: p.price,
      unit: 'per box',
      availability: !p.active ? 'Not sold at the moment' : p.stock > 0 ? 'In stock' : 'Sold out',
    })),
  };
}

function currentSignature(db) {
  const files = knowledgeFiles().map((f) => `${path.basename(f)}:${fs.statSync(f).mtimeMs}`);
  const embedder = options.embed !== undefined ? (options.embed ? 'custom' : 'none') : defaultEmbedder()?.name || 'none';
  return JSON.stringify({ facts: shopFacts(db), files, embedder });
}

// Rebuild the search index when the FAQ files or shop data changed.
export async function ensureIndex(db) {
  const sig = currentSignature(db);
  if (sig === signature) return lastBuild;
  const facts = shopFacts(db);
  const chunks = [];
  const names = ['shop-settings'];
  for (const file of knowledgeFiles()) {
    if (path.basename(file).toLowerCase() === 'faq.json') {
      facts.faq = JSON.parse(fs.readFileSync(file, 'utf8')).faq || [];
    } else {
      chunks.push(...(await loadFile(file)));
    }
    names.push(path.basename(file));
  }
  chunks.unshift(...chunkCatalogue(facts, 'shop'));
  lastBuild = { ...(await instance().buildChunks(chunks, names)), files: names };
  signature = sig;
  return lastBuild;
}

// Draft a WhatsApp reply to one customer question. Never sends anything.
export async function draftAnswer(db, question, customer = {}) {
  await ensureIndex(db);
  return instance().ask(question, customer);
}

export async function status(db) {
  const build = await ensureIndex(db);
  const log = readLog(options.logPath);
  return {
    available: isAvailable(),
    chunks: build.chunks,
    search: build.semantic ? 'keyword + semantic' : 'keyword',
    files: build.files,
    questions: log.length,
    unanswered: log.filter((e) => !e.answerable).length,
  };
}

// The hypothesis document: what customers asked that the FAQ could not answer.
export async function report(db, { useAi = false } = {}) {
  const llm = useAi ? options.llm || complete : null;
  return buildReport(readLog(options.logPath), { businessName: getSettings(db).business_name, llm });
}

// Tests the hypotheses: re-asks every unanswered question against the current FAQ.
export async function retest(db) {
  await ensureIndex(db);
  const questions = [...new Set(readLog(options.logPath).filter((e) => !e.answerable).map((e) => e.question))];
  const checker = createRag({
    indexPath: options.indexPath,
    logPath: options.logPath.replace(/\.jsonl$/, '-retest.jsonl'),
    llm: options.llm,
    embed: options.embed,
  });
  const results = [];
  for (const q of questions) {
    const d = await checker.ask(q, { customerName: 'retest' });
    results.push({ question: q, nowAnswered: d.answerable });
  }
  return { total: questions.length, nowAnswered: results.filter((r) => r.nowAnswered).length, results };
}
