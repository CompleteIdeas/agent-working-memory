// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Consolidation Scheduler — automatically triggers sleep cycles.
 *
 * Four triggers:
 *   1. Idle — agent inactive >10min → full consolidation
 *   2. Volume — 50+ writes since last consolidation → full consolidation
 *   3. Time — 30min since last consolidation → full consolidation
 *   4. Adaptive — retrieval precision <0.4 → full consolidation
 *
 * Also provides mini-consolidation for restore (fire-and-forget, lightweight).
 * Checks every 30 seconds across all active agents.
 */

import type { EngramStore } from '../storage/sqlite.js';
import type { ConsolidationEngine } from './consolidation.js';

const TICK_INTERVAL_MS = 30_000;         // Check every 30s
const IDLE_THRESHOLD_MS = 10 * 60_000;   // 10 minutes
const VOLUME_THRESHOLD = 50;             // 50 writes
const TIME_THRESHOLD_MS = 30 * 60_000;   // 30 minutes
const PRECISION_THRESHOLD = 0.4;         // Below this triggers consolidation

export class ConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private store: EngramStore,
    private consolidationEngine: ConsolidationEngine,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log('ConsolidationScheduler started (30s tick)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('ConsolidationScheduler stopped');
  }

  /**
   * Mini-consolidation — lightweight, called from restore path.
   * Only runs replay + strengthen (phases 1-2), skips heavy phases.
   */
  async runMiniConsolidation(agentId: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      console.log(`[scheduler] mini-consolidation for ${agentId}`);
      this.consolidationEngine.consolidate(agentId);
      this.store.markConsolidation(agentId, true);
    } catch (err) {
      console.error(`[scheduler] mini-consolidation failed for ${agentId}:`, err);
    } finally {
      this.running = false;
    }
  }

  private tick(): void {
    if (this.running) return;

    const agents = this.store.getActiveAgents();
    const now = Date.now();

    for (const agent of agents) {
      const idleMs = now - agent.lastActivityAt.getTime();
      const sinceConsolidation = agent.lastConsolidationAt
        ? now - agent.lastConsolidationAt.getTime()
        : Infinity;

      let trigger: string | null = null;

      // 1. Idle trigger — agent stopped writing/recalling >10min ago
      if (idleMs > IDLE_THRESHOLD_MS && sinceConsolidation > IDLE_THRESHOLD_MS) {
        trigger = `idle (${Math.round(idleMs / 60_000)}min)`;
      }

      // 2. Volume trigger — many writes accumulated
      if (!trigger && agent.writeCount >= VOLUME_THRESHOLD) {
        trigger = `volume (${agent.writeCount} writes)`;
      }

      // 3. Time trigger — been too long since last consolidation
      if (!trigger && sinceConsolidation > TIME_THRESHOLD_MS) {
        trigger = `time (${Math.round(sinceConsolidation / 60_000)}min)`;
      }

      // 4. Adaptive trigger — precision is low
      if (!trigger) {
        try {
          const precision = this.store.getRetrievalPrecision(agent.agentId, 1);
          if (precision > 0 && precision < PRECISION_THRESHOLD) {
            trigger = `adaptive (precision ${(precision * 100).toFixed(0)}%)`;
          }
        } catch { /* precision check is non-fatal */ }
      }

      if (trigger) {
        this.runFullConsolidation(agent.agentId, trigger);
        return; // One consolidation per tick to avoid overload
      }
    }
  }

  private runFullConsolidation(agentId: string, reason: string): void {
    this.running = true;
    try {
      console.log(`[scheduler] full consolidation for ${agentId} — trigger: ${reason}`);
      const result = this.consolidationEngine.consolidate(agentId);
      this.store.markConsolidation(agentId, false);
      console.log(`[scheduler] consolidation done: ${result.edgesStrengthened} strengthened, ${result.memoriesForgotten} forgotten`);
    } catch (err) {
      console.error(`[scheduler] consolidation failed for ${agentId}:`, err);
    } finally {
      this.running = false;
    }
  }
}
