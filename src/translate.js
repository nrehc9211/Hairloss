// Translates SmartDesk's replies into languages that have no hand-written template
// (anything other than English, Malay and Chinese), e.g. Tamil or Indonesian.
//
// Safety: prices, quantities, dates, order/invoice codes and bank account numbers
// must survive the translation exactly. If any of them changed or went missing,
// the original English reply is sent instead, so a customer never gets a wrong number.
import { createRequire } from 'node:module';
import { languageName } from './replies.js';

const require = createRequire(import.meta.url);
const { complete, providerInfo, parseJson } = require('./rag/llm.cjs');

const SYSTEM_PROMPT = (language) => `You translate WhatsApp messages from a small Malaysian cake shop to its customer.
Translate the message into ${language}. Keep a warm, natural WhatsApp tone.
Keep EXACTLY as written, character for character: every number, price (RM...), date, phone or bank
account number, order and invoice code (like ORD-0001 or INV-2026-0001), product names (like
"Kek Lapis Original"), emojis and line breaks. Do not add or remove information.
Return ONLY JSON: {"translation": string}`;

// Things that must appear unchanged in the translation.
export function protectedTokens(text) {
  const t = String(text);
  return {
    numbers: t.match(/\d+(?:[.,]\d+)*/g) || [],
    codes: t.match(/\b[A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*\b/g) || [],
    rm: (t.match(/RM/g) || []).length,
  };
}

export function keepsProtectedTokens(source, translation) {
  const src = protectedTokens(source);
  const out = String(translation);
  const missing = [...src.numbers, ...src.codes].filter((tok) => !out.includes(tok));
  if ((out.match(/RM/g) || []).length < src.rm) missing.push('RM');
  return missing;
}

// Returns { text, translated, problem }. Never throws: on any problem it returns the original.
export async function translateReply(body, lang) {
  if (!providerInfo()) return { text: body, translated: false, problem: 'no AI configured' };
  try {
    const raw = await complete({ system: SYSTEM_PROMPT(languageName(lang)), user: body, maxTokens: 1024, timeoutMs: Number(process.env.AI_REPLY_TIMEOUT_MS) || 8000 });
    const translation = String(parseJson(raw).translation || '').trim();
    if (!translation) return { text: body, translated: false, problem: 'empty translation' };
    const missing = keepsProtectedTokens(body, translation);
    if (missing.length) return { text: body, translated: false, problem: `changed or missing: ${missing.slice(0, 5).join(', ')}` };
    return { text: translation, translated: true, problem: null };
  } catch (err) {
    return { text: body, translated: false, problem: err.message.slice(0, 160) };
  }
}
