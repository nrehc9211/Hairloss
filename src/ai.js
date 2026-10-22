// Message understanding.
// The AI only *classifies* a customer message and *extracts* order data.
// Replies are built from the owner's own settings (prices, delivery info, discount rules),
// so customers always get the same, correct answer. Anything the AI is unsure about
// is escalated to the owner instead of guessed.
//
// Two engines:
//  - Claude (when ANTHROPIC_API_KEY or an `ant auth login` profile is available and the SDK is installed)
//  - Built-in keyword engine (always available, used as fallback)

const INTENTS = ['greeting', 'price', 'delivery', 'discount', 'order', 'details', 'payment', 'order_status', 'thanks', 'unknown'];

let claudeClient = null;
let claudeTried = false;

async function getClaude() {
  if (claudeTried) return claudeClient;
  claudeTried = true;
  if (process.env.AI_ENGINE === 'rules') return null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return null;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    claudeClient = new Anthropic();
    console.log('[ai] Claude engine enabled');
  } catch {
    console.log('[ai] @anthropic-ai/sdk not installed - using built-in keyword engine');
  }
  return claudeClient;
}

export function engineName() {
  return claudeClient ? 'Claude (claude-opus-5-5)' : 'Built-in keyword engine';
}

export async function understand(text, products) {
  const claude = await getClaude();
  if (claude) {
    try {
      const result = await classifyWithClaude(claude, text, products);
      if (result) return { ...result, engine: 'claude' };
    } catch (err) {
      console.warn('[ai] Claude call failed, falling back to rules:', err.message);
    }
  }
  return { ...classifyWithRules(text, products), engine: 'rules' };
}

// ---------------------------------------------------------------- Claude engine

async function classifyWithClaude(client, text, products) {
  const catalog = products.map(p => `${p.sku}: ${p.name} (RM${p.price})`).join('\n');
  const system = `You classify WhatsApp messages sent to a small Malaysian kek lapis (layer cake) shop.
Customers write in English, Malay or a mix. Return ONLY a JSON object, no prose:
{"intent": one of ${JSON.stringify(INTENTS)},
 "items": [{"sku": string, "qty": integer}],   // products the customer wants to order or get a quote for
 "name": string|null, "address": string|null,  // only if the customer states them
 "confidence": number between 0 and 1}
Intent guide: greeting=hello only; price=asks price/menu; delivery=asks delivery time/fee/area;
discount=asks promo/discount; order=wants to buy specific items; details=gives name and/or address;
payment=says they paid/transferred; order_status=asks where their order is; thanks=thanks/ok/bye;
unknown=anything else (custom requests, complaints, halal cert, allergies, bulk/corporate, etc.).
Use "unknown" whenever you are not sure. Product catalog:
${catalog}`;

  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: text }],
  });
  if (response.stop_reason === 'refusal') return null;

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!INTENTS.includes(parsed.intent)) return null;

  const bySku = new Map(products.map(p => [p.sku, p]));
  const items = (parsed.items || [])
    .filter(i => bySku.has(i.sku) && Number.isInteger(i.qty) && i.qty > 0)
    .map(i => ({ product: bySku.get(i.sku), qty: i.qty }));
  // Low confidence -> let the owner handle it.
  const intent = (parsed.confidence ?? 1) < 0.6 ? 'unknown' : parsed.intent;
  return { intent, items, name: parsed.name || null, address: parsed.address || null };
}

// ---------------------------------------------------------------- Keyword engine

const has = (t, words) => words.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t));

export function extractDetails(text) {
  const name = text.match(/(?:^|\n|,|;)\s*(?:name|nama)\s*[:\-]\s*([^\n,;]+)/i)?.[1]?.trim() || null;
  const address = text.match(/(?:address|alamat)\s*[:\-]\s*([\s\S]+?)(?=\n\s*(?:name|nama)\s*[:\-]|$)/i)?.[1]?.trim() || null;
  return { name, address };
}

export function extractItems(text, products) {
  const t = text.toLowerCase();
  const tokens = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5 };
  const found = new Map();
  tokens.forEach((tok, idx) => {
    const product = products.find(p => p.keywords.split(',').includes(tok));
    if (!product) return;
    let qty = null;
    // look back up to 4 tokens for a quantity ("2 box original", "dua kotak cheese")
    for (let j = idx - 1; j >= Math.max(0, idx - 4) && qty === null; j--) {
      if (/^\d+$/.test(tokens[j])) qty = parseInt(tokens[j], 10);
      else if (numberWords[tokens[j]]) qty = numberWords[tokens[j]];
      else if (products.some(p => p.keywords.split(',').includes(tokens[j]))) break;
    }
    // or forward: "cheese x2", "cheese 2 box"
    if (qty === null) {
      const next = tokens[idx + 1] || '';
      const m = next.match(/^x?(\d+)$/);
      if (m) qty = parseInt(m[1], 10);
    }
    found.set(product.sku, { product, qty: (found.get(product.sku)?.qty || 0) + (qty || 1) });
  });
  return [...found.values()];
}

export function classifyWithRules(text, products) {
  const t = text.toLowerCase();
  const details = extractDetails(text);
  const items = extractItems(text, products);

  const orderWords = ['order', 'want', 'nak', 'buy', 'beli', 'take', 'ambil', 'book', 'tempah', 'i ll', 'id like', 'please send', 'pesan'];
  const priceWords = ['price', 'how much', 'harga', 'berapa', 'menu', 'cost', 'rm', 'list', 'flavour', 'flavor', 'perisa'];
  const deliveryWords = ['how long', 'deliver', 'delivery', 'arrive', 'sampai', 'shipping', 'pos', 'postage', 'courier', 'berapa lama', 'when will', 'ship', 'hantar'];
  const discountWords = ['discount', 'promo', 'promotion', 'voucher', 'diskaun', 'murah', 'cheaper', 'offer', 'deal'];
  const paymentWords = ['paid', 'transferred', 'transfer', 'bank in', 'banked in', 'dah bayar', 'sudah bayar', 'receipt', 'resit', 'payment done', 'dah transfer'];
  const statusWords = ['where is my order', 'my order status', 'track', 'tracking', 'status', 'mana order', 'dah pos', 'dah hantar'];
  const greetWords = ['hi', 'hello', 'hey', 'assalamualaikum', 'salam', 'good morning', 'good afternoon', 'helo'];
  const thanksWords = ['thanks', 'thank you', 'tq', 'terima kasih', 'ok', 'okay', 'noted', 'bye'];

  if (has(t, paymentWords)) return { intent: 'payment', items: [], ...details };
  if (details.name || details.address) return { intent: items.length ? 'order' : 'details', items, ...details };
  if (items.length && has(t, priceWords) && !has(t, orderWords)) return { intent: 'price', items, ...details };
  if (items.length) return { intent: 'order', items, ...details };
  if (has(t, statusWords)) return { intent: 'order_status', items: [], ...details };
  if (has(t, deliveryWords)) return { intent: 'delivery', items: [], ...details };
  if (has(t, discountWords)) return { intent: 'discount', items: [], ...details };
  if (has(t, priceWords)) return { intent: 'price', items: [], ...details };
  if (has(t, orderWords) && /kek|cake|lapis/.test(t)) return { intent: 'price', items: [], ...details };
  const short = t.replace(/[^a-z\s]/g, '').trim().split(/\s+/).length <= 4;
  if (short && has(t, greetWords)) return { intent: 'greeting', items: [], ...details };
  if (short && has(t, thanksWords)) return { intent: 'thanks', items: [], ...details };
  return { intent: 'unknown', items: [], ...details };
}
