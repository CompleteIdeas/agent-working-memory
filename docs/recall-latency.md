# Where a recall's milliseconds go

Measured 2026-10-08 on the private snapshot (`store.db`), AWM 0.15.9, with the
shipped retrieval arm `AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1`.

Reproduce:

```
npm run profile:recall                 # 120 probes, identifier suite
npm run profile:recall -- --n 450 --fixture fixture-category.json
npm run profile:recall -- --live       # the path daily use takes (side effects ON)
npm run profile:recall -- --public     # reproducible corpus, no private data
npm run profile:recall -- --dtype q8   # or --pool N, --trunc N, --tagslen N
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

2. **The rerank-skip heuristic never fires on this store at the shipped k —
   0 of 870 queries.** `activation.ts` documents it as saving "~300ms of
   wall-clock per recall on simple queries". Its gate requires
   `rerankPool.length <= max(limit*2, 20)` = **20**, but the pool is
   `min(limit*8, 40)` = **24** at the shipped k=3 — one notch above the bound.
   Confirmed by observation: at `AWM_RERANK_POOL=16` the skip starts firing
   (3.3% of queries) purely because the pool drops under the bound.

   **Scope this claim carefully.** It is 0/870 *on an 11k-engram store at k=3*.
   The branch is still reachable wherever fewer than ~20 candidates clear
   `minScore` — a small or new store, or a narrow query — so a reviewer testing
   on a fresh store will see it fire and should not read that as a
   contradiction. What is wrong is the bound, not the idea: the saving it was
   written to collect is real, and at the shipped configuration it is never
   collected.

3. **Keyword search is 13.2% across three passes, not one.** `bm25` runs two
   (keyword-stripped for precision, expanded for recall) and Rocchio
   pseudo-relevance feedback runs a third on **100%** of queries. What that
   third pass buys has never been measured; it is a candidate for the next
   ablation, not a finding.

---

## The path daily use actually takes

Everything above is the *benchmark* path. `runner.ts` passes `internal: true`,
which skips `touchEngram`, the Hebbian co-activation buffer and the
activation-event insert. `internal` appears nowhere in `src/hooks/`,
`src/mcp.ts` or the adapters — so every real `memory_recall` and every
UserPromptSubmit prime runs those three stages, and no published latency number
has ever included them.

Measured with `npm run profile:recall -- --live`: 240 recalls, side effects on,
queries taken from `activation_events` (the store's own log of real past
recalls, so the real query distribution rather than identifier-shaped probes).

| | benchmark path | live path |
|---|---|---|
| total p50 | 538–547ms | **573ms** |
| `rerank` share | 78.0% | 76.9% |
| `touch` | *(skipped)* | 3.1ms · 0.5% |
| `hebbian` | *(skipped)* | 1.1ms · 0.2% |
| `logEvent` | *(skipped)* | 0.2ms · 0.0% |

**The side effects cost ~4.4ms, 0.7% of a recall.** `internal: true` understates
real recall latency by under one percent, so the published figures are honest
about the path users are on. That is a result worth having rather than assuming
in either direction.

**No buffer drift.** `getCoActivatedPairs(10_000)` reads a buffer that grows
across a session, so the Hebbian stage was the obvious candidate for
degradation over a long run. First 50 calls against the last 50: `hebbian`
0.91 → 1.10ms (+20% of a fifth of a millisecond), while `touch` and
`assocStats` got *faster* as SQLite warmed (−49%, −40%). Nothing runs away at
this length.

**Cold start is paid once per session, not per prompt.** The prime hook is a
thin script that POSTs to a long-lived per-session sidecar (`:8401` upward),
so the 1.3–1.5s model load lands on that sidecar's first recall and every
later prompt hits warm models. A per-prompt spawn would have made cold start
the dominant cost in daily use; it isn't.

### One real outlier: the pronoun branch

A query containing `she|he|they|her|his|him|their|it|that|this|there` triggers
a branch that calls `getEngramsByAgents(agentIds, 'active')` — **every active
engram, loaded into JS** — sorts them by access count and keeps five tag words
from the top ten.

| | |
|---|---|
| share of real prompts that trip it | **2.1%** (86 of 4,000 logged recalls; 5 of 240 in the live run) |
| share of fixture probes that trip it | 0.2% — so the benchmark never exercised it |
| cost **when it fires** | **245ms mean, 280ms median** |
| total recall when it fires | **926ms** against 572ms when it does not |

So about one real prompt in fifty paid a 62% slowdown to obtain five tag words,
and the benchmark corpus is ten times less likely to trip it than real traffic
is — which is why it survived this long.

**Fixed.** `EngramStore.getTopAccessedTags(agentIds, 10, 'active')` does it in
SQL. Same five tags, byte-identical, **287ms → 0.45ms** measured end to end,
still firing on the same 2.0% of real prompts. Identifier and topic accuracy
unmoved (92.7% / 92.0%); 802 tests pass.

One thing worth knowing if you touch it again: the obvious single query is a
trap. `agent_id IN (...)` makes SQLite abandon the ordered index walk and sort
the whole partition in a temp B-tree — **86ms**, against **0.03ms** for the
equality form that can walk `idx_engrams_access` and stop at `LIMIT`. The first
version of this fix was still 85ms for exactly that reason, which is only
visible in `EXPLAIN QUERY PLAN`. So the implementation queries per agent and
merges in JS; the global top N is always inside the union of the per-agent top
Ns, so that merge is exact rather than an approximation. Agent-scoped recall
passes one agent and was always on the fast path — it was **workspace-scoped**
recall that paid.

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
optimization has never been collected at the shipped k.
