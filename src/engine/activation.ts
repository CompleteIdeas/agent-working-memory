// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Activation Pipeline — the core retrieval engine.
 *
 * 10-phase cognitive retrieval pipeline:
 *   0. Query expansion (flan-t5-small synonym generation)
 *   1. Vector embedding (MiniLM 384d)
 *   2. Parallel retrieval (FTS5/BM25 + vector pool)
 *   3. Scoring (BM25, Jaccard, z-score vector, entity-bridge boost)
 *   4. Rocchio pseudo-relevance feedback (expand + re-search BM25)
 *   5. ACT-R temporal decay
 *   6. Hebbian boost (co-activation strength)
 *   7. Composite scoring with confidence gating
 *   8. Beam search graph walk (depth 2, hop penalty)
 *   9. Cross-encoder reranking (ms-marco-MiniLM, adaptive blend)
 *  10. Abstention gate
 *
 * Logs activation events for eval metrics.
 */

import { randomUUID } from 'node:crypto';
import { baseLevelActivation, softplus } from '../core/decay.js';
import { strengthenAssociation, CoActivationBuffer } from '../core/hebbian.js';
import { embed, cosineSimilarity } from '../core/embeddings.js';
import { rerank } from '../core/reranker.js';
import { expandQuery } from '../core/query-expander.js';
import type {
  Engram, ActivationResult, ActivationQuery, Association, PhaseScores,
} from '../types/index.js';
import type { EngramStore } from '../storage/sqlite.js';

