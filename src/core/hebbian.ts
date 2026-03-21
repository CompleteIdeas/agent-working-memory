// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Hebbian Learning — "neurons that fire together wire together"
 *
 * When two engrams are co-activated (retrieved together in the same
 * activation query), their association weight increases.
 *
 * Log-space weight update prevents runaway growth:
 *   logNew = log(w) + signal * log(1 + rate)
 *
 * Associations decay symmetrically when unused.
 */

const MIN_WEIGHT = 0.001;
const MAX_WEIGHT = 5.0;  // Cap at 5 to prevent graph walk explosion

/**
 * Strengthen an association weight after co-activation.
 */
export function strengthenAssociation(
  currentWeight: number,
  signal: number = 1.0,
  rate: number = 0.25
): number {
  const logW = Math.log(Math.max(currentWeight, MIN_WEIGHT));
  const logNew = logW + signal * Math.log(1 + rate);
  return Math.min(Math.exp(logNew), MAX_WEIGHT);
}

/**
 * Weaken an association weight due to lack of co-activation.
 * Called periodically by the connection engine.
 */
export function decayAssociation(
  currentWeight: number,
  daysSinceActivation: number,
  halfLife: number = 7.0 // days
): number {
  const decayFactor = Math.pow(0.5, daysSinceActivation / halfLife);
  return Math.max(currentWeight * decayFactor, MIN_WEIGHT);
}

/**
 * Ring buffer for tracking recent co-activations.
 * Feeds the Hebbian worker — when two engrams appear in the buffer
 * within a window, their association is strengthened.
 */
export class CoActivationBuffer {
  private buffer: { engramId: string; timestamp: number }[] = [];
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  push(engramId: string): void {
    this.buffer.push({ engramId, timestamp: Date.now() });
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  pushBatch(engramIds: string[]): void {
    for (const id of engramIds) {
      this.push(id);
    }
  }

  /**
   * Get all pairs of engrams that were co-activated within windowMs.
   */
  getCoActivatedPairs(windowMs: number = 5000): [string, string][] {
    const pairs: [string, string][] = [];
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        const a = this.buffer[i];
        const b = this.buffer[j];
        if (
          a.engramId !== b.engramId &&
          Math.abs(a.timestamp - b.timestamp) <= windowMs
        ) {
          pairs.push([a.engramId, b.engramId]);
        }
      }
    }
    return pairs;
  }

  clear(): void {
    this.buffer = [];
  }
}
