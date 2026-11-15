// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * The final-order rule's two 0.22.4 decisions, kept pure so they can be tested without models.
 *
 * 1. When the cross-encoder is SURE, its order stands. Its sigmoid scores saturate near 1, so
 *    the blend's small slice of first-stage rank (0.05 on keyword queries) used to outvote it:
 *    0.99 against 0.95 looks like a 0.04 gap, but it is a logit gap of 1.7. Sureness is the
 *    top-two margin in logit space.
 * 2. On keyword-shaped queries the vector rank counts a quarter as much in the fused term. On
 *    near-template corpora the blend's wrong first places were mostly the vector channel's #1.
 *
 * Measured with tests/realstore-eval/blend-study.ts (offline, on recorded pools) and confirmed
 * end to end: identifier 93.8 → 94.9, topic 96.0 → 96.2, natural 47.9 → 48.5, public
 * 38.8 → 56.5, long memories 72.9 → 77.1; no suite's success@1 or @3 drops.
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

/** Weight of the vector rank in the fused first-stage term: 1 for natural queries, 0.25 for keyword ones. */
export function vectorWeight(natural: boolean, env: NodeJS.ProcessEnv = process.env): number {
  return natural ? 1 : Number(env.AWM_BLEND_VEC_KEYWORD ?? 0.25);
}
