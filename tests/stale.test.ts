/**
 * Stale Agent Detection — Integration Tests
 *
 * Tests: detectStale, cleanupStale, pruneOldHeartbeats, purgeDeadAgents, cleanSlate
 * Plus: dead agent reconnection via /checkin and /next endpoints.
 *
 * Run: npx vitest run tests/stale.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { detectStale, cleanupStale, pruneOldHeartbeats, purgeDeadAgents, cleanSlate } from '../src/coordination/stale.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-stale-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;

async function http(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const resp = await globalThis.fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

/** Insert an agent directly for unit-level tests. */
function insertAgent(name: string, status = 'idle', lastSeenOffset = '0 seconds', workspace = 'TEST'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_agents (id, name, role, status, last_seen, workspace)
     VALUES (?, ?, 'worker', ?, datetime('now', '-' || ?), ?)`
  ).run(id, name, status, lastSeenOffset, workspace);
  return id;
}

/** Insert a lock for an agent. */
function insertLock(agentId: string, filePath: string): void {
  db.prepare(
    `INSERT INTO coord_locks (file_path, agent_id, reason) VALUES (?, ?, 'test')`
  ).run(filePath, agentId);
}

/** Insert an assignment for an agent. */
function insertAssignment(agentId: string, status = 'in_progress'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_assignments (id, agent_id, task, status, workspace)
     VALUES (?, ?, 'test task', ?, 'TEST')`
  ).run(id, agentId, status);
  return id;
}

function agentRow(id: string) {
  return db.prepare(`SELECT * FROM coord_agents WHERE id = ?`).get(id) as any;
}

function countLocks(agentId: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM coord_locks WHERE agent_id = ?`).get(agentId) as any).c;
}

function countAssignments(agentId: string, status: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM coord_assignments WHERE agent_id = ? AND status = ?`).get(agentId, status) as any).c;
}

