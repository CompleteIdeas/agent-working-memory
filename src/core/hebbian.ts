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
 * Uses power-law decay (DASH model) instead of exponential.
 * Power law has a longer tail — old but valuable associations
 * don't vanish as aggressively as exponential decay.
 *
 * DASH: weight = initial × (1 + t/scale)^(-exponent)
 * vs exponential: weight = initial × 0.5^(t/halfLife)
 *
 * At 7 days: power-law retains ~58% vs exponential 50%
 * At 30 days: power-law retains ~32% vs exponential 6%
 * At 90 days: power-law retains ~20% vs exponential 0.02%
 */
export function decayAssociation(
  currentWeight: number,
  daysSinceActivation: number,
  halfLife: number = 7.0 // scale parameter (days)
): number {
  // Power-law decay: (1 + t/scale)^(-exponent)
  const exponent = 0.8; // Controls steepness — 0.8 gives a good balance
  const decayFactor = Math.pow(1 + daysSinceActivation / halfLife, -exponent);
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

/**
 * Validation-gated Hebbian buffer (Kairos-inspired).
 *
 * Instead of strengthening associations immediately on co-activation,
 * pairs are held pending until feedback arrives. This prevents hub toxicity
 * from noisy co-retrieval — edges only strengthen when the retrieval was
 * actually useful.
 *
 * - Positive feedback → strengthen the pending pairs
 * - Negative feedback → slightly weaken them
 * - No feedback within GATE_TIMEOUT_MS → discard (neutral)
 */
const GATE_TIMEOUT_MS = 60_000; // 60 seconds to receive feedback

interface PendingHebbianUpdate {
  pairs: [string, string][];
  engramIds: string[];
  timestamp: number;
}

export class ValidationGatedBuffer {
  private pending: PendingHebbianUpdate[] = [];

  /** Record co-activated pairs as pending (awaiting feedback validation) */
  addPending(engramIds: string[], pairs: [string, string][]): void {
    this.pending.push({ pairs, engramIds, timestamp: Date.now() });
    // Evict expired entries
    const cutoff = Date.now() - GATE_TIMEOUT_MS;
    this.pending = this.pending.filter(p => p.timestamp > cutoff);
  }

  /**
   * Resolve pending updates for an engram that received feedback.
   * Returns pairs to strengthen (positive) or weaken (negative).
   */
  resolveFeedback(engramId: string, useful: boolean): { pairs: [string, string][]; signal: number } {
    const cutoff = Date.now() - GATE_TIMEOUT_MS;
    const matching: [string, string][] = [];

    // Find all pending updates that include this engram and are still within the gate window
    this.pending = this.pending.filter(p => {
      if (p.timestamp < cutoff) return false; // expired
      if (p.engramIds.includes(engramId)) {
        matching.push(...p.pairs);
        return false; // consumed
      }
      return true; // keep
    });

    // Deduplicate pairs
    const seen = new Set<string>();
    const unique: [string, string][] = [];
    for (const [a, b] of matching) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push([a, b]);
      }
    }

    return {
      pairs: unique,
      signal: useful ? 1.0 : -0.3, // positive = full strengthen, negative = slight weaken
    };
  }

  /** Get count of pending updates (for stats) */
  get pendingCount(): number { return this.pending.length; }
}
