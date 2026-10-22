// Customer-facing messages in English (en), Malay (ms) and Simplified Chinese (zh).
// Replies are still built from the owner's settings, so prices and terms are always
// correct; only the wording changes with the customer's language.

const CJK = /[\u3400-\u9fff]/;
// Scripts that identify a language on their own, even without an AI.
// Japanese kana is checked before Chinese characters (Japanese also uses them).
const SCRIPTS = [
  [/[\u0B80-\u0BFF]/, 'ta'], // Tamil
  [/[\u0900-\u097F]/, 'hi'], // Hindi (Devanagari)
  [/[\u0600-\u06FF]/, 'ar'], // Arabic / Jawi
  [/[\u0E00-\u0E7F]/, 'th'], // Thai
  [/[\uAC00-\uD7AF]/, 'ko'], // Korean
  [/[\u3040-\u30FF]/, 'ja'], // Japanese kana
  [/[\u0400-\u04FF]/, 'ru'], // Cyrillic
];
const MALAY = new Set(['berapa', 'nak', 'boleh', 'tak', 'dah', 'sudah', 'hantar', 'tolong', 'bila', 'mana', 'saya', 'terima',
  'kasih', 'harga', 'ada', 'kotak', 'sampai', 'bayar', 'alamat', 'nama', 'encik', 'puan', 'kak', 'lagi', 'dengan', 'untuk',
  'kalau', 'ni', 'tu', 'je', 'pun', 'ke', 'apa', 'macam', 'mahu', 'beli', 'pesan', 'tempah', 'kedai', 'perisa', 'diskaun',
  'murah', 'percuma', 'salam', 'assalamualaikum', 'selamat', 'sila', 'tahan', 'simpan', 'peti', 'sejuk', 'ucapan', 'tulis',
  'sijil', 'sedap', 'lama', 'hari', 'dalam', 'kenapa', 'bagaimana', 'jika', 'mau', 'ambil', 'sekali', 'satu', 'dua', 'tiga']);
const ENGLISH = new Set(['how', 'much', 'what', 'is', 'the', 'can', 'you', 'do', 'want', 'please', 'price', 'delivery', 'i',
  'my', 'where', 'when', 'thanks', 'thank', 'order', 'hello', 'hi', 'long', 'does', 'take', 'have', 'got', 'any', 'discount',
  'paid', 'transferred', 'and', 'on', 'it', 'are', 'your', 'would', 'like', 'need', 'buy']);

// Returns { lang, sure }. "sure" is false for messages with no language clues,
// such as "2 original" or a name and address; then the customer's last language is used.
export function detectLang(text) {
  const t = String(text || '');
  for (const [re, lang] of SCRIPTS) if (re.test(t)) return { lang, sure: true };
  if (CJK.test(t)) return { lang: 'zh', sure: true };
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  const ms = words.filter((w) => MALAY.has(w)).length;
  const en = words.filter((w) => ENGLISH.has(w)).length;
  if (ms > en) return { lang: 'ms', sure: true };
  if (en > 0) return { lang: 'en', sure: true };
  return { lang: 'en', sure: false };
}

export const LANG_NAMES = { en: 'English', ms: 'Malay', zh: 'Chinese' };

// Languages with hand-written templates. Any other language gets the English
// template, which SmartDesk then translates with the AI (see src/translate.js).
export const NATIVE_LANGS = new Set(['en', 'ms', 'zh']);
export const isNativeLang = (lang) => NATIVE_LANGS.has(lang);

// "ta" -> "Tamil", "id" -> "Indonesian"
export function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

const rm = (n) => `RM${Number(n).toFixed(2)}`;
const named = (name) => (name ? ' ' + name : '');

