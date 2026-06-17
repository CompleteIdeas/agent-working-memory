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

import type { IEngramStore as EngramStore } from '../storage/store.js';
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
import { extractMetaTags } from './auto-tagger.js';
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
export async function performWrite(
  engines: WritePipelineEngines,
  input: WriteInput,
): Promise<WriteResult> {
  const { store, connectionEngine } = engines;
  const enableReinforcement = input.enableReinforcement !== false
    && process.env.AWM_WRITE_PIPELINE !== 'off';

  // Profiling: AWM_PROFILE_WRITE=1 logs ms-per-phase to stderr (v0.8.2).
  // Off by default; zero cost when unset.
  const profile = process.env.AWM_PROFILE_WRITE === '1';
  const startTotal = profile ? performance.now() : 0;
  let tNovelty = 0, tCreate = 0, tEmbed = 0;

  // Pre-embed once (v0.8.5): the embedding is needed for cosine-based novelty
  // and is also the embedding we'll store on the engram. Computing it once
  // here costs ~50-100ms but saves the post-write async embed pass (which
  // used to run after createEngram). Net cost is the same; we just pay it
  // synchronously up front in exchange for a backend-agnostic novelty signal.
  //
  // If embed fails (model not loaded, hardware issue), we silently fall back
  // to BM25-only novelty and write without an embedding (the async embed
  // hook below will retry).
  // Disable via AWM_NOVELTY_EMBED=0 to keep writes ultra-fast at the cost
  // of cross-backend novelty consistency.
  const tStartEmbed = profile ? performance.now() : 0;
  let prewriteEmbedding: number[] | null = null;
  if (process.env.AWM_NOVELTY_EMBED !== '0') {
    try {
      prewriteEmbedding = await embed(`${input.concept} ${input.content}`);
    } catch { /* fall through — async embed will retry later */ }
  }
  if (profile) tEmbed = performance.now() - tStartEmbed;

  const tStartNovelty = profile ? performance.now() : 0;
  const noveltyResult = await computeNoveltyWithMatch(
    store, input.agentId, input.concept, input.content,
    input.workspace ?? null,
    prewriteEmbedding,
  );
  if (profile) tNovelty = performance.now() - tStartNovelty;

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
  const tStartCreate = profile ? performance.now() : 0;
  let result: WriteResult | null = null;
  if (enableReinforcement && noveltyResult.matchedEngramId) {
    const matched = await store.getEngram(noveltyResult.matchedEngramId);
    if (matched) {
      const newConcept = (input.concept ?? '').toLowerCase().trim();
      const matchedConcept = (matched.concept ?? '').toLowerCase().trim();
      const sameConcept = newConcept === matchedConcept && newConcept.length > 0;

      if (sameConcept) {
        const isCorrectionSignal = effectiveEventType === 'surprise'
          || effectiveEventType === 'friction';

        if (isCorrectionSignal) {
          // R3 — supersede the matched engram with the new write.
          // Force `active` disposition (v0.8.5): the user explicitly flagged
          // this write as a correction (eventType=surprise/friction). Without
          // this override, cosine-based novelty (which correctly recognizes
          // the correction's semantic similarity to the engram it's
          // correcting) would push salience low and the correction would
          // land in 'staging'. That broke the R2 superseder-reinforce chain
          // for later writes (the chain requires stage='active'). The user's
          // explicit correction intent must win over the duplicate-detection
          // signal. R3 corrections always go active.
          const correctionSalience: SalienceResult = {
            ...salience,
            disposition: 'active' as const,
            reasonCodes: [...salience.reasonCodes, 'correction:override-active'],
          };
          result = await createNewEngram(engines, input, correctionSalience, noveltyResult, {
            effectiveEventType,
            effectiveMemoryClass,
            supersedesId: matched.id,
          }, prewriteEmbedding);
        } else {
          // R2 — health check on the matched engram
          const isHealthy = matched.stage === 'active'
            && matched.confidence >= HEALTHY_CONFIDENCE_FLOOR
            && matched.supersededBy == null;

          if (isHealthy) {
            // R1 — reinforce (and merge new content into matched engram, v0.8.5)
            result = await reinforceMatched(store, matched, noveltyResult, salience, input.content, input.concept);
          } else if (matched.supersededBy) {
            // Unhealthy match but it was superseded — try to reinforce the superseder
            const superseder = await store.getEngram(matched.supersededBy);
            if (superseder && superseder.stage === 'active'
                && superseder.confidence >= HEALTHY_CONFIDENCE_FLOOR
                && superseder.supersededBy == null) {
              result = await reinforceMatched(store, superseder, noveltyResult, salience, input.content, input.concept);
            }
          }
        }
      }
    }
  }

  // -- Default: create new engram (if no reinforce/supersede branch fired) --
  if (!result) {
    result = await createNewEngram(engines, input, salience, noveltyResult, {
      effectiveEventType,
      effectiveMemoryClass,
      supersedesId: input.supersedes,
    }, prewriteEmbedding);
  }
  if (profile) tCreate = performance.now() - tStartCreate;

  if (profile) {
    const total = performance.now() - startTotal;
    // Single-line stderr log; cheap to grep, easy to disable.
    // Format: [write] action=create novelty=42.1ms create=18.3ms total=60.4ms agent=x id=y
    // eslint-disable-next-line no-console
    console.error(
      `[awm-write] action=${result.action} embed=${tEmbed.toFixed(1)}ms novelty=${tNovelty.toFixed(1)}ms create=${tCreate.toFixed(1)}ms total=${total.toFixed(1)}ms agent=${input.agentId} id=${result.engram.id}`,
    );
  }

  return result;
}

