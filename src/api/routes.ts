// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * API Routes — the black box interface agents interact with.
 *
 * Core (agent-facing):
 *   POST /memory/write       — write a memory (salience filter decides disposition)
 *   POST /memory/activate    — retrieve by context activation
 *   POST /memory/feedback    — report whether a memory was useful
 *   POST /memory/retract     — invalidate a wrong memory
 *
 * Checkpointing:
 *   POST /memory/checkpoint        — save explicit execution state
 *   GET  /memory/restore/:agentId  — restore state + targeted recall + async mini-consolidation
 *
 * Task management:
 *   POST /task/create         — create a prioritized task
 *   POST /task/update         — update status, priority, or blocking
 *   GET  /task/list/:agentId  — list tasks (filtered by status)
 *   GET  /task/next/:agentId  — get highest-priority actionable task
 *
 * Diagnostic (debugging/eval):
 *   POST /memory/search      — deterministic search (not cognitive)
 *   GET  /memory/:id         — get a specific engram
 *   GET  /agent/:id/stats    — memory stats for an agent
 *   GET  /agent/:id/metrics  — eval metrics
 *   POST /agent/register     — register a new agent
 *
 * System:
 *   POST /system/evict       — trigger eviction check
 *   POST /system/decay       — trigger edge decay
 *   POST /system/consolidate — run sleep cycle (strengthen, decay, sweep)
 *   GET  /health             — health check
 */

import type { FastifyInstance } from 'fastify';
import type { IEngramStore as EngramStore } from '../storage/store.js';
import type { ActivationEngine } from '../engine/activation.js';
import type { ConnectionEngine } from '../engine/connections.js';
import type { EvictionEngine } from '../engine/eviction.js';
import type { RetractionEngine } from '../engine/retraction.js';
import type { EvalEngine } from '../engine/eval.js';
import type { ConsolidationEngine } from '../engine/consolidation.js';
import type { ConsolidationScheduler } from '../engine/consolidation-scheduler.js';
import { evaluateSalience, computeNovelty } from '../core/salience.js';
import type { SalienceEventType } from '../core/salience.js';
import { performWrite } from '../core/write-pipeline.js';
import type { TaskStatus, TaskPriority } from '../types/engram.js';
import type { ConsciousState } from '../types/checkpoint.js';
import { DEFAULT_AGENT_CONFIG } from '../types/agent.js';
import { embed, embedBatch } from '../core/embeddings.js';

export interface MemoryDeps {
  store: EngramStore;
  activationEngine: ActivationEngine;
  connectionEngine: ConnectionEngine;
  evictionEngine: EvictionEngine;
  retractionEngine: RetractionEngine;
  evalEngine: EvalEngine;
  consolidationEngine: ConsolidationEngine;
  consolidationScheduler: ConsolidationScheduler;
}

