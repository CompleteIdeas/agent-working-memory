# Phase 9b — second-stage reordering ("rerank the rerank")

**Date:** 2026-08-23
**Result:** **+9.7pp success@1** (37.8% → 47.6%), p<0.001, adversarial abstention
provably and measurably unchanged. Costs no additional inference.
**Status:** implemented behind `AWM_RERANK2=1`, default OFF pending Robert's call
on flipping it.

---

## Where the idea came from

The D11 re-test established that **ranking, not retrieval, is AWM's bottleneck**:
gold clears the retrieval floor 89.1% of the time, but only 37.8% of answerable
queries put it at rank 1. Robert's question — *"can you rerank the rerank, like
top of the top?"* — targets exactly that gap.

The gap is measured, not theoretical. Gold is in the top-10 for 62.2% of
answerable queries. That is **24.4pp** sitting in positions 2–10, and half of it
is in ranks 2–3 alone.

## Diagnosis first: why is gold at rank 2?

Two candidate causes with completely different fixes:

- **the blend** — final order is `compositeWeight * composite + rerankWeight *
  rerankerScore` with `rerankWeight` capped at 0.7 (`activation.ts:881`), so
  `composite` always keeps ≥30% of the vote. Fixing this costs nothing.
- **the model** — if the cross-encoder itself misranks, only a stronger or
  comparative model helps, and that costs inference.

`tests/rerank2-eval/diagnose.ts` captured every score the pipeline computed for
all 616 answerable queries in one pass, so reordering policies could be simulated
offline without re-running any model. Verdict:

> **The blend disagrees with the cross-encoder about rank 1 on 38.6% of queries.
> Where the disagreement is decidable, the cross-encoder is right 77% of the
> time (61 vs 18).**

It was the blend. `composite` carries decay, Hebbian and salience terms — good for
deciding *which candidates deserve consideration*, bad at judging *which one
answers the question*.

## Simulated policies (offline, 616 queries)

| policy | s@1 | delta | broken | fixed |
|---|---|---|---|---|
| baseline | 39.1% | — | — | — |
| pure reranker, top-3 | 44.3% | +5.2pp | 7 | 39 |
| pure reranker, top-5 | 45.9% | +6.8pp | 8 | 50 |
| **pure reranker, top-10** | **47.1%** | **+8.0pp** | 12 | 61 |
| reranker top-5, margin>0.05 | 43.7% | +4.5pp | 3 | 31 |
| reranker top-5, margin>0.15 | 41.7% | +2.6pp | 1 | 17 |
| ORACLE (ceiling) | 63.5% | +24.4pp | 0 | 150 |

Margin guards are **strictly worse**: gating on a >0.15 margin cuts breakage
12→1 but also cuts fixes 61→17. Unconditional wins on net.

## Validated on the real tracer

Paired, identical query set, McNemar on discordant pairs:

| slice | n | base | rerank2 | delta | broken | fixed | p |
|---|---:|---:|---:|---:|---:|---:|---:|
| multi-hop | 189 | 30.2% | 37.6% | +7.4pp | 9 | 23 | 0.039 |
| single-hop | 125 | 51.2% | **64.8%** | **+13.6pp** | **0** | 17 | 0.003 |
| temporal | 53 | 5.7% | 11.3% | +5.7pp | 1 | 4 | 0.358 |
| open-domain | 249 | 43.8% | 54.2% | +10.4pp | 5 | 31 | 0.002 |
| **ALL answerable** | 616 | 37.8% | **47.6%** | **+9.7pp** | 15 | 75 | **<0.001** |
| ADVERSARIAL | 446 | 76.9% | 76.9% | +0.0pp | **0** | **0** | 1.000 |

Every category improves. The real gain exceeded the simulation (+9.7 vs +8.0).

## Why it cannot damage abstention — argued, then measured

Phase 9b runs **after** the channel-agreement gate, **after**
`computeRecallConfidence`, and **after** the `requireConfidence` check. Those
read `rerankerScore` maxima/margins and the score distribution. Reordering a
window afterwards changes neither its membership nor any score.

Retuning `rerankWeight` inside phase 7 would **not** have this property: it
shifts `item.score`, hence which items clear `minScore` — precisely what cost
adversarial 73.4→71.0 when the pool was last widened.

The argument predicts exactly 0 broken / 0 fixed on adversarial. **Measured: 0
and 0.** The design claim is confirmed, not merely asserted.

## Controls

- **Arm self-labels.** `AWM_RERANK2` was added to the tracer's arm list, closing
  the instrumentation gap that made the D11 inhibition arms indistinguishable.
  Output reads `arm=rerank2`.
- **True no-op when disabled.** A baseline re-run *after* the code change is
  byte-identical to the pre-change baseline on every reported metric.
- **Unit tests.** `tests/core/rerank2.test.ts`, 13 tests, covering the soundness
  guards — most importantly that an unscored window (reranker skipped, failed,
  or timed out, leaving `rerankerScore` at 0) returns the input **unchanged**
  rather than sorting on zeros and destroying a sound composite ordering.
- Full suite 53 files / 639 tests green.

## Cost

**Zero additional inference.** No new model, no extra cross-encoder passes — the
scores already exist and were being partially discarded. The added work is one
sort of ≤10 items. Given the reranker is already ~90% of warm recall latency,
this is the rare quality win that does not buy itself with time.

## Recommendation

**Flip `AWM_RERANK2` to default ON.** The evidence is strong (+9.7pp, p<0.001),
it improves every category, the dominant risk (abstention) is measurably
untouched, single-hop improves with zero breakage, and it is free.

Cost, stated honestly: **15 queries that baseline got right now land below rank
1**, against 75 newly correct. Net +60. That is the trade.

**Caveat before assuming it transfers.** LoCoMo passages are median 115 chars;
real AWM memories run thousands. The *mechanism* (blend overriding the
cross-encoder) is store-independent, but the magnitude may differ on the live
store. Worth a confirmation pass there before or shortly after flipping.

## Related finding — the reranker only sees 400 characters

`activation.ts:867` truncates each passage to 400 chars before reranking. LoCoMo
cannot detect any harm from this: its passages are median 115 chars, p99 363,
and only **0.5% exceed 400**. Real AWM memories are routinely 2,000–5,000 chars,
so a memory whose answer sits past char 400 is being judged on its opening alone.

**AWM's primary quality benchmark is structurally blind to this failure mode.**
That deserves its own eval built from long, structured memories — the shape the
live store actually holds — rather than conversational turns. Tracked separately.

## Artifacts

- `src/core/rerank2.ts` — the extracted, unit-tested reorder
- `src/engine/activation.ts` — phase 9b call site
- `tests/core/rerank2.test.ts` — 13 unit tests
- `tests/rerank2-eval/diagnose.ts` — one-pass score capture
- `tests/rerank2-eval/simulate.mjs` — offline policy simulator
- `tests/rerank2-eval/retest/` — tracer arms, paired analyzer, per-query records
