// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Stale agent detection and cleanup for the coordination module.
 */

import type Database from 'better-sqlite3';

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

/** Clean up stale agents: fail assignments, release locks, mark dead. */
export function cleanupStale(db: Database.Database, thresholdSeconds: number): { stale: StaleAgent[]; cleaned: number } {
  const stale = detectStale(db, thresholdSeconds);
  let cleaned = 0;

  for (const agent of stale) {
    // Fail active assignments
    const orphaned = db.prepare(
      `UPDATE coord_assignments SET status = 'failed', result = 'agent disconnected (stale)', completed_at = datetime('now')
       WHERE agent_id = ? AND status IN ('assigned', 'in_progress')`
    ).run(agent.id);

    if (orphaned.changes > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_failed', ?)`
      ).run(agent.id, `auto-failed ${orphaned.changes} orphaned assignment(s) — agent stale`);
    }

    // Release locks
    const locks = db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agent.id);

    // Mark dead
    db.prepare(`UPDATE coord_agents SET status = 'dead', current_task = NULL WHERE id = ?`).run(agent.id);

    cleaned += orphaned.changes + locks.changes;

    if (orphaned.changes > 0 || locks.changes > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'stale_cleanup', ?)`
      ).run(agent.id, `failed ${orphaned.changes} assignment(s), released ${locks.changes} lock(s)`);
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
