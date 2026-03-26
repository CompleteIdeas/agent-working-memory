/**
 * GET /assignments — Integration Tests
 *
 * Tests: status filter, invalid status validation, offset pagination, limit cap.
 *
 * Run: npx vitest run tests/assignments.test.ts
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

const DB_PATH = join(tmpdir(), `awm-assignments-test-${Date.now()}.db`);
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

function insertAssignment(agentId: string | null, task: string, status = 'assigned', workspace = 'TEST', priority = 0): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_assignments (id, agent_id, task, status, workspace, priority) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, task, status, workspace, priority);
  return id;
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
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
});

// ─── Tests ──────────────────────────────────────────────────────

describe('GET /assignments', () => {
  it('returns all assignments when no filters', async () => {
    const agentId = insertAgent('Worker-1');
    insertAssignment(agentId, 'task 1', 'assigned');
    insertAssignment(agentId, 'task 2', 'completed');
    insertAssignment(null, 'task 3', 'pending');

    const { status, data } = await http('/assignments');
    expect(status).toBe(200);
    expect(data.assignments).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  describe('status filter', () => {
    it('returns only matching statuses', async () => {
      const agentId = insertAgent('Worker-1');
      insertAssignment(agentId, 'assigned task', 'assigned');
      insertAssignment(agentId, 'completed task', 'completed');
      insertAssignment(agentId, 'failed task', 'failed');

      const { status, data } = await http('/assignments?status=completed');
      expect(status).toBe(200);
      expect(data.assignments).toHaveLength(1);
      expect(data.assignments[0].task).toBe('completed task');
      expect(data.total).toBe(1);
    });

    it('returns empty array when no assignments match status', async () => {
      const agentId = insertAgent('Worker-1');
      insertAssignment(agentId, 'assigned task', 'assigned');

      const { status, data } = await http('/assignments?status=failed');
      expect(status).toBe(200);
      expect(data.assignments).toHaveLength(0);
      expect(data.total).toBe(0);
    });

    it('rejects invalid status values with error', async () => {
      const { status } = await http('/assignments?status=bogus');
      // Zod .parse() throws → 422 via initCoordination error handler, or 500 without it
      expect(status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('pagination', () => {
    it('offset=0 and offset=1 return different results', async () => {
      const agentId = insertAgent('Worker-1');
      // Insert 3 tasks with different priorities so order is deterministic
      insertAssignment(agentId, 'high priority', 'assigned', 'TEST', 10);
      insertAssignment(agentId, 'mid priority', 'assigned', 'TEST', 5);
      insertAssignment(agentId, 'low priority', 'assigned', 'TEST', 1);

      const page0 = await http('/assignments?limit=2&offset=0');
      const page1 = await http('/assignments?limit=2&offset=1');

      expect(page0.data.assignments).toHaveLength(2);
      expect(page1.data.assignments).toHaveLength(2);
      // First item of page0 should not be in page1 (offset shifted)
      expect(page0.data.assignments[0].task).not.toBe(page1.data.assignments[0].task);
      // Second item of page0 should be first item of page1
      expect(page0.data.assignments[1].task).toBe(page1.data.assignments[0].task);

      // Total should reflect all assignments regardless of pagination
      expect(page0.data.total).toBe(3);
      expect(page1.data.total).toBe(3);
    });

    it('offset beyond total returns empty array', async () => {
      const agentId = insertAgent('Worker-1');
      insertAssignment(agentId, 'only task', 'assigned');

      const { status, data } = await http('/assignments?offset=10');
      expect(status).toBe(200);
      expect(data.assignments).toHaveLength(0);
      expect(data.total).toBe(1);
    });
  });

  describe('limit', () => {
    it('default limit returns up to 20 results', async () => {
      const agentId = insertAgent('Worker-1');
      for (let i = 0; i < 25; i++) {
        insertAssignment(agentId, `task ${i}`, 'assigned');
      }

      const { data } = await http('/assignments');
      expect(data.assignments.length).toBeLessThanOrEqual(20);
      expect(data.total).toBe(25);
    });

    it('limit caps at 100', async () => {
      // The schema enforces max 100 — requesting 200 should cap or reject
      const { status, data } = await http('/assignments?limit=200');
      // Zod .parse() throws on out-of-range, resulting in 422
      expect(status).toBeGreaterThanOrEqual(400);
    });

    it('limit=1 returns exactly one result', async () => {
      const agentId = insertAgent('Worker-1');
      insertAssignment(agentId, 'task A', 'assigned');
      insertAssignment(agentId, 'task B', 'assigned');

      const { status, data } = await http('/assignments?limit=1');
      expect(status).toBe(200);
      expect(data.assignments).toHaveLength(1);
      expect(data.total).toBe(2);
    });
  });

  describe('response shape', () => {
    it('includes agent_name from join', async () => {
      const agentId = insertAgent('Named-Worker');
      insertAssignment(agentId, 'joined task', 'assigned');

      const { data } = await http('/assignments');
      expect(data.assignments[0].agent_name).toBe('Named-Worker');
    });

    it('includes is_blocked field', async () => {
      const agentId = insertAgent('Worker-1');
      insertAssignment(agentId, 'normal task', 'assigned');

      const { data } = await http('/assignments');
      expect(data.assignments[0]).toHaveProperty('is_blocked');
    });
  });
});
