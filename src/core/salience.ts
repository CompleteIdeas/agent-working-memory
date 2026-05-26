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
import type { IEngramStore as EngramStore } from '../storage/store.js';

export type SalienceEventType = 'decision' | 'friction' | 'surprise' | 'causal' | 'observation' | 'user_feedback';

/**
 * Auto-detect user-feedback memories: content that begins with a known user's
 * name + a feedback verb. These memories represent direct human decisions and
 * must never be discarded. Examples:
 *   "Robert verbatim: 'LMS programs-first like CRM'"
 *   "Katherine said the CEC cycle resets on promotion"
 *   "Nancy directed Tier 1 has no grace period"
 *
 * Why this exists: the BM25 novelty check collapses near-duplicates regardless
 * of whether the content is a NEW decision or a repeat observation. User
 * feedback often shares terminology with prior memories ("LMS", "ECP",
 * "officials") and gets discarded at salience 0.14 (verified in activity log
 * 2026-05-06T19:08:47). Detecting "Robert said X" → canonical class bypasses
 * the salience filter entirely.
 *
 * Tune the name list as new staff join. Pattern requires word boundary at
 * start so "Roberta" or "Hannahs" don't match.
 */
const USER_FEEDBACK_PATTERN = /^(Robert|Katherine|Catherine|Nancy|Brandy|Brandi|Hannah|Marilyn|Kaylee|Pete|Abby|Tom|Wendy|Sita|Nick|Rob|Joan|Jennifer|Cindy|Jason|Alex|Molly)\s+(said|verbatim|feedback|asked|wants|prefers|requested|requested|directed|decided|confirmed|clarified|chose|specified|explained)\b/i;

/** Returns true if the content looks like direct user feedback that should auto-promote to canonical. */
export function detectUserFeedback(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  return USER_FEEDBACK_PATTERN.test(content.trim());
}

/**
 * Auto-detect verified operational findings: batch records, completion summaries,
 * incident reconciliations. These have low BM25 novelty (terminology repeats across
 * runs — "USEF results submission", "Freshdesk triage batch") but the SPECIFIC
 * event/ticket IDs, dates, and counts make each one uniquely valuable for future
 * recall.
 *
 * Why this exists: the salience filter discarded a 6-event USEF batch summary at
 * 0.14 (verified in activity log 2026-05-07T18:44:14) because the topic words
 * collided with the long-running USEF history. The procedural memory beside it
 * scored 0.70 — same topic, different content shape. The novelty signal alone
 * can't distinguish a useful operational record from a duplicate observation.
 *
 * Pattern requires BOTH:
 *   1. An action-verb header (Submitted/Finalized/Completed/Reconciled/Triaged/Posted/Resolved/Stamped)
 *   2. At least 2 concrete identifiers — absolute dates (YYYY-MM-DD) OR numeric IDs
 *      with context (event \d+, ticket #\d+, USEF \d+, USEA \d+).
 *
 * Matched memories get a salience floor of 0.45 (active, but below canonical
 * 0.7) — preserves the record without claiming source-of-truth status.
 */