/**
 * Reinforce-merge upper bound on content length (chars). When an engram's
 * merged content would exceed this, we drop the OLDEST reinforced segment(s)
 * to make room for the new one. Recency wins because later reinforces
 * usually elaborate on the topic with more specific keywords. Configurable
 * via `AWM_REINFORCE_MAX_CONTENT_LEN`.
 *
 * Default lowered to 1500 chars (~375 tokens) in v0.8.5 follow-up after
 * test:tokens showed 4000-char cap produced 3.5× baseline AWM context size
 * on concept-collision corpora (e.g. concept="${task} conversation"). 1500
 * is large enough to hold ~3–4 reinforced segments without blowing token
 * budget on recall.
 */
const REINFORCE_MAX_CONTENT_LEN = Number(process.env.AWM_REINFORCE_MAX_CONTENT_LEN ?? 1500);
const REINFORCE_SEPARATOR = '\n\n--- reinforced ---\n';

/**
 * Merge new content into an existing engram on reinforce (v0.8.5).
 *
 * Prior behavior: reinforce-on-duplicate kept ONLY the first write's
 * content. Subsequent same-concept writes bumped confidence + accessCount
 * but their content was discarded. When the new content carried valuable
 * keyword detail (later writes elaborating on the topic), that information
 * was lost — confirmed via scripts/trace-recall-divergence.ts on
 * test:tokens, where multi-turn auth-assistant content (HS256, refresh
 * tokens, 15 min, 7 day) consolidated into the FIRST auth-assistant turn's
 * content (just "I'll set up JWT auth with jsonwebtoken...") losing all
 * keyword info.
 *
 * Behavior: append the new content with a separator, unless it's already a
 * substring of the existing content (true repeat — no info gain). When the
 * projected length exceeds REINFORCE_MAX_CONTENT_LEN, drop the OLDEST
 * reinforced segment(s) until it fits. The first segment (original write)
 * is also evictable if subsequent reinforces have replaced it with more
 * specific content.
 *
 * Returns `{ merged, appended }` so callers can skip the re-embed + DB
 * update when nothing changed.
 */
function mergeReinforcedContent(existing: string, addition: string): { merged: string; appended: boolean } {
  const trimmed = (addition ?? '').trim();
  if (!trimmed) return { merged: existing, appended: false };
  // Already-covered: new content is a substring of existing — true repeat.
  if (existing.includes(trimmed)) return { merged: existing, appended: false };

  // Split into segments on the separator so we can drop oldest on overflow.
  const segments = existing.split(REINFORCE_SEPARATOR);
  segments.push(trimmed);
  let projected = segments.join(REINFORCE_SEPARATOR);

  // Drop oldest segments until the projected content fits the cap. Always
  // keep the new content (segments[last]) — if even the new addition alone
  // exceeds the cap, we keep it anyway since recency drives value.
  while (projected.length > REINFORCE_MAX_CONTENT_LEN && segments.length > 1) {
    segments.shift();
    projected = segments.join(REINFORCE_SEPARATOR);
  }
  return { merged: projected, appended: true };
}

