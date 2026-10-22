'use strict';
// Usage: npm run rag:ask -- "berapa harga kek coklat 8 inci?"
require('./_env.cjs');
const { createRag } = require('../src/rag/index.cjs');

(async () => {
  const question = process.argv.slice(2).join(' ');
  if (!question) throw new Error('Type a question, e.g. npm run rag:ask -- "ada kek halal?"');
  const draft = await createRag().ask(question, { customerName: 'CLI test' });
  console.log(JSON.stringify(draft, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
