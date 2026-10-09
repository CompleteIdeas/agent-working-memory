# Where a recall's milliseconds go

Measured 2026-10-08 on the private snapshot (`store.db`), AWM 0.15.9, with the
shipped retrieval arm `AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1`.

Reproduce:

```
npm run profile:recall                 # 120 probes, identifier suite
npm run profile:recall -- --n 450 --fixture fixture-category.json
npm run profile:recall -- --public     # reproducible corpus, no private data
```

**Why this page exists.** The write path has had phase telemetry since D1. The
read path had exactly one number — the total — so every statement about *which
stage owns it* was a reading of the code rather than a measurement. Two
comments in this repository asserted the cross-encoder was "~90% of warm recall
latency", each citing only the other. It is **75–78%**. The hypothesis was
right about the culprit and wrong about the size, which is the normal outcome
of guessing at a profile and the reason `src/core/recall-telemetry.ts` now
exists.

---

## The profile

Topic suite, 450 warm recalls, k=3, first 10 discarded as warm-up. Shares are
quoted because latency on this machine is monotonic in free memory while
accuracy is immune to it — shares survive load noise, absolute times do not.

| Stage | mean | p50 | p95 | share |
|---|---|---|---|---|
| `rerank` — cross-encoder inference | 437.6 | 425.4 | 573.7 | **78.0%** |
| `feedbackBM25` — Rocchio re-search | 41.1 | 40.9 | 73.6 | 7.3% |
| `bm25` — dual keyword pass | 33.2 | 21.3 | 92.9 | 5.9% |
| `assocStats` — association counts | 16.7 | 10.1 | 50.8 | 3.0% |
| `vector` — embedding search | 13.1 | 13.4 | 20.4 | 2.3% |
| `embed` — query embedding | 8.5 | 6.5 | 19.4 | 1.5% |
| `graph` — depth-2 association walk | 4.0 | 2.0 | 7.1 | 0.7% |
| `scoring` — the synchronous composite loop | 2.9 | 2.7 | 4.7 | 0.5% |
| *(unaccounted JS)* | ~1.1 | — | — | 0.2% |
| **TOTAL** | **560.9** | **547.3** | **762.5** | |

Spans are flat and non-overlapping, which is what makes *unaccounted* mean
something. At 0.2% it means the stages above are the whole story and there is
no hidden synchronous cost.

**Shape of the work, per recall (median):** 57 candidates scored · rerank pool
**24** · 10,993 passage chars summed over the pool · longest passage **607**
(p95 792).

**Cold start.** First recall 1,525ms against a warm p50 of 547ms, of which the
cross-encoder's first inference is 450–670ms. This is the "why did my first
recall feel slow" answer: it is one-off model load, not a slow store.

### Three things the profile corrects

1. **`graphWalk` is 0.7%, not a latency problem.** `known-limitations.md`
   reports that the association graph changes the top-3 result set in **0%** of
   queries, which made it the obvious cut. It is worth ~4ms. Removing it is a
   simplicity argument, not a performance one — and this is exactly the claim
   that reading the code would have gotten wrong.

2. **The rerank-skip heuristic is dead at the shipped default — 0 of 870
   queries.** `activation.ts` documents it as saving "~300ms of wall-clock per
   recall on simple queries". Its gate requires
   `rerankPool.length <= max(limit*2, 20)` = **20**, but the pool is
   `min(limit*8, 40)` = **24** at the shipped k=3. The pool is permanently one
   notch above the bound, so the branch cannot be taken. Confirmed by
   observation: at `AWM_RERANK_POOL=16` the skip starts firing (3.3% of
   queries) purely because the pool drops under the bound.

3. **Keyword search is 13.2% across three passes, not one.** `bm25` runs two
   (keyword-stripped for precision, expanded for recall) and Rocchio
   pseudo-relevance feedback runs a third on **100%** of queries. What that
   third pass buys has never been measured; it is a candidate for the next
   ablation, not a finding.

---

## Levers: latency saved against accuracy lost

All measured same-session on one quiet machine (13.8 GB free), so the latency
column is comparable across rows. Both baselines reproduce
`docs/benchmarks-current.md` exactly, which is the fourth and fifth identical
accuracy reproduction of those figures.

**Identifier suite, n=300:**

| Arm | s@1 | s@5 | MRR | silence | total p50 | rerank p50 |
|---|---|---|---|---|---|---|
| **fp32 (shipped)** | 92.7% | 96.7% | 94.6% | 90.0% | 538ms | 407ms |
| `AWM_RERANKER_DTYPE=q8` | **92.7%** | 97.0% | 94.7% | 90.0% | **384ms** | 261ms |
| `AWM_RERANK_POOL=16` | 88.7% | 93.3% | 90.9% | 90.0% | 361ms | 244ms |

**Topic suite, n=450:**

| Arm | s@1 | s@5 | MRR | silence | total p50 | rerank p50 |
|---|---|---|---|---|---|---|
| **fp32 (shipped)** | 92.0% | 96.7% | 94.2% | 90.0% | 547ms | 425ms |
| `AWM_RERANKER_DTYPE=q8` | **91.1%** | 96.7% | 93.7% | 90.0% | **359ms** | 255ms |

### Reading the table

**q8 quantization of the cross-encoder is the one lever that is nearly free.**
It cuts total p50 latency **29–34%** and the rerank stage **36–40%**, for
**0.0pp** of s@1 on identifier queries and **−0.9pp** on topic queries. `s@5`
and correct silence are unchanged on both suites, so what moves is rank-1
ordering on topic queries, not whether the right memory is retrieved at all.

**Cutting the rerank pool is strictly worse.** `AWM_RERANK_POOL=16` buys a
similar saving for **−4.0pp** of s@1 and **−3.4pp** of s@5. The composite is a
deliberately cheap wide pre-filter and the cross-encoder is the ranker; starve
the pool and the ranker never sees the gold. q8 keeps the pool and makes the
ranker cheaper, which is why it dominates.

**The reranker earns its cost.** It is 78% of the latency and it is also what
`AWM_RERANK_TAGS=1` (+7.4pp s@1) and `AWM_RERANK_WINDOW=query` act through.
Nothing here argues for removing it — the lever worth pulling makes the same
judgement cheaper rather than making less of it.

---

## Not changed

`dtype` is now readable from `AWM_RERANKER_DTYPE` instead of being a literal,
because a value that cannot be varied cannot be measured. **The default is
still `fp32`** and every published number stands at fp32. Flipping the shipped
default is a product decision about a −0.9pp topic-suite cost, and it is
Robert's to make, not something a profiling pass should land quietly.

Two measurements would settle it:

- the same sweep on the **public corpus**, so the result is reproducible by a
  reviewer rather than maintainer-only (mind the 4pp seed-noise floor there —
  a 0.9pp move is below it, so this tests the latency claim, not the accuracy
  one);
- `q4`, which may trade more accuracy for less again.

And one defect is worth fixing on its own merits, independent of dtype: the
rerank-skip bound is off by four at the shipped k, so a documented 300ms
optimisation has never once run.
