// Message understanding.
// The AI only *classifies* a customer message and *extracts* order data.
// Replies are built from the owner's own settings (prices, delivery info, discount rules),
// so customers always get the same, correct answer. Anything the AI is unsure about
// is escalated to the owner instead of guessed.
//
// Two engines:
//  - AI: Google Gemini (GEMINI_API_KEY) or Claude (ANTHROPIC_API_KEY), see src/rag/llm.cjs
//  - Built-in keyword engine (always available, used as fallback)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { complete, providerInfo, parseJson } = require('./rag/llm.cjs');

const INTENTS = ['greeting', 'price', 'delivery', 'discount', 'order', 'details', 'payment', 'order_status', 'thanks', 'unknown'];

// Last AI call result, so the dashboard shows when the AI is failing
// instead of silently using the keyword engine.
const health = { lastError: null, lastErrorAt: null, lastOkAt: null };

export function engineName() {
  if (process.env.AI_ENGINE === 'rules') return 'Built-in keyword engine';
  const info = providerInfo();
  if (!info) return 'Built-in keyword engine';
  const failing = health.lastErrorAt && (!health.lastOkAt || health.lastErrorAt > health.lastOkAt);
  return `${info.label} (${info.model})${failing ? ` - last call failed, using keywords: ${health.lastError}` : ''}`;
}

export async function understand(text, products) {
  return addOwnerQuestion(text, await classify(text, products));
}

// Topics only the shop's FAQ or the owner can answer. If a message mentions one of these
// alongside a routine question ("ori berapa? ada halal tak?"), that part must not be lost,
// even if the AI missed it or the keyword engine answered.
const OWNER_TOPICS = [
  /halal|jakim|sijil|清真|حلال/i,
  /allerg|alerg|alahan|kacang|\bnuts?\b|peanut|过敏|坚果|花生/i,
  /ingredient|bahan|成分|材料|\begg(s|less)?\b|telur|鸡蛋|sugar.?free|tanpa gula|无糖/i,
  /simpan|peti sejuk|fridge|freez|store it|keep it|shelf life|tahan berapa|冰箱|保存|放多久/i,
  /write|tulis|ucapan|happy birthday|message on|写字|祝福/i,
];

export function ownerTopicPart(text) {
  const t = String(text);
  if (!OWNER_TOPICS.some((re) => re.test(t))) return null;
  const matches = (part) => OWNER_TOPICS.some((re) => re.test(part));
  const clauses = t.split(/[?？!！,，。;；\n]+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length > 1) return clauses.find(matches) || t.trim();
  // No punctuation ("ori的多少 halal的吗"): take the words from the first topic word onwards.
  const words = t.trim().split(/\s+/);
  const start = words.findIndex(matches);
  return start > 0 ? words.slice(start).join(' ') : t.trim();
}

function addOwnerQuestion(text, result) {
  if (result.intent === 'unknown' || result.otherQuestion) return result;
  const part = ownerTopicPart(text);
  return part ? { ...result, otherQuestion: part } : result;
}

async function classify(text, products) {
  if (process.env.AI_ENGINE !== 'rules' && providerInfo()) {
    try {
      const result = await classifyWithAi(text, products);
      health.lastOkAt = Date.now();
      if (result) return { ...result, engine: providerInfo().provider };
    } catch (err) {
      health.lastError = err.message.slice(0, 160);
      health.lastErrorAt = Date.now();
      console.warn('[ai] AI call failed, falling back to rules:', err.message);
    }
  }
  return { ...classifyWithRules(text, products), engine: 'rules' };
}

// ---------------------------------------------------------------- AI engine

export const CLASSIFY_SYSTEM_PROMPT = (catalog) => `You classify WhatsApp messages sent to a small Malaysian kek lapis (layer cake) shop.
Customers write in any language: mostly English, Malay, Chinese or a mix, sometimes Tamil, Indonesian or others.
Return ONLY a JSON object, no prose:
{"intent": one of ${JSON.stringify(INTENTS)},
 "items": [{"sku": string, "qty": integer}],
 "name": string or null, "address": string or null,
 "language": ISO 639-1 code of the language the customer wrote in (e.g. "en", "ms", "zh", "ta", "id"),
             or null if the message has no real words (only numbers, a name or an address),
 "english": the message translated to English if it is not already in English, otherwise null,
 "other_question": if the message ALSO asks something the chosen intent does not cover (for example a price
             question that also asks about halal status), that other part as a short question in the
             customer's own words; otherwise null,
 "confidence": number between 0 and 1}
"items": products the customer wants to order or get a quote for, using the SKUs below. Convert number
words in any language to digits (dua = 2, tiga = 3). "name"/"address": only if the customer states them.
Intent guide: greeting=hello only; price=asks price/menu; delivery=asks delivery time/fee/area;
discount=asks promo/discount; order=wants to buy specific items; details=gives name and/or address;
payment=says they paid/transferred; order_status=asks where their order is; thanks=thanks/ok/bye;
unknown=anything else. Use "unknown" for questions about ingredients, allergies, halal, storage or
shelf life, custom messages, gift boxes, pickup, bulk or corporate orders, complaints and custom requests:
the shop's FAQ answers those. Use "unknown" whenever you are not sure.
Product catalog:
${catalog}`;

