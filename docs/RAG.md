# OrderLah RAG: answering customer questions from your documents

Customers ask about prices, sizes, delivery and ingredients on WhatsApp. This module finds the
answer in the business's own documents (catalogue, FAQ, PDFs) and drafts a reply for the owner to
approve. It never sends anything by itself.

## How it works

1. **Build the index** (`npm run rag:build`): documents are split into chunks. A catalogue JSON
   becomes one chunk per product and per FAQ entry. If `VOYAGE_API_KEY` is set, each chunk is also
   turned into an embedding for search by meaning.
2. **Retrieve**: for each question, keyword search (BM25) and semantic search (Voyage) each rank
   the chunks, and the two rankings are merged. Without a Voyage key, keyword search alone is used.
3. **Answer**: the top 5 chunks go to Claude with strict rules: use only these sources, copy
   prices exactly, reply in the customer's language, and say so when the answer is not there.
4. **Check**: code double-checks Claude's answer.
   - `PRICE_NOT_IN_SOURCE`: the reply mentions an RM price that is not in the retrieved sources.
   - `CITED_UNKNOWN_SOURCE` / `ANSWER_WITHOUT_SOURCE`: the answer is not properly grounded.
   - `NOT_IN_DOCUMENTS`: the documents could not answer the question.
   Any flag sets the draft to `needs_review`. A clean, high-confidence answer is `ready`, meaning
   the owner can approve it with one tap.
5. **Log and report**: every question is saved to `data/rag-log.jsonl`. `npm run rag:report`
   turns the log into a hypothesis document: what customers asked, what the documents could not
   answer, and what to add. `npm run rag:retest` tests those hypotheses after you update the documents.

## Setup

1. Copy the folders into the OrderLah repo: `src/rag/`, `scripts/` (the `rag-*.cjs` and `_env.cjs`
   files), `test/rag.test.cjs`, `data/catalogue.sample.json`.
2. Add these lines to `.env`:

   ```
   ANTHROPIC_API_KEY=...          # you already have this
   ANTHROPIC_MODEL=claude-sonnet-5-5
   VOYAGE_API_KEY=...             # optional: enables semantic search (sign up at voyageai.com)
   VOYAGE_MODEL=voyage-4
   ```

3. Add these scripts to `package.json`:

   ```json
   "rag:build": "node scripts/rag-build.cjs",
   "rag:ask": "node scripts/rag-ask.cjs",
   "rag:report": "node scripts/rag-report.cjs",
   "rag:retest": "node scripts/rag-retest.cjs"
   ```

4. Add to `.gitignore`: `data/rag-index.json`, `data/rag-log.jsonl`, `data/rag-retest-log.jsonl`.
5. For PDFs only: `npm install pdf-parse`.

No other packages are needed. The code uses Node's built-in `fetch` and `.env` loader (Node 20.12+).

## Try it

```
cp data/catalogue.sample.json data/catalogue.json
npm run rag:build
npm run rag:ask -- "berapa kek coklat 8 inci?"
npm run rag:ask -- "ada sijil halal?"          # not in the sample catalogue: should be flagged
npm run rag:report                              # or: npm run rag:report -- --ai
```

To index several files: `npm run rag:build -- data/catalogue.json data/faq.pdf data/notes.md`

## Connecting it to the message flow

The files use the `.cjs` extension so they work whether OrderLah uses `import` or `require`.
Questions should use the same draft-and-approve flow as orders. In `src/flows/orderFlow.js`, when
the order parser says a message is not an order, send it to the RAG module instead. Adjust the
names below to match your code:

```js
// CommonJS:  const { createRag } = require('../rag/index.cjs');
import ragModule from '../rag/index.cjs';
const rag = ragModule.createRag();

// inside handleIncoming(), after the order parser runs:
if (parsed.intent === 'not_an_order') {
  const draft = await rag.ask(message.text, { customerId: customer.id, customerName: customer.name });
  await orbyte.audit.log('question_draft_created', draft);
  return inbox.addDraftReply(customer, draft); // owner sees it with Hantar / Ubah, like follow-ups
}
```

Rebuild the index (`npm run rag:build`) whenever the catalogue changes.

## The report (hypothesis document)

See `docs/example-question-report.md` for a sample. Each hypothesis has the form
"If we add X to the documents, then these questions can be answered automatically", with the
evidence (how many customers asked), the suggested change, and how to test it. With `--ai`,
Claude groups similar questions into topics; without it, questions are grouped by the
missing-information note from the answer step.

## Limits to know

- The price check only catches prices written as "RM…". A price written as "85 ringgit" is not checked.
- Small catalogues fit in one prompt anyway; RAG matters more as you add PDFs, FAQs and notes.
- The index is a JSON file loaded into memory. That is fine for a few thousand chunks; a larger
  business would need a vector database.
- The offline tests (`npm test`) use fake AI responses. Run real questions against the APIs before
  the demo and check the answers yourself.
- If your `npm test` script lists test files explicitly (e.g. `node --test test/*.test.js`),
  add `test/*.test.cjs` to it. Plain `node --test` finds the new tests automatically.
