// Rule-based order parser. Used when no AI key is set, as a fallback when the
// AI call fails, and for the boss's quick edits ("chocolate cake 3, cheesecake 0").
// Handles Malay / English / Chinese / Manglish in the common short forms.
import { addDays } from '../clock.js';

const WORD_NUMS = {
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, sembilan: 9, sepuluh: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
  sebiji: 1, sekotak: 1, sebuah: 1, sepeket: 1,
};
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT_WORDS = ['biji', 'buah', 'kotak', 'kotaks', 'pek', 'peket', 'packet', 'packets', 'pack', 'packs', 'pkt', 'box', 'boxes', 'bungkus', 'beg', 'bag', 'bags', 'pcs', 'pc', 'piece', 'pieces', 'unit', 'units', 'carton', 'ctn', '包', '箱', '盒', '份', '袋', '个'];
const GAP_FILLER = /^[\s:=x×*\-.]*$/;
const REMOVE_WORDS = /(buang|remove|cancel|tak nak|tak mau|xnak|delete|删除|不要|取消)\s*$/;
const TIME_AFTER = /^\s*(am|pm|pagi|petang|malam|tengahari|点|點|:\d)/;
const TIME_BEFORE = /(?:^|[^a-z])(pukul|jam|at|before|sebelum|lepas)\s*$/;
const SIZE_AFTER = /^\s*(kg|g|gram|ml|l|liter|litre|inci|inch|in|公斤|寸)(?![a-z])/;

export function cnToNum(s) {
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i === -1) return s.length === 1 ? CN_DIGITS[s] : null;
  const tens = i === 0 ? 1 : CN_DIGITS[s[i - 1]];
  const ones = i === s.length - 1 ? 0 : CN_DIGITS[s[i + 1]];
  return tens * 10 + ones;
}

