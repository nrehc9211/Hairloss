'use strict';
// Builds the hypothesis document from the question log:
// what customers asked, what the documents could not answer, and testable
// hypotheses about what to add so more replies can be drafted automatically.

const { parseJson } = require('./llm.cjs');

const HYPOTHESIS_SYSTEM_PROMPT = `You analyse customer questions that a food and beverage business's
documents could not answer. Group similar questions by topic and write testable hypotheses.
Return ONLY JSON:
{"hypotheses": [{
  "topic": string,
  "hypothesis": string,        // "If we add X to the catalogue, then Y"
  "evidence_count": number,    // how many of the questions belong to this topic
  "example_questions": [string],
  "suggested_change": string,  // exactly what the owner should add or change
  "how_to_test": string        // a measurable check, e.g. re-run these questions after the change
}]}
Use only the questions provided. Order by evidence_count, highest first.`;

function summarise(entries) {
  const count = (fn) => entries.filter(fn).length;
  const flagCounts = {};
  for (const e of entries) for (const f of e.flags || []) {
    const key = f.split(':')[0];
    flagCounts[key] = (flagCounts[key] || 0) + 1;
  }
  return {
    total: entries.length,
    ready: count((e) => e.status === 'ready'),
    needsReview: count((e) => e.status === 'needs_review'),
    notInDocuments: count((e) => !e.answerable),
    flagCounts,
    from: entries[0]?.at,
    to: entries[entries.length - 1]?.at,
  };
}

// Without AI: group by the missing-info text the answer step already wrote.
function ruleBasedHypotheses(unanswered) {
  const groups = new Map();
  for (const e of unanswered) {
    const key = (e.missingInfo || 'unspecified').toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.question);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([topic, questions]) => ({
      topic,
      hypothesis: `If we add "${topic}" to the documents, these ${questions.length} question(s) can be answered automatically.`,
      evidence_count: questions.length,
      example_questions: questions.slice(0, 3),
      suggested_change: `Add ${topic} to the catalogue or FAQ.`,
      how_to_test: 'Update the documents, run `npm run rag:build`, then `npm run rag:retest` and check these questions become answerable.',
    }));
}

async function aiHypotheses(unanswered, llm) {
  if (!unanswered.length) return [];
  const list = unanswered.map((e, i) => `${i + 1}. ${e.question}${e.missingInfo ? ` [missing: ${e.missingInfo}]` : ''}`);
  const raw = await llm({ system: HYPOTHESIS_SYSTEM_PROMPT, user: list.join('\n'), maxTokens: 2048 });
  return parseJson(raw).hypotheses || [];
}

function toMarkdown(businessName, summary, hypotheses, reviewItems) {
  const pct = (n) => (summary.total ? `${Math.round((n / summary.total) * 100)}%` : '-');
  const lines = [
    `# Customer Question Report: ${businessName}`,
    '',
    `Period: ${summary.from?.slice(0, 10) || '-'} to ${summary.to?.slice(0, 10) || '-'}`,
    '',
    '## Summary',
    '',
    '| Measure | Count | Share |',
    '| --- | --- | --- |',
    `| Questions received | ${summary.total} | ${summary.total ? '100%' : '-'} |`,
    `| Ready for one-tap approval | ${summary.ready} | ${pct(summary.ready)} |`,
    `| Needed owner review | ${summary.needsReview} | ${pct(summary.needsReview)} |`,
    `| Not answerable from documents | ${summary.notInDocuments} | ${pct(summary.notInDocuments)} |`,
    '',
  ];
  if (Object.keys(summary.flagCounts).length) {
    lines.push('## Safety flags', '', '| Flag | Count |', '| --- | --- |');
    for (const [flag, n] of Object.entries(summary.flagCounts)) lines.push(`| ${flag} | ${n} |`);
    lines.push('');
  }
  lines.push('## Hypotheses', '');
  if (!hypotheses.length) lines.push('No unanswered questions in this period.', '');
  hypotheses.forEach((h, i) => {
    lines.push(
      `### H${i + 1}. ${h.topic}`,
      '',
      `**Hypothesis:** ${h.hypothesis}`,
      '',
      `**Evidence:** ${h.evidence_count} question(s), for example:`,
      '',
      ...(h.example_questions || []).map((q) => `- "${q}"`),
      '',
      `**Suggested change:** ${h.suggested_change}`,
      '',
      `**How to test:** ${h.how_to_test}`,
      '',
    );
  });
  if (reviewItems.length) {
    lines.push('## Replies the owner had to review', '', '| Question | Reason |', '| --- | --- |');
    for (const e of reviewItems.slice(0, 20)) {
      const reason = (e.flags || []).join(', ') || e.reason || '-';
      lines.push(`| ${e.question.replace(/\|/g, '/')} | ${reason.replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function buildReport(entries, { businessName = 'Business', llm = null } = {}) {
  const summary = summarise(entries);
  const unanswered = entries.filter((e) => !e.answerable);
  const hypotheses = llm ? await aiHypotheses(unanswered, llm) : ruleBasedHypotheses(unanswered);
  const reviewItems = entries.filter((e) => e.answerable && e.status === 'needs_review');
  return toMarkdown(businessName, summary, hypotheses, reviewItems);
}

module.exports = { buildReport, summarise, ruleBasedHypotheses };
