// AI layer for orders: turns a WhatsApp message (text, voice, photo) into structured order data.
// AI only READS. It never sets prices, never approves, never sends money.
import { config } from '../config.js';
import { parseOrderText } from './parser.js';
import { chatJson, chat, provider } from './llm.js';

const SYSTEM = (catalog, todayIso) => `You read customer orders sent on WhatsApp to a small Malaysian home bakery.
Messages mix Malay, English, Chinese and Manglish, and may be voice transcripts with filler words.
Today is ${todayIso} (Asia/Kuala_Lumpur). "esok"/"tomorrow"/"明天" = today+1, "lusa"/"后天" = today+2.

CATALOG (sku | name | unit | aliases):
${catalog.map((c) => `${c.sku} | ${c.name} | ${c.unit} | ${(c.aliases || []).join(', ')}`).join('\n')}

Return ONLY a JSON object, no prose:
{"isOrder": boolean,
 "items": [{"sku": string|null, "raw": string, "qty": number, "unit": string|null, "confidence": number}],
 "deliveryDate": "YYYY-MM-DD"|null,
 "notes": string|null}
Rules:
- sku MUST be one of the catalog SKUs, or null if you are not sure which product it is. Never invent SKUs.
- "raw" = the customer's own words for that line.
- confidence 0..1 for the whole line (product + quantity). Use < 0.7 when you guessed.
- If no quantity is given use 1 and confidence 0.5.
- Never output prices. Never add items the customer did not ask for.
- Questions about price or stock are NOT orders -> {"isOrder": false, "items": []}.`;

/** Keep only what the rest of the app can trust. */
function sanitize(result, catalog) {
  const skus = new Set(catalog.map((c) => c.sku));
  const items = (result.items || [])
    .map((i) => ({
      sku: skus.has(i.sku) ? i.sku : null,
      raw: String(i.raw || '').slice(0, 120),
      qty: Number.isFinite(Number(i.qty)) && Number(i.qty) >= 0 ? Number(i.qty) : 1,
      unit: i.unit || null,
      confidence: Math.max(0, Math.min(1, Number(i.confidence ?? 0.5))),
    }))
    .filter((i) => i.raw || i.sku);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(result.deliveryDate || '') ? result.deliveryDate : null;
  return { items, deliveryDate: d, notes: result.notes || null, isOrder: Boolean(result.isOrder ?? items.length) };
}

/**
 * @returns {Promise<{items:any[], deliveryDate:string|null, notes:string|null, isOrder:boolean, engine:string, error?:string}>}
 */
export async function extractOrder({ text, catalog, todayIso }) {
  if (provider() === 'none' || !text?.trim()) return parseOrderText(text, catalog, todayIso);
  try {
    const out = await chatJson({ system: SYSTEM(catalog, todayIso), user: `WhatsApp message:\n"""${text}"""` });
    const clean = sanitize(out, catalog);
    // If the model found nothing but the rule parser does, trust the rule parser.
    if (!clean.items.length) {
      const rules = parseOrderText(text, catalog, todayIso);
      if (rules.items.some((i) => i.sku && i.confidence >= 0.85)) return { ...rules, engine: `rules (after ${provider()})` };
    }
    return { ...clean, engine: provider() };
  } catch (err) {
    console.warn('[ai] extract failed, falling back to rule parser:', err.message);
    return { ...parseOrderText(text, catalog, todayIso), error: err.message };
  }
}

/** Voice note -> text. Uses OpenAI speech-to-text when an OpenAI key is set. */
export async function transcribe(buffer, mimeType = 'audio/ogg') {
  if (!config.ai.openaiKey) throw new Error('Voice notes need OPENAI_API_KEY (speech-to-text)');
  const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType.split(';')[0] }), `voice.${ext}`);
  form.append('model', config.ai.transcribeModel);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.openaiKey}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Transcribe HTTP ${res.status}`);
  return json.text || '';
}

/** Photo of a handwritten / printed order -> plain text lines (needs a vision-capable model). */
export async function imageToText(buffer, mimeType = 'image/jpeg') {
  const p = provider();
  const b64 = buffer.toString('base64');
  const media = mimeType.split(';')[0];
  const ask = 'This is a photo of an order sent on WhatsApp. Copy every order line as plain text, one per line, like "2 chocolate cakes". Keep the original words. Output only the lines.';
  const system = 'You transcribe order lists from photos.';
  if (p === 'anthropic') {
    return chat({ system, json: false, user: [{ type: 'image', source: { type: 'base64', media_type: media, data: b64 } }, { type: 'text', text: ask }] });
  }
  if (p === 'openai' || p === 'runpod') {
    return chat({ system, json: false, user: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: `data:${media};base64,${b64}` } }] });
  }
  throw new Error('Reading photos needs an AI model');
}
