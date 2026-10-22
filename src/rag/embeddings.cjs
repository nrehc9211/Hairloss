'use strict';
// Semantic search with Voyage AI embeddings (Anthropic has no embedding model of its own).
// Finds matches by meaning, so "kek coklat" can match "Chocolate Cake".
// If VOYAGE_API_KEY is not set, the system falls back to keyword search only.

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 64;

function voyageEnabled() {
  return Boolean(process.env.VOYAGE_API_KEY);
}

async function embed(texts, inputType) {
  const model = process.env.VOYAGE_MODEL || 'voyage-4';
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ input: texts.slice(i, i + BATCH_SIZE), model, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    json.data.sort((a, b) => a.index - b.index).forEach((d) => vectors.push(d.embedding));
  }
  return vectors;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function vectorSearch(vectors, queryVector, k = 5) {
  return Object.entries(vectors)
    .map(([id, v]) => ({ id, score: cosine(v, queryVector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

module.exports = { voyageEnabled, embed, vectorSearch, cosine };
