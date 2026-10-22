'use strict';
// Tests the hypotheses: re-asks every question that was NOT answerable,
// using the current (updated) documents. Run rag:build first after editing the catalogue.
require('./_env.cjs');
const { createRag } = require('../src/rag/index.cjs');
const { readLog } = require('../src/rag/log.cjs');

(async () => {
  const unanswered = readLog('data/rag-log.jsonl').filter((e) => !e.answerable);
  const questions = [...new Set(unanswered.map((e) => e.question))];
  if (!questions.length) return console.log('No unanswered questions to re-test.');
  const rag = createRag({ logPath: 'data/rag-retest-log.jsonl' }); // keep the main log clean
  let fixed = 0;
  for (const q of questions) {
    const draft = await rag.ask(q, { customerName: 'retest' });
    if (draft.answerable) fixed++;
    console.log(`${draft.answerable ? 'NOW ANSWERED ' : 'STILL MISSING'}  ${q}`);
  }
  console.log(`\n${fixed} of ${questions.length} previously unanswered questions are now answerable.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