async function classifyWithAi(text, products) {
  const catalog = products.map(p => `${p.sku}: ${p.name} (RM${p.price}) - customers may say: ${p.keywords}`).join('\n');
  // The customer is waiting: after 8 seconds the keyword engine answers instead.
  const raw = await complete({ system: CLASSIFY_SYSTEM_PROMPT(catalog), user: text, maxTokens: 512, timeoutMs: Number(process.env.AI_REPLY_TIMEOUT_MS) || 8000 });
  const parsed = parseJson(raw);
  if (!INTENTS.includes(parsed.intent)) return null;

  const bySku = new Map(products.map(p => [p.sku, p]));
  const items = (parsed.items || [])
    .filter(i => bySku.has(i.sku) && Number.isInteger(i.qty) && i.qty > 0)
    .map(i => ({ product: bySku.get(i.sku), qty: i.qty }));
  // Low confidence -> let the owner handle it.
  const intent = (parsed.confidence ?? 1) < 0.6 ? 'unknown' : parsed.intent;
  const language = /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(parsed.language || '') ? parsed.language.split('-')[0].toLowerCase() : null;
  const english = language && language !== 'en' && typeof parsed.english === 'string' ? parsed.english.trim() || null : null;
  const otherQuestion = intent !== 'unknown' && typeof parsed.other_question === 'string' ? parsed.other_question.trim() || null : null;
  return { intent, items, name: parsed.name || null, address: parsed.address || null, language, english, otherQuestion };
}

// ---------------------------------------------------------------- Keyword engine

// Chinese has no spaces between words, so Chinese keywords are matched as plain text.
const CJK = /[\u3400-\u9fff]/;
const has = (t, words) => words.some(w => (CJK.test(w) ? t.includes(w) : new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t)));

export function extractDetails(text) {
  const name = text.match(/(?:^|\n|,|;|，)\s*(?:name|nama|姓名|名字)\s*[:：\-]\s*([^\n,;，]+)/i)?.[1]?.trim() || null;
  const address = text.match(/(?:address|alamat|地址)\s*[:：\-]\s*([\s\S]+?)(?=\n\s*(?:name|nama|姓名|名字)\s*[:：\-]|$)/i)?.[1]?.trim() || null;
  return { name, address };
}

// Chinese numbers up to 99: 一 两 三 ... 十 十二 二十 二十五
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function chineseNumber(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!s.includes('十')) return CN_DIGITS[s] ?? null;
  const [tens, ones] = s.split('十');
  return (tens ? CN_DIGITS[tens] ?? 0 : 1) * 10 + (ones ? CN_DIGITS[ones] ?? 0 : 0);
}
const CN_QTY = '(\\d+|[一二两三四五六七八九十]+)';
const CN_UNIT = '(?:盒|个|份|条|块|件|粒|片)?';

function extractChineseItems(text, products, found) {
  for (const product of products) {
    for (const kw of product.keywords.split(',').map(k => k.trim()).filter(k => CJK.test(k))) {
      let idx = text.indexOf(kw);
      while (idx !== -1) {
        const before = text.slice(Math.max(0, idx - 6), idx).match(new RegExp(`${CN_QTY}\\s*${CN_UNIT}\\s*$`));
        const after = before ? null : text.slice(idx + kw.length, idx + kw.length + 6).match(new RegExp(`^\\s*(?:x|×)?\\s*${CN_QTY}\\s*${CN_UNIT}`));
        const qty = chineseNumber((before || after)?.[1] || '') || 1;
        found.set(product.sku, { product, qty: (found.get(product.sku)?.qty || 0) + qty });
        idx = text.indexOf(kw, idx + kw.length);
      }
    }
  }
}

export function extractItems(text, products) {
  const t = text.toLowerCase();
  const tokens = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, sembilan: 9, sepuluh: 10 };
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
  if (CJK.test(text)) extractChineseItems(text, products, found);
  return [...found.values()];
}

