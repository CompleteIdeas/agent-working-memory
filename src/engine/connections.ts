// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Connection Engine — discovers links between memories.
 *
 * **Lifecycle (v0.8.2):** `enqueue()` just appends to an in-memory queue and
 * returns. The queue is drained by `processQueue()`, which is called from
 * the consolidation cycle. Per-write inline drain was removed because each
 * `findConnections` call runs a full activation cycle (embed + BM25 + vector
 * + rerank) — ~200-500 ms of event-loop blocking per write, queued ahead
 * of subsequent requests under load.
 *
 * Cold-start exception: when the agent has fewer than
 * `AWM_CONNECTION_COLD_START_THRESHOLD` (default 10) active engrams, callers
 * can opt into inline drain via `enqueueAndMaybeFlush()` so the first few
 * writes still produce a useful association graph before the next
 * consolidation cycle fires. Once the pool grows past the threshold, all
 * discovery defers to consolidation regardless.
 *
 * Footprint: when AWM is idle and no consolidation is running, the queue
 * is a plain `string[]` — no timers, no background work, ~24 bytes per
 * queued ID. AWM remains cheap to NOT use.
 */

import type { IEngramStore as EngramStore } from '../storage/store.js';
import type { ActivationEngine } from './activation.js';
import type { Engram } from '../types/index.js';

const COLD_START_THRESHOLD = Number(process.env.AWM_CONNECTION_COLD_START_THRESHOLD ?? 10);

/**
 * R1 — broaden edge FORMATION beyond high-cosine semantic links.
 *
 * The semantic `activate` path only links engrams at ≥0.7 cosine, so two facts
 * that share an entity but are lexically/semantically distant ("my main project
 * is Atlas" vs "Atlas's codename is Magpie") never get an edge — starving the
 * graph walk / spreading activation of exactly the bridges multi-hop needs.
 *
 * When enabled, after the semantic pass we also form *entity co-occurrence*
 * edges: extract proper-noun entities from the engram, find other engrams that
 * literally mention the same entity (BM25 + substring re-check for precision),
 * and link them at a LOWER weight than semantic edges. Recall-only by design —
 * the edges feed candidate generation; the reranker still makes the final cut.
 *
 * Default-OFF (gate per docs/awm-improvement-register.md). Set
 * `AWM_BROAD_EDGES=1` to enable.
 */
const BROAD_EDGES = process.env.AWM_BROAD_EDGES === '1';
/** Max entity-co-occurrence edges formed per engram (on top of semantic). */
const MAX_ENTITY_EDGES = Number(process.env.AWM_BROAD_EDGES_MAX ?? 6);
/** Proper-noun entity extraction — mirrors auto-tagger's `entity:` pattern. */
const ENTITY_RE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)*)\b/g;
/** Common capitalized words that are not useful entity bridges. */
const ENTITY_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'Them',
  'And', 'But', 'For', 'With', 'From', 'Into', 'When', 'What', 'Where', 'Which',
  'While', 'Who', 'Why', 'How', 'Also', 'After', 'Before', 'Because', 'Should',
  'Would', 'Could', 'Will', 'Was', 'Were', 'Has', 'Have', 'Had', 'Not', 'Now',
  'New', 'One', 'Two', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

function extractEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ENTITY_RE)) {
    const name = m[1].trim();
    if (name.length < 3 || name.length > 40) continue;
    if (ENTITY_STOPWORDS.has(name)) continue;
    out.add(name);
  }
  return [...out];
}

export class ConnectionEngine {
  private store: EngramStore;
  private engine: ActivationEngine;
  private threshold: number;
  private queue: string[] = [];
  private processing = false;

  constructor(
    store: EngramStore,
    engine: ActivationEngine,
    threshold: number = 0.7
  ) {
    this.store = store;
    this.engine = engine;
    this.threshold = threshold;
  }

  /**
   * Queue a newly written engram for connection discovery.
   *
   * Synchronous and non-triggering. The queue is drained later by:
   *   - `processQueue()` called from the consolidation cycle, or
   *   - `enqueueAndMaybeFlush()` for cold-start inline drain.
   */
  enqueue(engramId: string): void {
    this.queue.push(engramId);
  }

  /**
   * Queue + opportunistic inline drain for cold-start agents.
   *
   * If the agent has fewer than `AWM_CONNECTION_COLD_START_THRESHOLD`
   * active engrams (default 10), drain the queue inline so the first few
   * writes produce a useful association graph before consolidation runs.
   * Once the pool grows past the threshold, this falls back to deferred
   * (consolidation-driven) drain.
   *
   * Returns immediately — the inline drain runs as a fire-and-forget
   * background task so the calling write doesn't block on it.
   */
  enqueueAndMaybeFlush(engramId: string, agentId: string): void {
    this.queue.push(engramId);
    if (this.processing) return;
    void this.maybeDrainColdStart(agentId);
  }