const STATUS_LABELS = {
  en: {
    pending_approval: 'Waiting for owner approval',
    awaiting_payment: 'Invoice sent - awaiting payment',
    paid: 'Paid - ready to pack',
    packing: 'Packing',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  },
  ms: {
    pending_approval: 'Menunggu kelulusan owner',
    awaiting_payment: 'Invois dihantar - menunggu bayaran',
    paid: 'Sudah dibayar - sedia untuk dibungkus',
    packing: 'Sedang dibungkus',
    out_for_delivery: 'Dalam penghantaran',
    delivered: 'Sudah dihantar',
    cancelled: 'Dibatalkan',
  },
  zh: {
    pending_approval: '等待老板审核',
    awaiting_payment: '发票已发送，等待付款',
    paid: '已付款，准备包装',
    packing: '包装中',
    out_for_delivery: '配送中',
    delivered: '已送达',
    cancelled: '已取消',
  },
};

const DATE_LOCALE = { en: 'en-MY', ms: 'ms-MY', zh: 'zh-CN' };
const formatDate = (iso, lang) =>
  new Date(iso).toLocaleDateString(DATE_LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' });

// Shared building blocks -------------------------------------------------------------

function priceList(lang, products) {
  const head = { en: 'Our kek lapis (per box):', ms: 'Kek lapis kami (sekotak):', zh: '我们的千层糕（每盒）：' }[lang];
  const soldOut = { en: ' (sold out)', ms: ' (habis dijual)', zh: '（已售完）' }[lang];
  return head + '\n' + products.map((p) => `• ${p.name} - ${rm(p.price)}${p.stock <= 0 ? soldOut : ''}`).join('\n');
}

function totals(lang, { discount, discountPct, deliveryFee, total }) {
  const L = {
    en: { disc: 'Discount', del: 'Delivery', free: 'FREE', total: 'Total' },
    ms: { disc: 'Diskaun', del: 'Penghantaran', free: 'PERCUMA', total: 'Jumlah' },
    zh: { disc: '折扣', del: '运费', free: '免运费', total: '总计' },
  }[lang];
  const colon = lang === 'zh' ? '：' : ': ';
  return `${discount ? `\n${L.disc} (${discountPct}%)${colon}-${rm(discount)}` : ''}` +
    `\n${L.del}${colon}${deliveryFee ? rm(deliveryFee) : L.free}\n${L.total}${colon}${rm(total)}`;
}

// Templates ---------------------------------------------------------------------------
// Each template takes the customer's language plus the values it needs.

const templates = {
  greeting(lang, { name, business, products }) {
    const list = priceList(lang, products);
    return {
      en: `Hi${named(name)}! Welcome to ${business}. 🍰\n\n${list}\n\nJust tell us what you'd like, e.g. "2 Original and 1 Cheese".`,
      ms: `Hai${named(name)}! Selamat datang ke ${business}. 🍰\n\n${list}\n\nBeritahu kami apa yang anda mahu, contohnya "2 Original dan 1 Cheese".`,
      zh: `您好${named(name)}！欢迎来到 ${business} 🍰\n\n${list}\n\n请告诉我们您想要什么，例如“2盒原味和1盒芝士”。`,
    }[lang];
  },

  thanks(lang) {
    return {
      en: `You're welcome! Let us know if you need anything else. 😊`,
      ms: `Sama-sama! Beritahu kami jika perlukan apa-apa lagi. 😊`,
      zh: `不客气！还需要什么请随时告诉我们。😊`,
    }[lang];
  },

  quote(lang, { lines, subtotal, discount, discountPct, deliveryFee, total }) {
    const t = totals(lang, { discount, discountPct, deliveryFee, total });
    return {
      en: `Here's your quote:\n${lines.join('\n')}\nSubtotal: ${rm(subtotal)}${t}\n\nReply "order" with the items to confirm.`,
      ms: `Ini sebut harga anda:\n${lines.join('\n')}\nJumlah kecil: ${rm(subtotal)}${t}\n\nBalas "nak" bersama item untuk sahkan pesanan.`,
      zh: `这是您的报价：\n${lines.join('\n')}\n小计：${rm(subtotal)}${t}\n\n回复“我要”加上商品即可下单。`,
    }[lang];
  },

  priceInfo(lang, { products, minQty, pct, freeMin }) {
    const list = priceList(lang, products);
    return {
      en: `${list}\n\nOrder ${minQty}+ boxes and get ${pct}% off. Free delivery above ${rm(freeMin)}.`,
      ms: `${list}\n\nBeli ${minQty} kotak atau lebih, dapat diskaun ${pct}%. Penghantaran percuma untuk pesanan melebihi ${rm(freeMin)}.`,
      zh: `${list}\n\n订购${minQty}盒或以上可享${pct}%折扣。订单满${rm(freeMin)}免运费。`,
    }[lang];
  },

  delivery(lang, { info, fee, freeMin }) {
    return {
      en: `${info}\nDelivery fee is ${rm(fee)}, FREE for orders above ${rm(freeMin)}.`,
      ms: `${info}\nCaj penghantaran ${rm(fee)}, PERCUMA untuk pesanan melebihi ${rm(freeMin)}.`,
      zh: `${info}\n运费${rm(fee)}，订单满${rm(freeMin)}免运费。`,
    }[lang];
  },

  discount(lang, { pct, minQty, freeMin }) {
    return {
      en: `Current promo: ${pct}% off when you order ${minQty} boxes or more (any flavour mix). Free delivery for orders above ${rm(freeMin)}. 🎉`,
      ms: `Promosi semasa: diskaun ${pct}% untuk ${minQty} kotak atau lebih (boleh campur perisa). Penghantaran percuma untuk pesanan melebihi ${rm(freeMin)}. 🎉`,
      zh: `目前优惠：订购${minQty}盒或以上（口味可混搭）可享${pct}%折扣。订单满${rm(freeMin)}免运费。🎉`,
    }[lang];
  },

  orderReceived(lang, { code, lines, discount, discountPct, deliveryFee, total, outOfStock, missingName, missingAddress }) {
    const t = totals(lang, { discount, discountPct, deliveryFee, total });
    const head = {
      en: `Thank you! We've received order ${code}:`,
      ms: `Terima kasih! Kami telah terima pesanan ${code}:`,
      zh: `谢谢！我们已收到订单 ${code}：`,
    }[lang];
    let msg = `${head}\n${lines.join('\n')}${t}`;
    if (outOfStock.length) {
      msg += '\n\n' + {
        en: `⚠️ ${outOfStock.join(', ')} may be out of stock - the owner will confirm.`,
        ms: `⚠️ ${outOfStock.join(', ')} mungkin kehabisan stok - owner akan sahkan.`,
        zh: `⚠️ ${outOfStock.join('、')} 可能缺货，老板会与您确认。`,
      }[lang];
    }
    if (missingName || missingAddress) {
      const parts = {
        en: [missingName && 'your name', missingAddress && 'your delivery address'],
        ms: [missingName && 'nama anda', missingAddress && 'alamat penghantaran'],
        zh: [missingName && '姓名', missingAddress && '送货地址'],
      }[lang].filter(Boolean);
      msg += '\n\n' + {
        en: `To prepare your invoice, please send ${parts.join(' and ')} like this:\nName: ...\nAddress: ...`,
        ms: `Untuk sediakan invois, sila hantar ${parts.join(' dan ')} seperti ini:\nNama: ...\nAlamat: ...`,
        zh: `为了准备发票，请按以下格式发送您的${parts.join('和')}：\n姓名：...\n地址：...`,
      }[lang];
    } else {
      msg += '\n\n' + {
        en: `The owner will review it and send your invoice shortly.`,
        ms: `Owner akan semak dan hantar invois anda sebentar lagi.`,
        zh: `老板审核后会尽快发送发票给您。`,
      }[lang];
    }
    return msg;
  },

  detailsSavedForOrder(lang, { name, code }) {
    return {
      en: `Thanks ${name || ''}! Details saved for order ${code}. The owner will send your invoice shortly.`,
      ms: `Terima kasih ${name || ''}! Maklumat disimpan untuk pesanan ${code}. Owner akan hantar invois sebentar lagi.`,
      zh: `谢谢${named(name)}！订单 ${code} 的资料已保存，老板会尽快发送发票给您。`,
    }[lang];
  },

  detailsSaved(lang, { name }) {
    return {
      en: `Thanks ${name || ''}, your details are saved. What would you like to order?`,
      ms: `Terima kasih ${name || ''}, maklumat anda telah disimpan. Nak pesan apa?`,
      zh: `谢谢${named(name)}，您的资料已保存。请问您想订购什么？`,
    }[lang];
  },

  paymentNoInvoice(lang) {
    return {
      en: `Thank you! Let me check this with the owner and get back to you shortly.`,
      ms: `Terima kasih! Saya akan semak dengan owner dan maklumkan semula sebentar lagi.`,
      zh: `谢谢！我会跟老板确认，稍后回复您。`,
    }[lang];
  },

  paymentNoted(lang, { invoiceNo }) {
    return {
      en: `Thank you! We've noted your payment for invoice ${invoiceNo}. The owner will verify it and we'll start packing right away. 📦`,
      ms: `Terima kasih! Kami telah catat bayaran untuk invois ${invoiceNo}. Owner akan sahkan dan kami terus bungkus pesanan anda. 📦`,
      zh: `谢谢！我们已记录发票 ${invoiceNo} 的付款。老板核实后我们会马上为您包装。📦`,
    }[lang];
  },

  noOrderFound(lang) {
    return {
      en: `We couldn't find an order under this number yet. Would you like to place one?`,
      ms: `Kami belum jumpa pesanan di bawah nombor ini. Nak buat pesanan?`,
      zh: `我们还没有找到这个号码的订单。您想下单吗？`,
    }[lang];
  },

  orderStatus(lang, { code, status }) {
    return { en: `Order ${code}: ${STATUS_LABELS.en[status]}.`, ms: `Pesanan ${code}: ${STATUS_LABELS.ms[status]}.`, zh: `订单 ${code}：${STATUS_LABELS.zh[status]}。` }[lang];
  },

  alsoChecking(lang) {
    return {
      en: `About your other question, I'm checking with the owner and will get back to you shortly. 🙏`,
      ms: `Tentang soalan anda yang satu lagi, saya sedang semak dengan owner dan akan maklumkan sebentar lagi. 🙏`,
      zh: `关于您的另一个问题，我正在跟老板确认，稍后回复您。🙏`,
    }[lang];
  },
  holding(lang) {
    return {
      en: `Thanks for your message! I'm checking this with the owner and will get back to you shortly. 🙏`,
      ms: `Terima kasih atas mesej anda! Saya sedang semak dengan owner dan akan balas sebentar lagi. 🙏`,
      zh: `谢谢您的信息！我正在跟老板确认，稍后回复您。🙏`,
    }[lang];
  },

  invoice(lang, { invoiceNo, business, code, items, discount, deliveryFee, total, due, bank }) {
    const lines = items.map((i) => `• ${i.qty} x ${i.name} = ${rm(i.line_total)}`).join('\n');
    const L = {
      en: { order: 'Order', disc: 'Discount', del: 'Delivery', free: 'FREE', total: 'TOTAL', pay: 'Please pay by', to: 'to', reply: `Reply "paid" once you've transferred. Thank you! 🙏` },
      ms: { order: 'Pesanan', disc: 'Diskaun', del: 'Penghantaran', free: 'PERCUMA', total: 'JUMLAH', pay: 'Sila bayar sebelum', to: 'ke', reply: `Balas "dah bayar" selepas pindahan dibuat. Terima kasih! 🙏` },
      zh: { order: '订单', disc: '折扣', del: '运费', free: '免运费', total: '总计', pay: '请在以下日期前付款：', to: '至', reply: `转账后请回复“已付款”。谢谢！🙏` },
    }[lang];
    const colon = lang === 'zh' ? '：' : ': ';
    const invoiceWord = { en: 'Invoice', ms: 'Invois', zh: '发票' }[lang];
    return `🧾 ${invoiceWord} ${invoiceNo} - ${business}\n${L.order} ${code}\n${lines}` +
      `${discount ? `\n${L.disc}${colon}-${rm(discount)}` : ''}\n${L.del}${colon}${deliveryFee ? rm(deliveryFee) : L.free}\n${L.total}${colon}${rm(total)}` +
      `\n\n${L.pay} ${formatDate(due, lang)} ${L.to}:\n${bank}\n${L.reply}`;
  },

  paymentReceived(lang, { invoiceNo, code }) {
    return {
      en: `✅ Payment received for ${invoiceNo}. Thank you! We'll pack your order ${code} now.`,
      ms: `✅ Bayaran untuk ${invoiceNo} telah diterima. Terima kasih! Kami akan bungkus pesanan ${code} sekarang.`,
      zh: `✅ 已收到发票 ${invoiceNo} 的付款，谢谢！我们现在就为您包装订单 ${code}。`,
    }[lang];
  },

  orderUpdate(lang, status, code) {
    const T = {
      packing: { en: `📦 Your order ${code} is being packed.`, ms: `📦 Pesanan ${code} anda sedang dibungkus.`, zh: `📦 您的订单 ${code} 正在包装中。` },
      out_for_delivery: { en: `🚚 Your order ${code} is out for delivery!`, ms: `🚚 Pesanan ${code} anda dalam perjalanan!`, zh: `🚚 您的订单 ${code} 正在配送中！` },
      delivered: {
        en: `🎉 Order ${code} has been delivered. Enjoy your kek lapis! We'd love your feedback.`,
        ms: `🎉 Pesanan ${code} telah sampai. Selamat menikmati kek lapis! Kami hargai maklum balas anda.`,
        zh: `🎉 订单 ${code} 已送达。请享用您的千层糕！欢迎给我们反馈。`,
      },
    };
    return T[status]?.[lang];
  },

  orderRejected(lang, { code, reason }) {
    return {
      en: `Sorry, we're unable to proceed with order ${code}: ${reason}`,
      ms: `Maaf, kami tidak dapat meneruskan pesanan ${code}: ${reason}`,
      zh: `抱歉，我们无法处理订单 ${code}：${reason}`,
    }[lang];
  },

  followUp(lang, { name, business, minQty, pct }) {
    return {
      en: `Hi${named(name)}! Just checking in from ${business} 😊 Still thinking about some kek lapis? Reply with what you'd like and we'll get it ready. Order ${minQty}+ boxes for ${pct}% off!`,
      ms: `Hai${named(name)}! Sekadar bertanya dari ${business} 😊 Masih berminat dengan kek lapis kami? Balas dengan pesanan anda dan kami akan sediakan. Beli ${minQty} kotak atau lebih untuk diskaun ${pct}%!`,
      zh: `您好${named(name)}！这里是 ${business} 😊 还在考虑千层糕吗？回复您想要的口味，我们马上为您准备。订购${minQty}盒或以上享${pct}%折扣！`,
    }[lang];
  },

  paymentReminder(lang, { invoiceNo, code, amount, bank }) {
    return {
      en: `Friendly reminder: invoice ${invoiceNo} for order ${code} (${rm(amount)}) is now due. Please transfer to ${bank} and reply "paid". Thank you! 🙏`,
      ms: `Peringatan mesra: invois ${invoiceNo} untuk pesanan ${code} (${rm(amount)}) sudah sampai tarikh bayaran. Sila pindahkan ke ${bank} dan balas "dah bayar". Terima kasih! 🙏`,
      zh: `温馨提醒：订单 ${code} 的发票 ${invoiceNo}（${rm(amount)}）已到期。请转账至 ${bank} 并回复“已付款”。谢谢！🙏`,
    }[lang];
  },
};

// Every template accepts any language code: unknown languages use English.
export const reply = Object.fromEntries(
  Object.entries(templates).map(([key, fn]) => [key, (lang, ...args) => fn(isNativeLang(lang) ? lang : 'en', ...args)]),
);