const isLatin = (s) => /^[a-z0-9 ]+$/i.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findAliasMatches(text, catalog) {
  const aliases = [];
  for (const item of catalog) {
    const names = new Set([item.name.toLowerCase(), item.sku.toLowerCase(), ...(item.aliases || []).map((a) => a.toLowerCase())]);
    for (const a of names) aliases.push({ alias: a, sku: item.sku, specific: /\d/.test(a) || a === item.name.toLowerCase() });
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  const taken = [];
  const matches = [];
  for (const { alias, sku, specific } of aliases) {
    // English plurals count too: "2 chocolate cakes"
    const re = isLatin(alias) ? new RegExp(`(^|[^a-z])(${escapeRe(alias)}(?:e?s)?)(?=[^a-z]|$)`, 'g') : new RegExp(`()(${escapeRe(alias)})`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      matches.push({ start, end, sku, alias, specific });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

function findNumbers(text, aliasSpans) {
  const re = /(\d+(?:\.\d+)?)|([零一二两三四五六七八九十]+)|\b(sebiji|sekotak|sebuah|sepeket|satu|dua|tiga|empat|lima|enam|tujuh|lapan|sembilan|sepuluh|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\b/g;
  const nums = [];
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (aliasSpans.some((a) => start >= a.start && end <= a.end)) continue;
    const after = text.slice(end, end + 12);
    const before = text.slice(Math.max(0, start - 10), start);
    if (TIME_AFTER.test(after) || TIME_BEFORE.test(before) || SIZE_AFTER.test(after)) continue;
    const value = m[1] ? Number(m[1]) : m[2] ? cnToNum(m[2]) : WORD_NUMS[m[3]];
    if (value == null || Number.isNaN(value)) continue;
    nums.push({ start, end, value, used: false });
  }
  return nums;
}

function gapInfo(gap) {
  let unit = null;
  // a pack size between item and quantity is fine: "nugget 1kg 4 pek"
  let rest = gap.replace(/\d+(?:\.\d+)?\s*(?:kg|g|gram|ml|l|liter|litre|inci|inch|in|公斤|寸)(?![a-z])/g, ' ');
  for (const u of UNIT_WORDS) {
    const latin = isLatin(u);
    const re = latin ? new RegExp(`(^|[^a-z])${escapeRe(u)}(?=[^a-z]|$)`) : new RegExp(escapeRe(u));
    if (re.test(rest)) {
      unit = unit || u;
      rest = latin ? rest.replace(re, '$1') : rest.replace(re, '');
    }
  }
  return { ok: GAP_FILLER.test(rest), unit };
}

const WEEKDAYS = [
  [0, /\b(ahad|sunday)\b|周日|星期日|星期天|礼拜天/],
  [1, /\b(isnin|monday)\b|周一|星期一|礼拜一/],
  [2, /\b(selasa|tuesday)\b|周二|星期二|礼拜二/],
  [3, /\b(rabu|wednesday)\b|周三|星期三|礼拜三/],
  [4, /\b(khamis|thursday)\b|周四|星期四|礼拜四/],
  [5, /\b(jumaat|jumat|friday)\b|周五|星期五|礼拜五/],
  [6, /\b(sabtu|saturday)\b|周六|星期六|礼拜六/],
];

export function detectDeliveryDate(text, todayIso) {
  const t = text.toLowerCase();
  if (/\b(lusa)\b|后天|day after tomorrow/.test(t)) return addDays(todayIso, 2);
  if (/\b(esok|besok|tomorrow|tmr|tmrw|esk)\b|明天|明日/.test(t)) return addDays(todayIso, 1);
  if (/\b(hari ini|harini|today|tdy)\b|今天|今日/.test(t)) return todayIso;
  const today = new Date(todayIso + 'T00:00:00Z').getUTCDay();
  for (const [day, re] of WEEKDAYS) {
    if (re.test(t)) return addDays(todayIso, ((day - today + 7) % 7) || 7); // next such day
  }
  return null;
}

/**
 * @returns {{items:Array<{sku:string|null, raw:string, qty:number, unit:string|null, confidence:number}>, deliveryDate:string|null, notes:string|null, isOrder:boolean, engine:string}}
 */
export function parseOrderText(text, catalog, todayIso) {
  const s = ` ${String(text || '').toLowerCase().replace(/[，、；]/g, ',')} `;
  const aliasMatches = findAliasMatches(s, catalog);
  const nums = findNumbers(s, aliasMatches);
  const items = [];

  for (const a of aliasMatches) {
    let qty = null;
    let unit = null;
    let span = [a.start, a.end];
    // 1) number BEFORE the item: "30 ayam", "2 kotak nugget", "30包鸡肉"
    const before = nums.filter((n) => !n.used && n.end <= a.start).at(-1);
    if (before) {
      const g = gapInfo(s.slice(before.end, a.start));
      if (g.ok) { qty = before.value; unit = g.unit; before.used = true; span = [before.start, a.end]; }
    }
    // 2) number AFTER the item: "ayam 30", "nugget x5", "鸡肉30包"
    if (qty == null) {
      const after = nums.find((n) => !n.used && n.start >= a.end);
      if (after) {
        const g = gapInfo(s.slice(a.end, after.start));
        if (g.ok) {
          qty = after.value;
          const tail = s.slice(after.end, after.end + 10).split(/[,\n]/)[0];
          const tailUnit = gapInfo(tail.split(/\s+/).filter(Boolean)[0] || '').unit;
          unit = g.unit || tailUnit;
          after.used = true;
          span = [a.start, after.end];
        }
      }
    }
    const removing = REMOVE_WORDS.test(s.slice(Math.max(0, a.start - 14), a.start));
    if (removing) qty = 0;
    const raw = s.slice(span[0], span[1]).trim();
    items.push({
      sku: a.sku,
      raw,
      qty: qty ?? 1,
      unit,
      confidence: qty == null && !removing ? 0.5 : a.specific ? 0.95 : 0.85,
    });
  }

  // Numbers followed by a word we do not know -> unknown item, ask the customer.
  for (const n of nums) {
    if (n.used) continue;
    const after = s.slice(n.end).match(/^\s*([a-z一-鿿][a-z一-鿿]*(?:\s+[a-z一-鿿]+)?)/);
    if (!after) continue;
    const word = after[1].trim();
    const first = word.split(/\s+/)[0];
    if (UNIT_WORDS.includes(first) || /^(hari|days?|minggu|weeks?|bulan|months?|hours?|minutes?|ringgit|rm|sen|orang|people|pax|persons?)$/.test(first)) {
      // "3 kotak lagi" -> a unit with no product: still unknown
      if (!UNIT_WORDS.includes(first)) continue;
    }
    items.push({ sku: null, raw: `${n.value} ${word}`, qty: n.value, unit: null, confidence: 0.3 });
  }

  return {
    items,
    deliveryDate: detectDeliveryDate(text || '', todayIso),
    notes: null,
    isOrder: items.length > 0,
    engine: 'rules',
  };
}
