// AI tagging + drafting for the WhatsApp inbox.
//   classify()       -> intent + urgency + one-line summary + a suggested reply
//   draftFollowUp()  -> a short follow-up message for a quiet customer
// Uses the language model (RunPod by default) and falls back to keyword rules,
// so the demo keeps working when the model is slow or offline.
import { hasLLM, chatJson, provider } from './llm.js';
import { parseOrderText } from './parser.js';

export const INTENTS = ['inquiry', 'comparing', 'considering', 'ordering', 'ordered', 'not_interested'];
export const URGENCY = ['urgent', 'normal'];
export const INTENT_LABEL = { inquiry: 'Inquiry', comparing: 'Comparing', considering: 'Considering', ordering: 'Ordering', ordered: 'Ordered', not_interested: 'Not interested' };

const RE = {
  notInterested: /(tak jadi|tak nak|tak mau|xnak|x jadi|no thanks|no need|not interested|never ?mind|no longer|cancel|stop|unsubscribe|不要了|不用了|算了|取消)/i,
  comparing: /(murah|shopee|lazada|tiktok shop|tempat lain|kedai lain|cheaper|elsewhere|other shop|discount|diskaun|less sikit|kurang sikit|便宜|别家|其他家|比较|优惠|打折)/i,
  considering: /(fikir dulu|nanti dulu|tengok dulu|nanti saya|consider|think first|let me think|think about it|later|maybe|mungkin|考虑|再看看|再说|想一想|看看先)/i,
  orderWords: /(nak order|nak beli|nak ambil|saya nak|aku nak|nak \d|nak satu|nak dua|i want|i'd like|i would like|i'll take|i will take|please book|order|book|要订|我要|帮我订|下单|预订|要\d|要[一二两三四五六七八九十])/i,
  question: /(\?|？|berapa|harga|ada tak|ada ke|ada x|available|how much|price|多少钱|还有|有没有|吗|几点|可以吗)/i,
  ordered: /(dah order|sudah order|bila sampai|bila nak sampai|bila hantar|status order|order saya|my order|where is my|到了吗|什么时候到|我的订单|几时到)/i,
  urgent: /(urgent|segera|cepat|asap|hari ini|harini|today|tonight|malam ni|esok pagi|petang ni|\bnow\b|sekarang|今天|急|马上|尽快|赶)/i,
};

/** Keyword version. Also used to sanity-check the model. */
export function classifyByKeywords(text, catalog) {
  const t = String(text || '');
  const parsed = parseOrderText(t, catalog, '2000-01-01');
  const firm = parsed.items.filter((i) => i.sku && i.confidence >= 0.85);
  const products = [...new Set(parsed.items.filter((i) => i.sku).map((i) => i.sku))];
  let intent = 'inquiry';
  if (RE.notInterested.test(t)) intent = 'not_interested';
  else if (RE.ordered.test(t)) intent = 'ordered';
  else if (firm.length && !RE.question.test(t)) intent = 'ordering';
  else if (firm.length && RE.orderWords.test(t)) intent = 'ordering';
  else if (RE.comparing.test(t)) intent = 'comparing';
  else if (RE.considering.test(t)) intent = 'considering';
  const urgency = RE.urgent.test(t) ? 'urgent' : 'normal';
  return { intent, urgency, products, engine: 'keywords' };
}

function productNames(skus, catalog) {
  return skus.map((s) => catalog.find((c) => c.sku === s)).filter(Boolean);
}
/** "Moist chocolate cake 1kg" -> "Moist chocolate cake", "Cupcakes (box of 12)" -> "Cupcakes" */
export const shortName = (name) => String(name || '').replace(/\s*\(.*?\)/g, '').replace(/\s+\d.*$/, '').trim();
const greetName = (customerName) => (customerName && !/^New customer|\+?\d/.test(customerName) ? ` ${customerName}` : '');

/** Template replies (used when no model, or the model fails). Prices come from the catalog only. */
export function templateReply({ intent, products, customerName, catalog }) {
  const items = productNames(products || [], catalog);
  const name = greetName(customerName);
  const priceLine = items.map((c) => `${c.name} RM${c.price}`).join(', ');
  if (intent === 'ordering') return `Thank you${name}! We're checking your order now, the invoice will follow shortly 🙏`;
  if (intent === 'ordered') return `Hi${name}! Let me check on your order, one moment please 🙏`;
  if (intent === 'comparing') return `Understood${name} 🙏 Our cakes are baked fresh the same day and can be delivered tomorrow morning. Would you like me to reserve one for you?`;
  if (intent === 'considering') return 'No problem, take your time 😊 If you like, I can reserve a slot for you.';
  if (intent === 'not_interested') return 'Alright, thank you! Message us anytime if you need anything 🙏';
  if (items.length) return `Hi${name}! ${priceLine}. Still available today 😊 Would you like me to reserve one for you?`;
  return `Hi${name}! Thanks for asking 😊 Which cake would you like, and for which day?`;
}

