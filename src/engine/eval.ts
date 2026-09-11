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

import type { IEngramStore as EngramStore } from '../storage/store.js';
import type { EvalMetrics } from '../types/index.js';

export class EvalEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Compute aggregate metrics for an agent over a time window.
   */
  async computeMetrics(agentId: string, windowHours: number = 24): Promise<EvalMetrics> {
    const window = windowHours <= 24 ? '24h' : `${Math.round(windowHours / 24)}d`;

    // Retrieval quality
    const precision = await this.store.getRetrievalPrecision(agentId, windowHours);

    // Staging accuracy
    const stagingMetrics = await this.store.getStagingMetrics(agentId);
    const totalStaged = stagingMetrics.promoted + stagingMetrics.discarded + stagingMetrics.expired;
    const promotionPrecision = totalStaged > 0 ? stagingMetrics.promoted / totalStaged : 0;

    // Memory health
    const activeEngrams = await this.store.getEngramsByAgent(agentId, 'active');
    const stagingEngrams = await this.store.getEngramsByAgent(agentId, 'staging');
    const retractedEngrams = (await this.store.getEngramsByAgent(agentId, undefined, true))
      .filter(e => e.retracted);
    const allAssociations = await this.store.getAllAssociations(agentId);

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
    const activationStats = await this.store.getActivationStats(agentId, windowHours);

    // Consolidated count
    const consolidatedCount = await this.store.getConsolidatedCount(agentId);

    return {
      agentId,
      timestamp: new Date(),
      window,

      activationCount: activationStats.count,
      avgPrecisionAtK: precision,
      avgLatencyMs: activationStats.avgLatencyMs,
      p50LatencyMs: activationStats.p50LatencyMs,
      p90LatencyMs: activationStats.p90LatencyMs,
      p95LatencyMs: activationStats.p95LatencyMs,

      totalEdges: allAssociations.length,
      edgesUsedInActivation: usedEdges.length,
      edgeUtilityRate: edgeUtility,
      avgEdgeSurvivalDays: avgSurvival,

      totalStaged: totalStaged,
      promotedCount: stagingMetrics.promoted,
      discardedCount: stagingMetrics.discarded,
      promotionPrecision,
      // D12 (2026-07-30): discarded writes persist as 'low-salience'-tagged
      // engrams (confidence 0.25). Regret = the filter demoted something the
      // agent later actually needed — measured as low-salience engrams that
      // were subsequently accessed at least once.
      discardRegret: activeEngrams.filter(e =>
        e.tags.includes('low-salience') && e.accessCount > 0).length,

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

  /**
   * 0.14.3: outcome-shaped usage numbers for memory_stats. Each of these can
   * move in BOTH directions, unlike edge utility. Cheap: one pass over the
   * agent's engrams plus two count queries.
   */
  async computeUsage(agentId: string): Promise<UsageMetrics> {
    const active = await this.store.getEngramsByAgent(agentId, 'active');
    const since30 = new Date(Date.now() - 30 * 24 * 3600_000);
    const writes30d = active.filter(e => e.createdAt >= since30).length;
    const neverRecalled = active.filter(e => e.accessCount === 0).length;
    const act30 = await this.store.getActivationStats(agentId, 30 * 24);
    const fb = await this.store.getLinkedFeedbackStats(agentId, 7 * 24);
    return {
      writes30d,
      recalls30d: act30.count,
      recallsPerWrite30d: writes30d > 0 ? act30.count / writes30d : 0,
      neverRecalledShare: active.length > 0 ? neverRecalled / active.length : 0,
      feedbackLinked7d: fb.total,
      usefulShare7d: fb.total > 0 ? fb.useful / fb.total : 0,
    };
  }
}

export interface UsageMetrics {
  writes30d: number;
  recalls30d: number;
  recallsPerWrite30d: number;
  neverRecalledShare: number;
  /** feedback rows in the window that carry an activation_event_id (0.14.3+) */
  feedbackLinked7d: number;
  usefulShare7d: number;
}