export function registerRoutes(app: FastifyInstance, deps: MemoryDeps): void {
  const { store, activationEngine, connectionEngine, evictionEngine, retractionEngine, evalEngine, consolidationEngine, consolidationScheduler } = deps;

  // ============================================================
  // CORE — Agent-facing endpoints
  // ============================================================

  app.post('/memory/write', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      concept: string;
      content: string;
      tags?: string[];
      eventType?: SalienceEventType;
      surprise?: number;
      decisionMade?: boolean;
      causalDepth?: number;
      resolutionEffort?: number;
      confidence?: number;
      // Memory class — canonical bypasses salience filter; structural is
      // for system-written event-log records (see 0.8 spec). Restored in
      // 0.8.0 after the field was dropped from the HTTP body schema during
      // the 0.7.x refactor — core/salience.ts:88-89,124,187 and
      // core/write-pipeline.ts:77 still expect and honor it, so HTTP
      // callers were silently losing the canonical-bypass signal.
      memory_class?: 'canonical' | 'working' | 'ephemeral' | 'structural';
      // Optional story-time / sequence ordering (0.8 Cluster A). NULL by
      // default. Used by sortBy: "sequence" on /memory/search and by
      // /memory/latest-by-tag (0.8 Cluster C).
      sequence?: number;
      // Force embedding for structural-class writes. Defaults to false for
      // structural (deterministic retrieval only) — opt in here when cognitive
      // recall over a structural engram is desired. (0.8 Cluster A)
      embed?: boolean;
      // Typed cross-record links (0.8 Cluster D). Each reference is
      // {type, matchEngramId?, matchConcept?}. If matchConcept is given
      // without matchEngramId, AWM resolves it to the most recent active
      // engram at write time and stores BOTH on the reference (stable link).
      // If no match found, stores just matchConcept (caller may be linking
      // to a future or deleted engram). Types: advances | resolves |
      // subverts | abandons | extends | supersedes.
      references?: Array<{
        type: 'advances' | 'resolves' | 'subverts' | 'abandons' | 'extends' | 'supersedes';
        matchEngramId?: string;
        matchConcept?: string;
        matchTags?: string[];
      }>;
      // Agent-provided metadata (stored as searchable tags)
      project?: string;
      topic?: string;
      source?: string;
      confidenceLevel?: string;
      sessionId?: string;
      intent?: string;
    };

    if (!body.agentId || typeof body.agentId !== 'string' ||
        !body.concept || typeof body.concept !== 'string' ||
        !body.content || typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'agentId, concept, and content are required strings' });
    }

    // Assemble tags: user-provided + agent metadata
    const userTags = body.tags ?? [];
    const metaTags: string[] = [];
    if (body.project) metaTags.push(`proj=${body.project}`);
    if (body.topic) metaTags.push(`topic=${body.topic}`);
    if (body.source) metaTags.push(`src=${body.source}`);
    if (body.confidenceLevel) metaTags.push(`conf=${body.confidenceLevel}`);
    if (body.sessionId) metaTags.push(`sid=${body.sessionId}`);
    if (body.intent) metaTags.push(`intent=${body.intent}`);

    // Resolve references (0.8 Cluster D): if matchConcept is given without
    // matchEngramId, look up the most recent active engram with that concept
    // (+ optional matchTags) and store both. Stable link survives concept
    // edits. No match found → store just matchConcept so the intent
    // (link-to-future or link-to-deleted) is preserved.
    const resolvedRefs = await Promise.all((body.references ?? []).map(async ref => {
      if (!ref.matchEngramId && ref.matchConcept) {
        const matched = await store.findActiveMatchByConcept(
          body.agentId, ref.matchConcept, ref.matchTags,
        );
        if (matched) {
          return { type: ref.type, matchEngramId: matched.id, matchConcept: ref.matchConcept };
        }
      }
      return { type: ref.type, matchEngramId: ref.matchEngramId, matchConcept: ref.matchConcept };
    }));

    const result = await performWrite({ store, connectionEngine }, {
      agentId: body.agentId,
      concept: body.concept,
      content: body.content,
      tags: [...userTags, ...metaTags],
      memoryClass: body.memory_class,
      eventType: body.eventType,
      surprise: body.surprise,
      decisionMade: body.decisionMade,
      causalDepth: body.causalDepth,
      resolutionEffort: body.resolutionEffort,
      confidence: body.confidence,
      sequence: body.sequence,
      embed: body.embed,
      references: resolvedRefs.length > 0 ? resolvedRefs : undefined,
    });

    // Auto-checkpoint always (covers create, reinforce, and supersede).
    try { await store.updateAutoCheckpointWrite(body.agentId, result.engram.id); } catch { /* non-fatal */ }

    if (result.action === 'reinforce') {
      return reply.code(200).send({
        stored: false,
        action: 'reinforce',
        disposition: 'reinforced',
        engram: result.engram,
        reinforce: result.reinforce,
        novelty: result.noveltyResult.novelty,
      });
    }

    // create / supersede paths follow legacy temporal-edge + episode logic.
    // Structural-class writes (0.8 Cluster A) skip these: they're system-written
    // event-log records, not conversational beats, so keeping them out of the
    // temporal graph + episode index keeps cognitive retrieval clean.
    const isStructural = body.memory_class === 'structural';
    if (!isStructural) {
      try {
        const prev = await store.getLatestEngram(body.agentId, result.engram.id);
        if (prev) {
          await store.upsertAssociation(prev.id, result.engram.id, 0.3, 'temporal', 0.8);
        }
      } catch { /* Temporal edge creation is non-fatal */ }

      if (result.salience
          && (result.salience.disposition === 'active' || result.salience.disposition === 'discard')) {
        try {
          let episode = await store.getActiveEpisode(body.agentId, 3600_000);
          if (!episode) {
            episode = await store.createEpisode({ agentId: body.agentId, label: body.concept });
          }
          await store.addEngramToEpisode(result.engram.id, episode.id);
        } catch { /* Episode assignment is non-fatal */ }
      }
    }

    const isLowSalience = result.salience?.disposition === 'discard';
    return reply.code(201).send({
      stored: true,
      action: result.action,
      // disposition: legacy field — 'low-salience' is returned for discard so
      // callers know the engram was kept but marked low-value. The raw inner
      // salience decision is exposed as `salienceDisposition` for callers
      // (and tests) that want the unmapped value.
      disposition: isLowSalience ? 'low-salience' : (result.salience?.disposition ?? 'active'),
      salienceDisposition: result.salience?.disposition ?? null,
      salience: result.salience?.score ?? 0,
      reasonCodes: result.salience?.reasonCodes ?? [],
      engram: result.engram,
      supersedeOf: result.supersedeOf,
    });
  });

  /**
   * Bulk write — accepts many facts in one request.
   * Creates engrams in a single transaction, embeds in batch.
   * Returns all IDs for downstream supersession calls.
   */
  app.post('/memory/write-batch', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      sessionId?: string; // Shared session ID for all memories in this batch
      memories: Array<{
        concept: string;
        content: string;
        tags?: string[];
        supersedes?: string;
        sessionId?: string; // Per-memory session override
      }>;
    };

    if (!body.agentId || !body.memories || body.memories.length === 0) {
      return reply.code(400).send({ error: 'agentId and non-empty memories array required' });
    }

    const results: Array<{ id: string; concept: string; disposition: string }> = [];

    for (const mem of body.memories) {
      // Add session ID tag if provided (batch-level or per-memory)
      const sid = mem.sessionId ?? body.sessionId;
      const memTags = [...(mem.tags ?? [])];
      if (sid) memTags.push(`sid=${sid}`);

      const engram = await store.createEngram({
        agentId: body.agentId,
        concept: mem.concept,
        content: mem.content,
        tags: memTags,
        salience: 0.5,
        confidence: 0.5,
        supersedes: mem.supersedes ?? undefined,
      });

      // Handle supersession inline — archive superseded memory to remove from active pool
      if (mem.supersedes) {
        await store.supersedeEngram(mem.supersedes, engram.id);
        await store.updateConfidence(mem.supersedes, 0.1);
        await store.updateStage(mem.supersedes, 'archived'); // Remove from active search pool
      }

      results.push({ id: engram.id, concept: mem.concept, disposition: 'active' });
    }

    // Batch embed synchronously — ensures embeddings are ready before queries hit
    const texts = body.memories.map((m, i) => `${m.concept} ${m.content}`);
    try {
      const vecs = await embedBatch(texts);
      for (let i = 0; i < vecs.length; i++) {
        if (results[i]) {
          await store.updateEmbedding(results[i].id, vecs[i]);
        }
      }
    } catch { /* Embedding failure is non-fatal */ }

    try { await store.updateAutoCheckpointWrite(body.agentId, results[results.length - 1]?.id ?? ''); } catch {}

    return reply.code(201).send({
      stored: results.length,
      results,
    });
  });

  app.post('/memory/activate', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      context: string;
      limit?: number;
      minScore?: number;
      includeStaging?: boolean;
      useReranker?: boolean;
      useExpansion?: boolean;
      abstentionThreshold?: number;
      requireConfidence?: number;
      workspace?: string;
      bm25Only?: boolean;
      granularity?: 'full' | 'compact' | 'auto';
    };

    const results = await activationEngine.activate({
      agentId: body.agentId,
      context: body.context,
      limit: body.limit,
      minScore: body.minScore,
      includeStaging: body.includeStaging,
      useReranker: body.useReranker,
      useExpansion: body.useExpansion,
      abstentionThreshold: body.abstentionThreshold,
      requireConfidence: body.requireConfidence,
      workspace: body.workspace,
      bm25Only: body.bm25Only,
      granularity: body.granularity,
    });

    // Auto-checkpoint: track recall for consolidation scheduling
    try {
      const ids = results.map(r => r.engram.id);
      await store.updateAutoCheckpointRecall(body.agentId, body.context, ids);
    } catch { /* non-fatal */ }

    // Surface recall confidence as a top-level field too — same value is on
    // every result, but it describes the recall as a whole, so exposing it
    // once is easier for consumers (and lets them inspect 0-result recalls).
    const confidence = results[0]?.confidence ?? 0;
    return reply.send({ results, confidence });
  });

  app.post('/memory/feedback', async (req, reply) => {
    const body = req.body as {
      activationEventId?: string;
      engramId: string;
      useful: boolean;
      context?: string;
    };

    await store.logRetrievalFeedback(
      body.activationEventId ?? null,
      body.engramId,
      body.useful,
      body.context ?? ''
    );

    // Update engram confidence based on feedback
    const engram = await store.getEngram(body.engramId);
    if (engram) {
      const config = DEFAULT_AGENT_CONFIG;
      const delta = body.useful
        ? config.feedbackPositiveBoost
        : -config.feedbackNegativePenalty;
      await store.updateConfidence(engram.id, engram.confidence + delta);
    }

    // Touch activity for consolidation scheduling
    if (engram) {
      try { await store.touchActivity(engram.agentId); } catch { /* non-fatal */ }
    }

    return reply.send({ recorded: true });
  });

  app.post('/memory/retract', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      targetEngramId: string;
      reason: string;
      counterContent?: string;
    };

    const result = await retractionEngine.retract({
      agentId: body.agentId,
      targetEngramId: body.targetEngramId,
      reason: body.reason,
      counterContent: body.counterContent,
    });

    // Touch activity for consolidation scheduling
    try { await store.touchActivity(body.agentId); } catch { /* non-fatal */ }

    return reply.send(result);
  });

  app.post('/memory/supersede', async (req, reply) => {
    const body = req.body as {
      // ── Form A — supersede by existing engram IDs (pre-0.8 behavior) ──
      oldEngramId?: string;
      newEngramId?: string;
      // ── Form B — atomic write-and-supersede by concept match (0.8 Cluster D) ──
      agentId?: string;
      matchConcept?: string;
      matchTags?: string[];
      newEngram?: {
        concept: string;
        content: string;
        tags?: string[];
        memory_class?: 'canonical' | 'working' | 'ephemeral' | 'structural';
        sequence?: number;
        eventType?: SalienceEventType;
      };
      // Common
      reason?: string;
    };

    const isFormA = !!(body.oldEngramId && body.newEngramId);
    const isFormB = !!(body.matchConcept && body.newEngram && body.agentId);

    if (isFormA && isFormB) {
      return reply.code(400).send({
        error: 'Pass either {oldEngramId, newEngramId} (Form A) OR ' +
               '{agentId, matchConcept, newEngram} (Form B), not both.',
      });
    }
    if (!isFormA && !isFormB) {
      return reply.code(400).send({
        error: 'Missing required fields. Form A: {oldEngramId, newEngramId}. ' +
               'Form B: {agentId, matchConcept, newEngram}.',
      });
    }

    // ── Form A — by IDs ──
    if (isFormA) {
      const oldEngram = await store.getEngram(body.oldEngramId!);
      const newEngram = await store.getEngram(body.newEngramId!);
      if (!oldEngram) return reply.code(404).send({ error: `Old engram ${body.oldEngramId} not found` });
      if (!newEngram) return reply.code(404).send({ error: `New engram ${body.newEngramId} not found` });

      await store.upsertAssociation(body.newEngramId!, body.oldEngramId!, 0.8, 'causal', 1.0);
      await store.updateConfidence(body.oldEngramId!, oldEngram.confidence * 0.2);
      await store.supersedeEngram(body.oldEngramId!, body.newEngramId!);
      try { await store.touchActivity(oldEngram.agentId); } catch { /* non-fatal */ }

      return reply.send({
        superseded: body.oldEngramId,
        supersededBy: body.newEngramId,
        reason: body.reason ?? 'outdated',
      });
    }

    // ── Form B — atomic write-and-supersede by concept match ──
    // Find old (most recent active match by concept + optional tags), write
    // new engram via performWrite, link them — all in one SQL transaction.
    // If no match: write new anyway, return { superseded: null }.
    // AWM 0.8.x P4b follow-up: Form B atomicity via withTransaction.
    // Holds the SQLite/PGlite lock across the async write + supersede pair
    // so callers never observe a half-completed state.
    const result = await (store.withTransaction(async () => {
      const matched = await store.findActiveMatchByConcept(
        body.agentId!, body.matchConcept!, body.matchTags,
      );

      const writeRes = await performWrite({ store, connectionEngine }, {
        agentId: body.agentId!,
        concept: body.newEngram!.concept,
        content: body.newEngram!.content,
        tags: body.newEngram!.tags ?? [],
        memoryClass: body.newEngram!.memory_class,
        sequence: body.newEngram!.sequence,
        eventType: body.newEngram!.eventType,
        enableReinforcement: false,
      });

      if (matched) {
        await store.upsertAssociation(writeRes.engram.id, matched.id, 0.8, 'causal', 1.0);
        await store.updateConfidence(matched.id, matched.confidence * 0.2);
        await store.supersedeEngram(matched.id, writeRes.engram.id);
      }
      return { writeRes, matched };
    }) as Promise<{ writeRes: Awaited<ReturnType<typeof performWrite>>; matched: any }>);

    try { await store.touchActivity(body.agentId!); } catch { /* non-fatal */ }

    return reply.code(201).send({
      newEngram: result.writeRes.engram,
      superseded: result.matched ? result.matched.id : null,
      supersededBy: result.writeRes.engram.id,
      reason: body.reason ?? 'resolved by concept match',
    });
  });

  // ============================================================
  // DIAGNOSTIC — Debugging and inspection
  // ============================================================

  app.post('/memory/search', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      text?: string;
      concept?: string;
      tags?: string[];          // legacy AND-filter — preserved, equivalent to tagsAll
      tagsAll?: string[];       // 0.8 Cluster B — explicit AND
      tagsAny?: string[];       // 0.8 Cluster B — OR (at least one)
      tagsNone?: string[];      // 0.8 Cluster B — NOT (exclude all)
      stage?: string;
      retracted?: boolean;
      limit?: number;
      offset?: number;
      sortBy?: 'createdAt' | 'sequence' | 'salience' | 'confidence' | 'lastAccessed';
      sortOrder?: 'asc' | 'desc';
    };

    const results = await store.search({
      agentId: body.agentId,
      text: body.text,
      concept: body.concept,
      tags: body.tags,
      tagsAll: body.tagsAll,
      tagsAny: body.tagsAny,
      tagsNone: body.tagsNone,
      stage: body.stage as any,
      retracted: body.retracted,
      limit: body.limit,
      offset: body.offset,
      sortBy: body.sortBy,
      sortOrder: body.sortOrder,
    });

    return reply.send({ results, count: results.length });
  });

  // ============================================================
  // 0.8 Cluster C — materialized-view + atomic-counter endpoints
  // ============================================================

  /**
   * For each distinct value of `tagKey`, return the most recent active
   * engram. Used by NovelForge for "latest emotional state per character",
   * "latest motif phase per motif", etc.
   */
  app.post('/memory/latest-by-tag', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      tagKey: string;                // e.g. "character=", "motif="
      scopeTagsAll?: string[];       // optional narrowing
      retracted?: boolean;
      sortBy?: 'createdAt' | 'sequence';
      limit?: number;
    };
    if (!body.agentId || !body.tagKey) {
      return reply.code(400).send({ error: 'agentId and tagKey are required' });
    }
    const results = await store.getLatestByTag({
      agentId: body.agentId,
      tagKeyPrefix: body.tagKey,
      scopeTagsAll: body.scopeTagsAll,
      retracted: body.retracted ?? false,
      sortBy: body.sortBy,
      limit: body.limit,
    });
    return reply.send({ results, count: results.length });
  });

  /**
   * Filter by tag-set operators, sort by numeric value extracted from a
   * tag prefix, return top N. Used by NovelForge for "top N active
   * promises by weight".
   */
  app.post('/memory/top-by', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      sortField: string;             // tag prefix, e.g. "weight="
      order?: 'asc' | 'desc';        // default desc
      filterTagsAll?: string[];
      filterTagsAny?: string[];
      filterTagsNone?: string[];
      retracted?: boolean;
      limit?: number;
    };
    if (!body.agentId || !body.sortField) {
      return reply.code(400).send({ error: 'agentId and sortField are required' });
    }
    const results = await store.getTopBy({
      agentId: body.agentId,
      sortField: body.sortField,
      order: body.order ?? 'desc',
      filterTagsAll: body.filterTagsAll,
      filterTagsAny: body.filterTagsAny,
      filterTagsNone: body.filterTagsNone,
      retracted: body.retracted ?? false,
      limit: body.limit,
    });
    return reply.send({ results, count: results.length });
  });

  /**
   * Compute effective state of an engram from referenced events. Two
   * targeting modes: by ID, or by concept match (same semantics as Form B's
   * findActiveMatchByConcept).
   */
  app.post('/memory/resolve', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      targetEngramId?: string;
      matchConcept?: string;
      matchTags?: string[];
    };
    if (!body.agentId) {
      return reply.code(400).send({ error: 'agentId is required' });
    }

    let targetId = body.targetEngramId;
    if (!targetId && body.matchConcept) {
      const matched = await store.findActiveMatchByConcept(
        body.agentId, body.matchConcept, body.matchTags,
      );
      if (!matched) {
        return reply.code(404).send({
          error: `No active engram matches concept "${body.matchConcept}"`,
        });
      }
      targetId = matched.id;
    }
    if (!targetId) {
      return reply.code(400).send({
        error: 'Provide either targetEngramId or matchConcept',
      });
    }

    const result = await store.resolveEffectiveState(targetId);
    if (!result) return reply.code(404).send({ error: `Engram ${targetId} not found` });
    return reply.send(result);
  });

  /**
   * Race-free next-sequence allocator. Caller writes the engram with the
   * returned value in `sequence`. Doesn't reserve — concurrent allocations
   * always serialize via BEGIN IMMEDIATE.
   */
  app.get('/memory/sequence/:agentId/next', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const next = await store.allocateNextSequence(agentId);
    return reply.send({ agentId, next });
  });

  app.get('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const engram = await store.getEngram(id);
    if (!engram) return reply.code(404).send({ error: 'Not found' });

    const associations = await store.getAssociationsFor(id);
    return reply.send({ engram, associations });
  });

  app.get('/agent/:id/stats', async (req, reply) => {
    const { id } = req.params as { id: string };
    const active = await store.getEngramsByAgent(id, 'active');
    const staging = await store.getEngramsByAgent(id, 'staging');
    const retracted = (await store.getEngramsByAgent(id, undefined, true)).filter(e => e.retracted);
    const associations = await store.getAllAssociations(id);

    return reply.send({
      agentId: id,
      engrams: {
        active: active.length,
        staging: staging.length,
        retracted: retracted.length,
        total: active.length + staging.length + retracted.length,
      },
      associations: associations.length,
      avgConfidence: active.length > 0
        ? +(active.reduce((s, e) => s + e.confidence, 0) / active.length).toFixed(3)
        : 0,
    });
  });

  app.get('/agent/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string };
    const windowHours = parseInt((req.query as any).window ?? '24', 10);
    const metrics = await evalEngine.computeMetrics(id, windowHours);
    return reply.send({ metrics });
  });

  app.post('/agent/register', async (req, reply) => {
    const body = req.body as { name: string };
    const id = crypto.randomUUID();
    return reply.code(201).send({
      id,
      name: body.name,
      config: DEFAULT_AGENT_CONFIG,
    });
  });

  // ============================================================
  // SYSTEM — Maintenance operations
  // ============================================================

  app.post('/system/evict', async (req, reply) => {
    const body = req.body as { agentId: string };
    const result = await evictionEngine.enforceCapacity(body.agentId, DEFAULT_AGENT_CONFIG);
    return reply.send(result);
  });

  app.post('/system/decay', async (req, reply) => {
    const body = req.body as { agentId: string; halfLifeDays?: number };
    const decayed = await evictionEngine.decayEdges(body.agentId, body.halfLifeDays);
    return reply.send({ edgesDecayed: decayed });
  });

  app.post('/system/consolidate', async (req, reply) => {
    const body = req.body as { agentId: string };
    const result = await consolidationEngine.consolidate(body.agentId);
    return reply.send(result);
  });

  // ============================================================
  // CHECKPOINTING — Conscious state preservation
  // ============================================================

  app.post('/memory/checkpoint', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      currentTask: string;
      decisions?: string[];
      activeFiles?: string[];
      nextSteps?: string[];
      relatedMemoryIds?: string[];
      notes?: string;
      episodeId?: string | null;
    };

    const state: ConsciousState = {
      currentTask: body.currentTask,
      decisions: body.decisions ?? [],
      activeFiles: body.activeFiles ?? [],
      nextSteps: body.nextSteps ?? [],
      relatedMemoryIds: body.relatedMemoryIds ?? [],
      notes: body.notes ?? '',
      episodeId: body.episodeId ?? null,
    };

    store.saveCheckpoint(body.agentId, state);
    return reply.send({ saved: true, agentId: body.agentId });
  });

  app.get('/memory/restore/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const checkpoint = await store.getCheckpoint(agentId);

    const now = Date.now();
    const idleMs = checkpoint
      ? now - checkpoint.auto.lastActivityAt.getTime()
      : 0;

    // Get last written engram for context
    let lastWrite: { id: string; concept: string; content: string } | null = null;
    if (checkpoint?.auto.lastWriteId) {
      const engram = await store.getEngram(checkpoint.auto.lastWriteId);
      if (engram) {
        lastWrite = { id: engram.id, concept: engram.concept, content: engram.content };
      }
    }

    // Recall memories using last context (if available)
    let recalledMemories: Array<{ id: string; concept: string; content: string; score: number }> = [];
    const recallContext = checkpoint?.auto.lastRecallContext
      ?? checkpoint?.executionState?.currentTask
      ?? null;

    if (recallContext) {
      try {
        const results = await activationEngine.activate({
          agentId,
          context: recallContext,
          limit: 5,
          minScore: 0.05,
          useReranker: true,
          useExpansion: true,
        });
        recalledMemories = results.map(r => ({
          id: r.engram.id,
          concept: r.engram.concept,
          content: r.engram.content,
          score: r.score,
        }));
      } catch { /* recall failure is non-fatal */ }
    }

    // Trigger mini-consolidation if idle >5min (async, fire-and-forget)
    const MINI_CONSOLIDATION_IDLE_MS = 5 * 60_000;
    let miniConsolidationTriggered = false;
    if (idleMs > MINI_CONSOLIDATION_IDLE_MS) {
      miniConsolidationTriggered = true;
      consolidationScheduler.runMiniConsolidation(agentId).catch(() => {});
    }

    return reply.send({
      executionState: checkpoint?.executionState ?? null,
      checkpointAt: checkpoint?.checkpointAt ?? null,
      recalledMemories,
      lastWrite,
      idleMs,
      miniConsolidationTriggered,
    });
  });

  // ============================================================
  // TASK MANAGEMENT
  // ============================================================

  app.post('/task/create', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      concept: string;
      content: string;
      tags?: string[];
      priority?: TaskPriority;
      blockedBy?: string;
    };

    const engram = await store.createEngram({
      agentId: body.agentId,
      concept: body.concept,
      content: body.content,
      tags: [...(body.tags ?? []), 'task'],
      salience: 0.9,
      confidence: 0.8,
      salienceFeatures: {
        surprise: 0.5, decisionMade: true, causalDepth: 0.5,
        resolutionEffort: 0.5, eventType: 'decision',
      },
      reasonCodes: ['task-created'],
      taskStatus: body.blockedBy ? 'blocked' : 'open',
      taskPriority: body.priority ?? 'medium',
      blockedBy: body.blockedBy,
    });

    connectionEngine.enqueue(engram.id);
    embed(`${body.concept} ${body.content}`).then(async vec => {
      await store.updateEmbedding(engram.id, vec);
    }).catch(() => {});

    return reply.send(engram);
  });

  app.post('/task/update', async (req, reply) => {
    const body = req.body as {
      taskId: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      blockedBy?: string | null;
    };

    const engram = await store.getEngram(body.taskId);
    if (!engram || !engram.taskStatus) {
      return reply.code(404).send({ error: 'Task not found' });
    }

    if (body.blockedBy !== undefined) {
      await store.updateBlockedBy(body.taskId, body.blockedBy);
    }
    if (body.status) {
      await store.updateTaskStatus(body.taskId, body.status);
    }
    if (body.priority) {
      await store.updateTaskPriority(body.taskId, body.priority);
    }

    return reply.send(await store.getEngram(body.taskId));
  });

  app.get('/task/list/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { status, includeDone } = req.query as { status?: TaskStatus; includeDone?: string };

    let tasks = await store.getTasks(agentId, status);
    if (includeDone !== 'true' && !status) {
      tasks = tasks.filter(t => t.taskStatus !== 'done');
    }

    return reply.send({ tasks, count: tasks.length });
  });

  app.get('/task/next/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const next = await store.getNextTask(agentId);
    return reply.send(next ? { task: next } : { task: null, message: 'No actionable tasks' });
  });

  // Time warp — shift all timestamps backward by N days (for testing)
  app.post('/system/time-warp', async (req, reply) => {
    const body = req.body as { agentId: string; days: number };
    const ms = body.days * 24 * 60 * 60 * 1000;
    const shifted = await store.timeWarp(body.agentId, ms);
    return reply.send({ shifted, days: body.days });
  });

  // ─── Export ─────────────────────────────────────────────────────────────

  app.get('/memory/export', async (req, reply) => {
    const { agentId, all } = req.query as { agentId?: string; all?: string };
    const includeAll = all === 'true';
    // /memory/export uses raw SQL — SQLite-only. On PGlite, callers should use
    // the awm CLI export/merge tools instead.
    if (typeof (store as any).getDb !== 'function') {
      return reply.code(501).send({ error: 'export endpoint requires the SQLite backend' });
    }
    const db = (store as any).getDb();

    let engramSql = `SELECT id, agent_id, concept, content, confidence, salience, access_count,
      last_accessed, created_at, salience_features, reason_codes, stage, ttl,
      retracted, retracted_by, retracted_at, tags
      FROM engrams`;
    const conditions: string[] = [];
    const params: string[] = [];

    if (agentId) {
      conditions.push('agent_id = ?');
      params.push(agentId);
    }
    if (!includeAll) {
      conditions.push('retracted = 0');
      conditions.push("stage = 'active'");
    }
    if (conditions.length > 0) {
      engramSql += ' WHERE ' + conditions.join(' AND ');
    }
    engramSql += ' ORDER BY created_at ASC';

    const engrams = db.prepare(engramSql).all(...params) as { id: string }[];

    const engramIds = new Set(engrams.map(e => e.id));
    const allAssocs = db.prepare(
      `SELECT id, from_engram_id, to_engram_id, weight, confidence, type, activation_count, created_at, last_activated
       FROM associations`
    ).all() as { from_engram_id: string; to_engram_id: string }[];
    const associations = allAssocs.filter(a => engramIds.has(a.from_engram_id) && engramIds.has(a.to_engram_id));

    return reply.send({
      exported_at: new Date().toISOString(),
      agent_id: agentId ?? null,
      include_all: includeAll,
      engrams_count: engrams.length,
      associations_count: associations.length,
      engrams,
      associations,
    });
  });

  // ─── Health ─────────────────────────────────────────────────────────────

  app.get('/health', async () => {
    const coordEnabled = process.env.AWM_COORDINATION === 'true' || process.env.AWM_COORDINATION === '1';
    const base: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.8.5',
      coordination: coordEnabled,
    };
    if (coordEnabled && typeof (deps.store as any).getDb === 'function') {
      try {
        const db = (deps.store as any).getDb();
        const stats = db.prepare(`SELECT
          (SELECT COUNT(*) FROM coord_agents WHERE status != 'dead') AS agents_alive,
          (SELECT COUNT(*) FROM coord_assignments WHERE status = 'pending') AS pending_tasks,
          (SELECT COUNT(*) FROM coord_locks) AS active_locks`).get() as { agents_alive: number; pending_tasks: number; active_locks: number };
        Object.assign(base, stats);
      } catch { /* tables may not exist yet */ }
    }
    return base;
  });
}
