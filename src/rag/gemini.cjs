'use strict';
// Google Gemini API client, no packages needed (uses Node's built-in fetch).
//
//   GEMINI_API_KEY          required (GOOGLE_API_KEY also accepted)
//   GEMINI_MODEL            default gemini-3.8-flash
//   GEMINI_THINKING_LEVEL   default low (faster, cheaper); set "off" to omit
//   GEMINI_EMBED_MODEL      default gemini-embedding-001
//   GEMINI_FALLBACK_MODEL   default gemini-3.5-flash: used when the main model is busy ("off" to disable)
//   GEMINI_TIMEOUT_MS       default 15000: give up after this long (callers fall back safely)
//   GEMINI_BASE_URL         only for tests

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const EMBED_BATCH = 100;
const EMBED_DIMENSIONS = 768;

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function geminiConfig() {
  const apiKey = geminiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  return {
    apiKey,
    baseUrl: (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL ?? 'low',
    embedModel: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL === 'off' ? null : process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash',
  };
}

async function post(url, apiKey, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Gemini took too long (over ${Math.round(timeoutMs / 1000)}s)`);
    }
    // No connection at all (internet down, firewall, DNS): worth one more try.
    throw Object.assign(new Error(`Could not reach Gemini (${err.cause?.code || err.message})`), { network: true });
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try { message = JSON.parse(text).error?.message || message; } catch { /* not JSON */ }
    throw Object.assign(new Error(`Gemini API failed (${res.status}): ${message}`), { status: res.status, body: text });
  }
  return JSON.parse(text);
}

// Busy, rate-limited or unreachable: worth retrying. Wrong key or model name: not.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const isRetryable = (err) => Boolean(err.network) || RETRYABLE_STATUS.has(err.status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(c, model, body, timeoutMs) {
  const url = `${c.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    return await post(url, c.apiKey, body, timeoutMs);
  } catch (err) {
    // Some models don't accept a thinking setting: retry once without it.
    if (err.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(err.body || '')) {
      const { thinkingConfig, ...rest } = body.generationConfig;
      return post(url, c.apiKey, { ...body, generationConfig: rest }, timeoutMs);
    }
    throw err;
  }
}

// Same shape as the Claude function: ({ system, user }) => Promise<string>.
// Asks for JSON output, because every SmartDesk prompt expects a JSON object.
// If the model is busy (e.g. 503 "high demand") it retries once, then tries the
// fallback model, all within the time limit.
async function gemini({ system, user, timeoutMs }) {
  const c = geminiConfig();
  const limit = timeoutMs || Number(process.env.GEMINI_TIMEOUT_MS) || 15000;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  if (c.thinkingLevel && c.thinkingLevel !== 'off') body.generationConfig.thinkingConfig = { thinkingLevel: c.thinkingLevel };

  const attempts = [{ model: c.model }, { model: c.model, waitFirst: 700 }];
  if (c.fallbackModel && c.fallbackModel !== c.model) attempts.push({ model: c.fallbackModel });

  const started = Date.now();
  const deadline = started + limit;
  let json = null;
  let usedModel = null;
  let lastErr = null;
  for (const [i, attempt] of attempts.entries()) {
    if (attempt.waitFirst) await sleep(attempt.waitFirst);
    const remaining = deadline - Date.now();
    if (i > 0 && remaining < 1000) break; // not enough time left for a useful retry
    try {
      json = await callModel(c, attempt.model, body, remaining);
      usedModel = attempt.model;
      break;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
    }
  }
  if (!json) throw lastErr || new Error(`Gemini took too long (over ${Math.round(limit / 1000)}s)`);

  const took = Date.now() - started;
  if (usedModel !== c.model) console.log(`[ai] ${c.model} was busy, answered by ${usedModel}`);
  if (took > 2000) console.log(`[ai] Gemini answered in ${(took / 1000).toFixed(1)}s (${usedModel})`);

  const candidate = json.candidates?.[0];
  if (!candidate) {
    const blocked = json.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no answer${blocked ? ` (blocked: ${blocked})` : ''}`);
  }
  const text = (candidate.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error(`Gemini returned an empty answer (finishReason: ${candidate.finishReason || 'unknown'})`);
  return text;
}

// Embeddings for meaning-based search. inputType: 'document' or 'query'.
async function geminiEmbed(texts, inputType) {
  const c = geminiConfig();
  const url = `${c.baseUrl}/v1beta/models/${encodeURIComponent(c.embedModel)}:batchEmbedContents`;
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const request = {
      requests: texts.slice(i, i + EMBED_BATCH).map((text) => ({
        model: `models/${c.embedModel}`,
        content: { parts: [{ text }] },
        taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: EMBED_DIMENSIONS,
      })),
    };
    const limit = Number(process.env.GEMINI_TIMEOUT_MS) || 15000;
    let json;
    try {
      json = await post(url, c.apiKey, request, limit);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      await sleep(700);
      json = await post(url, c.apiKey, request, limit);
    }
    for (const e of json.embeddings || []) vectors.push(e.values);
  }
  if (vectors.length !== texts.length) throw new Error('Gemini returned the wrong number of embeddings');
  return vectors;
}

module.exports = { gemini, geminiEmbed, geminiConfig, geminiKey };
