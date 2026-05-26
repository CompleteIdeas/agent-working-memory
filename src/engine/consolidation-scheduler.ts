// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Consolidation Scheduler - sleep-only consolidation (AWM 0.8.x).
 *
 * Two triggers, both modeled on biological sleep (offline consolidation, not in-band):
 *
 *   1. Cron - fires at a configured time (default: 0 3 * * * = 3 AM local time).
 *      Configurable via AWM_CONSOLIDATION_CRON env var.
 *
 *   2. Quiescence - fires when ALL active agents have been idle >30 min.
 *      "Truly asleep" - no agent is currently writing or recalling.
 *
 * Kill switch: AWM_DISABLE_SCHEDULER=1 skips both triggers. Manual
 * consolidation via POST /system/consolidate still works.
 *
 * Removed in 2.0: in-band idle/volume/time/precision triggers that fired
 * during active hours and blocked HTTP.
 *
 * Tick granularity: 1 minute (sufficient for cron-at-the-minute precision
 * and quiescence checks at human timescales).
 */

import type { IEngramStore as EngramStore } from '../storage/store.js';
import type { ConsolidationEngine } from './consolidation.js';

const TICK_INTERVAL_MS = 60_000;             // Check every 60s
const QUIESCENCE_THRESHOLD_MS = 30 * 60_000; // 30 minutes
const DEFAULT_CRON = '0 3 * * *';            // 3 AM local time daily

// --- Cron matcher (hand-rolled, minute-granularity) ---

/**
 * Parse a single cron field into a Set of valid integer values.
 * Supports: wildcard, literal value, range A-B, list A,B,C, step A-B/N.
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    // Handle step: <range>/N
    const stepMatch = part.match(/^(.+?)\/(\d+)$/);
    if (stepMatch) {
      const range = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0) continue;
      const [lo, hi] = range === '*'
        ? [min, max]
        : range.includes('-')
          ? range.split('-').map(n => parseInt(n, 10)) as [number, number]
          : [parseInt(range, 10), max];
      for (let n = lo; n <= hi; n += step) {
        if (n >= min && n <= max) result.add(n);
      }
      continue;
    }
    // Range: A-B
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(n => parseInt(n, 10));
      for (let n = lo; n <= hi; n++) {
        if (n >= min && n <= max) result.add(n);
      }
      continue;
    }
    // Wildcard
    if (part === '*') {
      for (let n = min; n <= max; n++) result.add(n);
      continue;
    }
    // Single value
    const n = parseInt(part, 10);
    if (!Number.isNaN(n) && n >= min && n <= max) result.add(n);
  }
  return result;
}

/**
 * Return true if `now` matches the cron expression at minute granularity.
 * Format: "minute hour dayOfMonth month dayOfWeek" (5 fields, space-separated).
 * Day-of-week: 0-6 (0 = Sunday). 7 is also accepted as Sunday alias.
 */
export function cronMatches(now: Date, expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeekRaw = parseCronField(fields[4], 0, 7);
  // Normalize: 7 == 0 (Sunday)
  const daysOfWeek = new Set<number>();
  for (const d of daysOfWeekRaw) daysOfWeek.add(d === 7 ? 0 : d);

  return (
    minutes.has(now.getMinutes()) &&
    hours.has(now.getHours()) &&
    daysOfMonth.has(now.getDate()) &&
    months.has(now.getMonth() + 1) &&
    daysOfWeek.has(now.getDay())
  );
}

// --- Scheduler ---