async function reinforceMatched(
  store: EngramStore,
  matched: Engram,
  noveltyResult: NoveltyResult,
  salience: SalienceResult,
  /** The new write's content, so we can merge it into the matched engram (v0.8.5). */
  newContent: string = '',
  /** The new write's concept, used for re-embed text when content changes. */
  newConceptHint: string = '',
): Promise<WriteResult> {
  const previousConfidence = matched.confidence;
  const previousAccessCount = matched.accessCount;
  const newConfidence = Math.min(
    REINFORCE_CONFIDENCE_CEIL,
    previousConfidence + REINFORCE_CONFIDENCE_DELTA,
  );
  await store.updateConfidence(matched.id, newConfidence);
  await store.touchEngram(matched.id);

  // v0.8.5: merge new content into existing engram so reinforce-on-duplicate
  // doesn't throw away later writes' information. Re-embed the merged
  // content so semantic recall reflects the accumulated knowledge.
  let mergedContent = matched.content;
  if (newContent && process.env.AWM_REINFORCE_MERGE_CONTENT !== '0') {
    const result = mergeReinforcedContent(matched.content, newContent);
    if (result.appended) {
      mergedContent = result.merged;
      try {
        await store.updateContent(matched.id, mergedContent);
        // Re-embed the merged content so cosine recall surfaces the new
        // info. Use concept + merged-content; embedding model truncates
        // beyond 512 tokens but the topic anchor (early content) drives
        // the vector for retrieval purposes.
        const conceptForEmbed = newConceptHint || matched.concept;
        const newVec = await embed(`${conceptForEmbed} ${mergedContent}`);
        await store.updateEmbedding(matched.id, newVec);
      } catch { /* merge is best-effort — confidence bump already landed */ }
    }
  }

  // Return the engram with the updated values reflected (the DB write
  // happened above; the in-memory object is one snapshot behind).
  const refreshed: Engram = {
    ...matched,
    content: mergedContent,
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

async function createNewEngram(
  engines: WritePipelineEngines,
  input: WriteInput,
  salience: SalienceResult,
  noveltyResult: NoveltyResult,
  meta: {
    effectiveEventType: SalienceEventType;
    effectiveMemoryClass: MemoryClass | undefined;
    supersedesId: string | undefined;
  },
  /** Pre-computed embedding from performWrite (v0.8.5). If non-null, used
   *  directly + skips the post-create async embed pass. */
  prewriteEmbedding: number[] | null = null,
): Promise<WriteResult> {
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

  // Auto-tag meta-tags (default-OFF, AWM_AUTOTAG=1). extractMetaTags emits
  // `entity:<ProperNoun>` and `cat:<category>` tags from concept+content. These
  // are indexed in FTS5 (→ BM25 recall boost on entity/category terms) AND feed
  // the Phase 3.7 entity-bridge boost, which is otherwise STARVED: that boost
  // explicitly skips session/speaker/turn tags, so without `entity:` tags it has
  // nothing to bridge on (inert on LoCoMo and underfed in real use). Gated +
  // additive so existing callers' tags are untouched when off.
  if (process.env.AWM_AUTOTAG === '1') {
    const existing = new Set(tags.map(t => t.toLowerCase()));
    for (const mt of extractMetaTags(input.concept, input.content)) {
      if (!existing.has(mt.toLowerCase())) { tags.push(mt); existing.add(mt.toLowerCase()); }
    }
  }

  const engram = await store.createEngram({
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
    embedding: prewriteEmbedding && prewriteEmbedding.length > 0
      ? prewriteEmbedding
      : undefined,
  });

  if (salience.disposition === 'staging') {
    await store.updateStage(engram.id, 'staging');
  }

  // Supersession side-effects: mark the old engram, add causal edge.
  if (meta.supersedesId) {
    try {
      const oldEngram = await store.getEngram(meta.supersedesId);
      if (oldEngram) {
        await store.supersedeEngram(meta.supersedesId, engram.id);
        await store.upsertAssociation(engram.id, oldEngram.id, 0.8, 'causal', 0.9);
      }
    } catch { /* supersession is best-effort */ }
  }

  // Connection discovery — only for non-staged writes (active or low-salience).
  // Structural engrams skip connection discovery: they're event-log records,
  // not observations the agent needs to think about (0.8 Cluster A).
  //
  // v0.8.2: enqueueAndMaybeFlush queues for the next consolidation cycle
  // (cheap, no event-loop blocking). For cold-start agents (fewer than
  // AWM_CONNECTION_COLD_START_THRESHOLD active engrams, default 10), the
  // queue drains inline as a background task so the first few writes still
  // build a useful association graph before the next consolidation fires.
  const isStructural = meta.effectiveMemoryClass === 'structural';
  if ((salience.disposition === 'active' || isLowSalience) && !isStructural) {
    try { connectionEngine.enqueueAndMaybeFlush(engram.id, input.agentId); } catch { /* non-fatal */ }
  }

  // Async embed — never blocks the response, failure non-fatal.
  // Structural engrams skip embedding by default (deterministic retrieval only).
  // Caller can override by passing `embed: true` on the write input.
  //
  // v0.8.5: skip the async embed entirely when performWrite already
  // pre-computed the embedding for cosine-based novelty. The embedding
  // was passed to createEngram above; no re-embed needed.
  const alreadyEmbedded = prewriteEmbedding != null && prewriteEmbedding.length > 0;
  const shouldEmbed = (!isStructural || input.embed === true) && !alreadyEmbedded;
  if (shouldEmbed) {
    embed(`${input.concept} ${input.content}`)
      .then(async vec => {
        try { await store.updateEmbedding(engram.id, vec); } catch { /* engram may be evicted */ }
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