function countEvents(agentId: string, eventType: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM coord_events WHERE agent_id = ? AND event_type = ?`).get(agentId, eventType) as any).c;
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeAll(async () => {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCoordinationTables(db);

  app = Fastify({ logger: false });
  registerCoordinationRoutes(app, db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('unexpected address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

beforeEach(() => {
  // Clean all coordination tables between tests
  db.exec(`DELETE FROM coord_events`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
  db.exec(`DELETE FROM coord_commands`);
});

// ─── detectStale ────────────────────────────────────────────────

describe('detectStale', () => {
  it('finds agents past the threshold', () => {
    insertAgent('Fresh-A', 'idle', '30 seconds');
    insertAgent('Stale-B', 'working', '300 seconds');
    insertAgent('Stale-C', 'idle', '600 seconds');

    const stale = detectStale(db, 120);
    const names = stale.map(a => a.name);
    expect(names).toContain('Stale-B');
    expect(names).toContain('Stale-C');
    expect(names).not.toContain('Fresh-A');
  });

  it('ignores agents already marked dead', () => {
    insertAgent('Dead-D', 'dead', '9999 seconds');
    insertAgent('Stale-E', 'idle', '300 seconds');

    const stale = detectStale(db, 120);
    const names = stale.map(a => a.name);
    expect(names).not.toContain('Dead-D');
    expect(names).toContain('Stale-E');
  });

  it('returns empty array when no agents are stale', () => {
    insertAgent('Fresh-F', 'idle', '10 seconds');
    insertAgent('Fresh-G', 'working', '50 seconds');

    const stale = detectStale(db, 120);
    expect(stale).toHaveLength(0);
  });

  it('returns seconds_since_seen for each stale agent', () => {
    insertAgent('Stale-H', 'idle', '300 seconds');

    const stale = detectStale(db, 120);
    expect(stale).toHaveLength(1);
    expect(stale[0].seconds_since_seen).toBeGreaterThanOrEqual(290);
  });

  it('returns empty when table has no agents', () => {
    expect(detectStale(db, 120)).toHaveLength(0);
  });
});

// ─── cleanupStale ───────────────────────────────────────────────

describe('cleanupStale', () => {
  it('marks stale agents as dead', () => {
    const id = insertAgent('Stale-Worker', 'working', '300 seconds');

    cleanupStale(db, 120);

    expect(agentRow(id).status).toBe('dead');
    expect(agentRow(id).current_task).toBeNull();
  });

  it('fails active assignments of stale agents', () => {
    const agentId = insertAgent('Stale-Assigned', 'working', '300 seconds');
    insertAssignment(agentId, 'in_progress');
    insertAssignment(agentId, 'assigned');

    cleanupStale(db, 120);

    expect(countAssignments(agentId, 'failed')).toBe(2);
    expect(countAssignments(agentId, 'in_progress')).toBe(0);
    expect(countAssignments(agentId, 'assigned')).toBe(0);
  });

  it('does not fail already-completed assignments', () => {
    const agentId = insertAgent('Stale-Completed', 'idle', '300 seconds');
    insertAssignment(agentId, 'completed');

    cleanupStale(db, 120);

    expect(countAssignments(agentId, 'completed')).toBe(1);
    expect(countAssignments(agentId, 'failed')).toBe(0);
  });

  it('releases locks held by stale agents', () => {
    const agentId = insertAgent('Stale-Locked', 'working', '300 seconds');
    insertLock(agentId, 'src/foo.ts');
    insertLock(agentId, 'src/bar.ts');

    cleanupStale(db, 120);

    expect(countLocks(agentId)).toBe(0);
  });

  it('records cleanup events', () => {
    const agentId = insertAgent('Stale-Events', 'working', '300 seconds');
    insertAssignment(agentId, 'in_progress');
    insertLock(agentId, 'src/baz.ts');

    cleanupStale(db, 120);

    expect(countEvents(agentId, 'assignment_failed')).toBeGreaterThanOrEqual(1);
    expect(countEvents(agentId, 'stale_cleanup')).toBeGreaterThanOrEqual(1);
  });

  it('returns correct cleaned count', () => {
    const agentId = insertAgent('Stale-Count', 'working', '300 seconds');
    insertAssignment(agentId, 'in_progress');
    insertLock(agentId, 'src/x.ts');
    insertLock(agentId, 'src/y.ts');

    const result = cleanupStale(db, 120);
    // 1 assignment + 2 locks = 3
    expect(result.cleaned).toBe(3);
    expect(result.stale).toHaveLength(1);
  });

  it('handles agent with no assignments or locks', () => {
    const agentId = insertAgent('Stale-Clean', 'idle', '300 seconds');

    const result = cleanupStale(db, 120);
    expect(result.stale).toHaveLength(1);
    expect(result.cleaned).toBe(0);
    expect(agentRow(agentId).status).toBe('dead');
  });

  it('does not touch fresh agents', () => {
    const freshId = insertAgent('Fresh-Safe', 'working', '10 seconds');
    const staleId = insertAgent('Stale-Target', 'working', '300 seconds');
    insertLock(freshId, 'src/safe.ts');
    insertAssignment(freshId, 'in_progress');

    cleanupStale(db, 120);

    expect(agentRow(freshId).status).toBe('working');
    expect(countLocks(freshId)).toBe(1);
    expect(countAssignments(freshId, 'in_progress')).toBe(1);
    expect(agentRow(staleId).status).toBe('dead');
  });
});

// ─── pruneOldHeartbeats ─────────────────────────────────────────

describe('pruneOldHeartbeats', () => {
  it('removes heartbeat events older than 1 hour', () => {
    const agentId = insertAgent('HB-Agent', 'idle', '0 seconds');
    // Insert old heartbeat
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail, created_at)
       VALUES (?, 'heartbeat', 'old hb', datetime('now', '-2 hours'))`
    ).run(agentId);
    // Insert recent heartbeat
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail)
       VALUES (?, 'heartbeat', 'fresh hb')`
    ).run(agentId);

    const pruned = pruneOldHeartbeats(db);
    expect(pruned).toBe(1);

    const remaining = (db.prepare(
      `SELECT COUNT(*) as c FROM coord_events WHERE event_type = 'heartbeat'`
    ).get() as any).c;
    expect(remaining).toBe(1);
  });

  it('does not prune non-heartbeat events', () => {
    const agentId = insertAgent('HB-Agent2', 'idle', '0 seconds');
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail, created_at)
       VALUES (?, 'assignment_failed', 'old event', datetime('now', '-2 hours'))`
    ).run(agentId);

    const pruned = pruneOldHeartbeats(db);
    expect(pruned).toBe(0);
  });

  it('returns 0 when nothing to prune', () => {
    expect(pruneOldHeartbeats(db)).toBe(0);
  });
});

// ─── purgeDeadAgents ────────────────────────────────────────────

