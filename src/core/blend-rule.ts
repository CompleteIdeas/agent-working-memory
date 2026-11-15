// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * The final-order rule's two 0.22.4 decisions, kept pure so they can be tested without models.
 *
 * Both decide FIRST PLACE only; places 2+ keep the 0.21.1 blend's order.
 * 1. When the cross-encoder is SURE, its #1 is first. Its sigmoid scores saturate near 1, so
 *    the blend's small slice of first-stage rank (0.05 on keyword queries) used to outvote it:
 *    0.99 against 0.95 looks like a 0.04 gap, but it is a logit gap of 1.7. Sureness is the
 *    top-two margin in logit space.
 * 2. Otherwise a keyword query re-blends for first place with the vector rank counting a
 *    quarter, except where both channels agree. On near-template corpora the blend's wrong
 *    first places were mostly the vector channel's #1 (72 of 107 on the public store).
 *
 * Measured with tests/realstore-eval/blend-study.ts (offline, on recorded pools) and confirmed
 * end to end: identifier 93.8 -> 95.4, topic 96.0 -> 96.2, natural 47.9 -> 48.5, public
 * 38.8 -> 52.8, long memories 72.9 -> 77.1; no suite's success@1, @3 or @5 drops.
 */

/** Logit of a probability, clamped so 0 and 1 stay finite. */
export function logit(p: number): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
}

/** Margin (logit space) a natural or keyword query needs before the cross-encoder's order stands. */
export function sureThreshold(natural: boolean, env: NodeJS.ProcessEnv = process.env): number {
  return natural ? Number(env.AWM_BLEND_SURE_NATURAL ?? 1.5) : Number(env.AWM_BLEND_SURE_KEYWORD ?? 1);
}

/**
 * Is the cross-encoder sure? `scores` are its scores (times any stale penalty), in any order.
 * False with fewer than two candidates' worth of evidence, and always false when
 * `AWM_BLEND_SURE=off` (0.22.3 behaviour: always blend).
 */
export function crossEncoderSure(scores: number[], natural: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWM_BLEND_SURE === 'off' || scores.length < 2) return false;
  const [a, b] = [...scores].sort((x, y) => y - x);
  return logit(a!) - logit(b!) >= sureThreshold(natural, env);
}

/**
 * Weight of a candidate's vector rank when a keyword query re-blends for first place: 0.25
 * (AWM_BLEND_VEC_KEYWORD), except 1 for a candidate both channels rank in their top two
 * (0-based ranks <= AWM_BLEND_AGREE_RANK, default 1). Ranks are -1 when a channel missed it.
 * Agreement keeps the full weight because the questions the quarter weight lost on the real
 * store (the date-cue suite) were a vector #1 that BM25 also ranked second.
 */
export function keywordVectorWeight(bm25Rank: number, vecRank: number, env: NodeJS.ProcessEnv = process.env): number {
  const A = Number(env.AWM_BLEND_AGREE_RANK ?? 1);
  if (bm25Rank >= 0 && bm25Rank <= A && vecRank >= 0 && vecRank <= A) return 1;
  return Number(env.AWM_BLEND_VEC_KEYWORD ?? 0.25);
}
