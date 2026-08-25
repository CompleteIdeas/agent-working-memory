# The 400-character reranking blind spot

**Date:** 2026-08-23
**Result:** long-memory success@1 **25.0% → 87.5%** (3.5×), at **0.07%** added CPU
and **zero** added token cost.
**Also:** corrects the recommendation made earlier the same day to default
`AWM_RERANK2` ON by itself. **It must not ship alone.**

---

## The finding

`activation.ts` truncated every passage to the first **400 characters** before
cross-encoder reranking. The reason was real — cross-encoders pad to the longest
passage in a batch, so one 5,000-char memory in a 40-item pool drags everything
to ~512 tokens and costs 3–4×, and the reranker is already ~90% of warm recall
latency. "Just send everything" was never available.

But a **prefix** is the wrong 400 characters to spend.

### Grounded in the live store (29,844 engrams, 11,294 active, read-only)

| | |
|---|---|
| canonical memories: median length | **1,965 chars** |
| canonical memories exceeding 400 chars | **98.7%** |
| working memories exceeding 400 chars | 7.7% |
| **all stored characters past the truncation point** | **52.1%** (2.6M of 5.0M) |
| canonical vocabulary invisible to the reranker | **78.8%** of distinct terms |
| long canonical memories with identifiers **only** past char 400 | **99.9%** |

The truncation lands almost exclusively on `canonical` — the class AWM designates
as source-of-truth. Real examples of terms the reranker could never see:
`psql-equihub-dev2.postgres.database.azure.com`, `memory_supersede`,
`api-equihub-dev.scm.azurewebsites.net`, `_web_pass`.

This directly contradicts AWM's own writing guidance, which instructs authors to
*"include 2+ retrievable identifiers… the literal terms a future query will
use."* Authors were told to write the identifiers, and the ranker could not see
them.

## The mechanism, proven

LoCoMo cannot detect any of this: its passages are median 115 chars, p99 363,
and only **0.5%** reach 400. So a purpose-built eval was needed —
`tests/longmem-eval` — shaped like the real store: long, structured,
identifier-dense canonical memories, with the answer planted at a **controlled
offset** and same-domain distractors.

| answer offset | s@1 | s@5 | mean rank | gold rerank | gold BM25 |
|---|---|---|---|---|---|
| visible (<400) | **100.0%** | 100.0% | 1.00 | **0.986** | 0.735 |
| just past (~700) | **0.0%** | 91.7% | 3.08 | **0.000** | 0.683 |
| mid (~1600) | 0.0% | 83.3% | 4.17 | 0.000 | 0.636 |
| deep (~3000) | 0.0% | 41.7% | 5.80 | 0.000 | 0.597 |

**100% → 0% the moment the answer crosses char 400.** The cross-encoder score
collapses to literally zero while BM25 barely moves — FTS indexes full content
(`sqlite.ts:251`), so the memory stays **retrievable but stops being rankable**.
That is the `lost@pool/scoring` bucket, which the D11 work identified as the
pipeline's dominant loss at 32.5%.

*Caveat on magnitude:* this eval isolates the mechanism cleanly — query terms
appear **only** at the planted offset. Real memories often mention their topic
early too, so 100→0 is an upper bound on the effect, not a prediction for the
live store. The mechanism, however, is not in doubt.

## The fix

Spend the **same** character budget on the window that actually contains the
query's terms (`src/core/rerank-window.ts`, `AWM_RERANK_WINDOW=query`). Same
budget, same batch padding, same inference — better 400 chars.

| arm | long-mem s@1 | ~700 | ~1600 | ~3000 |
|---|---|---|---|---|
| baseline (prefix) | 25.0% | 0.0% | 0.0% | 0.0% |
| `AWM_RERANK2=1` alone | 25.0% | 0.0% | 0.0% | 0.0% |
| `AWM_RERANK_TRUNC=1200` | 31.3% | 25.0% | 0.0% | 0.0% |
| `AWM_RERANK_WINDOW=query` | 45.8% | 41.7% | 25.0% | 16.7% |
| **window + rerank2** | **87.5%** | **91.7%** | **83.3%** | **83.3%** |

