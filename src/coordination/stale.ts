// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Stale agent detection and cleanup for the coordination module.
 */

import type Database from 'better-sqlite3';
import { classifyFailure, FailureMode, MUTATION_HINTS } from './failure-modes.js';
import { recordFailure as circuitRecordFailure } from './circuit-breaker.js';

interface StaleAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  last_seen: string;
  seconds_since_seen: number;
}

/** Detect agents that haven't checked in within the threshold. */
export function detectStale(db: Database.Database, thresholdSeconds: number): StaleAgent[] {
  return db.prepare(
    `SELECT id, name, role, status, last_seen,
            ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen
     FROM coord_agents
     WHERE status NOT IN ('dead')
       AND (julianday('now') - julianday(last_seen)) * 86400 > ?`
  ).all(thresholdSeconds) as StaleAgent[];
}

/** Maximum retry attempts before an assignment is permanently failed. */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Retry or permanently fail a single assignment.
 * Called from cleanupStale (stale path) and POST /assignment/:id/fail (voluntary path).
 *
 * @returns 'retried' | 'failed'
 */
export function retryOrFailAssignment(
  db: Database.Database,
  assignmentId: string,
  agentId: string,
  failureResult: string,
  mode?: FailureMode,
): 'retried' | 'failed' {
  const row = db.prepare(
    `SELECT attempt_count, description FROM coord_assignments WHERE id = ?`
  ).get(assignmentId) as { attempt_count: number; description: string | null } | undefined;

  const attemptCount = row?.attempt_count ?? 0;
  const failureMode = mode ?? classifyFailure(failureResult);

  if (attemptCount < MAX_RETRY_ATTEMPTS) {
    const hint = MUTATION_HINTS[failureMode];
    const nextAttempt = attemptCount + 1;
    const hintBlock = `\n\n--- RETRY HINT (attempt ${nextAttempt}) ---\n${hint}`;
    const newDescription = (row?.description ?? '') + hintBlock;

    db.prepare(
      `UPDATE coord_assignments
       SET status = 'pending', agent_id = NULL, started_at = NULL, result = NULL,
           attempt_count = ?, last_failure_mode = ?, description = ?
       WHERE id = ?`
    ).run(nextAttempt, failureMode, newDescription, assignmentId);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_retry', ?)`
    ).run(agentId, `attempt ${nextAttempt}: ${failureMode} — ${failureResult.slice(0, 200)}`);

    return 'retried';
  } else {
    db.prepare(
      `UPDATE coord_assignments
       SET status = 'failed', result = ?, last_failure_mode = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).run(failureResult, failureMode, assignmentId);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_failed', ?)`
    ).run(agentId, `permanently failed after ${attemptCount} attempt(s): ${failureResult.slice(0, 200)}`);

    return 'failed';
  }
}

/** Clean up stale agents: retry or fail assignments, release locks, mark dead. */
export function cleanupStale(db: Database.Database, thresholdSeconds: number): { stale: StaleAgent[]; cleaned: number } {
  const stale = detectStale(db, thresholdSeconds);
  let cleaned = 0;

  for (const agent of stale) {
    // Handle each orphaned assignment with retry logic
    const orphanedRows = db.prepare(
      `SELECT id FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress')`
    ).all(agent.id) as Array<{ id: string }>;

    let retried = 0;
    let failed = 0;

    for (const row of orphanedRows) {
      const outcome = retryOrFailAssignment(db, row.id, agent.id, 'agent disconnected (stale)');
      if (outcome === 'retried') retried++;
      else failed++;
    }

    if (orphanedRows.length > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_failed', ?)`
      ).run(agent.id, `stale cleanup: retried ${retried}, permanently failed ${failed}`);

      // Record failure in circuit breaker for each orphaned assignment
      circuitRecordFailure(db, agent.id);
    }

    // Release locks
    const locks = db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agent.id);

    // Mark dead
    db.prepare(`UPDATE coord_agents SET status = 'dead', current_task = NULL WHERE id = ?`).run(agent.id);

    cleaned += orphanedRows.length + locks.changes;

    if (orphanedRows.length > 0 || locks.changes > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'stale_cleanup', ?)`
      ).run(agent.id, `failed ${orphanedRows.length} assignment(s), released ${locks.changes} lock(s)`);
    }
  }

  return { stale, cleaned };
}

/** Prune heartbeat events older than 1 hour. Keeps assignment, registered, and command events permanently. */
export function pruneOldHeartbeats(db: Database.Database): number {
  const result = db.prepare(
    `DELETE FROM coord_events WHERE event_type = 'heartbeat' AND created_at < datetime('now', '-1 hour')`
  ).run();
  return result.changes;
}

/** Purge dead agents older than 24 hours to prevent table bloat. */
export function purgeDeadAgents(db: Database.Database, maxAgeHours = 24): number {
  const result = db.prepare(
    `DELETE FROM coord_agents WHERE status = 'dead' AND last_seen < datetime('now', '-' || ? || ' hours')`
  ).run(maxAgeHours);
  return result.changes;
}

/** Clean slate on startup: mark all live agents dead, release locks, clear commands. */
export function cleanSlate(db: Database.Database): void {
  // Always clear commands, even if no alive agents remain
  db.prepare(`UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL`).run();

  const alive = db.prepare(
    `SELECT id, name FROM coord_agents WHERE status != 'dead'`
  ).all() as Array<{ id: string; name: string }>;

  if (alive.length === 0) return;

  for (const agent of alive) {
    db.prepare(`UPDATE coord_agents SET status = 'dead', current_task = NULL WHERE id = ?`).run(agent.id);
    db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agent.id);
  }

  console.log(`  Coordination clean slate: marked ${alive.length} agent(s) from previous session as dead`);
}
