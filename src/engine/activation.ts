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
import { strengthenAssociation, CoActivationBuffer, ValidationGatedBuffer } from '../core/hebbian.js';
import { embed, cosineSimilarity } from '../core/embeddings.js';
import { rerank } from '../core/reranker.js';
import { expandQuery } from '../core/query-expander.js';
import type {
  Engram, ActivationResult, ActivationQuery, Association, PhaseScores, QueryMode,
} from '../types/index.js';
import type { EngramStore } from '../storage/sqlite.js';

// ─── Query-adaptive pipeline parameters ───────────────────────────

interface AdaptiveParams {
  mode: 'targeted' | 'exploratory' | 'balanced';
  textWeight: number;       // Weight for text match in composite (default 0.6)
  temporalWeight: number;   // Weight for temporal signals (default 0.4)
  decayExponentBase: number;// Base ACT-R decay exponent (default 0.5)
  zScoreGate: number;       // Z-score threshold for vector match (default 0.5)
  beamWidth: number;        // Graph walk beam width (default 15)
  hopPenalty: number;       // Graph walk hop penalty (default 0.3)
}

const ADAPTIVE_PRESETS: Record<'targeted' | 'exploratory' | 'balanced', AdaptiveParams> = {
  targeted: {
    mode: 'targeted',
    textWeight: 0.75,       // Heavy BM25/keyword emphasis
    temporalWeight: 0.25,
    decayExponentBase: 0.6, // Stronger decay — recent exact matches matter more
    zScoreGate: 0.8,        // Strict vector gate — only strong semantic matches
    beamWidth: 3,           // Narrow beam — don't wander
    hopPenalty: 0.2,        // Steeper hop penalty
  },
  exploratory: {
    mode: 'exploratory',
    textWeight: 0.4,        // Lower BM25 weight
    temporalWeight: 0.6,    // Lean on temporal/associative signals
    decayExponentBase: 0.3, // Weaker decay — surface older memories
    zScoreGate: 0.3,        // Relaxed vector gate — cast wider net
    beamWidth: 20,          // Wide beam — explore associations
    hopPenalty: 0.4,        // Gentler hop penalty
  },
  balanced: {
    mode: 'balanced',
    textWeight: 0.6,
    temporalWeight: 0.4,
    decayExponentBase: 0.5,
    zScoreGate: 0.5,
    beamWidth: 15,
    hopPenalty: 0.3,
  },
};

/**
 * Classify a query as targeted, exploratory, or balanced.
 *
 * Targeted signals: identifiers (PROJ-123, camelCase, snake_case, UUIDs),
 * short queries (< 8 words), quoted strings, file paths.
 *
 * Exploratory signals: question words, long queries (> 15 words),
 * vague modifiers ("general", "overview", "about", "related to").
 */