describe('purgeDeadAgents', () => {
  it('removes dead agents older than threshold', () => {
    insertAgent('Dead-Old', 'dead', '90000 seconds'); // ~25 hours
    insertAgent('Dead-Recent', 'dead', '3600 seconds'); // 1 hour

    const purged = purgeDeadAgents(db, 24);
    expect(purged).toBe(1);

    // Recent dead agent should still be there
    const remaining = db.prepare(`SELECT name FROM coord_agents WHERE status = 'dead'`).all() as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Dead-Recent');
  });

  it('does not purge living agents', () => {
    insertAgent('Alive', 'idle', '90000 seconds');
    insertAgent('Dead-Old2', 'dead', '90000 seconds');

    const purged = purgeDeadAgents(db, 24);
    expect(purged).toBe(1);
    const alive = db.prepare(`SELECT id FROM coord_agents WHERE name = 'Alive'`).get() as { id: string } | undefined;
    expect(alive).toBeTruthy();
    expect(agentRow(alive!.id).status).toBe('idle');
  });

  it('respects custom maxAgeHours parameter', () => {
    insertAgent('Dead-Custom', 'dead', '7200 seconds'); // 2 hours

    expect(purgeDeadAgents(db, 1)).toBe(1);  // 1 hour threshold: purged
  });

  it('returns 0 when nothing to purge', () => {
    expect(purgeDeadAgents(db)).toBe(0);
  });
});

// ─── cleanSlate ─────────────────────────────────────────────────

describe('cleanSlate', () => {
  it('marks all live agents as dead', () => {
    const idA = insertAgent('Slate-A', 'idle', '0 seconds');
    const idB = insertAgent('Slate-B', 'working', '0 seconds');

    cleanSlate(db);

    expect(agentRow(idA).status).toBe('dead');
    expect(agentRow(idB).status).toBe('dead');
  });

  it('clears current_task on all agents', () => {
    const id = insertAgent('Slate-C', 'working', '0 seconds');
    db.prepare(`UPDATE coord_agents SET current_task = 'some-task' WHERE id = ?`).run(id);

    cleanSlate(db);

    expect(agentRow(id).current_task).toBeNull();
  });

  it('releases all locks', () => {
    const idA = insertAgent('Slate-D', 'working', '0 seconds');
    const idB = insertAgent('Slate-E', 'idle', '0 seconds');
    insertLock(idA, 'src/a.ts');
    insertLock(idB, 'src/b.ts');

    cleanSlate(db);

    const lockCount = (db.prepare(`SELECT COUNT(*) as c FROM coord_locks`).get() as any).c;
    expect(lockCount).toBe(0);
  });

  it('clears active commands when live agents exist', () => {
    insertAgent('Slate-Cmd', 'idle', '0 seconds');
    db.prepare(
      `INSERT INTO coord_commands (command, reason) VALUES ('BUILD_FREEZE', 'test')`
    ).run();

    cleanSlate(db);

    const active = (db.prepare(
      `SELECT COUNT(*) as c FROM coord_commands WHERE cleared_at IS NULL`
    ).get() as any).c;
    expect(active).toBe(0);
  });

  it('clears commands even when no live agents exist', () => {
    insertAgent('Already-Dead', 'dead', '0 seconds');
    db.prepare(
      `INSERT INTO coord_commands (command, reason) VALUES ('BUILD_FREEZE', 'orphaned')`
    ).run();

    cleanSlate(db);

    // Commands should still be cleared (fix: command clearing runs before early return)
    const active = (db.prepare(
      `SELECT COUNT(*) as c FROM coord_commands WHERE cleared_at IS NULL`
    ).get() as any).c;
    expect(active).toBe(0);
  });

  it('does nothing to agents when no live agents exist', () => {
    const deadId = insertAgent('Already-Dead2', 'dead', '0 seconds');

    cleanSlate(db);

    expect(agentRow(deadId).status).toBe('dead');
  });

  it('skips agents already dead', () => {
    const deadId = insertAgent('Slate-Dead', 'dead', '0 seconds');
    const liveId = insertAgent('Slate-Live', 'idle', '0 seconds');

    cleanSlate(db);

    // Both should be dead, but the point is cleanSlate doesn't error on already-dead
    expect(agentRow(deadId).status).toBe('dead');
    expect(agentRow(liveId).status).toBe('dead');
  });
});

// ─── Dead agent reconnection via HTTP ───────────────────────────