  private async maybeDrainColdStart(agentId: string): Promise<void> {
    try {
      const count = await this.store.getActiveCount(agentId);
      if (count < COLD_START_THRESHOLD) {
        await this.processQueue();
      }
    } catch {
      // Cold-start drain is best-effort. The next consolidation cycle
      // will drain whatever stayed queued.
    }
  }

  /**
   * Drain the queue: run connection discovery for every queued engram.
   *
   * Called from the consolidation cycle (`ConsolidationEngine.consolidate`)
   * at the start of each run, and from `enqueueAndMaybeFlush()` for
   * cold-start agents. Reentrant-safe via the `processing` flag.
   *
   * Exposed publicly so callers (consolidation, tests) can explicitly drain.
   */
  async processQueue(): Promise<void> {
    if (this.processing) return; // Reentrancy guard
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const engramId = this.queue.shift()!;
        const engram = await this.store.getEngram(engramId);
        if (!engram || engram.stage !== 'active') continue;

        try {
          await this.findConnections(engram);
        } catch {
          // Connection discovery is best-effort — don't crash the server
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Number of engrams currently queued for connection discovery. */
  queueSize(): number {
    return this.queue.length;
  }

  /**
   * Find and create connections for a given engram.
   */
  private async findConnections(engram: Engram): Promise<void> {
    const results = await this.engine.activate({
      agentId: engram.agentId,
      context: `${engram.concept} ${engram.content}`,
      limit: 5,
      minScore: this.threshold,
      internal: true,
      spread: false, // edge discovery must not recurse through R2 spreading
    });

    // Filter out self and already-connected engrams
    const existing = await this.store.getAssociationsFor(engram.id);
    const existingIds = new Set(existing.map(a =>
      a.fromEngramId === engram.id ? a.toEngramId : a.fromEngramId
    ));

    for (const result of results) {
      if (result.engram.id === engram.id) continue;
      if (existingIds.has(result.engram.id)) continue;

      // Create a connection association
      await this.store.upsertAssociation(
        engram.id,
        result.engram.id,
        result.score,
        'connection'
      );

      // Bidirectional
      await this.store.upsertAssociation(
        result.engram.id,
        engram.id,
        result.score,
        'connection'
      );
      existingIds.add(result.engram.id);
    }

    if (BROAD_EDGES) {
      await this.formEntityEdges(engram, existingIds);
    }
  }

  /**
   * R1 — form entity co-occurrence edges (default-off, `AWM_BROAD_EDGES=1`).
   *
   * Extract proper-noun entities from the engram, find other engrams that
   * literally mention the same entity, and link them at a lower weight than
   * the semantic edges above. The BM25 candidate is re-checked with a
   * case-insensitive substring match so a coincidental capitalized word
   * doesn't create a spurious edge (precision guard); edge weight scales with
   * the number of shared entities but stays below the 0.7 semantic floor so
   * semantic links still dominate the graph walk.
   */
  private async formEntityEdges(engram: Engram, existingIds: Set<string>): Promise<void> {
    const entities = extractEntities(`${engram.concept} ${engram.content}`);
    if (entities.length === 0) return;

    // Gather candidates that match any of the engram's entities (BM25 OR).
    const query = entities.slice(0, 6).join(' ');
    const candidates = await this.store.searchBM25(engram.agentId, query, 20);
    const lowerEntities = entities.map(e => e.toLowerCase());

    // Rank candidates by how many of our entities they literally contain.
    const scored: Array<{ id: string; engram: Engram; shared: number }> = [];
    for (const cand of candidates) {
      if (cand.id === engram.id) continue;
      if (existingIds.has(cand.id)) continue;
      if (cand.stage !== 'active') continue;
      const candText = `${cand.concept} ${cand.content}`.toLowerCase();
      let shared = 0;
      for (const ent of lowerEntities) {
        if (candText.includes(ent)) shared++;
      }
      if (shared > 0) scored.push({ id: cand.id, engram: cand, shared });
    }

    scored.sort((a, b) => b.shared - a.shared);
    for (const { id, shared } of scored.slice(0, MAX_ENTITY_EDGES)) {
      // Below the 0.7 semantic floor; more shared entities → stronger edge.
      const weight = Math.min(0.6, 0.4 + 0.1 * shared);
      await this.store.upsertAssociation(engram.id, id, weight, 'connection');
      await this.store.upsertAssociation(id, engram.id, weight, 'connection');
      existingIds.add(id);
    }
  }
}
