// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Second-stage reordering — "rerank the rerank".
 *
 * THE PROBLEM
 * -----------
 * Phase 7 blends the cross-encoder's judgement with the composite score:
 *
 *     score = compositeWeight * composite + rerankWeight * rerankerScore
 *
 * with `rerankWeight` capped at 0.7, so `composite` always keeps at least 30%
 * of the vote on final ordering. Composite carries decay, Hebbian and salience
 * terms — useful for deciding WHICH candidates deserve consideration, but a
 * poor judge of which one actually answers the question.
 *
 * Measured on LoCoMo (616 answerable probes, tests/rerank2-eval): the blend
 * disagrees with the cross-encoder about which item deserves rank 1 on **38.6%**
 * of queries. Where that disagreement is decidable — one of the two is the gold
 * evidence — the **cross-encoder is right 77% of the time** (61 vs 18).
 *
 * THE FIX
 * -------
 * Re-sort only the final returned window by `rerankerScore` alone. Simulated
 * gain: **+8.0pp success@1** (39.1% -> 47.1%), fixing 61 queries and breaking
 * 12, with every category improving.
 *
 * WHY THIS IS SAFE
 * ----------------
 * Applied AFTER the channel-agreement gate, AFTER computeRecallConfidence, and
 * AFTER the requireConfidence check. Those read rerankerScore maxima/margins and
 * the score distribution. Reordering a window afterwards changes neither its
 * membership nor any score, so **adversarial abstention is provably
 * unaffected**. Retuning `rerankWeight` inside phase 7 would NOT have that
 * property — it shifts `item.score`, hence which items clear `minScore`, which
 * is exactly what cost adversarial 73.4->71.0 when the pool was last widened.
 *
 * Margin-guarded variants were simulated and are strictly worse: gating on a
 * >0.15 reranker margin cuts breakage 12->1 but also cuts fixes 61->17.
 */

/** Minimal shape this needs — anything carrying a cross-encoder score. */
export interface RerankScored {
  phaseScores: { rerankerScore: number };
}

/**
 * Re-sort the first `k` entries of `ranked` by descending `rerankerScore`,
 * leaving the tail untouched. Returns a new array; never mutates the input.
 *
 * Returns `ranked` unchanged when reordering would be unsound:
 *  - `k <= 1`, or fewer than 2 entries to order
 *  - any entry in the window has `rerankerScore <= 0`, which means the
 *    cross-encoder did not score it (skipped, failed, or timed out). Sorting
 *    on a zero would scramble an otherwise sound composite ordering — the
 *    reranker is wrapped in try/catch and a 10s timeout upstream, so this is a
 *    real path, not a theoretical one.
 */
export function reorderByReranker<T extends RerankScored>(ranked: T[], k: number): T[] {
  if (k <= 1 || ranked.length <= 1) return ranked;

  const window = Math.min(k, ranked.length);
  if (window <= 1) return ranked;

  const head = ranked.slice(0, window);
  for (const r of head) {
    if (!(r.phaseScores.rerankerScore > 0)) return ranked;  // also catches NaN
  }

  const sorted = head.slice().sort((a, b) => b.phaseScores.rerankerScore - a.phaseScores.rerankerScore);
  return sorted.concat(ranked.slice(window));
}

/** Window size for the second stage. */
export function rerank2WindowSize(): number {
  return Number(process.env.AWM_RERANK2_K ?? 10);
}

/** Whether the second stage is enabled. Default OFF pending the tracer verdict. */
export function rerank2Enabled(): boolean {
  return process.env.AWM_RERANK2 === '1';
}
