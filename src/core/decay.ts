// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * ACT-R Base-Level Activation
 *
 * Based on Anderson's ACT-R cognitive architecture (1993).
 * Memories that are accessed more recently and more frequently
 * have higher activation — a well-established model of human memory.
 *
 * Formula: B(M) = ln(n + 1) - d * ln(ageDays / (n + 1))
 *
 * Where:
 *   n = access count
 *   d = decay exponent (default 0.5)
 *   ageDays = age of memory in days
 */

export function baseLevelActivation(
  accessCount: number,
  ageDays: number,
  decayExponent: number = 0.5
): number {
  const n = Math.max(accessCount, 0);
  const age = Math.max(ageDays, 0.001); // Avoid log(0)
  return Math.log(n + 1) - decayExponent * Math.log(age / (n + 1));
}

/**
 * Softplus — smooth approximation of ReLU.
 * Used to keep activation scores positive without hard clipping.
 */
export function softplus(x: number): number {
  return Math.log(1 + Math.exp(x));
}

/**
 * Composite activation score combining content match, temporal decay,
 * Hebbian boost, and confidence.
 *
 * Score = contentMatch * softplus(B(M) + scale * hebbianBoost) * confidence
 */
export function compositeScore(params: {
  contentMatch: number;
  accessCount: number;
  ageDays: number;
  hebbianBoost: number;
  confidence: number;
  decayExponent?: number;
  hebbianScale?: number;
}): number {
  const {
    contentMatch,
    accessCount,
    ageDays,
    hebbianBoost,
    confidence,
    decayExponent = 0.5,
    hebbianScale = 1.0,
  } = params;

  const bm = baseLevelActivation(accessCount, ageDays, decayExponent);
  return contentMatch * softplus(bm + hebbianScale * hebbianBoost) * confidence;
}