/**
 * Common English stopwords — filtered from similarity calculations.
 * These words carry no semantic signal for memory retrieval.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'that',
  'this', 'with', 'they', 'will', 'each', 'make', 'like', 'then', 'than',
  'them', 'some', 'what', 'when', 'where', 'which', 'who', 'how', 'use',
  'into', 'does', 'also', 'just', 'more', 'over', 'such', 'only', 'very',
  'about', 'after', 'being', 'between', 'could', 'during', 'before',
  'should', 'would', 'their', 'there', 'these', 'those', 'through',
  'because', 'using', 'other',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * Jaccard similarity between two word sets: |intersection| / |union|
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export class ActivationEngine {
  private store: EngramStore;
  private coActivationBuffer: CoActivationBuffer;

  constructor(store: EngramStore) {
    this.store = store;
    this.coActivationBuffer = new CoActivationBuffer(50);
  }

  /**
   * Activate — retrieve the most cognitively relevant engrams for a context.
   */
  async activate(query: ActivationQuery): Promise<ActivationResult[]> {
    const startTime = performance.now();
    const limit = query.limit ?? 10;
    const minScore = query.minScore ?? 0.01; // Default: filter out zero-relevance results
    const useReranker = query.useReranker ?? true;
    const useExpansion = query.useExpansion ?? true;
    const abstentionThreshold = query.abstentionThreshold ?? 0;

    // Phase 0: Query expansion — add related terms to improve BM25 recall
    let searchContext = query.context;
    if (useExpansion) {
      try {
        searchContext = await expandQuery(query.context);
      } catch {
        // Expansion unavailable — use original query
      }
    }

    // Phase 1: Embed original query for vector similarity (original, not expanded)
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embed(query.context);
    } catch {
      // Embedding unavailable — fall back to text-only matching
    }

    // Phase 2: Parallel retrieval — BM25 with rank scores + all active engrams
    // Use expanded query for BM25 (more terms = better keyword recall)
    const bm25Ranked = this.store.searchBM25WithRank(query.agentId, searchContext, limit * 3);
    const bm25ScoreMap = new Map(bm25Ranked.map(r => [r.engram.id, r.bm25Score]));

    const allActive = this.store.getEngramsByAgent(
      query.agentId,
      query.includeStaging ? undefined : 'active',
      query.includeRetracted ?? false
    );

    // Merge candidates (deduplicate)
    const candidateMap = new Map<string, Engram>();
    for (const r of bm25Ranked) candidateMap.set(r.engram.id, r.engram);
    for (const e of allActive) candidateMap.set(e.id, e);
    const candidates = Array.from(candidateMap.values());

    if (candidates.length === 0) return [];

    // Tokenize query once
    const queryTokens = tokenize(query.context);

    // Phase 3a: Compute raw cosine similarities for adaptive normalization
    const rawCosineSims = new Map<string, number>();
    if (queryEmbedding) {
      for (const engram of candidates) {
        if (engram.embedding) {
          rawCosineSims.set(engram.id, cosineSimilarity(queryEmbedding, engram.embedding));
        }
      }
    }

    // Compute distribution stats for model-agnostic normalization
    const simValues = Array.from(rawCosineSims.values());
    const simMean = simValues.length > 0
      ? simValues.reduce((a, b) => a + b, 0) / simValues.length : 0;
    const rawStdDev = simValues.length > 1
      ? Math.sqrt(simValues.reduce((sum, s) => sum + (s - simMean) ** 2, 0) / simValues.length) : 0.15;
    // Floor stddev at 0.10 to prevent z-score inflation with small candidate pools
    const simStdDev = Math.max(rawStdDev, 0.10);

    // Phase 3b: Score each candidate with per-phase breakdown
    const scored = candidates.map(engram => {
      const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const associations = this.store.getAssociationsFor(engram.id);

      // --- Text relevance (keyword signals) ---

      // Signal 1: BM25 continuous score (0-1, from FTS5 rank)
      const bm25Score = bm25ScoreMap.get(engram.id) ?? 0;

      // Signal 2: Jaccard similarity with stopword filtering
      const conceptTokens = tokenize(engram.concept);
      const contentTokens = tokenize(engram.content);
      const conceptJaccard = jaccard(queryTokens, conceptTokens);
      const contentJaccard = jaccard(queryTokens, contentTokens);
      const jaccardScore = 0.6 * conceptJaccard + 0.4 * contentJaccard;

      // Signal 3: Concept exact match bonus (up to 0.3)
      const conceptOverlap = conceptTokens.size > 0
        ? [...conceptTokens].filter(w => queryTokens.has(w)).length / conceptTokens.size
        : 0;
      const conceptBonus = conceptOverlap * 0.3;

      const keywordMatch = Math.min(Math.max(bm25Score, jaccardScore) + conceptBonus, 1.0);

      // --- Vector similarity (semantic signal) ---
      // Two-stage: absolute floor prevents noise, then z-score ranks within matches.
      // Stage 1: Raw cosine must exceed mean + 1 stddev (absolute relevance gate)
      // Stage 2: Z-score maps relative position to 0-1 for ranking quality
      let vectorMatch = 0;
      const rawSim = rawCosineSims.get(engram.id);
      if (rawSim !== undefined) {
        const zScore = (rawSim - simMean) / simStdDev;
        // Gate: must be at least 1 stddev above mean to be considered a match
        if (zScore > 1.0) {
          // Map z=1..3 → 0..1 linearly
          vectorMatch = Math.min(1, (zScore - 1.0) / 2.0);
        }
      }

      // Combined text match: best of keyword and vector signals
      const textMatch = Math.max(keywordMatch, vectorMatch);

      // --- Temporal signals ---

      // ACT-R decay — confidence-modulated
      // High-confidence memories (confirmed useful via feedback) decay slower.
      // Default exponent: 0.5. At confidence 0.8+: 0.3 (much slower decay).
      const decayExponent = 0.5 - 0.2 * Math.max(0, (engram.confidence - 0.5) / 0.5);
      const decayScore = baseLevelActivation(engram.accessCount, ageDays, decayExponent);

      // Hebbian boost from associations — capped to prevent popular memories
      // from dominating regardless of query relevance
      const rawHebbian = associations.length > 0
        ? associations.reduce((sum, a) => sum + a.weight, 0) / associations.length
        : 0;
      const hebbianBoost = Math.min(rawHebbian, 0.5);

      // Centrality signal — well-connected memories (high weighted degree)
      // get a small boost. This makes consolidation edges matter for retrieval.
      // Log-scaled to prevent hub domination: 10 edges ≈ 0.05 boost, 50 ≈ 0.08
      const weightedDegree = associations.reduce((sum, a) => sum + a.weight, 0);
      const centralityBoost = associations.length > 0
        ? Math.min(0.1, 0.03 * Math.log1p(weightedDegree))
        : 0;

      // Confidence gate — multiplicative quality signal
      const confidenceGate = engram.confidence;

      // Feedback bonus — memories confirmed useful via explicit feedback get a
      // direct additive boost. Models how a senior dev "just knows" certain things
      // are important. Confidence > 0.6 means at least 2+ positive feedbacks.
      // Scales: conf 0.6→0.03, 0.7→0.06, 0.8→0.09, 1.0→0.15
      const feedbackBonus = engram.confidence > 0.55
        ? Math.min(0.15, 0.3 * Math.max(0, engram.confidence - 0.5))
        : 0;

      // --- Composite score: relevance-gated additive ---
      // Text relevance must be present for temporal signals to contribute.
      // Without text relevance, a memory shouldn't activate regardless of recency.
      // Temporal contribution scales with text relevance (weak match = weak temporal boost).
      const temporalNorm = Math.min(softplus(decayScore + hebbianBoost), 3.0) / 3.0;
      const relevanceGate = textMatch > 0.1 ? textMatch : 0.0; // Proportional gate
      const composite = (0.6 * textMatch + 0.4 * temporalNorm * relevanceGate + centralityBoost * relevanceGate + feedbackBonus * relevanceGate) * confidenceGate;

      const phaseScores: PhaseScores = {
        textMatch,
        vectorMatch,
        decayScore,
        hebbianBoost,
        graphBoost: 0, // Filled in phase 5
        confidenceGate,
        composite,
        rerankerScore: 0, // Filled in phase 7
      };

      return { engram, score: composite, phaseScores, associations };
    });

    // Phase 3.5: Rocchio pseudo-relevance feedback — expand query with top result terms
    // then re-search BM25 to find candidates that keyword search missed
    const preSorted = scored.sort((a, b) => b.score - a.score);
    const topForFeedback = preSorted.slice(0, 3).filter(r => r.phaseScores.textMatch > 0.1);
    if (topForFeedback.length > 0) {
      const feedbackTerms = new Set<string>();
      for (const item of topForFeedback) {
        const tokens = tokenize(item.engram.content);
        for (const t of tokens) {
          if (!queryTokens.has(t) && t.length >= 4) feedbackTerms.add(t);
        }
      }
      // Take top 5 feedback terms and re-search
      const extraTerms = Array.from(feedbackTerms).slice(0, 5).join(' ');
      if (extraTerms) {
        const feedbackBM25 = this.store.searchBM25WithRank(query.agentId, `${searchContext} ${extraTerms}`, limit * 2);
        for (const r of feedbackBM25) {
          if (!candidateMap.has(r.engram.id)) {
            candidateMap.set(r.engram.id, r.engram);
            // Score the new candidate
            const engram = r.engram;
            const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
            const associations = this.store.getAssociationsFor(engram.id);
            const cTokens = tokenize(engram.concept);
            const ctTokens = tokenize(engram.content);
            const cJac = jaccard(queryTokens, cTokens);
            const ctJac = jaccard(queryTokens, ctTokens);
            const jSc = 0.6 * cJac + 0.4 * ctJac;
            const cOvlp = cTokens.size > 0 ? [...cTokens].filter(w => queryTokens.has(w)).length / cTokens.size : 0;
            const km = Math.min(Math.max(r.bm25Score, jSc) + cOvlp * 0.3, 1.0);
            let vm = 0;
            const rs = rawCosineSims.get(engram.id) ?? (queryEmbedding && engram.embedding ? cosineSimilarity(queryEmbedding, engram.embedding) : 0);
            if (rs) {
              const z = (rs - simMean) / simStdDev;
              if (z > 1.0) vm = Math.min(1, (z - 1.0) / 2.0);
            }
            const tm = Math.max(km, vm);
            const ds = baseLevelActivation(engram.accessCount, ageDays);
            const rh = associations.length > 0 ? Math.min(associations.reduce((s, a) => s + a.weight, 0) / associations.length, 0.5) : 0;
            const tn = Math.min(softplus(ds + rh), 3.0) / 3.0;
            const rg = tm > 0.1 ? tm : 0.0;
            const comp = (0.6 * tm + 0.4 * tn * rg) * engram.confidence;
            scored.push({ engram, score: comp, phaseScores: { textMatch: tm, vectorMatch: vm, decayScore: ds, hebbianBoost: rh, graphBoost: 0, confidenceGate: engram.confidence, composite: comp, rerankerScore: 0 }, associations });
          }
        }
      }
    }

    // Phase 3.7: Entity-Bridge boost — boost scored candidates that share entity tags
    // with the most query-relevant result. Only bridge from the single best text-match
    // to avoid pulling in unrelated entities from tangentially-matching results.
    {
      // Find the result with the highest textMatch (most query-relevant, not just highest score)
      // Gate: only bridge when anchor has meaningful text relevance (> 0.15)
      // Adaptive: scale bridge boost inversely with candidate pool size to prevent
      // over-boosting in large memory pools where many items share entity tags
      const sortedByTextMatch = scored
        .filter(r => r.phaseScores.textMatch > 0.15)
        .sort((a, b) => b.phaseScores.textMatch - a.phaseScores.textMatch);

      // Bridge from top 2 text-matched results (IDF handles weighting)
      const bridgeAnchors = sortedByTextMatch.slice(0, 2);

      if (bridgeAnchors.length > 0) {
        const entityTags = new Set<string>();
        const anchorIds = new Set(bridgeAnchors.map(r => r.engram.id));

        for (const item of bridgeAnchors) {
          for (const tag of item.engram.tags) {
            const t = tag.toLowerCase();
            // Skip non-entity tags: turn IDs, session tags, dialogue IDs, generic speaker labels
            if (/^t\d+$/.test(t) || t.startsWith('session-') || t.startsWith('dia_') || t.length < 3) continue;
            if (/^speaker\d*$/.test(t)) continue; // Generic speaker labels are too broad
            entityTags.add(t);
          }
        }

        // Document frequency filter: remove tags appearing in >30% of items (too common)
        // This prevents speaker names in 2-person conversations from being used as bridges
        if (entityTags.size > 0 && scored.length > 10) {
          const tagFreqs = new Map<string, number>();
          for (const item of scored) {
            const seen = new Set<string>();
            for (const tag of item.engram.tags) {
              const t = tag.toLowerCase();
              if (entityTags.has(t) && !seen.has(t)) {
                seen.add(t);
                tagFreqs.set(t, (tagFreqs.get(t) ?? 0) + 1);
              }
            }
          }
          const maxFreq = scored.length * 0.30;
          for (const [tag, freq] of tagFreqs) {
            if (freq > maxFreq) entityTags.delete(tag);
          }
        }

        if (entityTags.size > 0) {
          for (const item of scored) {
            if (anchorIds.has(item.engram.id)) continue;

            const engramTags = new Set(item.engram.tags.map((t: string) => t.toLowerCase()));
            let sharedEntities = 0;
            for (const et of entityTags) {
              if (engramTags.has(et)) sharedEntities++;
            }

            if (sharedEntities > 0) {
              // Flat bridge boost per shared entity
              const bridgeBoost = Math.min(sharedEntities * 0.15, 0.4);
              item.score += bridgeBoost;
              item.phaseScores.composite += bridgeBoost;
              item.phaseScores.graphBoost += bridgeBoost;
            }
          }
        }
      }
    }

    // Phase 4+5: Graph walk — boost engrams connected to high-scoring ones
    // Only walk from engrams that had text relevance (composite > 0 pre-walk)
    const sorted = scored.sort((a, b) => b.score - a.score);
    const topN = sorted.slice(0, limit * 3);
    this.graphWalk(topN, 2, 0.3);

    // Phase 6: Initial filter and sort for re-ranking pool
    const pool = topN
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score);

    // Phase 7: Cross-encoder re-ranking — scores (query, passage) pairs directly
    // Widens the pool to find relevant results that keyword matching missed
    const rerankPool = pool.slice(0, Math.max(limit * 3, 30));

    if (useReranker && rerankPool.length > 0) {
      try {
        const passages = rerankPool.map(r =>
          `${r.engram.concept}: ${r.engram.content}`
        );
        const rerankResults = await rerank(query.context, passages);

        // Adaptive reranker blend (Codex recommendation):
        // When BM25/text signals are strong, trust them more; when weak, lean on reranker.
        const bm25Max = Math.max(...rerankPool.map(r => r.phaseScores.textMatch));
        const rerankWeight = Math.min(0.7, Math.max(0.3, 0.3 + 0.4 * (1 - bm25Max)));
        const compositeWeight = 1 - rerankWeight;

        for (const rr of rerankResults) {
          const item = rerankPool[rr.index];
          item.phaseScores.rerankerScore = rr.score;
          item.score = compositeWeight * item.phaseScores.composite + rerankWeight * rr.score;
        }
      } catch {
        // Re-ranker unavailable — keep original scores
      }
    }

    // Phase 8a: Semantic drift penalty — if no candidate has meaningful vector match
    // (none exceeded 1 stddev above mean), the query is likely off-topic.
    if (queryEmbedding && rerankPool.length > 0) {
      const maxVectorSim = Math.max(...rerankPool.map(r => r.phaseScores.vectorMatch));
      if (maxVectorSim < 0.05) {
        // Query is semantically distant from everything — apply drift penalty
        for (const item of rerankPool) {
          item.score *= 0.5;
        }
      }
    }

    // Phase 8b: Entropy gating — if top-5 reranker scores are flat (low variance),
    // the reranker can't distinguish relevant from irrelevant. Abstain.
    if (abstentionThreshold > 0 && rerankPool.length >= 3) {
      const topRerankerScores = rerankPool
        .map(r => r.phaseScores.rerankerScore)
        .sort((a, b) => b - a)
        .slice(0, 5);
      const maxScore = topRerankerScores[0];
      const meanScore = topRerankerScores.reduce((s, v) => s + v, 0) / topRerankerScores.length;
      const variance = topRerankerScores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / topRerankerScores.length;

      // Abstain if: top score below threshold OR scores are flat (low discrimination)
      if (maxScore < abstentionThreshold || (maxScore < 0.5 && variance < 0.01)) {
        return [];
      }
    }

    // Phase 8c: Supersession penalty — superseded memories are deprioritized.
    // They aren't wrong (that's retraction), just outdated.
    for (const item of rerankPool) {
      if (item.engram.supersededBy) {
        item.score *= 0.15; // Severe down-rank — successor should dominate
      }
    }

    // Phase 9: Final sort, limit, explain
    const results: ActivationResult[] = rerankPool
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => ({
        engram: r.engram,
        score: r.score,
        phaseScores: r.phaseScores,
        why: this.explain(r.phaseScores, r.engram, r.associations),
        associations: r.associations,
      }));

    const activatedIds = results.map(r => r.engram.id);

    // Side effects: touch, co-activate, Hebbian update (skip for internal/system calls)
    if (!query.internal) {
      for (const id of activatedIds) {
        this.store.touchEngram(id);
      }
      this.coActivationBuffer.pushBatch(activatedIds);
      this.updateHebbianWeights();

      // Log activation event for eval
      const latencyMs = performance.now() - startTime;
      this.store.logActivationEvent({
        id: randomUUID(),
        agentId: query.agentId,
        timestamp: new Date(),
        context: query.context,
        resultsReturned: results.length,
        topScore: results.length > 0 ? results[0].score : 0,
        latencyMs,
        engramIds: activatedIds,
      });
    }

    return results;
  }

  /**
   * Beam search graph walk — replaces naive BFS.
   * Scores paths (not just nodes), uses query-dependent edge filtering,
   * and supports deeper exploration with focused beams.
   */
  private graphWalk(
    scored: { engram: Engram; score: number; phaseScores: PhaseScores; associations: Association[] }[],
    maxDepth: number,
    hopPenalty: number
  ): void {
    const scoreMap = new Map(scored.map(s => [s.engram.id, s]));
    const MAX_TOTAL_BOOST = 0.25; // Slightly higher cap for beam search (deeper paths earn it)
    const BEAM_WIDTH = 15;

    // Seed the beam with high-scoring, text-relevant items
    const beam = scored
      .filter(item => item.phaseScores.textMatch >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, BEAM_WIDTH);

    // Track which engrams have been explored (avoid cycles)
    const explored = new Set<string>();

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextBeam: typeof beam = [];

      for (const item of beam) {
        if (explored.has(item.engram.id)) continue;
        explored.add(item.engram.id);

        // Get associations — for depth > 0, fetch from store if not in scored set
        const associations = item.associations.length > 0
          ? item.associations
          : this.store.getAssociationsFor(item.engram.id);

        for (const assoc of associations) {
          const neighborId = assoc.fromEngramId === item.engram.id
            ? assoc.toEngramId
            : assoc.fromEngramId;

          if (explored.has(neighborId)) continue;

          const neighbor = scoreMap.get(neighborId);
          if (!neighbor) continue;

          // Query-dependent edge filtering: neighbor must have SOME relevance
          // (textMatch > 0.05 for deeper hops, relaxed from 0.1)
          const relevanceFloor = depth === 0 ? 0.1 : 0.05;
          if (neighbor.phaseScores.textMatch < relevanceFloor) continue;

          // Skip if neighbor already at boost cap
          if (neighbor.phaseScores.graphBoost >= MAX_TOTAL_BOOST) continue;

          // Path score: source score * edge weight * hop penalty^(depth+1)
          const normalizedWeight = Math.min(assoc.weight, 5.0) / 5.0;
          const pathScore = item.score * normalizedWeight * Math.pow(hopPenalty, depth + 1);

          const boost = Math.min(pathScore, 0.15, MAX_TOTAL_BOOST - neighbor.phaseScores.graphBoost);
          if (boost > 0.001) {
            neighbor.score += boost;
            neighbor.phaseScores.graphBoost += boost;
            nextBeam.push(neighbor);
          }
        }
      }

      // Prune beam for next depth level
      if (nextBeam.length === 0) break;
      beam.length = 0;
      beam.push(...nextBeam
        .sort((a, b) => b.score - a.score)
        .slice(0, BEAM_WIDTH)
      );
    }
  }

  private updateHebbianWeights(): void {
    const pairs = this.coActivationBuffer.getCoActivatedPairs(10_000);
    // Deduplicate pairs to prevent repeated strengthening
    const seen = new Set<string>();
    for (const [a, b] of pairs) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = this.store.getAssociation(a, b) ?? this.store.getAssociation(b, a);
      const currentWeight = existing?.weight ?? 0.1;
      const newWeight = strengthenAssociation(currentWeight);
      this.store.upsertAssociation(a, b, newWeight, 'hebbian');
      this.store.upsertAssociation(b, a, newWeight, 'hebbian');
    }
  }

  private explain(phases: PhaseScores, engram: Engram, associations: Association[]): string {
    const parts: string[] = [];
    parts.push(`composite=${phases.composite.toFixed(3)}`);
    if (phases.textMatch > 0) parts.push(`text=${phases.textMatch.toFixed(2)}`);
    if (phases.vectorMatch > 0) parts.push(`vector=${phases.vectorMatch.toFixed(2)}`);
    parts.push(`decay=${phases.decayScore.toFixed(2)}`);
    if (phases.hebbianBoost > 0) parts.push(`hebbian=${phases.hebbianBoost.toFixed(2)}`);
    if (phases.graphBoost > 0) parts.push(`graph=${phases.graphBoost.toFixed(2)}`);
    if (phases.rerankerScore > 0) parts.push(`reranker=${phases.rerankerScore.toFixed(2)}`);
    parts.push(`conf=${phases.confidenceGate.toFixed(2)}`);
    parts.push(`access=${engram.accessCount}`);
    if (associations.length > 0) parts.push(`edges=${associations.length}`);
    return parts.join(' | ');
  }
}