With windowing, the gold's cross-encoder score recovers to **0.979–0.993 at every
depth** — the reranker can finally see the answer.

**Simply truncating less is strictly dominated.** `TRUNC=1200` scores 31.3% vs
windowing's 45.8% while costing 3× the tokens, and it still fails completely
past 1,200 chars. Any fixed prefix just moves the cliff.

**The two fixes are complementary, not alternatives.** Windowing lets the
reranker *see* the answer; phase 9b lets the reranker's now-correct judgement
*decide*. Windowing alone reaches only 45.8% because the blend still suppresses
the corrected signal (though s@5 hits 100% at every depth — the gold is right
there, just not first).

## Correction: `AWM_RERANK2` must not ship alone

Earlier today, on LoCoMo evidence, the recommendation was to flip `AWM_RERANK2`
to default ON. **That was wrong for the live store.** Measured here:

| ~700 bucket | s@5 | mean rank |
|---|---|---|
| baseline | 91.7% | 3.08 |
| **rerank2 alone** | **25.0%** | **6.67** |

Phase 9b alone makes long-memory recall substantially **worse**. `composite`
carries BM25 `textMatch` over *full* content, which was partially compensating
for the reranker's blindness; making the blind reranker authoritative strips that
protection. The damage is invisible in success@1 (already floored at 0%) and
shows in s@5 and mean rank.

LoCoMo could not have caught this — at 115-char passages the reranker is never
blind. **Ship the two together, or neither.**

## Cost

- **Tokens: zero added.** Same character budget ⇒ same batch padding ⇒ same
  inference.
- **CPU: 0.574 ms** per 40-candidate pool of 5,100-char memories — **0.07%** of
  the ~800 ms rerank step (`tests/longmem-eval/bench-window.ts`).

## Safety

- **Neutral on LoCoMo**, as designed — 99.5% of its passages are under 400 chars,
  so windowing is a near-no-op there:

  | arm | s@1 | s@5 | s@10 | adversarial |
  |---|---|---|---|---|
  | baseline | 37.8% | 55.0% | 62.2% | 76.9% |
  | window | 37.8% | 55.2% | 62.3% | 76.9% |
  | window + rerank2 | 47.6% | 60.1% | 62.3% | 76.9% |

- **Adversarial abstention 76.9% in every arm.**
- Falls back to the head when no query term matches, or when the query is all
  stopwords — i.e. it degrades to exactly the old behaviour when it has no signal.
- Defaults preserve shipped behaviour (`prefix`, 400).
- 14 unit tests (`tests/core/rerank-window.test.ts`); suite 55 files / 666 tests.

## Recommendation

Default **both** `AWM_RERANK_WINDOW=query` and `AWM_RERANK2=1` together:
long-memory recall 25.0% → 87.5%, LoCoMo 37.8% → 47.6%, adversarial unchanged,
no token cost.

Neither should be defaulted alone: rerank2 alone regresses long memories, and
windowing alone leaves most of its own gain on the table.

## Wider lesson

Two separate findings this session came from the same root: **AWM's primary
benchmark does not look like AWM's actual data.** LoCoMo is short conversational
turns seeded in one shot; the live store is long structured notes accumulated
over months. That gap hid this truncation cliff completely, and it is the same
reason the K=40 window sweep cannot be trusted (LoCoMo has no decay or Hebbian
history for `composite` to lose).

Worth keeping `tests/longmem-eval` as a standing second benchmark, run alongside
LoCoMo for anything touching ranking.

## Artifacts

- `src/core/rerank-window.ts` — windowing + passage construction
- `src/engine/activation.ts` — call site
- `tests/core/rerank-window.test.ts` — 14 unit tests
- `tests/longmem-eval/corpus.ts` / `runner.ts` — the eval LoCoMo cannot be
- `tests/longmem-eval/bench-window.ts` — CPU overhead measurement
- `tests/longmem-eval/locomo-check/` — LoCoMo neutrality arms