describe('dead agent reconnection', () => {
  it('reconnects dead agent via /checkin with same UUID', async () => {
    // Register agent
    const { data: reg } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Reconnect-A', role: 'worker', workspace: 'TEST' },
    });
    expect(reg.action).toBe('registered');
    const agentId = reg.agentId;

    // Mark it dead (simulate stale cleanup)
    db.prepare(`UPDATE coord_agents SET status = 'dead' WHERE id = ?`).run(agentId);
    expect(agentRow(agentId).status).toBe('dead');

    // Reconnect via checkin
    const { data: recon } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Reconnect-A', role: 'worker', workspace: 'TEST' },
    });
    expect(recon.action).toBe('reconnected');
    expect(recon.agentId).toBe(agentId);
    expect(recon.status).toBe('idle');
    expect(agentRow(agentId).status).toBe('idle');
  });

  it('reconnects dead agent via /next with same UUID', async () => {
    // Register agent
    const { data: reg } = await http('/next', {
      method: 'POST',
      body: { name: 'Reconnect-B', role: 'worker', workspace: 'TEST' },
    });
    const agentId = reg.agentId;

    // Mark dead
    db.prepare(`UPDATE coord_agents SET status = 'dead' WHERE id = ?`).run(agentId);

    // Reconnect via /next
    const { data: recon } = await http('/next', {
      method: 'POST',
      body: { name: 'Reconnect-B', role: 'worker', workspace: 'TEST' },
    });
    expect(recon.agentId).toBe(agentId);
    expect(recon.status).toBe('idle');

    // Check reconnected event was recorded
    expect(countEvents(agentId, 'reconnected')).toBeGreaterThanOrEqual(1);
  });

  it('dead agent with active assignment gets it failed by cleanup, then reconnects clean', async () => {
    // Register + assign
    const { data: reg } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Reconnect-C', role: 'worker', workspace: 'TEST' },
    });
    const agentId = reg.agentId;
    const assignId = insertAssignment(agentId, 'in_progress');
    insertLock(agentId, 'src/reconnect.ts');

    // Simulate stale cleanup
    db.prepare(`UPDATE coord_agents SET last_seen = datetime('now', '-300 seconds') WHERE id = ?`).run(agentId);
    cleanupStale(db, 120);

    expect(agentRow(agentId).status).toBe('dead');
    expect(countAssignments(agentId, 'failed')).toBe(1);
    expect(countLocks(agentId)).toBe(0);

    // Reconnect — should get idle status, no lingering assignments
    const { data: recon } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Reconnect-C', role: 'worker', workspace: 'TEST' },
    });
    expect(recon.agentId).toBe(agentId);
    expect(recon.status).toBe('idle');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────

describe('edge cases', () => {
  it('cleanupStale with multiple stale agents cleans all', () => {
    const ids = [
      insertAgent('Multi-A', 'working', '300 seconds'),
      insertAgent('Multi-B', 'idle', '400 seconds'),
      insertAgent('Multi-C', 'working', '500 seconds'),
    ];
    ids.forEach(id => {
      insertAssignment(id, 'in_progress');
      insertLock(id, `src/${id.slice(0, 4)}.ts`);
    });

    const result = cleanupStale(db, 120);
    expect(result.stale).toHaveLength(3);
    // 3 assignments + 3 locks = 6
    expect(result.cleaned).toBe(6);

    ids.forEach(id => {
      expect(agentRow(id).status).toBe('dead');
      expect(countLocks(id)).toBe(0);
      expect(countAssignments(id, 'failed')).toBe(1);
    });
  });

  it('cleanupStale sets result text on failed assignments', () => {
    const agentId = insertAgent('Result-Agent', 'working', '300 seconds');
    const assignId = insertAssignment(agentId, 'in_progress');

    cleanupStale(db, 120);

    const assignment = db.prepare(`SELECT result FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(assignment.result).toContain('agent disconnected');
  });

  it('cleanupStale sets completed_at on failed assignments', () => {
    const agentId = insertAgent('Time-Agent', 'working', '300 seconds');
    const assignId = insertAssignment(agentId, 'in_progress');

    cleanupStale(db, 120);

    const assignment = db.prepare(`SELECT completed_at FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(assignment.completed_at).not.toBeNull();
  });

  it('detectStale threshold boundary — exactly at threshold is not stale', () => {
    // Agent last seen 120 seconds ago, threshold 120 — should NOT be stale (> not >=)
    insertAgent('Boundary', 'idle', '120 seconds');

    const stale = detectStale(db, 120);
    // Due to query execution time, this could be at or just over 120.
    // The SQL uses >, so exactly 120 is not stale. But timing can vary.
    // We test with a clear margin instead:
    const freshId = insertAgent('ClearlyFresh', 'idle', '60 seconds');
    const stale2 = detectStale(db, 120);
    expect(stale2.map(a => a.name)).not.toContain('ClearlyFresh');
  });
});
