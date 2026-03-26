/**
 * Edge case tests for /next auto-claim and /reassign endpoints.
 *
 * Run: npx vitest run tests/next-reassign.test.ts
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

const DB_PATH = join(tmpdir(), `awm-next-reassign-test-${Date.now()}.db`);
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

function insertAssignment(agentId: string | null, task: string, status = 'assigned', opts: { blocked_by?: string; workspace?: string; priority?: number } = {}): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_assignments (id, agent_id, task, status, blocked_by, workspace, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, task, status, opts.blocked_by ?? null, opts.workspace ?? 'TEST', opts.priority ?? 0);
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

// ─── /next auto-claim edge cases ────────────────────────────────

describe('/next auto-claim edge cases', () => {
  it('does NOT auto-claim a task whose blocked_by is not completed', async () => {
    const agentId = insertAgent('Blocker-Test');
    // Create a blocker assignment that is still in_progress
    const blockerId = insertAssignment(agentId, 'blocking task', 'in_progress');
    // Create a pending task blocked by the in-progress one
    const blockedId = insertAssignment(null, 'blocked task', 'pending', { blocked_by: blockerId });

    // New idle agent polls /next — should NOT get the blocked task
    const { data } = await http('/next', { method: 'POST', body: { name: 'Idle-Agent', workspace: 'TEST' } });
    expect(data.assignment).toBeNull();
  });

  it('auto-claims a task whose blocked_by IS completed', async () => {
    const agentId = insertAgent('Completed-Blocker');
    // Blocker assignment is completed
    const blockerId = insertAssignment(agentId, 'completed blocker', 'completed');
    // Pending task blocked by completed task — should be claimable
    insertAssignment(null, 'unblocked task', 'pending', { blocked_by: blockerId });

    const { data } = await http('/next', { method: 'POST', body: { name: 'Ready-Agent', workspace: 'TEST' } });
    expect(data.assignment).not.toBeNull();
    expect(data.assignment.task).toBe('unblocked task');
  });

  it('returns existing in_progress task instead of claiming new', async () => {
    const agentId = insertAgent('Busy-Worker', 'working');
    const existingId = insertAssignment(agentId, 'existing work', 'in_progress');
    // Also add a pending task
    insertAssignment(null, 'available task', 'pending');

    const { data } = await http('/next', { method: 'POST', body: { name: 'Busy-Worker', workspace: 'TEST' } });
    expect(data.assignment).not.toBeNull();
    expect(data.assignment.id).toBe(existingId);
    expect(data.assignment.task).toBe('existing work');
  });

  it('returns existing assigned task instead of claiming new', async () => {
    const agentId = insertAgent('Assigned-Worker', 'working');
    const assignedId = insertAssignment(agentId, 'assigned work', 'assigned');
    insertAssignment(null, 'pending work', 'pending');

    const { data } = await http('/next', { method: 'POST', body: { name: 'Assigned-Worker', workspace: 'TEST' } });
    expect(data.assignment).not.toBeNull();
    expect(data.assignment.id).toBe(assignedId);
  });
});

// ─── /reassign edge cases ───────────────────────────────────────

describe('/reassign edge cases', () => {
  it('returns 404 for non-existent assignment', async () => {
    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(status).toBe(404);
    expect(data.error).toMatch(/not found/i);
  });

  it('rejects reassignment of completed assignment', async () => {
    const agentId = insertAgent('Done-Worker');
    const completedId = insertAssignment(agentId, 'finished task', 'completed');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: completedId },
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/completed/);
  });

  it('rejects reassignment of failed assignment', async () => {
    const agentId = insertAgent('Failed-Worker');
    const failedId = insertAssignment(agentId, 'failed task', 'failed');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: failedId },
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/failed/);
  });

  it('reassigns pending task to a target agent', async () => {
    const targetId = insertAgent('Target-Worker');
    const taskId = insertAssignment(null, 'reassignable task', 'pending');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: taskId, targetAgentId: targetId },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.newAgentId).toBe(targetId);
    expect(data.status).toBe('assigned');
  });

  it('reassigns to pending when no target specified (unassign)', async () => {
    const agentId = insertAgent('Current-Worker', 'working');
    const taskId = insertAssignment(agentId, 'take away task', 'in_progress');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: taskId },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.newAgentId).toBeNull();
    expect(data.status).toBe('pending');

    // Old agent should be idle now
    const agent = db.prepare(`SELECT status, current_task FROM coord_agents WHERE id = ?`).get(agentId) as any;
    expect(agent.status).toBe('idle');
    expect(agent.current_task).toBeNull();
  });
});
