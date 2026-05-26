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
    }
  }
}
