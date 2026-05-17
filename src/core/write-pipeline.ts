// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Unified write pipeline — shared implementation of the three write-time
 * memory rules (R1/R2/R3) that distinguish AWM as a "memory" system
 * (selective retention) rather than "storage" (retrieve-all-then-dump):
 *
 *   R1 — Reinforce on duplicate. Repeat = stronger memory. When a new
 *        write shares the EXACT same concept as an existing engram,
 *        boost that engram's confidence + access count instead of
 *        creating a new near-duplicate. One strong engram beats N weak
 *        ones.
 *
 *   R2 — Pick the RIGHT match. Skip the match if it's already
 *        superseded, unhealthy (confidence < 0.3), or not in active
 *        stage. If the match is superseded, reinforce the SUPERSEDER
 *        instead (the "we fixed it, now we know better" chain).
 *
 *   R3 — Corrections override. When the write's eventType is `surprise`
 *        or `friction` AND the matched engram is the same concept, the
 *        new write SUPERSEDES the matched engram instead of reinforcing
 *        it. Fresh truth beats old habit.
 *
 * Critical implementation detail (lesson from LoCoMo 2026-05-12): the
 * match-vs-create pivot is **concept equality**, not raw novelty.
 * Thresholding on novelty alone collapses distinct facts that happen to
 * share template language (e.g. 419 conversation turns all prefixed
 * "[session_3] Caroline: ..." merged into 7 engrams, recall coverage
 * halved). Concept equality is the sharp signal: same concept means
 * the writer is restating the same topic.
 *
 * Disposition (active/staging/discard) is still set from evaluateSalience
 * for the CREATE path. REINFORCE writes never reach staging — they just
 * touch an existing engram. SUPERSEDE writes follow the disposition of
 * the new engram (typically active because corrections are high-salience).
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { ConnectionEngine } from '../engine/connections.js';
import type { Engram, MemoryClass, MemoryType } from '../types/engram.js';
import {
  evaluateSalience,
  computeNoveltyWithMatch,
  detectUserFeedback,
  type SalienceEventType,
  type SalienceResult,
  type NoveltyResult,
} from './salience.js';
import { embed } from './embeddings.js';
import { DEFAULT_AGENT_CONFIG } from '../types/agent.js';

/** Confidence floor below which a matched engram is treated as "decaying out". */
export const HEALTHY_CONFIDENCE_FLOOR = 0.3;

/** Confidence delta applied on reinforcement. Bounded by REINFORCE_CONFIDENCE_CEIL. */
export const REINFORCE_CONFIDENCE_DELTA = 0.05;
export const REINFORCE_CONFIDENCE_CEIL = 0.95;

/** Default disposition-confidence priors when the caller doesn't supply one. */
const CONFIDENCE_PRIORS: Record<string, number> = {
  decision: 0.65,
  friction: 0.60,
  causal: 0.60,
  surprise: 0.55,
  user_feedback: 0.70,
  observation: 0.45,
};

export type WriteAction = 'create' | 'reinforce' | 'supersede';

export interface WriteInput {
  agentId: string;
  concept: string;
  content: string;
  /** Tags as the caller wants them stored (already assembled). */
  tags?: string[];
  memoryClass?: MemoryClass;
  memoryType?: MemoryType;
  eventType?: SalienceEventType;
  surprise?: number;
  decisionMade?: boolean;
  causalDepth?: number;
  resolutionEffort?: number;
  /** Confidence override. When unset, defaults from disposition + eventType priors. */
  confidence?: number;
  /** Explicit supersession requested by caller (independent of correction-on-match). */
  supersedes?: string;
  /** Workspace scope for cross-agent novelty (v0.5.4+ stores only). */
  workspace?: string | null;
  /** Set to false to skip the reinforce/supersede branching and always create. */
  enableReinforcement?: boolean;
  /** Optional story-time / sequence ordering (0.8 Cluster A). */
  sequence?: number;
  /** Typed cross-record links — stored alongside the engram (0.8 Cluster A). */
  references?: import('../types/engram.js').EngramReference[];
  /** Force embedding for structural-class writes. structural skips by default
   *  because it's deterministically retrieved; opt in if a caller wants
   *  cognitive recall over a structural engram. (0.8 Cluster A) */
  embed?: boolean;
}

