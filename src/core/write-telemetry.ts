// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Write-path telemetry (D1, 2026-07-30).
 *
 * Purpose: prove the mechanism behind slow writes before building the
 * serialized write service. Captures, per write:
 *   - phase wall times (embed / novelty / persist)
 *   - event-loop lag at write completion (was this process's loop blocked?)
 *   - whether a consolidation cycle was running IN THIS PROCESS
 *   - whether SQLITE_BUSY was hit
 *   - embed-model cold-load duration (first inference)
 *
 * Always-on slow-write warning: any write slower than AWM_SLOW_WRITE_MS
 * (default 250ms; set 0 to disable) emits ONE structured stderr line.
 * AWM_PROFILE_WRITE=1 continues to log every write as before.
 *
 * Design notes: additive module — no existing export changes (MWA vendors
 * dist internals; nothing here alters existing paths). All timers are
 * unref'd so they never hold the process open.
 */

const SLOW_WRITE_MS = (() => {
  const v = Number(process.env.AWM_SLOW_WRITE_MS ?? '250');
  return Number.isFinite(v) ? v : 250;
})();

// ---------- Event-loop lag monitor ----------

const TICK_MS = 500;
let lastTick = 0;
let maxLagSinceRead = 0;
let monitorStarted = false;

/** Start the loop-lag heartbeat. Idempotent; call once at process boot. */
export function startLoopLagMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  lastTick = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - TICK_MS;
    if (lag > maxLagSinceRead) maxLagSinceRead = lag;
    lastTick = now;
  }, TICK_MS);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Max observed loop lag (ms beyond the expected tick) since the last read.
 * Reading resets the max. A large value means this process's event loop was
 * blocked (in-process ML, consolidation, sync SQL) during the window.
 */
export function readMaxLoopLag(): number {
  const v = maxLagSinceRead;
  maxLagSinceRead = 0;
  return Math.max(0, Math.round(v));
}

// ---------- In-process consolidation state ----------

let consolidationActive = false;
let consolidationAgent: string | null = null;
let consolidationStartedAt = 0;

export function setConsolidationActive(active: boolean, agentId?: string): void {
  consolidationActive = active;
  consolidationAgent = active ? (agentId ?? null) : null;
  consolidationStartedAt = active ? performance.now() : 0;
}

export function getConsolidationState(): { active: boolean; agentId: string | null; runningMs: number } {
  return {
    active: consolidationActive,
    agentId: consolidationAgent,
    runningMs: consolidationActive ? Math.round(performance.now() - consolidationStartedAt) : 0,
  };
}

// ---------- Model cold-load record ----------

let modelColdLoadMs: number | null = null;

export function noteModelLoad(ms: number): void {
  if (modelColdLoadMs === null) {
    modelColdLoadMs = Math.round(ms);
    process.stderr.write(`[awm] embed model cold load: ${modelColdLoadMs}ms\n`);
  }
}

export function getModelColdLoadMs(): number | null {
  return modelColdLoadMs;
}

// ---------- Slow-write reporter ----------

export interface WriteTimings {
  totalMs: number;
  embedMs: number;
  noveltyMs: number;
  persistMs: number;
  action: string;        // created | reinforced | superseded | discarded | ...
  agentId: string;
  busyHit: boolean;      // a SQLITE_BUSY was caught (and rethrown) during persist
}

/**
 * Report a completed write. Emits one structured stderr line when the write
 * exceeded the slow threshold (always-on) — including loop lag and in-process
 * consolidation state, the two signals that distinguish "DB lock wait" from
 * "my own event loop was blocked".
 */
export function reportWrite(t: WriteTimings): void {
  if (SLOW_WRITE_MS <= 0) return;
  if (t.totalMs < SLOW_WRITE_MS) return;
  const consol = getConsolidationState();
  const parts = [
    `[awm] SLOW WRITE ${Math.round(t.totalMs)}ms`,
    `agent=${t.agentId}`,
    `action=${t.action}`,
    `embed=${Math.round(t.embedMs)}ms`,
    `novelty=${Math.round(t.noveltyMs)}ms`,
    `persist=${Math.round(t.persistMs)}ms`,
    `loopLagMax=${readMaxLoopLag()}ms`,
    `consolidating=${consol.active ? `yes(${consol.agentId ?? '?'},${consol.runningMs}ms)` : 'no'}`,
    `busy=${t.busyHit ? 'yes' : 'no'}`,
    modelColdLoadMs !== null ? `modelColdLoad=${modelColdLoadMs}ms` : 'modelColdLoad=none',
  ];
  process.stderr.write(parts.join(' ') + '\n');
}
