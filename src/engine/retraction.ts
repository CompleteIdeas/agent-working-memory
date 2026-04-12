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

    // Reduce confidence of associated engrams (contamination spread)
    // Depth 2 with 50% decay per hop, capped at 20 total affected nodes
    const associatesAffected = this.propagateConfidenceReduction(target.id, 0.1, 2);

    return { retractedId: target.id, correctionId, associatesAffected };
  }

  /**
   * Reduce confidence of engrams associated with a retracted engram.
   * Propagates up to maxDepth hops with decaying penalty (50% per hop).
   * Capped at MAX_AFFECTED to prevent cascading through the graph.
   */
  private static readonly MAX_AFFECTED = 20;

  private propagateConfidenceReduction(
    engramId: string,
    penalty: number,
    maxDepth: number,
    currentDepth: number = 0,
    visited: Set<string> = new Set(),
  ): number {
    if (currentDepth >= maxDepth) return 0;
    if (visited.size >= RetractionEngine.MAX_AFFECTED) return 0;
    visited.add(engramId);

    let affected = 0;
    const associations = this.store.getAssociationsFor(engramId);
    for (const assoc of associations) {
      if (assoc.type === 'invalidation') continue; // Don't penalize corrections
      if (visited.size >= RetractionEngine.MAX_AFFECTED) break;

      const neighborId = assoc.fromEngramId === engramId
        ? assoc.toEngramId
        : assoc.fromEngramId;
      if (visited.has(neighborId)) continue;

      const neighbor = this.store.getEngram(neighborId);
      if (!neighbor || neighbor.retracted) continue;

      // Scale penalty by association weight and decay per hop (50% per depth level)
      const depthDecay = Math.pow(0.5, currentDepth);
      const scaledPenalty = penalty * assoc.weight * depthDecay;
      const newConfidence = Math.max(0.1, neighbor.confidence - scaledPenalty);
      this.store.updateConfidence(neighborId, newConfidence);
      affected++;

      // Recurse to next depth
      affected += this.propagateConfidenceReduction(
        neighborId, penalty, maxDepth, currentDepth + 1, visited
      );
    }
    return affected;
  }
}