export class ConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly cronExpr: string;
  private readonly disabled: boolean;
  private lastCronTriggeredMinute: string | null = null;

  constructor(
    private store: EngramStore,
    private consolidationEngine: ConsolidationEngine,
  ) {
    this.cronExpr = process.env.AWM_CONSOLIDATION_CRON ?? DEFAULT_CRON;
    this.disabled = process.env.AWM_DISABLE_SCHEDULER === '1' || process.env.AWM_DISABLE_SCHEDULER === 'true';
  }

  start(): void {
    if (this.timer) return;
    if (this.disabled) {
      console.log('ConsolidationScheduler disabled (AWM_DISABLE_SCHEDULER=1)');
      return;
    }
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log(`ConsolidationScheduler started - cron='${this.cronExpr}', quiescence-gate=${QUIESCENCE_THRESHOLD_MS / 60_000}min`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('ConsolidationScheduler stopped');
  }

  /** True if the scheduler is currently running a consolidation cycle. */
  isRunning(): boolean {
    return this.running;
  }

  /** True if the scheduler's automatic triggers are disabled (kill switch). */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Mini-consolidation - lightweight, called from restore path.
   * Only runs replay + strengthen (phases 1-2), skips heavy phases.
   */
  async runMiniConsolidation(agentId: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      console.log(`[scheduler] mini-consolidation for ${agentId}`);
      await this.consolidationEngine.consolidate(agentId);
      await this.store.markConsolidation(agentId, true);
    } catch (err) {
      console.error(`[scheduler] mini-consolidation failed for ${agentId}:`, err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Tick handler - checks both triggers. Cron first (planned), then quiescence (opportunistic).
   * Fires consolidation for at most one agent per tick to avoid overload.
   */
  private async tick(): Promise<void> {
    if (this.running) return;
    const now = new Date();

    // Trigger 1: cron
    if (cronMatches(now, this.cronExpr)) {
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
      if (this.lastCronTriggeredMinute !== minuteKey) {
        this.lastCronTriggeredMinute = minuteKey;
        const agent = await this.pickAgent();
        if (agent) {
          this.runFullConsolidation(agent.agentId, `cron (${this.cronExpr})`);
          return;
        }
      }
    }

    // Trigger 2: quiescence
    if (await this.isQuiescent(now)) {
      const agent = await this.pickAgent();
      if (agent) {
        this.runFullConsolidation(agent.agentId, `quiescence (>${QUIESCENCE_THRESHOLD_MS / 60_000}min idle, all agents)`);
        return;
      }
    }
  }

  /**
   * Pick the agent that benefits most from consolidation:
   * highest writeCount since last consolidation, tie-break by oldest consolidation.
   */
  private async pickAgent(): Promise<{ agentId: string } | null> {
    const agents = await this.store.getActiveAgents();
    if (agents.length === 0) return null;
    const sorted = [...agents].sort((a, b) => {
      if (b.writeCount !== a.writeCount) return b.writeCount - a.writeCount;
      const aT = a.lastConsolidationAt?.getTime() ?? 0;
      const bT = b.lastConsolidationAt?.getTime() ?? 0;
      return aT - bT;
    });
    return sorted[0];
  }

  /**
   * Quiescence check: ALL active agents must have lastActivityAt > threshold ago.
   * `lastActivityAt` is updated on both writes and recalls so this captures both.
   * If no active agents, the system is trivially quiescent.
   */
  private async isQuiescent(now: Date): Promise<boolean> {
    const agents = await this.store.getActiveAgents();
    if (agents.length === 0) return true;
    const nowMs = now.getTime();
    for (const agent of agents) {
      const idleMs = nowMs - agent.lastActivityAt.getTime();
      if (idleMs < QUIESCENCE_THRESHOLD_MS) return false;
    }
    return true;
  }

  private async runFullConsolidation(agentId: string, reason: string): Promise<void> {
    this.running = true;
    try {
      console.log(`[scheduler] full consolidation for ${agentId} - trigger: ${reason}`);
      const result = await this.consolidationEngine.consolidate(agentId);
      await this.store.markConsolidation(agentId, false);
      console.log(`[scheduler] consolidation done: ${result.edgesStrengthened} strengthened, ${result.memoriesForgotten} forgotten`);
    } catch (err) {
      console.error(`[scheduler] consolidation failed for ${agentId}:`, err);
    } finally {
      this.running = false;
    }
  }
}
