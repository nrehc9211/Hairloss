# Customer Question Report: Dapur Lina Cakes

Period: 2026-10-14 to 2026-10-20

## Summary

| Measure | Count | Share |
| --- | --- | --- |
| Questions received | 8 | 100% |
| Ready for one-tap approval | 3 | 38% |
| Needed owner review | 5 | 63% |
| Not answerable from documents | 3 | 38% |

## Safety flags

| Flag | Count |
| --- | --- |
| NOT_IN_DOCUMENTS | 3 |
| PRICE_NOT_IN_SOURCE | 1 |

## Hypotheses

### H1. halal certification status

**Hypothesis:** If we add "halal certification status" to the documents, these 2 question(s) can be answered automatically.

**Evidence:** 2 question(s), for example:

- "Is your cake halal?"
- "ada sijil halal?"

**Suggested change:** Add halal certification status to the catalogue or FAQ.

**How to test:** Update the documents, run `npm run rag:build`, then `npm run rag:retest` and check these questions become answerable.

### H2. nut allergen information

**Hypothesis:** If we add "nut allergen information" to the documents, these 1 question(s) can be answered automatically.

**Evidence:** 1 question(s), for example:

- "kek ni ada kacang tak?"

**Suggested change:** Add nut allergen information to the catalogue or FAQ.

**How to test:** Update the documents, run `npm run rag:build`, then `npm run rag:retest` and check these questions become answerable.

## Replies the owner had to review

| Question | Reason |
| --- | --- |
| boleh bagi diskaun 20%? | Customer asked for a discount |
| kek coklat RM80 kan? | PRICE_NOT_IN_SOURCE: RM80.00 |
