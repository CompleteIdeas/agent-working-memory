// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Eviction Engine — capacity enforcement and edge pruning.
 *
 * When memory budgets are exceeded:
 *   1. Archive lowest-value active engrams
 *   2. Delete expired staging engrams
 *   3. Prune weakest edges when per-engram cap exceeded
 *   4. Decay unused association weights over time
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { AgentConfig } from '../types/agent.js';
import { decayAssociation } from '../core/hebbian.js';

export class EvictionEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Check capacity budgets and evict if needed.
   * Returns count of evicted engrams.
   */
  enforceCapacity(agentId: string, config: AgentConfig): { evicted: number; edgesPruned: number } {
    let evicted = 0;
    let edgesPruned = 0;

    // Active engram budget
    const activeCount = this.store.getActiveCount(agentId);
    if (activeCount > config.maxActiveEngrams) {
      const excess = activeCount - config.maxActiveEngrams;
      const candidates = this.store.getEvictionCandidates(agentId, excess);
      for (const engram of candidates) {
        this.store.updateStage(engram.id, 'archived');
        evicted++;
      }
    }

    // Staging budget
    const stagingCount = this.store.getStagingCount(agentId);
    if (stagingCount > config.maxStagingEngrams) {
      const expired = this.store.getExpiredStaging();
      for (const engram of expired) {
        this.store.deleteEngram(engram.id);
        evicted++;
      }
    }

    // Edge pruning — cap per engram
    const engrams = this.store.getEngramsByAgent(agentId, 'active');
    for (const engram of engrams) {
      const edgeCount = this.store.countAssociationsFor(engram.id);
      if (edgeCount > config.maxEdgesPerEngram) {
        // Remove weakest edges until under cap
        let toRemove = edgeCount - config.maxEdgesPerEngram;
        while (toRemove > 0) {
          const weakest = this.store.getWeakestAssociation(engram.id);
          if (weakest) {
            this.store.deleteAssociation(weakest.id);
            edgesPruned++;
          }
          toRemove--;
        }
      }
    }

    return { evicted, edgesPruned };
  }

  /**
   * Decay all association weights based on time since last activation.
   * Run periodically (e.g., daily).
   */
  decayEdges(agentId: string, halfLifeDays: number = 7): number {
    const associations = this.store.getAllAssociations(agentId);
    let decayed = 0;

    for (const assoc of associations) {
      const daysSince = (Date.now() - assoc.lastActivated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 0.5) continue; // Skip recently activated

      const newWeight = decayAssociation(assoc.weight, daysSince, halfLifeDays);
      if (newWeight < 0.01) {
        // Below minimum useful weight — prune
        this.store.deleteAssociation(assoc.id);
        decayed++;
      } else if (Math.abs(newWeight - assoc.weight) > 0.001) {
        this.store.upsertAssociation(
          assoc.fromEngramId, assoc.toEngramId, newWeight, assoc.type, assoc.confidence
        );
        decayed++;
      }
    }

    return decayed;
  }
}
