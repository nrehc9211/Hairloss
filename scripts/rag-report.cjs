'use strict';
// Usage: npm run rag:report            (rule-based hypotheses, no API call)
//        npm run rag:report -- --ai    (Claude groups questions into hypotheses)
require('./_env.cjs');
const fs = require('node:fs');
const { readLog } = require('../src/rag/log.cjs');
const { buildReport } = require('../src/rag/report.cjs');
const { claude } = require('../src/rag/llm.cjs');

(async () => {
  const useAi = process.argv.includes('--ai');
  let businessName = 'Business';
  try {
    businessName = JSON.parse(fs.readFileSync('data/catalogue.json', 'utf8')).business.name;
  } catch {
    // keep default name
  }
  const entries = readLog('data/rag-log.jsonl');
  const markdown = await buildReport(entries, { businessName, llm: useAi ? claude : null });
  fs.mkdirSync('docs', { recursive: true });
  const out = `docs/question-report-${new Date().toISOString().slice(0, 10)}.md`;
  fs.writeFileSync(out, markdown);
  console.log(`Report written to ${out} (${entries.length} questions)`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
