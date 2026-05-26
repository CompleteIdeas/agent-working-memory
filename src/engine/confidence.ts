// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Retrieval confidence — score-distribution-aware signal that complements
 * the per-result `score`. The shape of the result set carries information
 * the raw scores do not:
 *
 *   - Confident recall: top-1 dominates, sharp cliff, non-trivial floor.
 *   - Noisy recall: many similar scores, flat distribution, weak floor.
 *   - "Best of bad bunch": sharp cliff but the cliff sits below a usable
 *     floor — the system found a winner among uninteresting candidates.
 *
 * Research grounding:
 *   - Geifman & El-Yaniv, "Selective Classification for Deep Neural
 *     Networks" (NeurIPS 2017): abstaining improves precision on confused
 *     inputs more than recalibrating thresholds.
 *   - Roitero et al, "Predictive Confidence in Retrieval" (SIGIR 2022):
 *     score-distribution shape predicts retrieval quality better than
 *     top-1 score in isolation.
 *   - Carmel & Yom-Tov, "Estimating Query Difficulty for IR" (Synthesis
 *     Lectures, 2010): post-retrieval predictors — sharpness, depth of
 *     score drop — correlate with TREC topic difficulty.
 *
 * AWM 0.8.5 integration: confidence is computed once per recall after
 * final scoring and attached to every `ActivationResult`. Consumers may
 * use it however they like (display, abstention, paired retrieval).
 * Default behavior of recall is unchanged — confidence is data, not a
 * gate, in PR-1.
 *
 * Configurable via env vars (initial weights tuned to favour sharpness):
 *   AWM_CONF_SHARPNESS_W (default 0.4) — weight of top1/mean(top5) signal
 *   AWM_CONF_CLIFF_W     (default 0.3) — weight of (top1 - top10) / top1
 *   AWM_CONF_FLOOR_W     (default 0.3) — weight of top1 absolute score
 */

export interface RecallConfidence {
  /** Composite confidence in [0, 1]. Higher = recall result is more trustworthy. */
  confidence: number;
  /** top1 / mean(top5), mapped to [0, 1] via (s-1)/(s+1). High = clear winner. */
  sharpness: number;
  /** (top1 - top10) / top1 in [0, 1]. High = sharp dropoff after winner. */
  cliff: number;
  /** top1 raw score, clamped to [0, 1]. Low = "best of bad bunch" risk. */
  floor: number;
}

const SHARPNESS_W = parseFloat(process.env.AWM_CONF_SHARPNESS_W ?? '0.4');
const CLIFF_W = parseFloat(process.env.AWM_CONF_CLIFF_W ?? '0.3');
const FLOOR_W = parseFloat(process.env.AWM_CONF_FLOOR_W ?? '0.3');

/**
 * Compute recall confidence from an ordered (descending) array of result scores.
 *
 * Returns a confidence near 0 when:
 *   - Empty result set (no winner)
 *   - Flat distribution (sharpness ~1, cliff ~0)
 *   - Low absolute scores (floor low — "best of bad bunch")
 *
 * Returns a confidence near 1 when:
 *   - top-1 dominates (sharpness >> 1)
 *   - Sharp cliff after top-1 (cliff close to 1)
 *   - top-1 is itself a strong absolute match (floor close to 1)
 *
 * Edge cases:
 *   - 1 result: cliff is 0 (no runner-up). Sharpness defaults to 1 (no peers
 *     to dominate). Confidence anchored entirely by floor.
 *   - 0 results: all zero, confidence = 0.
 */
export function computeRecallConfidence(scoresDesc: number[]): RecallConfidence {
  if (scoresDesc.length === 0) {
    return { confidence: 0, sharpness: 0, cliff: 0, floor: 0 };
  }

  const top1 = scoresDesc[0];

  // Floor: clamp top1 into [0, 1]. AWM composite scores already lie in this
  // range under normal use, but be defensive.
  const floor = Math.max(0, Math.min(1, top1));

  // Sharpness: top1 / mean(top-5). Skip if only 1 result (no peers).
  let sharpness = 0;
  if (scoresDesc.length >= 2) {
    const window = scoresDesc.slice(0, Math.min(5, scoresDesc.length));
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    if (mean > 0) {
      const ratio = top1 / mean; // typically in [1, K]
      sharpness = (ratio - 1) / (ratio + 1); // maps [1, ∞) → [0, 1)
    }
  }

  // Cliff: how steep is the drop from top-1 to the K-th candidate?
  // Use top-10 (or last available). If only 1 result, no cliff to measure.
  let cliff = 0;
  if (scoresDesc.length >= 2 && top1 > 0) {
    const tail = scoresDesc[Math.min(9, scoresDesc.length - 1)];
    cliff = Math.max(0, Math.min(1, (top1 - tail) / top1));
  }

  // Geometric blend — any near-zero component pulls confidence down.
  // Add a tiny epsilon so log/zero doesn't collapse the whole signal when
  // a result is genuinely sharp but the cliff is computed off only 2-3
  // candidates (cliff small even for confident recalls).
  const EPS = 0.05;
  const s = sharpness + EPS;
  const c = cliff + EPS;
  const f = floor + EPS;

  // Weighted geometric mean: prod(x_i ^ w_i)
  const logConf =
    SHARPNESS_W * Math.log(s)
    + CLIFF_W * Math.log(c)
    + FLOOR_W * Math.log(f);
  const totalW = SHARPNESS_W + CLIFF_W + FLOOR_W;
  // Subtract epsilon contribution so the floor of confidence is ~0 when all
  // signals are zero (rather than the value of EPS).
  const rawConf = Math.exp(logConf / totalW) - EPS;
  const confidence = Math.max(0, Math.min(1, rawConf));

  return { confidence, sharpness, cliff, floor };
}
