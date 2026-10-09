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
npm run profile:recall -- --feedback 1 # put the Rocchio pass back (finding 3)
```

**Why this page exists.** The write path has had phase telemetry since D1. The
read path had exactly one number — the total — so every statement about *which
stage owns it* was a reading of the code rather than a measurement. Two
comments in this repository asserted the cross-encoder was "~90% of warm recall
latency", each citing only the other. It was **75–78%** of the pipeline
measured here, and is **82–84%** of the one that now ships, because defaulting
the Rocchio pass off removed 7% of the denominator without touching the
numerator. The hypothesis was
right about the culprit and wrong about the size, which is the normal outcome
of guessing at a profile and the reason `src/core/recall-telemetry.ts` now
exists.

> **What this page changed, and what that does to its own numbers (2026-10-09).**
> Two findings below were acted on the day after the measurement, so every table
> on this page is the *pre-change* state and stays as measured:
>
> - **Finding 2, the clear-winner rerank skip: deleted.** Number-neutral — it
>   never fired on any store measured here, and forcing it on cost accuracy.
> - **Finding 3, the Rocchio feedback pass: now default off.** This one *does*
>   move the published figures. Identifier s@1 92.7% → **93.0%**, topic 92.0% →
>   **92.2%**, and every accuracy table below carries the old baseline. Current
>   figures live in `docs/benchmarks-current.md`.

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

2. **The rerank-skip heuristic never fired at the shipped k, and forcing it on
   cost accuracy. It is now removed.** `activation.ts` documented it as saving
   "~300ms of wall-clock per recall on simple queries". Its gate required
   `rerankPool.length <= max(limit*2, 20)` = **20** against a pool of
   `min(limit*8, 40)` = **24** at the shipped k=3 — one notch above the bound.
   It fired on 0 of 870 queries in the first profile, 0 of 300 on the identifier
   suite and 0 of 200 on the public corpus.

   The bound was in step when it was written. 0.7.13 had cut the pool to
   `max(limit*2, 15)`, and its changelog notes the skip would fire *more* often
   as a result. 0.9.0 widened the pool to `max(limit*4, 40)` for recall and left
   the bound behind.

   So the question was whether to collect the saving, and the answer is no.
   Measured with `--skip-pool off`, the lever added for exactly this:

   | identifier n=300 | s@1 | s@5 | MRR | silence | skip fired |
   |---|---|---|---|---|---|
   | bound as shipped | **92.7%** | **96.7%** | **94.6%** | 90.0% | 0/300 |
   | bound off | 91.7% | 96.3% | 93.9% | 90.0% | 10/300 |

   (Both rows carry the Rocchio pass, which was still on when this was measured.
   The comparison is unaffected — it is one change against one baseline — but the
   absolute figures are the 2026-10-08 ones.)

   A per-query diff of the two traces moves **exactly the 10 queries it fired on
   and nothing else**: 3 of those 10 lost rank-1, and one lost the gold out of
   the top 5 altogether. The heuristic's premise — that the cross-encoder rarely
   changes the top result when the composite already has a clean winner — does
   not hold on the queries it selected for itself. Against that, the saving is at
   most **13.6ms of a 528ms recall** (3.3% of queries × a 407ms rerank stage),
   which is smaller than this machine's run-to-run drift: three back-to-back runs
   of the *same* arm gave 528, 548 and 500ms.

   It was also unsafe where it *did* fire — a store with fewer than ~20
   candidates clearing `minScore`, which is to say a new install. Every pool item
   keeps `rerankerScore = 0`, and phase 8 reads that in three places with no idea
   the stage was skipped: the reranker agreement channel dies; `margin` is 0, so
   the thin-margin branch *always* fires (×0.4 on every score, which drops
   `floor` in `computeRecallConfidence` and therefore depresses confidence on
   exactly the clearest queries); and a caller passing `abstentionThreshold`
   needs 3 of 3 channels and abstains.

   **Deleting it is number-neutral on every store measured here**, because it
   never fired on any of them. Reproduce the rejection at commit `d7417c4`:
   `npm run profile:recall -- --n 300 --skip-pool off`. The same hazard outlives
   the skip on the two paths where the reranker still does not run —
   `useReranker: false` (exposed as the MCP `use_reranker` parameter) and the
   reranker's own catch — which is a separate defect with its own measurement.

3. **Keyword search was 13.2% across three passes, not one — and the third pass
   bought nothing.** `bm25` runs two (keyword-stripped for precision, expanded
   for recall). Rocchio pseudo-relevance feedback ran a third on **100%** of
   queries for 6.7–7.0% of every warm recall, and that cost had never been
   weighed against a benefit. Measured with `--feedback 0`, arrow reads ON → OFF:

   | Suite | s@1 | s@5 | MRR | correct silence | stage cost removed |
   |---|---|---|---|---|---|
   | identifier n=300 | 92.7 → **93.0** | 96.7 → **97.0** | 94.6 → **94.9** | 90.0 → 90.0 | 37ms (7.0%) |
   | topic n=450 | 92.0 → **92.2** | 96.7 → **96.9** | 94.2 → **94.4** | 90.0 → 90.0 | 35ms (6.9%) |
   | public n=200 | 56.0 → 56.0 | 61.5 → 61.5 | 58.7 → 58.7 | 100 → 100 | 3ms (1.2%) |

   Read that accuracy column as **unmoved, not improved**. It is one query on
   each private suite, and on the topic suite a per-query diff shows one gold
   moving up and one moving down. The decisive row is the public corpus — the
   only suite here with real recall headroom, at s@5 61.5% — where a
   candidate-*adding* pass changes nothing whatsoever. Across all three suites it
   moves 3 gold ranks in 950 queries, two of them the wrong way, which is the
   shape to expect from a pass that can only add candidates and whose additions
   can only displace.

   Take the saving from the **stage table**, not from the totals. This machine's
   run-to-run drift is larger than the effect — three back-to-back runs of one
   arm gave 528, 548 and 500ms — and on the public corpus BM25 is cheap, so most
   of the 10% total drop there is noise around a 3ms stage.

   **Default off since 2026-10-09**; `AWM_FEEDBACK_BM25=1` restores it. Scope the
   result to this implementation before concluding anything about the technique:
   the five expansion terms are the first novel tokens in *document order*, not
   the top five by weight, and come mostly from the top-1 result. A weighted term
   selection is a different experiment.

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
unmoved (92.7% / 92.0% — the shipped defaults on 2026-10-08, before the Rocchio
pass was turned off); 802 tests pass.

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
`docs/benchmarks-current.md` **as it stood on 2026-10-08** exactly, which was
the fourth and fifth identical accuracy reproduction of those figures.

That lineage ends here. Defaulting the Rocchio pass off on 2026-10-09 (finding 3)
moved the baseline to 93.0% / 92.2%, so the `fp32 (shipped)` rows below are the
*old* default and the q8 comparison is relative to it. **The q8 question has not
been re-measured against the new baseline** — it needs to be before the dtype
decision is taken, because the −0.9pp topic cost that makes it a tradeoff was
measured against a pipeline that no longer ships.

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

**The reranker earns its cost.** It is 78% of the latency as measured here
(82–84% of the pipeline that now ships) and it is also what
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

The rerank-skip bound that this page originally listed as a defect to fix turned
out to be the wrong read: collecting its saving costs more accuracy than the
saving is worth, so the branch was removed instead. See finding 2.
