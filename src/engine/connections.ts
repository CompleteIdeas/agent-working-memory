// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Connection Engine — discovers links between memories.
 *
 * Runs asynchronously. When a new engram is written, the connection
 * engine checks it against existing memories and forms association
 * edges where resonance exceeds a threshold.
 *
 * Connection memories are first-class engrams — they can themselves
 * activate and form higher-order connections, producing emergent
 * associative structure over time.
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { ActivationEngine } from './activation.js';
import type { Engram } from '../types/index.js';

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
   */
  enqueue(engramId: string): void {
    this.queue.push(engramId);
    if (!this.processing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const engramId = this.queue.shift()!;
      const engram = this.store.getEngram(engramId);
      if (!engram || engram.stage !== 'active') continue;

      try {
        await this.findConnections(engram);
      } catch {
        // Connection discovery is best-effort — don't crash the server
      }
    }

    this.processing = false;
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
    const existing = this.store.getAssociationsFor(engram.id);
    const existingIds = new Set(existing.map(a =>
      a.fromEngramId === engram.id ? a.toEngramId : a.fromEngramId
    ));

    for (const result of results) {
      if (result.engram.id === engram.id) continue;
      if (existingIds.has(result.engram.id)) continue;

      // Create a connection association
      this.store.upsertAssociation(
        engram.id,
        result.engram.id,
        result.score,
        'connection'
      );

      // Bidirectional
      this.store.upsertAssociation(
        result.engram.id,
        engram.id,
        result.score,
        'connection'
      );
    }
  }
}
