// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Salience Filter — decides what's worth remembering.
 *
 * Codex feedback incorporated:
 *   - Persists raw feature scores for auditability
 *   - Returns reason codes for explainability
 *   - Thresholds are tunable per agent
 *   - Deterministic heuristics first, LLM augmentation optional
 */

import type { SalienceFeatures, MemoryClass } from '../types/index.js';
import type { EngramStore } from '../storage/sqlite.js';

export type SalienceEventType = 'decision' | 'friction' | 'surprise' | 'causal' | 'observation';

export interface SalienceInput {
  content: string;
  eventType?: SalienceEventType;
  surprise?: number;
  decisionMade?: boolean;
  causalDepth?: number;
  resolutionEffort?: number;
  /** 0 = exact duplicate exists, 1 = completely novel. Computed by caller via BM25 similarity check. */
  novelty?: number;
  /** Memory class — canonical memories get salience floor of 0.7 and never stage. */
  memoryClass?: MemoryClass;
}

export interface SalienceResult {
  score: number;
  disposition: 'active' | 'staging' | 'discard';
  features: SalienceFeatures;
  reasonCodes: string[];
}

/**
 * Weights for the salience scoring formula.
 * Novelty is the strongest signal — new information should always be stored.
 * Duplicates get filtered aggressively.
 */
const WEIGHTS = {
  surprise: 0.15,
  decision: 0.15,
  causalDepth: 0.15,
  resolutionEffort: 0.1,
  novelty: 0.45,
};

/**
 * Rule-based salience scorer with full audit trail.
 */
export function evaluateSalience(
  input: SalienceInput,
  activeThreshold: number = 0.4,
  stagingThreshold: number = 0.2
): SalienceResult {
  const features: SalienceFeatures = {
    surprise: input.surprise ?? 0,
    decisionMade: input.decisionMade ?? false,
    causalDepth: input.causalDepth ?? 0,
    resolutionEffort: input.resolutionEffort ?? 0,
    eventType: input.eventType ?? 'observation',
  };

  const reasonCodes: string[] = [];

  // Novelty: 1.0 = completely new info, 0 = exact duplicate exists
  // Default to 0.8 (assume mostly novel) when caller doesn't check
  const novelty = input.novelty ?? 0.8;

  // Score components
  const surpriseScore = WEIGHTS.surprise * features.surprise;
  const decisionScore = WEIGHTS.decision * (features.decisionMade ? 1.0 : 0);
  const causalScore = WEIGHTS.causalDepth * features.causalDepth;
  const effortScore = WEIGHTS.resolutionEffort * features.resolutionEffort;
  const noveltyScore = WEIGHTS.novelty * novelty;

  if (features.surprise > 0.5) reasonCodes.push('high_surprise');
  if (features.decisionMade) reasonCodes.push('decision_point');
  if (features.causalDepth > 0.5) reasonCodes.push('causal_insight');
  if (features.resolutionEffort > 0.5) reasonCodes.push('high_effort_resolution');
  if (novelty > 0.7) reasonCodes.push('novel_information');
  if (novelty < 0.3) reasonCodes.push('redundant_information');

  // Event type bonus
  let typeBonus = 0;
  switch (features.eventType) {
    case 'decision': typeBonus = 0.15; reasonCodes.push('event:decision'); break;
    case 'friction': typeBonus = 0.2; reasonCodes.push('event:friction'); break;
    case 'surprise': typeBonus = 0.25; reasonCodes.push('event:surprise'); break;
    case 'causal': typeBonus = 0.2; reasonCodes.push('event:causal'); break;
    case 'observation': break;
  }

  let score = Math.min(surpriseScore + decisionScore + causalScore + effortScore + noveltyScore + typeBonus, 1.0);

  // Memory class overrides
  const memoryClass = input.memoryClass ?? 'working';

  if (memoryClass === 'canonical') {
    // Canonical memories: salience floor of 0.7, never go to staging
    score = Math.max(score, 0.7);
    reasonCodes.push('class:canonical');
  } else if (memoryClass === 'ephemeral') {
    reasonCodes.push('class:ephemeral');
  }

  let disposition: 'active' | 'staging' | 'discard';
  if (memoryClass === 'canonical') {
    // Canonical always goes active — they represent current truth
    disposition = 'active';
    reasonCodes.push('disposition:active');
  } else if (score >= activeThreshold) {
    disposition = 'active';
    reasonCodes.push('disposition:active');
  } else if (score >= stagingThreshold) {
    disposition = 'staging';
    reasonCodes.push('disposition:staging');
  } else {
    disposition = 'discard';
    reasonCodes.push('disposition:discard');
  }

  return { score, disposition, features, reasonCodes };
}

/**
 * Compute novelty score by checking how similar the content is to existing memories.
 * Uses BM25 (synchronous, fast) to find the closest existing memory.
 *
 * Returns 0..1 where:
 *   1.0 = nothing similar exists (completely novel)
 *   0.0 = near-exact duplicate exists
 *
 * The check is cheap (~1ms) because BM25 is synchronous SQLite FTS5.
 */
export function computeNovelty(store: EngramStore, agentId: string, concept: string, content: string): number {
  try {
    // Search using concept + first 100 chars of content (enough to detect duplicates, fast)
    const contentStr = typeof content === 'string' ? content : '';
    const conceptStr = typeof concept === 'string' ? concept : '';
    const searchText = `${conceptStr} ${contentStr.slice(0, 100)}`;

    const results = store.searchBM25WithRank(agentId, searchText, 5);
    if (results.length === 0) return 1.0; // Nothing similar — fully novel

    // searchBM25WithRank normalizes scores to 0..1 via |rank|/(1+|rank|).
    // Higher score = stronger match = less novel.
    const topScore = results[0].bm25Score;

    // Penalize exact concept string duplicates — if any result has the same concept,
    // heavily reduce novelty to prevent hub toxicity from repeated task_end summaries
    const conceptLower = conceptStr.toLowerCase().trim();
    const exactConceptMatch = results.some(r => r.engram?.concept?.toLowerCase().trim() === conceptLower);
    const conceptPenalty = exactConceptMatch ? 0.4 : 0;

    // Continuous novelty: inversely proportional to BM25 similarity
    // Maps topScore (0..1) → novelty (0.1..0.95) using a smooth curve
    // Floor at 0.1 (never zero — even duplicates might have new context)
    // Ceiling at 0.95 (never 1.0 — always a tiny chance of overlap)
    return Math.max(0.1, Math.min(0.95, 1.0 - topScore - conceptPenalty));
  } catch {
    // If BM25 search fails (e.g., FTS not ready), assume novel
    return 0.8;
  }
}
