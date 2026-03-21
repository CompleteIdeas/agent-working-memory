// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Evaluation types — measuring whether memory actually helps.
 *
 * Four measurement dimensions:
 *   1. Retrieval quality (precision, recall, latency)
 *   2. Connection quality (edge utility, stability)
 *   3. Staging accuracy (promotion precision, discard regret)
 *   4. Task impact (with/without memory comparison)
 */

/**
 * Single activation event record — logged for offline analysis.
 */
export interface ActivationEvent {
  id: string;
  agentId: string;
  timestamp: Date;
  context: string;
  resultsReturned: number;
  topScore: number;
  latencyMs: number;
  engramIds: string[];
  feedback?: RetrievalFeedbackEvent[];
}

export interface RetrievalFeedbackEvent {
  engramId: string;
  useful: boolean;
  timestamp: Date;
}

/**
 * Staging lifecycle event — tracks promote/discard decisions.
 */
export interface StagingEvent {
  engramId: string;
  agentId: string;
  action: 'promoted' | 'discarded' | 'expired';
  resonanceScore: number | null;
  timestamp: Date;
  ageMs: number;  // How long it lived in staging
}

/**
 * Aggregate metrics snapshot — computed periodically.
 */
export interface EvalMetrics {
  agentId: string;
  timestamp: Date;
  window: string;  // e.g., "24h", "7d"

  // Retrieval quality
  activationCount: number;
  avgPrecisionAtK: number;    // Of returned results, % judged useful
  avgLatencyMs: number;
  p95LatencyMs: number;

  // Connection quality
  totalEdges: number;
  edgesUsedInActivation: number;
  edgeUtilityRate: number;    // % of edges that contributed to retrieval
  avgEdgeSurvivalDays: number;

  // Staging accuracy
  totalStaged: number;
  promotedCount: number;
  discardedCount: number;
  promotionPrecision: number; // % of promoted items later used
  discardRegret: number;      // % of discarded items agent re-introduced

  // Memory health
  activeEngramCount: number;
  stagingEngramCount: number;
  retractedCount: number;
  consolidatedCount: number;
  avgConfidence: number;

  // Contamination tracking
  staleUsageCount: number;        // Activations using outdated engrams
  retractionRate: number;         // Rate of memories being invalidated
}

/**
 * Task trial — for with/without memory comparison.
 */
export interface TaskTrial {
  id: string;
  agentId: string;
  taskDescription: string;
  memoryEnabled: boolean;
  startedAt: Date;
  completedAt: Date | null;
  success: boolean | null;
  stepsToCompletion: number;
  errorsEncountered: number;
  memoriesActivated: number;
  userCorrections: number;
}
