// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Evaluation Engine — measures whether memory actually helps.
 *
 * Four dimensions (from Codex):
 *   1. Retrieval quality — precision@k, latency
 *   2. Connection quality — edge utility, stability
 *   3. Staging accuracy — promotion precision, discard regret
 *   4. Memory health — contamination tracking, confidence distribution
 *
 * Task impact (with/without memory) is measured externally via TaskTrial records.
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { EvalMetrics } from '../types/index.js';

export class EvalEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Compute aggregate metrics for an agent over a time window.
   */
  computeMetrics(agentId: string, windowHours: number = 24): EvalMetrics {
    const window = windowHours <= 24 ? '24h' : `${Math.round(windowHours / 24)}d`;

    // Retrieval quality
    const precision = this.store.getRetrievalPrecision(agentId, windowHours);

    // Staging accuracy
    const stagingMetrics = this.store.getStagingMetrics(agentId);
    const totalStaged = stagingMetrics.promoted + stagingMetrics.discarded + stagingMetrics.expired;
    const promotionPrecision = totalStaged > 0 ? stagingMetrics.promoted / totalStaged : 0;

    // Memory health
    const activeEngrams = this.store.getEngramsByAgent(agentId, 'active');
    const stagingEngrams = this.store.getEngramsByAgent(agentId, 'staging');
    const retractedEngrams = this.store.getEngramsByAgent(agentId, undefined, true)
      .filter(e => e.retracted);
    const allAssociations = this.store.getAllAssociations(agentId);

    const avgConfidence = activeEngrams.length > 0
      ? activeEngrams.reduce((sum, e) => sum + e.confidence, 0) / activeEngrams.length
      : 0;

    // Edge utility — % of edges that have been used in activation
    const usedEdges = allAssociations.filter(a => a.activationCount > 0);
    const edgeUtility = allAssociations.length > 0
      ? usedEdges.length / allAssociations.length
      : 0;

    // Edge survival — average age of edges that are still above minimum weight
    const livingEdges = allAssociations.filter(a => a.weight > 0.01);
    const avgSurvival = livingEdges.length > 0
      ? livingEdges.reduce((sum, a) =>
          sum + (Date.now() - a.createdAt.getTime()) / (1000 * 60 * 60 * 24), 0
        ) / livingEdges.length
      : 0;

    // Activation performance stats
    const activationStats = this.store.getActivationStats(agentId, windowHours);

    // Consolidated count
    const consolidatedCount = this.store.getConsolidatedCount(agentId);

    return {
      agentId,
      timestamp: new Date(),
      window,

      activationCount: activationStats.count,
      avgPrecisionAtK: precision,
      avgLatencyMs: activationStats.avgLatencyMs,
      p95LatencyMs: activationStats.p95LatencyMs,

      totalEdges: allAssociations.length,
      edgesUsedInActivation: usedEdges.length,
      edgeUtilityRate: edgeUtility,
      avgEdgeSurvivalDays: avgSurvival,

      totalStaged: totalStaged,
      promotedCount: stagingMetrics.promoted,
      discardedCount: stagingMetrics.discarded,
      promotionPrecision,
      discardRegret: 0, // Requires tracking discarded-then-rediscovered items

      activeEngramCount: activeEngrams.length,
      stagingEngramCount: stagingEngrams.length,
      retractedCount: retractedEngrams.length,
      consolidatedCount,
      avgConfidence,

      staleUsageCount: 0, // Requires per-activation age/confidence tracking
      retractionRate: retractedEngrams.length /
        Math.max(activeEngrams.length + retractedEngrams.length, 1),
    };
  }
}