const TAG_SYSTEM = (catalog, business) => `You help a small Malaysian home bakery manage WhatsApp chats.
Business: ${business.name}. Selling points: ${business.sellingPoints || '-'}.
Catalog (name - price RM): ${catalog.map((c) => `${c.name} - ${c.price}`).join('; ')}.

Customers may write in English, Malay, Chinese or Manglish.
Read the customer's latest messages and return ONLY JSON:
{"intent": one of ${JSON.stringify(INTENTS)},
 "urgency": "urgent" | "normal",
 "summary": "max 12 words, in English, what the customer wants",
 "reply": "a short friendly reply the owner could send, max 2 sentences, in English"}
Meaning of intent:
- inquiry: asking about products, price, stock, delivery
- comparing: mentions other shops/platforms or that it is cheaper elsewhere
- considering: says they will think about it / later / maybe
- ordering: clearly wants to buy now (product + quantity, or "I want to order")
- ordered: already ordered, asking about status
- not_interested: says no, cancel, stop
Rules: only quote prices from the catalog; never invent discounts; urgent only if they need it today/very soon or say urgent.`;

/**
 * @param {{text:string, recent:string[], customerName:string, catalog:any[], business:any}} p
 */
export async function classify({ text, recent = [], customerName, catalog, business }) {
  const kw = classifyByKeywords(text, catalog);
  const fallback = () => ({ ...kw, summary: summaryFromKeywords(kw, catalog), reply: templateReply({ ...kw, customerName, catalog }) });
  if (!hasLLM()) return fallback();
  try {
    const out = await chatJson({
      system: TAG_SYSTEM(catalog, business),
      user: `Customer name: ${customerName || 'unknown'}\nEarlier messages (oldest first):\n${recent.slice(-6).map((m) => `- ${m}`).join('\n') || '- (none)'}\nLatest message: """${text}"""`,
    });
    const intent = INTENTS.includes(out.intent) ? out.intent : kw.intent;
    const urgency = URGENCY.includes(out.urgency) ? out.urgency : kw.urgency;
    return {
      intent, urgency, products: kw.products,
      summary: String(out.summary || summaryFromKeywords({ intent, products: kw.products }, catalog)).slice(0, 120),
      reply: String(out.reply || templateReply({ intent, products: kw.products, customerName, catalog })).slice(0, 600),
      engine: provider(),
    };
  } catch (err) {
    console.warn('[tagger] model failed, using keywords:', err.message);
    return { ...fallback(), error: err.message };
  }
}

function summaryFromKeywords({ intent, products }, catalog) {
  const names = productNames(products || [], catalog).map((c) => shortName(c.name));
  return `${INTENT_LABEL[intent]}${names.length ? ': ' + names.join(', ') : ''}`;
}

const FU_SYSTEM = (business) => `You write ONE short WhatsApp follow-up for a small Malaysian bakery (${business.name}).
Selling points: ${business.sellingPoints || '-'}.
Return ONLY JSON: {"message": "..."}.
Rules: max 2 sentences, warm and polite, in English, no pressure, no new discounts or prices that are not in the conversation, offer to reserve or answer questions.`;

/** Draft a follow-up for a quiet customer. attempt = 1 or 2. */
export async function draftFollowUp({ intent, customerName, lastCustomerText, products = [], attempt = 1, catalog, business }) {
  const name = greetName(customerName);
  const item = shortName(productNames(products, catalog)[0]?.name);
  const template = () => {
    if (attempt >= 2) return `Hi${name}, if you have any other questions, just ask anytime. Thank you! 🙏`;
    if (intent === 'comparing') return `Hi${name}! Just so you know, our cakes are baked the same day and can be delivered tomorrow morning. Would you like me to reserve one for you?`;
    if (intent === 'considering') return `Hi${name}! Still interested? I can hold a slot for you until tomorrow 😊`;
    return `Hi${name}! Is there anything else I can help you with${item ? ` about the ${item.toLowerCase()}` : ''}? 😊`;
  };
  if (!hasLLM()) return { message: template(), engine: 'template' };
  try {
    const out = await chatJson({
      system: FU_SYSTEM(business),
      user: `Customer: ${customerName || 'unknown'}\nTheir status: ${intent}\nTheir last message: """${lastCustomerText}"""\nThis is follow-up number ${attempt} of max 2.`,
    });
    const message = String(out.message || '').trim();
    return { message: message ? message.slice(0, 500) : template(), engine: provider() };
  } catch (err) {
    console.warn('[tagger] follow-up draft failed, using template:', err.message);
    return { message: template(), engine: 'template', error: err.message };
  }
}
