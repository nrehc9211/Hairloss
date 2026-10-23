'use strict';
// Keyword search (BM25). Works with no API key and catches exact words like product codes.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'you', 'your', 'i', 'me', 'my', 'can', 'what', 'how',
  'for', 'of', 'to', 'and', 'or', 'in', 'on', 'it', 'have', 'has', 'any', 'please', 'pls', 'boss',
  'ada', 'tak', 'ke', 'yang', 'dan', 'untuk', 'saya', 'nak', 'boleh', 'ini', 'itu', 'ya', 'lah', 'tu',
]);
const CJK = /[\u3400-\u9fff]/;

function tokenize(text) {
  const tokens = [];
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (CJK.test(word)) {
      // Chinese has no spaces: index single characters and pairs.
      const chars = [...word];
      chars.forEach((c, i) => {
        tokens.push(c);
        if (chars[i + 1]) tokens.push(c + chars[i + 1]);
      });
    } else if (!STOPWORDS.has(word)) {
      tokens.push(word);
    }
  }
  return tokens;
}

function buildKeywordIndex(chunks) {
  const docs = chunks.map((c) => {
    const terms = tokenize(c.text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    return { id: c.id, length: terms.length, tf };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLength = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1);
  return { docs, df, avgLength };
}

function keywordSearch(index, query, k = 5) {
  const K1 = 1.2;
  const B = 0.75;
  const N = index.docs.length;
  const terms = [...new Set(tokenize(query))];
  const results = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const t of terms) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / index.avgLength));
    }
    if (score > 0) results.push({ id: doc.id, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = { tokenize, buildKeywordIndex, keywordSearch };
