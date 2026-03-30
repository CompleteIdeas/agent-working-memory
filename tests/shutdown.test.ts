/**
 * POST /shutdown — graceful coordination teardown tests.
 *
 * Verifies:
 * - All live agents are marked dead
 * - Their locks are released
 * - A shutdown event is recorded per agent
 * - Already-dead agents are not double-processed
 * - Returns { ok: true, agents_marked_offline: N }
 * - WAL is flushed (DB still readable after call)
 *
 * Note: The endpoint does NOT terminate the process — callers (e.g. launch-hive.cjs)
 * are responsible for sending SIGTERM/SIGKILL after calling /shutdown.
 *
 * Run: npx vitest run tests/shutdown.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-shutdown-test-${Date.now()}.db`);
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

function insertAgent(name: string, status = 'idle', workspace = 'TEST'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_agents (id, name, role, status, workspace) VALUES (?, ?, 'worker', ?, ?)`
  ).run(id, name, status, workspace);
  return id;
}

function insertLock(agentId: string, filePath: string): void {
  db.prepare(
    `INSERT INTO coord_locks (file_path, agent_id, reason) VALUES (?, ?, 'test')`
  ).run(filePath, agentId);
}

function agentStatus(id: string): string {
  return (db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(id) as any).status;
}

function countLocks(agentId: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM coord_locks WHERE agent_id = ?`).get(agentId) as any).c;
}

function countEvents(agentId: string, type: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM coord_events WHERE agent_id = ? AND event_type = ?`).get(agentId, type) as any).c;
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
  db.exec(`DELETE FROM coord_events`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_channel_sessions`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
  db.exec(`DELETE FROM coord_commands`);
});

// ─── POST /shutdown ──────────────────────────────────────────────

describe('POST /shutdown', () => {
  it('returns ok=true and correct offline count', async () => {
    insertAgent('Alpha', 'idle');
    insertAgent('Beta', 'working');

    const { status, data } = await http('/shutdown', { method: 'POST' });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.agents_marked_offline).toBe(2);
  });

  it('marks all live agents as dead', async () => {
    const idA = insertAgent('Idle-A', 'idle');
    const idB = insertAgent('Working-B', 'working');

    await http('/shutdown', { method: 'POST' });

    expect(agentStatus(idA)).toBe('dead');
    expect(agentStatus(idB)).toBe('dead');
  });

  it('clears current_task on agents', async () => {
    const id = insertAgent('Task-Agent', 'working');
    db.prepare(`UPDATE coord_agents SET current_task = 'some-task' WHERE id = ?`).run(id);

    await http('/shutdown', { method: 'POST' });

    const row = db.prepare(`SELECT current_task FROM coord_agents WHERE id = ?`).get(id) as any;
    expect(row.current_task).toBeNull();
  });

  it('releases locks held by agents', async () => {
    const idA = insertAgent('Lock-A', 'working');
    const idB = insertAgent('Lock-B', 'idle');
    insertLock(idA, 'src/foo.ts');
    insertLock(idA, 'src/bar.ts');
    insertLock(idB, 'src/baz.ts');

    await http('/shutdown', { method: 'POST' });

    expect(countLocks(idA)).toBe(0);
    expect(countLocks(idB)).toBe(0);
  });

  it('records a shutdown event for each agent', async () => {
    const idA = insertAgent('Event-A', 'idle');
    const idB = insertAgent('Event-B', 'working');

    await http('/shutdown', { method: 'POST' });

    expect(countEvents(idA, 'shutdown')).toBe(1);
    expect(countEvents(idB, 'shutdown')).toBe(1);
  });

  it('skips already-dead agents', async () => {
    const deadId = insertAgent('Dead-Already', 'dead');
    const liveId = insertAgent('Live-One', 'idle');

    const { data } = await http('/shutdown', { method: 'POST' });
    expect(data.agents_marked_offline).toBe(1);
    expect(agentStatus(deadId)).toBe('dead');
    expect(agentStatus(liveId)).toBe('dead');
    // No shutdown event for the already-dead agent
    expect(countEvents(deadId, 'shutdown')).toBe(0);
  });

  it('returns 0 when no live agents', async () => {
    insertAgent('Dead-1', 'dead');
    insertAgent('Dead-2', 'dead');

    const { status, data } = await http('/shutdown', { method: 'POST' });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.agents_marked_offline).toBe(0);
  });

  it('is idempotent — second call returns 0 offline', async () => {
    insertAgent('Alpha', 'idle');

    const { data: first } = await http('/shutdown', { method: 'POST' });
    expect(first.agents_marked_offline).toBe(1);

    const { data: second } = await http('/shutdown', { method: 'POST' });
    expect(second.agents_marked_offline).toBe(0);
  });

  it('DB is still readable after shutdown (WAL checkpoint succeeded)', async () => {
    insertAgent('Survivor', 'idle');
    await http('/shutdown', { method: 'POST' });

    // Verify DB is still queryable
    const count = (db.prepare(`SELECT COUNT(*) as c FROM coord_agents`).get() as any).c;
    expect(count).toBe(1);
  });

  it('handles mixed agent statuses correctly', async () => {
    const idle = insertAgent('Idle', 'idle');
    const working = insertAgent('Working', 'working');
    const dead = insertAgent('Dead', 'dead');

    const { data } = await http('/shutdown', { method: 'POST' });

    expect(data.agents_marked_offline).toBe(2);
    expect(agentStatus(idle)).toBe('dead');
    expect(agentStatus(working)).toBe('dead');
    expect(agentStatus(dead)).toBe('dead');
  });
});
