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

/** Minimal shape this needs — anything carrying a cross-encoder score, and
 *  optionally the stale penalty Phase 8c applied to it (see below). */
export interface RerankScored {
  phaseScores: { rerankerScore: number; stalePenalty?: number };
  /** The Phase 7 blended score (composite + reranker). Carries decay, so recency. */
  score?: number;
}

/**
 * NEAR-TIES (0.18.1, found by MWA when it moved to rerank2-on defaults)
 * -----------------------------------------------------------------------
 * The cross-encoder judges relevance to the query and nothing else. Three
 * same-topic facts written in October, December and March ("the book club
 * chose a fantasy novel / science fiction / a mystery") score within a few
 * hundredths of each other for "what did the book club most recently
 * choose", and a sort by reranker score alone put the newest LAST. The blend
 * carries decay, so it knows which is newest; replacing it outright threw
 * that away exactly where the cross-encoder has nothing to say.
 *
 * The first fix tried was a score epsilon: within `AWM_RERANK2_TIE_EPS` the
 * blended score decides. MEASURED at 0.03 on the private snapshot (2026-10-19):
 * identifier s@1 93.0% -> 78.7%, topic 92.2% -> 84.4%. The cross-encoder's
 * scores saturate near 1.0 for the top candidates, so hundredths separate most
 * top-2 pairs and are informative there; the blend loses to it 77% of the time
 * on disagreements. So the epsilon DEFAULTS TO 0 (off) and exists only for
 * experiments. The recency rule lives where it belongs instead: among results
 * the conflict detector marks as two versions of one fact, the newest goes
 * first (conflicts.ts `newestFirstAmongConflicts`, applied in activation.ts).
 * That cannot touch a suite whose golds are single facts.
 */
export function rerank2TieEpsilon(): number {
  const v = Number(process.env.AWM_RERANK2_TIE_EPS ?? 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * THE STALE-SUPPRESSION HOLE (found 2026-10-19, MWA evaluation probe)
 * --------------------------------------------------------------------
 * Phase 8c multiplies a superseded (or, since 2026-10-19, expired) memory's
 * `score` by 0.15 so its successor dominates. This stage sorted the window by
 * raw `rerankerScore`, which never carried that penalty — so with
 * `AWM_RERANK2=1` (what `awm setup` writes into every Claude Code install) a
 * superseded memory came back at rank 1 ABOVE its replacement whenever the
 * cross-encoder liked its wording better. The supersession test ran with the
 * reranker off, so nothing caught it. `tests/core/rerank2.test.ts` now pins the
 * corrected behaviour: the sort key is `rerankerScore × stalePenalty`, the same
 * factor Phase 8c used, so stale rows sort below current ones here exactly as
 * they do in the blend. The soundness guards below are unchanged.
 */
export function rerankSortKey(r: RerankScored): number {
  return r.phaseScores.rerankerScore * (r.phaseScores.stalePenalty ?? 1);
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

  const eps = rerank2TieEpsilon();
  const sorted = head.slice().sort((a, b) => {
    const d = rerankSortKey(b) - rerankSortKey(a);
    if (eps > 0 && Math.abs(d) < eps) return (b.score ?? 0) - (a.score ?? 0);  // experiment only; see above
    return d;
  });
  return sorted.concat(ranked.slice(window));
}

/** Window size for the second stage. */
export function rerank2WindowSize(): number {
  return Number(process.env.AWM_RERANK2_K ?? 10);
}

/**
 * Whether the second stage is enabled. Default ON since 2026-10-19; set
 * `AWM_RERANK2=0` to disable. It was opt-in (`=1`) from 2026-08-24, injected
 * into every config `awm setup` wrote — and a config that did not carry the
 * three strings ran degraded for 47 days without anyone noticing, because
 * degraded recall looks exactly like working recall. The measured-good
 * configuration is now what the code does when nothing is set; the env var
 * is the escape hatch, like the other diagnostics knobs.
 */
export function rerank2Enabled(): boolean {
  return process.env.AWM_RERANK2 !== '0';
}
