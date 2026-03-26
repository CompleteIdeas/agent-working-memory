/**
 * GET /health/deep — Integration Tests
 *
 * Run: npx vitest run tests/health-deep.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

const DB_PATH = join(tmpdir(), `awm-health-deep-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;

async function http(path: string): Promise<{ status: number; data: any }> {
  const resp = await globalThis.fetch(`${baseUrl}${path}`);
  return { status: resp.status, data: await resp.json() };
}

function insertAgent(name: string, status = 'idle', lastSeenOffset = '0 seconds'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_agents (id, name, role, status, last_seen, workspace, started_at)
     VALUES (?, ?, 'worker', ?, datetime('now', '-' || ?), 'TEST', datetime('now', '-' || ?))`
  ).run(id, name, status, lastSeenOffset, lastSeenOffset);
  return id;
}

beforeAll(async () => {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCoordinationTables(db);

  app = Fastify({ logger: false });
  // Pass store=undefined — /health/deep gracefully handles missing store (db_healthy defaults true)
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
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
});

describe('GET /health/deep', () => {
  it('returns status ok when healthy with no agents', async () => {
    const { status, data } = await http('/health/deep');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.db_healthy).toBe(true);
    expect(data.agents_alive).toBe(0);
    expect(data.stale_agents).toBe(0);
    expect(data.pending_tasks).toBe(0);
  });

  it('counts alive agents correctly', async () => {
    insertAgent('Alive-1');
    insertAgent('Alive-2');
    insertAgent('Dead-1', 'dead');

    const { data } = await http('/health/deep');
    expect(data.agents_alive).toBe(2);
  });

  it('counts stale agents (>120s since last seen)', async () => {
    insertAgent('Fresh', 'idle', '10 seconds');
    insertAgent('Stale-1', 'idle', '300 seconds');
    insertAgent('Stale-2', 'working', '600 seconds');

    const { data } = await http('/health/deep');
    expect(data.stale_agents).toBe(2);
  });

  it('returns degraded when stale agents > 2', async () => {
    insertAgent('Stale-A', 'idle', '300 seconds');
    insertAgent('Stale-B', 'idle', '300 seconds');
    insertAgent('Stale-C', 'idle', '300 seconds');

    const { data } = await http('/health/deep');
    expect(data.status).toBe('degraded');
    expect(data.stale_agents).toBe(3);
  });

  it('counts pending tasks', async () => {
    const agentId = insertAgent('Worker-1');
    db.prepare(
      `INSERT INTO coord_assignments (id, task, status, workspace) VALUES (?, 'pending task', 'pending', 'TEST')`
    ).run(crypto.randomUUID());
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, status, workspace) VALUES (?, ?, 'active task', 'in_progress', 'TEST')`
    ).run(crypto.randomUUID(), agentId);
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, status, workspace) VALUES (?, ?, 'done task', 'completed', 'TEST')`
    ).run(crypto.randomUUID(), agentId);

    const { data } = await http('/health/deep');
    expect(data.pending_tasks).toBe(2); // pending + in_progress
  });
});