const OPERATIONAL_VERB_PATTERN = /\b(Submitted|Finalized|Completed|Reconciled|Triaged|Posted|Resolved|Stamped|Pushed|Deployed|Migrated|Imported|Exported|Backfilled)\b/i;
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const CONCRETE_ID_PATTERN = /\b(?:events?|tickets?|comps?|comp_id|usef|usea|classes|class|cases?|orders?|payments?|member_id|horse_id|user_id|orgs?|#)\s*[#:]?\s*\d{3,}/gi;

/** Returns true if the content looks like a verified operational/batch record that should auto-bump salience. */
export function detectVerifiedFinding(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const text = content.trim();
  if (!OPERATIONAL_VERB_PATTERN.test(text)) return false;
  const dateCount = (text.match(ISO_DATE_PATTERN) || []).length;
  const idCount = (text.match(CONCRETE_ID_PATTERN) || []).length;
  return dateCount + idCount >= 2;
}

/**
 * Auto-detect trivial routine operations: file reads, status pings, log-line
 * completions. These have high BM25 novelty (each one has different filenames,
 * timestamps, attempt counts) but represent NO learning value — they're the
 * sort of background chatter a working agent generates by the thousand.
 *
 * Why this exists: the novelty weight (0.45) puts a floor at ~0.45 for every
 * write on a fresh agent, which prevents trivial observations from ever
 * routing to 'discard'. self-test 1.2 ("File read completed successfully for
 * file 0") explicitly asks for trivial → discard. We can't detect triviality
 * from features alone — the caller passes surprise=0, effort=0 but novelty
 * computes to 1.0 — so we need a content shape check.
 *
 * Pattern requires:
 *   - A routine verb phrase: "completed", "succeeded", "finished", "returned",
 *     "loaded", "saved", "read", "wrote", "synced", "pinged", "checked",
 *     "started", "stopped", "rotated", "flushed"
 *   - Generic operational noun: file/log/request/response/status/job/connection
 *   - Total length under ~150 chars (trivial events are short)
 *
 * Matched memories get a salience CAP at 0.10 (below the 0.2 stagingThreshold,
 * so they route to 'discard'). Caller can still force-store via
 * memory_class=canonical or memory_class=structural.
 */
const TRIVIAL_VERB_PATTERN = /\b(completed|succeeded|finished|returned|loaded|saved|read|wrote|synced|pinged|checked|started|stopped|rotated|flushed)\b/i;
const TRIVIAL_NOUN_PATTERN = /\b(file|log|request|response|status|job|connection|task|cron|sync|tick|batch)\b/i;

/** Returns true if the content looks like a routine operational ping that adds no learning value. */
export function detectTrivialOperation(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const text = content.trim();
  if (text.length > 150) return false;
  if (!TRIVIAL_VERB_PATTERN.test(text)) return false;
  if (!TRIVIAL_NOUN_PATTERN.test(text)) return false;
  // Don't trip on verified findings — they share some verbs (Completed) but
  // have concrete identifiers. detectVerifiedFinding has priority.
  if (detectVerifiedFinding(text)) return false;
  return true;
}

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
  // Auto-detect user feedback before scoring. If content matches the pattern,
  // force eventType='user_feedback' and memoryClass='canonical'. This bypasses
  // the BM25 novelty floor that was discarding pivotal user decisions at 0.14.
  let resolvedEventType: SalienceEventType = input.eventType ?? 'observation';
  let resolvedMemoryClass: MemoryClass = input.memoryClass ?? 'working';
  let autoPromoted = false;
  let verifiedFindingFloor = false;
  let trivialOperationCap = false;
  if (detectUserFeedback(input.content)) {
    resolvedEventType = 'user_feedback';
    resolvedMemoryClass = 'canonical';
    autoPromoted = true;
  } else if (detectVerifiedFinding(input.content)) {
    // Operational record: bump eventType to 'decision' (typeBonus +0.15) and
    // remember to apply a 0.45 salience floor below. Do NOT promote to canonical
    // — these records are verified, not source-of-truth.
    if (resolvedEventType === 'observation') {
      resolvedEventType = 'decision';
    }
    verifiedFindingFloor = true;
  } else if (detectTrivialOperation(input.content)) {
    // Trivial routine operation — cap salience below stagingThreshold so it
    // routes to 'discard'. Caller can still force-keep via canonical/structural.
    trivialOperationCap = true;
  }

  const features: SalienceFeatures = {
    surprise: input.surprise ?? 0,
    decisionMade: input.decisionMade ?? false,
    causalDepth: input.causalDepth ?? 0,
    resolutionEffort: input.resolutionEffort ?? 0,
    eventType: resolvedEventType,
  };

  const reasonCodes: string[] = [];
  if (autoPromoted) reasonCodes.push('auto:user_feedback');
  if (verifiedFindingFloor) reasonCodes.push('auto:verified_finding');
  if (trivialOperationCap) reasonCodes.push('auto:trivial_operation');

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

  // Event type bonus — gated by signal strength. The bonus represents the
  // confidence that an event of this type warrants the type-specific boost.
  // If the caller labels something `friction` but every signal is near zero,
  // they're telling the system the friction was minor — the typeBonus is
  // attenuated to reflect that. Without this gate, any labeled friction
  // event clears the active threshold on novelty alone (self-test 1.4).
  let typeBonus = 0;
  let typeReason = '';
  switch (features.eventType) {
    case 'decision': typeBonus = 0.15; typeReason = 'event:decision'; break;
    case 'friction': typeBonus = 0.2; typeReason = 'event:friction'; break;
    case 'surprise': typeBonus = 0.25; typeReason = 'event:surprise'; break;
    case 'causal': typeBonus = 0.2; typeReason = 'event:causal'; break;
    case 'user_feedback': typeBonus = 0.3; typeReason = 'event:user_feedback'; break;
    case 'observation': break;
  }
  // Signal-weakness gate. The novelty score alone (~0.45 for fresh content)
  // would clear the active threshold (0.4), so any labelled event with no
  // backing numerical signals lands as 'active' regardless of the label's
  // semantics. That's wrong for friction/causal: those types describe events
  // that *happened to the agent* and benefit from explicit intensity signals.
  // surprise / user_feedback / decision-with-decisionMade are exempt: their
  // label alone is the signal.
  const exemptFromAttenuation =
       features.eventType === 'user_feedback'
    || features.eventType === 'surprise'
    || (features.eventType === 'decision' && features.decisionMade);
  const signalStrength = features.surprise + features.causalDepth + features.resolutionEffort + (features.decisionMade ? 0.5 : 0);
  const signalsAreWeak = !exemptFromAttenuation && signalStrength < 0.5;

  if (typeBonus > 0 && signalsAreWeak) {
    typeBonus *= 0.25; // weak-signal event: keep a hint, not the full bonus
    typeReason += ':attenuated';
  }
  if (typeReason) reasonCodes.push(typeReason);

  // Cap the novelty contribution when signals are weak AND the eventType
  // claims a typeBonus (friction/causal). Without this, novelty=1.0 alone
  // (0.45 noveltyScore) clears the active threshold (0.4), making any
  // weakly-signalled non-exempt write 'active' regardless of intent.
  // Plain observations (typeBonus=0) are NOT capped — a novel observation
  // is still default-active even without explicit signals.
  let cappedNoveltyScore = noveltyScore;
  if (signalsAreWeak && typeBonus > 0) {
    cappedNoveltyScore = Math.min(noveltyScore, 0.30);
    if (cappedNoveltyScore < noveltyScore) reasonCodes.push('novelty:capped');
  }

  let score = Math.min(surpriseScore + decisionScore + causalScore + effortScore + cappedNoveltyScore + typeBonus, 1.0);

  // Apply triviality cap BEFORE memoryClass floor — the floor still wins for
  // canonical/structural writes (covered below). Trivial cap forces routine
  // operational chatter below stagingThreshold.
  if (trivialOperationCap) {
    score = Math.min(score, 0.1);
  }

  // Memory class overrides
  const memoryClass = resolvedMemoryClass;

  if (memoryClass === 'canonical') {
    // Canonical memories: salience floor of 0.7, never go to staging
    score = Math.max(score, 0.7);
    reasonCodes.push('class:canonical');
  } else if (memoryClass === 'structural') {
    // Structural memories (0.8): system-written event-log records — chapter
    // analyses, promise advancements, materialized-view feeds. Floor 0.7 like
    // canonical (always preserved by construction) but distinct reasonCode
    // so retrieval paths can filter them out of cognitive `/activate` by
    // default. Caller controls embedding + temporal-edge skipping in the
    // write pipeline.
    score = Math.max(score, 0.7);
    reasonCodes.push('class:structural');
  } else if (memoryClass === 'ephemeral') {
    reasonCodes.push('class:ephemeral');
  } else if (verifiedFindingFloor) {
    // Verified operational record: 0.45 floor — keeps it active without canonical promotion
    score = Math.max(score, 0.45);
  }

  let disposition: 'active' | 'staging' | 'discard';
  if (memoryClass === 'canonical' || memoryClass === 'structural') {
    // Canonical = source-of-truth; structural = system-written record.
    // Both always go active — they represent intentional permanent state.
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
export async function computeNovelty(store: EngramStore, agentId: string, concept: string, content: string): Promise<number> {
  try {
    // Search using concept + first 100 chars of content (enough to detect duplicates, fast)
    const contentStr = typeof content === 'string' ? content : '';
    const conceptStr = typeof concept === 'string' ? concept : '';
    const searchText = `${conceptStr} ${contentStr.slice(0, 100)}`;

    const results = await store.searchBM25WithRank(agentId, searchText, 5);
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
 * Compute novelty score AND return the best matching engram (for
 * reinforcement-on-duplicate).
 *
 * **v0.8.5+: dual-signal novelty (BM25 ∨ cosine, max).**
 *
 * When `embedding` is provided, computes both:
 *   - BM25 lexical match (existing path) — catches verbatim duplicates,
 *     identifier-driven matches, recall-output reingestion attempts.
 *   - Cosine semantic match (new) — catches paraphrased duplicates,
 *     vocabulary-drifted restatements of the same fact, cross-role
 *     rephrasings (user question → assistant answer about same fact).
 *
 * Takes `max(bm25Score, cosineSimilarity)` and returns the engram from
 * whichever signal won. Why both?
 *   - BM25 is *backend-dependent* — Postgres ts_rank_cd and SQLite FTS5
 *     BM25 are different algorithms producing different rankings for
 *     short-text matches (verified empirically 2026-05-26). Cosine is
 *     *backend-agnostic* — same embedding model produces identical
 *     similarity scores on either backend.
 *   - Cosine alone misses the exact-text cases BM25 catches (recall
 *     output leakage, identifier matching). BM25 alone misses the
 *     semantic cases cosine catches (paraphrase, vocabulary drift —
 *     the LoCoMo pattern of "user said X" across conversations).
 *
 * When `embedding` is null/omitted, falls back to BM25-only (preserves
 * backward compat with v0.8.4 and earlier callers).
 *
 * Optionally checks workspace-scoped memories too (cross-agent dedup).
 */
export async function computeNoveltyWithMatch(
  store: EngramStore, agentId: string, concept: string, content: string,
  workspace?: string | null,
  embedding?: number[] | null,
): Promise<NoveltyResult> {
  try {
    const contentStr = typeof content === 'string' ? content : '';
    const conceptStr = typeof concept === 'string' ? concept : '';
    const searchText = `${conceptStr} ${contentStr.slice(0, 100)}`;

    // BM25 channel (existing) — agent-scoped + optional workspace.
    const bm25Results = await store.searchBM25WithRank(agentId, searchText, 3);
    let wsResults: { engram: { id: string; concept?: string; createdAt?: Date | string | number }; bm25Score: number }[] = [];
    if (workspace && typeof (store as any).searchBM25WithRankWorkspace === 'function') {
      wsResults = await (store as any).searchBM25WithRankWorkspace(agentId, searchText, 3, workspace);
    }
    const allBm25 = [...bm25Results, ...wsResults];
    allBm25.sort((a, b) => b.bm25Score - a.bm25Score);
    const topBm25 = allBm25[0]
      ? { engramId: allBm25[0].engram.id, score: allBm25[0].bm25Score, engram: allBm25[0].engram }
      : null;

    // Cosine channel (v0.8.5) — only when caller supplies an embedding.
    // The embed cost is paid once in the write-pipeline pre-novelty and
    // re-used for the engram's stored vector, so we don't double-embed.
    let topCosine: { engramId: string; score: number; engram: any } | null = null;
    if (embedding && embedding.length > 0) {
      try {
        const hits = await store.searchByVector(agentId, embedding, 3);
        if (hits.length > 0) {
          const h = hits[0];
          // pgvector distance ≈ 1 - cosineSimilarity for unit-norm BGE vectors.
          // SQLite searchByVector returns distance = 1 - sim in the same form.
          // Clamp into [0, 1] to be safe with floating-point drift.
          const sim = Math.max(0, Math.min(1, 1 - h.distance));
          topCosine = { engramId: h.engram.id, score: sim, engram: h.engram };
        }
      } catch { /* cosine channel optional — fall back to BM25 alone */ }
    }

    // Combine: take the higher-confidence signal. If both fired and they
    // identify the same engram, scores reinforce each other (we still take
    // max, but the matched engram is the same). If they identify *different*
    // engrams (one semantic match, one lexical), the higher score wins —
    // typically the more discriminating signal for that particular content.
    //
    // Tested MIN and cosine-primary on 2026-05-26 to address PGlite token
    // bloat; both dropped accuracy 7–20pp across backends. The bloat is a
    // recall-output problem (returning full merged engram content when only
    // a slice matches the query), not a novelty problem. Keeping MAX
    // preserves the 100% / 97.5% accuracy we had on PGlite / SQLite.
    let combinedTop: { engramId: string; score: number; engram: any } | null;
    if (topCosine && topBm25) {
      combinedTop = topCosine.score >= topBm25.score ? topCosine : topBm25;
    } else if (topCosine) {
      combinedTop = topCosine;
    } else if (topBm25) {
      combinedTop = topBm25;
    } else {
      return { novelty: 1.0, matchedEngramId: null, matchScore: 0 };
    }

    const topScore = combinedTop.score;

    // Quadratic dampening — see computeNovelty for curve rationale
    const baseNovelty = 1.0 - topScore * topScore;

    // Recent-only concept penalty (30d window). Check across all matches we
    // saw on EITHER channel — exact-concept repeat counts as a near-duplicate
    // regardless of which signal noticed it.
    const conceptLower = conceptStr.toLowerCase().trim();
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const checkExactConcept = (eng: { concept?: string; createdAt?: Date | string | number }): boolean => {
      if (eng?.concept?.toLowerCase().trim() !== conceptLower) return false;
      const created = eng?.createdAt;
      if (!created) return true;
      const createdMs = created instanceof Date
        ? created.getTime()
        : typeof created === 'number' ? created : Date.parse(created);
      return Number.isFinite(createdMs) && createdMs >= cutoffMs;
    };
    const exactConceptRecent = allBm25.some(r => checkExactConcept(r.engram))
      || (topCosine ? checkExactConcept(topCosine.engram) : false);
    const conceptPenalty = exactConceptRecent ? 0.3 : 0;

    const novelty = Math.max(0.05, Math.min(0.95, baseNovelty - conceptPenalty));
    return { novelty, matchedEngramId: combinedTop.engramId, matchScore: topScore };
  } catch {
    return { novelty: 0.8, matchedEngramId: null, matchScore: 0 };
  }
}
