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

    // Quadratic dampening (1 - topScore²) so mid-range matches don't kill novelty.
    // Old curve was linear (1 - topScore) which floored at 0.1 for almost any match
    // in a populated DB, killing the salience signal.
    // Curve comparison (topScore → novelty):
    //   0.30 → 0.91 (different topic — strong novelty)
    //   0.60 → 0.64 (loosely related — partial credit)
    //   0.80 → 0.36 (related but distinct — meaningful signal)
    //   0.95 → 0.10 (near-dupe — still suppress)
    const baseNovelty = 1.0 - topScore * topScore;

    // Concept penalty scoped to recent matches only — re-using the same concept
    // string for a NEW topic months later shouldn't be punished. Penalty was 0.4
    // (too harsh); now 0.3 and only applies if any matched result is < 30 days old.
    const conceptLower = conceptStr.toLowerCase().trim();
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const exactConceptRecent = results.some(r => {
      if (r.engram?.concept?.toLowerCase().trim() !== conceptLower) return false;
      const created = r.engram?.createdAt as Date | string | number | undefined;
      if (!created) return true; // No timestamp — treat as recent (conservative)
      const createdMs = created instanceof Date
        ? created.getTime()
        : typeof created === 'number' ? created : Date.parse(created);
      return Number.isFinite(createdMs) && createdMs >= cutoffMs;
    });
    const conceptPenalty = exactConceptRecent ? 0.3 : 0;

    // Floor lowered to 0.05 (was 0.10) so true duplicates can score near-zero
    // and clearly stay below stagingThreshold (0.2). Ceiling unchanged.
    return Math.max(0.05, Math.min(0.95, baseNovelty - conceptPenalty));
  } catch {
    // If BM25 search fails (e.g., FTS not ready), assume novel
    return 0.8;
  }
}

/**
 * Result from novelty computation with match info for reinforcement.
 */
export interface NoveltyResult {
  novelty: number;
  matchedEngramId: string | null;
  matchScore: number;
}

/**
 * Compute novelty score AND return the best matching engram (for reinforcement-on-duplicate).
 * Uses BM25 (synchronous, fast) to find the closest existing memory.
 * Optionally checks workspace-scoped memories too (cross-agent dedup).
 */
export function computeNoveltyWithMatch(
  store: EngramStore, agentId: string, concept: string, content: string,
  workspace?: string | null
): NoveltyResult {
  try {
    const contentStr = typeof content === 'string' ? content : '';
    const conceptStr = typeof concept === 'string' ? concept : '';
    const searchText = `${conceptStr} ${contentStr.slice(0, 100)}`;

    // Agent-scoped search (limit:3 to avoid single shallow match suppressing novelty)
    const results = store.searchBM25WithRank(agentId, searchText, 3);

    // Workspace search — only if the store supports it (v0.5.4+)
    let wsResults: { engram: { id: string }; bm25Score: number }[] = [];
    if (workspace && typeof (store as any).searchBM25WithRankWorkspace === 'function') {
      wsResults = (store as any).searchBM25WithRankWorkspace(agentId, searchText, 3, workspace);
    }

    const allResults = [...results, ...wsResults];
    if (allResults.length === 0) return { novelty: 1.0, matchedEngramId: null, matchScore: 0 };

    allResults.sort((a, b) => b.bm25Score - a.bm25Score);
    const top = allResults[0];
    const topScore = top.bm25Score;

    // Quadratic dampening — see computeNovelty for curve rationale
    const baseNovelty = 1.0 - topScore * topScore;

    // Recent-only concept penalty (30d window)
    const conceptLower = conceptStr.toLowerCase().trim();
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const exactConceptRecent = allResults.some(r => {
      const eng = r.engram as { concept?: string; createdAt?: Date | string | number };
      if (eng?.concept?.toLowerCase().trim() !== conceptLower) return false;
      const created = eng?.createdAt;
      if (!created) return true;
      const createdMs = created instanceof Date
        ? created.getTime()
        : typeof created === 'number' ? created : Date.parse(created);
      return Number.isFinite(createdMs) && createdMs >= cutoffMs;
    });
    const conceptPenalty = exactConceptRecent ? 0.3 : 0;

    const novelty = Math.max(0.05, Math.min(0.95, baseNovelty - conceptPenalty));
    return { novelty, matchedEngramId: top.engram.id, matchScore: topScore };
  } catch {
    return { novelty: 0.8, matchedEngramId: null, matchScore: 0 };
  }
}
