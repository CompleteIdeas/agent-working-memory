// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Staging Buffer — weak signal handler.
 *
 * Observations that don't meet the salience threshold for active memory
 * go to staging. The staging buffer periodically:
 *   1. Checks staged engrams against active memory for resonance
 *   2. Promotes resonant engrams to active
 *   3. Discards expired engrams that never resonated
 *
 * Modeled on hippocampal consolidation — provisional encoding
 * that only persists if reactivated.
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { ActivationEngine } from './activation.js';

export class StagingBuffer {
  private store: EngramStore;
  private engine: ActivationEngine;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(store: EngramStore, engine: ActivationEngine) {
    this.store = store;
    this.engine = engine;
  }

  /**
   * Start the periodic staging check.
   */
  start(intervalMs: number = 60_000): void {
    this.checkInterval = setInterval(() => this.sweep(), intervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Sweep staged engrams: promote or discard.
   */
  async sweep(): Promise<{ promoted: string[]; discarded: string[] }> {
    const promoted: string[] = [];
    const discarded: string[] = [];

    const expired = this.store.getExpiredStaging();
    for (const engram of expired) {
      // Check if this engram resonates with active memory
      const results = await this.engine.activate({
        agentId: engram.agentId,
        context: `${engram.concept} ${engram.content}`,
        limit: 3,
        minScore: 0.3,
        internal: true,
      });

      if (results.length > 0) {
        // Resonance found — promote to active
        this.store.updateStage(engram.id, 'active');
        promoted.push(engram.id);
      } else {
        // No resonance — discard
        this.store.deleteEngram(engram.id);
        discarded.push(engram.id);
      }
    }

    return { promoted, discarded };
  }
}