export interface WriteResult {
  action: WriteAction;
  /**
   * For action='create' or 'supersede': the newly created engram.
   * For action='reinforce': the EXISTING engram that was reinforced
   * (its confidence and access_count have been bumped in place).
   */
  engram: Engram;
  /** Salience result — present for create/supersede; null for reinforce (no new salience evaluation). */
  salience: SalienceResult | null;
  /** Novelty + match info, useful for caller logging. */
  noveltyResult: NoveltyResult;
  /** Reinforcement detail — present only for action='reinforce'. */
  reinforce?: {
    previousConfidence: number;
    newConfidence: number;
    previousAccessCount: number;
  };
  /** Supersession detail — present only for action='supersede'. */
  supersedeOf?: { id: string };
}

export interface WritePipelineEngines {
  store: EngramStore;
  connectionEngine: ConnectionEngine;
}

/**
 * Run a write through the unified pipeline.
 *
 * Side effects (always):
 *   - Compute novelty + best match
 *   - Evaluate salience for audit
 *
 * Side effects (action-dependent):
 *   - REINFORCE: touchEngram + updateConfidence on the matched engram;
 *               no new engram is created.
 *   - SUPERSEDE: createEngram with supersedes=matched.id, then call
 *               supersedeEngram. Async embed + enqueue follow.
 *   - CREATE:   createEngram, async embed + enqueue. If salience says
 *               staging, updateStage to 'staging'.
 *
 * The caller is responsible for:
 *   - Tag assembly (callers know their own metadata format)
 *   - Temporal adjacency edges
 *   - Episode assignment
 *   - Auto-checkpoint tracking
 *   - Decision propagation
 *
 * Set process.env.AWM_WRITE_PIPELINE=off to revert to legacy create-only
 * behavior (the same write inputs but every write creates a new engram).
 */
export function performWrite(
  engines: WritePipelineEngines,
  input: WriteInput,
): WriteResult {
  const { store, connectionEngine } = engines;
  const enableReinforcement = input.enableReinforcement !== false
    && process.env.AWM_WRITE_PIPELINE !== 'off';

  const noveltyResult = computeNoveltyWithMatch(
    store, input.agentId, input.concept, input.content, input.workspace ?? null,
  );

  // Effective event type — auto-promote user-feedback content.
  const effectiveEventType: SalienceEventType =
    input.eventType ?? (detectUserFeedback(input.content) ? 'user_feedback' : 'observation');

  // Effective memory class — auto-canonical for user-feedback and verified findings.
  let effectiveMemoryClass: MemoryClass | undefined = input.memoryClass;
  if (!effectiveMemoryClass && effectiveEventType === 'user_feedback') {
    effectiveMemoryClass = 'canonical';
  }

  const salience = evaluateSalience({
    content: input.content,
    eventType: effectiveEventType,
    surprise: input.surprise,
    decisionMade: input.decisionMade,
    causalDepth: input.causalDepth,
    resolutionEffort: input.resolutionEffort,
    novelty: noveltyResult.novelty,
    memoryClass: effectiveMemoryClass,
  });

  // -- Reinforce / Supersede branching --
  if (enableReinforcement && noveltyResult.matchedEngramId) {
    const matched = store.getEngram(noveltyResult.matchedEngramId);
    if (matched) {
      const newConcept = (input.concept ?? '').toLowerCase().trim();
      const matchedConcept = (matched.concept ?? '').toLowerCase().trim();
      const sameConcept = newConcept === matchedConcept && newConcept.length > 0;

      if (sameConcept) {
        const isCorrectionSignal = effectiveEventType === 'surprise'
          || effectiveEventType === 'friction';

        if (isCorrectionSignal) {
          // R3 — supersede the matched engram with the new write
          return createNewEngram(engines, input, salience, noveltyResult, {
            effectiveEventType,
            effectiveMemoryClass,
            supersedesId: matched.id,
          });
        }

        // R2 — health check on the matched engram
        const isHealthy = matched.stage === 'active'
          && matched.confidence >= HEALTHY_CONFIDENCE_FLOOR
          && matched.supersededBy == null;

        if (isHealthy) {
          // R1 — reinforce
          return reinforceMatched(store, matched, noveltyResult, salience);
        }

        // Unhealthy match but it was superseded — try to reinforce the superseder
        if (matched.supersededBy) {
          const superseder = store.getEngram(matched.supersededBy);
          if (superseder && superseder.stage === 'active'
              && superseder.confidence >= HEALTHY_CONFIDENCE_FLOOR
              && superseder.supersededBy == null) {
            return reinforceMatched(store, superseder, noveltyResult, salience);
          }
        }

        // Otherwise fall through to create new
      }
    }
  }

  // -- Default: create new engram --
  return createNewEngram(engines, input, salience, noveltyResult, {
    effectiveEventType,
    effectiveMemoryClass,
    supersedesId: input.supersedes,
  });
}

