// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Agent — a consciousness boundary.
 * Each agent has its own isolated memory space with capacity budgets.
 */

export interface Agent {
  id: string;
  name: string;
  createdAt: Date;
  config: AgentConfig;
}

export interface AgentConfig {
  // Salience filter thresholds
  salienceThreshold: number;       // Below this → discard
  stagingThreshold: number;        // Below salience but above this → staging buffer
  stagingTtlMs: number;            // Default TTL for staging entries

  // Capacity budgets (eviction triggers when exceeded)
  maxActiveEngrams: number;        // Hard cap on active memory
  maxStagingEngrams: number;       // Hard cap on staging buffer
  maxEdgesPerEngram: number;       // Prevent graph explosion

  // Activation pipeline tuning
  activationLimit: number;         // Max results per activation query
  hebbianRate: number;             // Learning rate for association strengthening
  decayExponent: number;           // ACT-R d parameter (default 0.5)
  edgeDecayHalfLifeDays: number;   // How fast unused edges weaken

  // Connection engine
  connectionThreshold: number;     // Min resonance score to form a connection
  connectionCheckIntervalMs: number;

  // Consolidation
  consolidationIntervalMs: number; // How often to check for merge candidates
  consolidationSimilarity: number; // Threshold for merging similar engrams

  // Confidence updates
  feedbackPositiveBoost: number;   // How much positive feedback increases confidence
  feedbackNegativePenalty: number; // How much negative feedback decreases confidence
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  salienceThreshold: 0.4,
  stagingThreshold: 0.2,
  stagingTtlMs: 24 * 60 * 60 * 1000,       // 24 hours

  maxActiveEngrams: 10_000,
  maxStagingEngrams: 1_000,
  maxEdgesPerEngram: 20,

  activationLimit: 10,
  hebbianRate: 0.25,
  decayExponent: 0.5,
  edgeDecayHalfLifeDays: 7,

  connectionThreshold: 0.7,
  connectionCheckIntervalMs: 60_000,

  consolidationIntervalMs: 300_000,          // 5 minutes
  consolidationSimilarity: 0.85,

  feedbackPositiveBoost: 0.05,
  feedbackNegativePenalty: 0.1,
};
