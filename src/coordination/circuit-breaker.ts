// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-worker CircuitBreaker for the coordination control layer.
 * Prevents chronically-stale workers from poisoning the assignment queue.
 * Part of AWM 0.8.1 — additive, no breaking changes.
 *
 * States:
 *   closed    — normal operation
 *   open      — worker blocked after FAILURE_THRESHOLD consecutive failures
 *   half_open — probe window (30s after open), allows one assignment attempt
 */

import type Database from 'better-sqlite3';

export type CircuitState = 'closed' | 'open' | 'half_open';

const FAILURE_THRESHOLD = 5;
const HALF_OPEN_DELAY_MS = 30_000;

/** Record a worker failure. Opens the circuit when consecutive failures hit the threshold. */
export function recordFailure(db: Database.Database, agentId: string): void {
  db.prepare(`
    INSERT INTO coord_circuit_state (agent_id, consecutive_failures, last_transition_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      consecutive_failures = consecutive_failures + 1,
      state = CASE
        WHEN consecutive_failures + 1 >= ${FAILURE_THRESHOLD} THEN 'open'
        ELSE state
      END,
      opened_at = CASE
        WHEN consecutive_failures + 1 >= ${FAILURE_THRESHOLD} AND (state != 'open' OR opened_at IS NULL)
        THEN datetime('now')
        ELSE opened_at
      END,
      last_transition_at = datetime('now')
  `).run(agentId);
}

/** Record a worker success. Resets to closed regardless of prior state. */
export function recordSuccess(db: Database.Database, agentId: string): void {
  db.prepare(`
    INSERT INTO coord_circuit_state (agent_id, state, consecutive_failures, last_transition_at)
    VALUES (?, 'closed', 0, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      state = 'closed',
      consecutive_failures = 0,
      opened_at = NULL,
      last_transition_at = datetime('now')
  `).run(agentId);
}

/**
 * Get current circuit state for a worker.
 * If the circuit has been open for >30s, auto-transitions to half_open.
 */
export function getState(db: Database.Database, agentId: string): CircuitState {
  const row = db.prepare(
    `SELECT state, opened_at FROM coord_circuit_state WHERE agent_id = ?`
  ).get(agentId) as { state: string; opened_at: string | null } | undefined;

  if (!row || row.state === 'closed') return 'closed';
  if (row.state === 'half_open') return 'half_open';

  // open — check if half-open window has elapsed
  if (row.state === 'open' && row.opened_at) {
    const openedAt = new Date(row.opened_at.endsWith('Z') ? row.opened_at : row.opened_at + 'Z').getTime();
    if (Date.now() - openedAt > HALF_OPEN_DELAY_MS) {
      db.prepare(
        `UPDATE coord_circuit_state SET state = 'half_open', last_transition_at = datetime('now') WHERE agent_id = ?`
      ).run(agentId);
      return 'half_open';
    }
  }

  return 'open';
}

/** Returns true when the worker is eligible to receive an assignment. */
export function isAvailable(db: Database.Database, agentId: string): boolean {
  return getState(db, agentId) !== 'open';
}