function classifyQuery(context: string): 'targeted' | 'exploratory' | 'balanced' {
  const words = context.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const lower = context.toLowerCase();

  let targetedScore = 0;
  let exploratoryScore = 0;

  // Identifier patterns
  if (/[A-Z]+-\d+/.test(context)) targetedScore += 2;          // PROJ-123
  if (/[a-z][A-Z]/.test(context)) targetedScore += 1;          // camelCase
  if (/\w+_\w+/.test(context)) targetedScore += 1;             // snake_case
  if (/[0-9a-f]{8}-[0-9a-f]{4}/.test(lower)) targetedScore += 2; // UUID fragment
  if (/["']/.test(context)) targetedScore += 1;                 // Quoted strings
  if (/[\/\\]/.test(context)) targetedScore += 1;               // File paths
  if (/\.\w{1,4}$/.test(context.trim())) targetedScore += 1;   // File extensions

  // Short queries are usually targeted
  if (wordCount <= 5) targetedScore += 2;
  else if (wordCount <= 8) targetedScore += 1;

  // Question words / exploratory modifiers
  if (/^(what|how|why|when|where|who|which|can|does|is|are)\b/i.test(context)) exploratoryScore += 1;
  if (/\b(overview|general|about|related|similar|like|broad|concept|idea|approach|strategy)\b/i.test(lower)) exploratoryScore += 1;
  if (/\b(any|all|everything|anything)\b/i.test(lower)) exploratoryScore += 1;

  // Long queries are usually exploratory
  if (wordCount > 15) exploratoryScore += 2;
  else if (wordCount > 10) exploratoryScore += 1;

  const diff = targetedScore - exploratoryScore;
  if (diff >= 2) return 'targeted';
  if (diff <= -2) return 'exploratory';
  return 'balanced';
}

function resolveAdaptiveParams(query: ActivationQuery): AdaptiveParams {
  const mode = query.mode ?? 'auto';
  if (mode !== 'auto') return ADAPTIVE_PRESETS[mode];
  const classified = classifyQuery(query.context);
  return ADAPTIVE_PRESETS[classified];
}

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
  readonly validationGate: ValidationGatedBuffer;

  constructor(store: EngramStore) {
    this.store = store;
    this.coActivationBuffer = new CoActivationBuffer(50);
    this.validationGate = new ValidationGatedBuffer();
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
    const adaptive = resolveAdaptiveParams(query);

    // Resolve workspace scope: if workspace is set, search across all agents in that workspace
    const agentIds = query.workspace
      ? this.store.getWorkspaceAgentIds(query.agentId, query.workspace)
      : [query.agentId];
    const isWorkspaceScoped = agentIds.length > 1;

    // Phase -1: Coref expansion — if query has pronouns, append recent entity names
    let queryContext = query.context;
    const pronounPattern = /\b(she|he|they|her|his|him|their|it|that|this|there)\b/i;
    if (pronounPattern.test(queryContext)) {
      try {
        const recentEntities = this.store.getEngramsByAgents(agentIds, 'active')
          .sort((a, b) => b.accessCount - a.accessCount)
          .slice(0, 10)
          .flatMap(e => e.tags.filter(t => t.length >= 3 && !/^(session-|low-|D\d)/.test(t)))
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5);
        if (recentEntities.length > 0) {
          queryContext = `${queryContext} ${recentEntities.join(' ')}`;
        }
      } catch { /* non-fatal */ }
    }

    // Phase 0: Query expansion — add related terms to improve BM25 recall
    let searchContext = queryContext;
    if (useExpansion) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        searchContext = await Promise.race([
          expandQuery(query.context),
          new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('expansion timeout')), 5000); }),
        ]);
      } catch {
        // Expansion unavailable or timed out — use original query
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Phase 1: Embed query for vector similarity (uses coref-expanded context)
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embed(queryContext);
    } catch {
      // Embedding unavailable — fall back to text-only matching
    }

    // Phase 2: Parallel retrieval — dual BM25 + all active engrams
    // Two-pass BM25: (1) keyword-stripped query for precision, (2) expanded query for recall.
    const keywordQuery = Array.from(tokenize(query.context)).join(' ');
    const bm25Keyword = keywordQuery.length > 2
      ? this.store.searchBM25WithRankMultiAgent(agentIds, keywordQuery, limit * 3)
      : [];
    const bm25Expanded = this.store.searchBM25WithRankMultiAgent(agentIds, searchContext, limit * 3);

    // Merge: take the best BM25 score per engram from either pass
    const bm25ScoreMap = new Map<string, number>();
    const bm25EngramMap = new Map<string, any>();
    for (const r of [...bm25Keyword, ...bm25Expanded]) {
      const existing = bm25ScoreMap.get(r.engram.id) ?? 0;
      if (r.bm25Score > existing) {
        bm25ScoreMap.set(r.engram.id, r.bm25Score);
        bm25EngramMap.set(r.engram.id, r.engram);
      }
    }
    const bm25Ranked = Array.from(bm25EngramMap.entries()).map(([id, engram]) => ({
      engram, bm25Score: bm25ScoreMap.get(id) ?? 0,
    }));

    // Phase 3 — Two-pass fetch (0.7.9+):
    //   Pass 1: slim fetch (id, concept, embedding only) for ALL active engrams.
    //           Used for cosine sim + adaptive z-score stats + cheap pool filter.
    //   Pass 2: full fetch ONLY on the survivors that pass the filter.
    //
    // Why: phase-breakdown spike (2026-05-08, post-0.7.7) showed `SELECT * FROM
    // engrams WHERE agent_id = ?` over 10K rows costs 440ms (40% of recall) due
    // to row materialization of content/tags/JSON-blob columns the filter pass
    // doesn't read. Slim fetch trims the per-row payload to the three fields
    // the filter actually uses.
    const slimActive = this.store.getEngramsByAgentsSlim(
      agentIds,
      query.includeStaging ? undefined : 'active',
      query.includeRetracted ?? false
    );

    // Tokenize query once (used by filter + scoring)
    const queryTokens = tokenize(query.context);

    // Phase 3a: Compute raw cosine similarities on slim pool for adaptive normalization
    const rawCosineSims = new Map<string, number>();
    if (queryEmbedding) {
      for (const e of slimActive) {
        if (e.embedding) {
          rawCosineSims.set(e.id, cosineSimilarity(queryEmbedding, e.embedding));
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

    // Determine survivor IDs from the slim pool using the same survival criteria
    // (BM25 hit / cosine z-score / concept-jaccard) plus all BM25-ranked candidates
    // (which already came in fully-hydrated and may not be in slimActive's stage filter).
    const poolFilterEnabled = process.env.AWM_DISABLE_POOL_FILTER !== '1';
    const survivorIds = new Set<string>();
    // Always include BM25-ranked engrams (they came pre-hydrated)
    for (const r of bm25Ranked) survivorIds.add(r.engram.id);

    if (poolFilterEnabled) {
      for (const e of slimActive) {
        if (survivorIds.has(e.id)) continue;
        const bm25 = bm25ScoreMap.get(e.id) ?? 0;
        if (bm25 > 0) { survivorIds.add(e.id); continue; }
        const sim = rawCosineSims.get(e.id);
        if (sim !== undefined) {
          const z = (sim - simMean) / simStdDev;
          if (z > adaptive.zScoreGate) { survivorIds.add(e.id); continue; }
        }
        // Cheap concept jaccard
        const ct = tokenize(e.concept);
        if (ct.size === 0) continue;
        let overlap = 0;
        for (const w of ct) if (queryTokens.has(w)) overlap++;
        if (overlap > 0) survivorIds.add(e.id);
      }
    } else {
      // Filter disabled — include all slim active engrams
      for (const e of slimActive) survivorIds.add(e.id);
    }

    // Pass 2: hydrate full Engram rows ONLY for survivors that aren't already loaded
    const candidateMap = new Map<string, Engram>();
    for (const r of bm25Ranked) candidateMap.set(r.engram.id, r.engram);
    const idsToHydrate = Array.from(survivorIds).filter(id => !candidateMap.has(id));
    if (idsToHydrate.length > 0) {
      for (const e of this.store.getEngramsByIds(idsToHydrate)) {
        candidateMap.set(e.id, e);
      }
    }
    let candidates = Array.from(candidateMap.values());

    // Filter by memory type if specified
    if (query.memoryType) {
      candidates = candidates.filter(e => e.memoryType === query.memoryType);
    }

    if (candidates.length === 0) return [];

    // Phase 3b: Score each candidate with per-phase breakdown
    // Candidates are already filtered (the slim-pool filter ran before hydration).
    //
    // Optimization (0.7.12+): the scoring loop only reads `count` and `sumWeight`
    // from associations. Use a SQL aggregate (GROUP BY) to fetch scalar stats
    // instead of materializing thousands of Association objects. Phase-breakdown
    // (post-0.7.10) showed this saves ~200ms (222ms → ~20ms).
    //
    // Graph walk still needs full Association objects, but it operates on the
    // top-N (~30 candidates) — its on-demand `getAssociationsFor` lookups are
    // cheap (<5ms total).
    const assocStats = this.store.getAssociationStatsForBatch(candidates.map(e => e.id));
    const scored = candidates.map(engram => {
      const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const stats = assocStats.get(engram.id) ?? { count: 0, sumWeight: 0 };

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
      // z-gate adapts to query mode: targeted uses strict gate (0.8), exploratory relaxes (0.3).
      let vectorMatch = 0;
      const rawSim = rawCosineSims.get(engram.id);
      if (rawSim !== undefined) {
        const zScore = (rawSim - simMean) / simStdDev;
        if (zScore > adaptive.zScoreGate) {
          vectorMatch = Math.min(1, (zScore - adaptive.zScoreGate) / 2.0);
        }
      }

      // Combined text match: weighted blend of keyword and vector signals.
      // BM25 is better at lexical discrimination; vector is better at semantic matching.
      // When both are non-zero, blend favors the stronger signal with a boost.
      const textMatch = keywordMatch > 0 && vectorMatch > 0
        ? 0.5 * Math.max(keywordMatch, vectorMatch) + 0.3 * Math.min(keywordMatch, vectorMatch) + 0.2 * (keywordMatch * vectorMatch)
        : Math.max(keywordMatch, vectorMatch);

      // --- Temporal signals ---

      // ACT-R decay — confidence + replay modulated (synaptic tagging)
      // High-confidence memories decay slower. Heavily-accessed memories also resist decay.
      // Base exponent adapts to query mode: targeted (0.6) decays harder, exploratory (0.3) preserves older memories.
      const confMod = 0.2 * Math.max(0, (engram.confidence - 0.5) / 0.5);
      const replayMod = Math.min(0.1, 0.05 * Math.log1p(engram.accessCount));
      const decayExponent = Math.max(0.2, adaptive.decayExponentBase - confMod - replayMod);
      const decayScore = baseLevelActivation(engram.accessCount, ageDays, decayExponent);

      // Hebbian boost from associations — capped to prevent popular memories
      // from dominating regardless of query relevance
      const rawHebbian = stats.count > 0 ? stats.sumWeight / stats.count : 0;
      const hebbianBoost = Math.min(rawHebbian, 0.5);

      // Centrality signal — well-connected memories (high weighted degree)
      // get a small boost. This makes consolidation edges matter for retrieval.
      // Log-scaled to prevent hub domination: 10 edges ≈ 0.05 boost, 50 ≈ 0.08
      const centralityBoost = stats.count > 0
        ? Math.min(0.1, 0.03 * Math.log1p(stats.sumWeight))
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
      // Text/temporal weights adapt to query mode: targeted (0.75/0.25), exploratory (0.4/0.6).
      const temporalNorm = Math.min(softplus(decayScore + hebbianBoost), 3.0) / 3.0;
      const relevanceGate = textMatch > 0.1 ? textMatch : 0.0; // Proportional gate
      const composite = (adaptive.textWeight * textMatch + adaptive.temporalWeight * temporalNorm * relevanceGate + centralityBoost * relevanceGate + feedbackBonus * relevanceGate) * confidenceGate;

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

      // associations: empty in 0.7.12+ — graph walk lazy-fetches per engram on demand
      return { engram, score: composite, phaseScores, associations: [] as Association[] };
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
        const feedbackBM25 = this.store.searchBM25WithRankMultiAgent(agentIds, `${searchContext} ${extraTerms}`, limit * 2);
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
              if (z > adaptive.zScoreGate) vm = Math.min(1, (z - adaptive.zScoreGate) / 2.0);
            }
            const tm = km > 0 && vm > 0
              ? 0.5 * Math.max(km, vm) + 0.3 * Math.min(km, vm) + 0.2 * (km * vm)
              : Math.max(km, vm);
            const ds = baseLevelActivation(engram.accessCount, ageDays);
            const rh = associations.length > 0 ? Math.min(associations.reduce((s, a) => s + a.weight, 0) / associations.length, 0.5) : 0;
            const tn = Math.min(softplus(ds + rh), 3.0) / 3.0;
            const rg = tm > 0.1 ? tm : 0.0;
            const comp = (adaptive.textWeight * tm + adaptive.temporalWeight * tn * rg) * engram.confidence;
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
    this.graphWalk(topN, 2, adaptive.hopPenalty, adaptive.beamWidth);

    // Phase 6: Initial filter and sort for re-ranking pool
    const pool = topN
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score);

    // Phase 7: Cross-encoder re-ranking — scores (query, passage) pairs directly
    // Widens the pool to find relevant results that keyword matching missed
    //
    // Pool size (0.7.13+): max(limit*2, 15). Was max(limit*3, 30); reduced because
    // the cross-encoder cost scales linearly with passage count and 30 was overkill
    // when limit is typically 5-10. Phase-breakdown showed reranker was 65% of the
    // post-0.7.12 recall floor — halving the pool is a direct ~50% reranker savings
    // (~100ms recovered on most queries) with negligible top-K quality impact at
    // limit=5/10 (the user wants top-5 or top-10; reranking 30 to find top-5 reranks
    // many candidates that won't be returned).
    const rerankPool = pool.slice(0, Math.max(limit * 2, 15));

    // Reranker skip heuristic (0.7.10+): if BM25 already has a clear winner with
    // strong absolute score AND a meaningful gap to the runner-up, the cross-encoder
    // is unlikely to change the top result. Skipping saves ~300ms of wall-clock per
    // recall on simple queries (40% of post-0.7.9 floor was reranker).
    //
    // Conservative gate (only skip when very confident):
    //   - top-1 textMatch >= 0.8 (high BM25 + jaccard agreement)
    //   - top-1 score is at least 1.5× top-2 score (clear separation)
    //   - rerankPool size <= limit*2 (small pool — reranker has less to do)
    //
    // Ambiguous queries (close BM25 scores, weak top-1, large pool) still go through
    // the reranker. Disable this heuristic via AWM_DISABLE_RERANK_SKIP=1.
    let rerankSkipped = false;
    if (useReranker && rerankPool.length >= 2 && process.env.AWM_DISABLE_RERANK_SKIP !== '1') {
      const top1 = rerankPool[0];
      const top2 = rerankPool[1];
      const t1Text = top1.phaseScores.textMatch;
      const t1Score = top1.score;
      const t2Score = top2.score;
      const cleanWinner = t1Text >= 0.8 && t1Score >= 1.5 * Math.max(t2Score, 0.01);
      const smallPool = rerankPool.length <= Math.max(limit * 2, 20);
      if (cleanWinner && smallPool) {
        rerankSkipped = true;
      }
    }

    if (useReranker && !rerankSkipped && rerankPool.length > 0) {
      try {
        // Truncate content to ~400 chars before rerank (0.7.14+). Cross-encoders
        // have a 512-token max anyway and pad to the longest passage in the batch;
        // sending full content (some 5000+ chars) means everything pads to ~512
        // tokens. Truncation drops tokenization + inference cost ~3-4× on long
        // memory pools without losing rerank signal — the concept + first 400
        // chars carry the core meaning.
        const passages = rerankPool.map(r => {
          const concept = r.engram.concept;
          const content = r.engram.content.length > 400
            ? r.engram.content.slice(0, 400)
            : r.engram.content;
          return `${concept}: ${content}`;
        });
        let rerankTimer: ReturnType<typeof setTimeout> | undefined;
        const rerankResults = await Promise.race([
          rerank(query.context, passages),
          new Promise<never>((_, reject) => { rerankTimer = setTimeout(() => reject(new Error('reranker timeout')), 10000); }),
        ]).finally(() => { if (rerankTimer) clearTimeout(rerankTimer); });

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

    // Phase 8: Multi-channel OOD detection + agreement gate
    // Requires at least 2 of 3 retrieval channels to agree the query is in-domain.
    if (rerankPool.length >= 3) {
      const topBM25 = Math.max(...rerankPool.map(r => bm25ScoreMap.get(r.engram.id) ?? 0));
      const topVector = queryEmbedding
        ? Math.max(...rerankPool.map(r => r.phaseScores.vectorMatch))
        : 0;
      const topReranker = Math.max(...rerankPool.map(r => r.phaseScores.rerankerScore));

      const bm25Ok = topBM25 > 0.3;
      const vectorOk = topVector > 0.05;
      const rerankerOk = topReranker > 0.25;
      const channelsAgreeing = (bm25Ok ? 1 : 0) + (vectorOk ? 1 : 0) + (rerankerOk ? 1 : 0);

      const rerankerScores = rerankPool
        .map(r => r.phaseScores.rerankerScore)
        .sort((a, b) => b - a);
      const margin = rerankerScores.length >= 2
        ? rerankerScores[0] - rerankerScores[1]
        : rerankerScores[0];

      const maxRawCosine = queryEmbedding && simValues.length > 0
        ? Math.max(...simValues)
        : 1.0;

      // Stricter gate when caller explicitly requests abstention (e.g., noise filter queries)
      const requiredChannels = abstentionThreshold > 0 ? 3 : 2;

      // Hard abstention: fewer than required channels agree AND semantic drift is high
      if (channelsAgreeing < requiredChannels && maxRawCosine < (simMean + simStdDev * 1.5)) {
        return [];
      }

      // Soft penalty: only 1 channel agrees or margin is thin
      if (channelsAgreeing < 2 || margin < 0.05) {
        // If caller explicitly requested abstention, honor it when agreement is weak
        if (abstentionThreshold > 0) {
          return [];
        }
        for (const item of rerankPool) {
          item.score *= 0.4;
        }
      }
    }

    // Legacy abstention gate (when explicitly requested)
    if (abstentionThreshold > 0 && rerankPool.length >= 3) {
      const topRerankerScores = rerankPool
        .map(r => r.phaseScores.rerankerScore)
        .sort((a, b) => b - a)
        .slice(0, 5);
      const maxScore = topRerankerScores[0];
      const meanScore = topRerankerScores.reduce((s, v) => s + v, 0) / topRerankerScores.length;
      const variance = topRerankerScores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / topRerankerScores.length;

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

    // Side effects: touch, co-activate, defer Hebbian to validation gate (skip for internal/system calls)
    if (!query.internal) {
      for (const id of activatedIds) {
        this.store.touchEngram(id);
      }
      this.coActivationBuffer.pushBatch(activatedIds);
      // Validation-gated Hebbian: defer strengthening until feedback arrives
      const pairs = this.coActivationBuffer.getCoActivatedPairs(10_000);
      const seen = new Set<string>();
      const uniquePairs: [string, string][] = [];
      for (const [a, b] of pairs) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!seen.has(key)) { seen.add(key); uniquePairs.push([a, b]); }
      }
      this.validationGate.addPending(activatedIds, uniquePairs);

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
   * Multi-graph traversal (MAGMA-inspired).
   *
   * Instead of one beam search over all edge types, runs independent traversals
   * per graph type with specialized scoring, then fuses the boosts.
   *
   * Four sub-graphs:
   * - Semantic (connection + hebbian edges) → standard weight-based walk
   * - Temporal (temporal edges) → recency-weighted (favor recent connections)
   * - Causal (causal edges) → full weight walk (causal links are high-value)
   * - Entity (bridge edges) → entity-tag-weighted walk
   *
   * Each sub-graph contributes independently to the final graph boost,
   * weighted by configurable per-graph weights.
   */
  private static readonly GRAPH_WEIGHTS = {
    semantic: 0.40,   // connection + hebbian
    temporal: 0.20,   // temporal edges
    causal: 0.25,     // causal edges (high-value signal)
    entity: 0.15,     // bridge edges
  };

  private graphWalk(
    scored: { engram: Engram; score: number; phaseScores: PhaseScores; associations: Association[] }[],
    maxDepth: number,
    hopPenalty: number,
    beamWidth: number = 15
  ): void {
    const scoreMap = new Map(scored.map(s => [s.engram.id, s]));
    const MAX_TOTAL_BOOST = 0.25;

    // Define which edge types belong to each sub-graph
    const graphTypes: Record<string, string[]> = {
      semantic: ['connection', 'hebbian'],
      temporal: ['temporal'],
      causal: ['causal'],
      entity: ['bridge'],
    };

    // Run independent traversals per sub-graph, accumulate boosts
    const boostAccum = new Map<string, number>(); // engramId → total boost

    for (const [graphName, edgeTypes] of Object.entries(graphTypes)) {
      const graphWeight = ActivationEngine.GRAPH_WEIGHTS[graphName as keyof typeof ActivationEngine.GRAPH_WEIGHTS];
      const subBeamWidth = Math.max(3, Math.ceil(beamWidth * graphWeight));

      // Seed beam
      const beam = scored
        .filter(item => item.phaseScores.textMatch >= 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, subBeamWidth);

      const explored = new Set<string>();

      for (let depth = 0; depth < maxDepth; depth++) {
        const nextBeam: typeof beam = [];

        for (const item of beam) {
          if (explored.has(item.engram.id)) continue;
          explored.add(item.engram.id);

          const associations = item.associations.length > 0
            ? item.associations
            : this.store.getAssociationsFor(item.engram.id);

          // Filter to only edges of this sub-graph type
          const relevantEdges = associations.filter(a => edgeTypes.includes(a.type));

          for (const assoc of relevantEdges) {
            const neighborId = assoc.fromEngramId === item.engram.id
              ? assoc.toEngramId
              : assoc.fromEngramId;

            if (explored.has(neighborId)) continue;
            const neighbor = scoreMap.get(neighborId);
            if (!neighbor) continue;

            const relevanceFloor = depth === 0 ? 0.1 : 0.05;
            if (neighbor.phaseScores.textMatch < relevanceFloor) continue;

            // Path score with graph-type-specific weighting
            const normalizedWeight = Math.min(assoc.weight, 5.0) / 5.0;
            let pathScore = item.score * normalizedWeight * Math.pow(hopPenalty, depth + 1);

            // Causal edges get a 2x boost — they represent verified reasoning chains
            if (graphName === 'causal') pathScore *= 2.0;

            // Weight by sub-graph importance
            const boost = Math.min(pathScore * graphWeight, 0.15);
            if (boost > 0.001) {
              boostAccum.set(neighborId, (boostAccum.get(neighborId) ?? 0) + boost);
              nextBeam.push(neighbor);
            }
          }
        }

        if (nextBeam.length === 0) break;
        beam.length = 0;
        beam.push(...nextBeam
          .sort((a, b) => b.score - a.score)
          .slice(0, subBeamWidth)
        );
      }
    }

    // Apply fused boosts to scored items
    for (const [engramId, totalBoost] of boostAccum) {
      const item = scoreMap.get(engramId);
      if (!item) continue;
      const capped = Math.min(totalBoost, MAX_TOTAL_BOOST - item.phaseScores.graphBoost);
      if (capped > 0.001) {
        item.score += capped;
        item.phaseScores.graphBoost += capped;
      }
    }
  }

  /**
   * Resolve validation-gated Hebbian update for a specific engram.
   * Called by memory_feedback — only strengthens when retrieval was useful.
   * This prevents hub toxicity from noisy co-retrieval (Kairos-inspired).
   */
  resolveHebbianFeedback(engramId: string, useful: boolean): number {
    const { pairs, signal } = this.validationGate.resolveFeedback(engramId, useful);
    let updated = 0;

    for (const [a, b] of pairs) {
      const existing = this.store.getAssociation(a, b) ?? this.store.getAssociation(b, a);
      const currentWeight = existing?.weight ?? 0.1;

      if (signal > 0) {
        // Positive feedback → strengthen
        const newWeight = strengthenAssociation(currentWeight, signal);
        this.store.upsertAssociation(a, b, newWeight, 'hebbian');
        this.store.upsertAssociation(b, a, newWeight, 'hebbian');
      } else {
        // Negative feedback → slight weakening (decay by signal magnitude)
        const newWeight = Math.max(0.001, currentWeight * (1 + signal)); // signal is -0.3
        this.store.upsertAssociation(a, b, newWeight, 'hebbian');
        this.store.upsertAssociation(b, a, newWeight, 'hebbian');
      }
      updated++;
    }
    return updated;
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
