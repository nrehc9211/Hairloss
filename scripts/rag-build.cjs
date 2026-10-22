'use strict';
// Usage: npm run rag:build -- [files...]   (default: data/catalogue.json)
require('./_env.cjs');
const { createRag } = require('../src/rag/index.cjs');

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) files.push('data/catalogue.json');
  const result = await createRag().build(files);
  console.log(`Indexed ${result.chunks} chunks from ${files.join(', ')}`);
  console.log(result.semantic ? 'Search: keyword + semantic (Voyage)' : 'Search: keyword only (set VOYAGE_API_KEY for semantic search)');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
