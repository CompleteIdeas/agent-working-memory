// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Retraction Engine — negative memory / invalidation.
 *
 * Codex critique: "You need explicit anti-salience for wrong info.
 * Otherwise wrong memories persist and compound mistakes."
 *
 * When an agent discovers a memory is wrong:
 *   1. The original engram is marked retracted (not deleted — audit trail)
 *   2. An invalidation association is created
 *   3. Optionally, a counter-engram with correct info is created
 *   4. Confidence of associated engrams is reduced (contamination check)
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { Retraction } from '../types/index.js';

export class RetractionEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Retract a memory — mark it invalid and optionally create a correction.
   */
  retract(retraction: Retraction): { retractedId: string; correctionId: string | null; associatesAffected: number } {
    const target = this.store.getEngram(retraction.targetEngramId);
    if (!target) {
      throw new Error(`Engram ${retraction.targetEngramId} not found`);
    }

    // Mark the original as retracted
    this.store.retractEngram(target.id, null);

    let correctionId: string | null = null;

    // Create counter-engram if correction content provided
    if (retraction.counterContent) {
      const correction = this.store.createEngram({
        agentId: retraction.agentId,
        concept: `correction:${target.concept}`,
        content: retraction.counterContent,
        tags: [...target.tags, 'correction', 'retraction'],
        salience: Math.max(target.salience, 0.6), // Corrections are at least moderately salient
        confidence: 0.7,
        reasonCodes: ['retraction_correction', `invalidates:${target.id}`],
      });

      correctionId = correction.id;

      // Create invalidation link
      this.store.upsertAssociation(
        correction.id, target.id, 1.0, 'invalidation', 1.0
      );

      // Update retracted_by to point to correction
      this.store.retractEngram(target.id, correction.id);
    }

    // Reduce confidence of closely associated engrams (contamination spread)
    const associatesAffected = this.propagateConfidenceReduction(target.id, 0.1, 1);

    return { retractedId: target.id, correctionId, associatesAffected };
  }

  /**
   * Reduce confidence of engrams associated with a retracted engram.
   * Shallow propagation (depth 1) to avoid over-penalizing.
   */
  private propagateConfidenceReduction(
    engramId: string,
    penalty: number,
    maxDepth: number,
    currentDepth: number = 0
  ): number {
    if (currentDepth >= maxDepth) return 0;

    let affected = 0;
    const associations = this.store.getAssociationsFor(engramId);
    for (const assoc of associations) {
      if (assoc.type === 'invalidation') continue; // Don't penalize corrections

      const neighborId = assoc.fromEngramId === engramId
        ? assoc.toEngramId
        : assoc.fromEngramId;
      const neighbor = this.store.getEngram(neighborId);
      if (!neighbor || neighbor.retracted) continue;

      // Scale penalty by association weight
      const scaledPenalty = penalty * assoc.weight;
      const newConfidence = Math.max(0.1, neighbor.confidence - scaledPenalty);
      this.store.updateConfidence(neighborId, newConfidence);
      affected++;
    }
    return affected;
  }
}