export function classifyWithRules(text, products) {
  const t = text.toLowerCase();
  const details = extractDetails(text);
  const items = extractItems(text, products);

  // English, Malay and Chinese words for each kind of message.
  const orderWords = ['order', 'want', 'nak', 'buy', 'beli', 'take', 'ambil', 'book', 'tempah', 'i ll', 'id like', 'please send', 'pesan',
    '我要', '要买', '买', '订购', '订', '下单', '给我'];
  const priceWords = ['price', 'how much', 'harga', 'berapa', 'menu', 'cost', 'rm', 'list', 'flavour', 'flavor', 'perisa',
    '多少钱', '价钱', '价格', '几钱', '多少', '价目', '菜单', '口味'];
  const deliveryWords = ['how long', 'deliver', 'delivery', 'arrive', 'sampai', 'shipping', 'pos', 'postage', 'courier', 'berapa lama', 'when will', 'ship', 'hantar',
    '送货', '运费', '邮费', '寄', '快递', '配送', '几天', '多久到', '送到'];
  const discountWords = ['discount', 'promo', 'promotion', 'voucher', 'diskaun', 'murah', 'cheaper', 'offer', 'deal',
    '折扣', '优惠', '便宜', '打折', '促销'];
  const paymentWords = ['paid', 'transferred', 'transfer', 'bank in', 'banked in', 'dah bayar', 'sudah bayar', 'receipt', 'resit', 'payment done', 'dah transfer',
    '已转账', '转账了', '付款了', '已付款', '已付', '汇款了', '付了'];
  const statusWords = ['where is my order', 'my order status', 'track', 'tracking', 'status', 'mana order', 'dah pos', 'dah hantar',
    '订单在哪', '到哪了', '查订单', '订单状态', '发货了吗', '寄出了吗', '什么时候到'];
  const greetWords = ['hi', 'hello', 'hey', 'assalamualaikum', 'salam', 'good morning', 'good afternoon', 'helo', 'hai',
    '你好', '您好', '哈喽', '嗨', '早安', '早上好'];
  const thanksWords = ['thanks', 'thank you', 'tq', 'terima kasih', 'ok', 'okay', 'noted', 'bye',
    '谢谢', '多谢', '感谢', '好的', '知道了', '拜拜'];
  // Topics that need the FAQ or the owner, not a template reply (shelf life, halal, allergies, custom requests...).
  const faqWords = ['halal', 'tahan', 'simpan', 'peti sejuk', 'fridge', 'keep', 'store', 'expire', 'alahan', 'alergi', 'allergy', 'allergic',
    'kacang', 'nut', 'nuts', 'telur', 'egg', 'eggless', 'ingredient', 'ingredients', 'bahan', 'corporate', 'korporat', 'bulk', 'custom',
    'tulis', 'ucapan', 'write', 'birthday', 'hari jadi', 'gift', 'hadiah', 'hamper', 'pickup', 'pick up', 'ambil sendiri', 'size', 'saiz',
    'cancel', 'batal', 'cod', 'cash', 'tunai', 'card',
    '清真', '保存', '放多久', '放几天', '冰箱', '过敏', '花生', '坚果', '鸡蛋', '无蛋', '成分', '材料', '写字', '生日', '祝福', '贺卡',
    '公司', '团购', '礼盒', '礼篮', '自取', '尺寸', '多大', '几片', '取消', '现金', '货到付款', '刷卡'];

  if (has(t, paymentWords)) return { intent: 'payment', items: [], ...details };
  if (details.name || details.address) return { intent: items.length ? 'order' : 'details', items, ...details };
  if (items.length && has(t, priceWords) && !has(t, orderWords)) return { intent: 'price', items, ...details };
  if (items.length) return { intent: 'order', items, ...details };
  if (has(t, faqWords)) return { intent: 'unknown', items: [], ...details };
  if (has(t, statusWords)) return { intent: 'order_status', items: [], ...details };
  if (has(t, deliveryWords)) return { intent: 'delivery', items: [], ...details };
  if (has(t, discountWords)) return { intent: 'discount', items: [], ...details };
  if (has(t, priceWords)) return { intent: 'price', items: [], ...details };
  if (has(t, orderWords) && /kek|cake|lapis|千层/.test(t)) return { intent: 'price', items: [], ...details };
  const latinWords = t.replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  const chineseChars = (t.match(/[\u3400-\u9fff]/g) || []).length;
  const short = latinWords <= 4 && chineseChars <= 6;
  if (short && has(t, greetWords)) return { intent: 'greeting', items: [], ...details };
  if (short && has(t, thanksWords)) return { intent: 'thanks', items: [], ...details };
  return { intent: 'unknown', items: [], ...details };
}