function reinforceMatched(
  store: EngramStore,
  matched: Engram,
  noveltyResult: NoveltyResult,
  salience: SalienceResult,
): WriteResult {
  const previousConfidence = matched.confidence;
  const previousAccessCount = matched.accessCount;
  const newConfidence = Math.min(
    REINFORCE_CONFIDENCE_CEIL,
    previousConfidence + REINFORCE_CONFIDENCE_DELTA,
  );
  store.updateConfidence(matched.id, newConfidence);
  store.touchEngram(matched.id);

  // Return the engram with the updated values reflected (the DB write
  // happened above; the in-memory object is one snapshot behind).
  const refreshed: Engram = {
    ...matched,
    confidence: newConfidence,
    accessCount: previousAccessCount + 1,
    lastAccessed: new Date(),
  };

  return {
    action: 'reinforce',
    engram: refreshed,
    salience: null,
    noveltyResult,
    reinforce: { previousConfidence, newConfidence, previousAccessCount },
  };
}

function createNewEngram(
  engines: WritePipelineEngines,
  input: WriteInput,
  salience: SalienceResult,
  noveltyResult: NoveltyResult,
  meta: {
    effectiveEventType: SalienceEventType;
    effectiveMemoryClass: MemoryClass | undefined;
    supersedesId: string | undefined;
  },
): WriteResult {
  const { store, connectionEngine } = engines;

  const isLowSalience = salience.disposition === 'discard';

  // Confidence: caller wins, then disposition-aware prior, then fall back
  // to eventType prior.
  const confidence = input.confidence
    ?? (isLowSalience
      ? 0.25
      : salience.disposition === 'staging'
        ? 0.40
        : CONFIDENCE_PRIORS[meta.effectiveEventType] ?? 0.45);

  const tags = [...(input.tags ?? [])];
  if (isLowSalience && !tags.includes('low-salience')) tags.push('low-salience');

  const engram = store.createEngram({
    agentId: input.agentId,
    concept: input.concept,
    content: input.content,
    tags,
    salience: salience.score,
    confidence,
    salienceFeatures: salience.features,
    reasonCodes: salience.reasonCodes,
    memoryClass: meta.effectiveMemoryClass,
    memoryType: input.memoryType,
    ttl: salience.disposition === 'staging' ? DEFAULT_AGENT_CONFIG.stagingTtlMs : undefined,
    supersedes: meta.supersedesId,
    sequence: input.sequence,
    references: input.references,
  });

  if (salience.disposition === 'staging') {
    store.updateStage(engram.id, 'staging');
  }

  // Supersession side-effects: mark the old engram, add causal edge.
  if (meta.supersedesId) {
    try {
      const oldEngram = store.getEngram(meta.supersedesId);
      if (oldEngram) {
        store.supersedeEngram(meta.supersedesId, engram.id);
        store.upsertAssociation(engram.id, oldEngram.id, 0.8, 'causal', 0.9);
      }
    } catch { /* supersession is best-effort */ }
  }

  // Connection discovery — only for non-staged writes (active or low-salience).
  // Structural engrams skip connection discovery: they're event-log records,
  // not observations the agent needs to think about (0.8 Cluster A).
  const isStructural = meta.effectiveMemoryClass === 'structural';
  if ((salience.disposition === 'active' || isLowSalience) && !isStructural) {
    try { connectionEngine.enqueue(engram.id); } catch { /* non-fatal */ }
  }

  // Async embed — never blocks the response, failure non-fatal.
  // Structural engrams skip embedding by default (deterministic retrieval only).
  // Caller can override by passing `embed: true` on the write input.
  const shouldEmbed = !isStructural || input.embed === true;
  if (shouldEmbed) {
    embed(`${input.concept} ${input.content}`)
      .then(vec => {
        try { store.updateEmbedding(engram.id, vec); } catch { /* engram may be evicted */ }
      })
      .catch(() => { /* embed failure tolerated */ });
  }

  const action: WriteAction = meta.supersedesId ? 'supersede' : 'create';
  return {
    action,
    engram,
    salience,
    noveltyResult,
    supersedeOf: meta.supersedesId ? { id: meta.supersedesId } : undefined,
  };
}
