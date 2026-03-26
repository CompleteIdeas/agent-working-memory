/**
 * Coordination endpoint tests — POST /reassign, POST/GET /command
 *
 * Run: npx vitest run tests/reassign-command.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

const DB_PATH = join(tmpdir(), `awm-rc-test-${Date.now()}.db`);
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

async function registerAgent(name: string, workspace = 'TEST'): Promise<string> {
  const { data } = await http('/checkin', {
    method: 'POST',
    body: { name, role: 'worker', workspace },
  });
  return data.agentId as string;
}

async function createAssignment(agentId: string | null, task: string): Promise<string> {
  const body: Record<string, unknown> = { task };
  if (agentId) body.agentId = agentId;
  const { data } = await http('/assign', { method: 'POST', body });
  return data.assignmentId as string;
}

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
  db.exec(`DELETE FROM coord_decisions`);
  db.exec(`DELETE FROM coord_findings`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
  db.exec(`DELETE FROM coord_commands`);
});

// ─── POST /reassign ─────────────────────────────────────────────

describe('POST /reassign', () => {
  it('reassigns to a new agent by targetAgentId', async () => {
    const agentA = await registerAgent('Reassign-A');
    const agentB = await registerAgent('Reassign-B');
    const assignId = await createAssignment(agentA, 'Task to move');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, targetAgentId: agentB },
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.newAgentId).toBe(agentB);
    expect(data.status).toBe('assigned');

    // Verify assignment moved
    const row = db.prepare(`SELECT agent_id, status FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(row.agent_id).toBe(agentB);
    expect(row.status).toBe('assigned');

    // Old agent should be idle
    const oldAgent = db.prepare(`SELECT status, current_task FROM coord_agents WHERE id = ?`).get(agentA) as any;
    expect(oldAgent.status).toBe('idle');
    expect(oldAgent.current_task).toBeNull();

    // New agent should be working
    const newAgent = db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(agentB) as any;
    expect(newAgent.status).toBe('working');
  });

  it('reassigns by target_worker_name', async () => {
    const agentA = await registerAgent('Name-Source');
    const agentB = await registerAgent('Name-Target');
    const assignId = await createAssignment(agentA, 'Name-based reassign');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, target_worker_name: 'Name-Target' },
    });

    expect(status).toBe(200);
    expect(data.newAgentId).toBe(agentB);
  });

  it('sets to pending when no target specified', async () => {
    const agentA = await registerAgent('Pending-Source');
    const assignId = await createAssignment(agentA, 'Back to queue');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId },
    });

    expect(status).toBe(200);
    expect(data.newAgentId).toBeNull();
    expect(data.status).toBe('pending');

    const row = db.prepare(`SELECT agent_id, status FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(row.agent_id).toBeNull();
    expect(row.status).toBe('pending');
  });

  it('releases locks from old agent on reassign', async () => {
    const agentA = await registerAgent('Lock-Source');
    const agentB = await registerAgent('Lock-Target');
    const assignId = await createAssignment(agentA, 'Lock reassign');

    // Add a lock for agent A
    await http('/lock', {
      method: 'POST',
      body: { agentId: agentA, filePath: 'src/locked.ts', reason: 'working' },
    });

    await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, targetAgentId: agentB },
    });

    // Old agent's locks should be released
    const locks = db.prepare(`SELECT COUNT(*) as c FROM coord_locks WHERE agent_id = ?`).get(agentA) as any;
    expect(locks.c).toBe(0);
  });

  it('returns 404 for non-existent assignment', async () => {
    const { status } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 for completed assignment', async () => {
    const agentA = await registerAgent('Completed-Source');
    const assignId = await createAssignment(agentA, 'Already done');

    // Complete the assignment
    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully' },
    });

    const { status } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId },
    });
    expect(status).toBe(400);
  });

  it('returns 404 for unknown target worker name', async () => {
    const agentA = await registerAgent('Name-404-Source');
    const assignId = await createAssignment(agentA, 'Bad target');

    const { status } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, target_worker_name: 'Nonexistent-Worker' },
    });
    expect(status).toBe(404);
  });

  it('returns 404 for non-existent targetAgentId', async () => {
    const agentA = await registerAgent('UUID-404-Source');
    const assignId = await createAssignment(agentA, 'Bad UUID target');

    const { status, data } = await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, targetAgentId: '00000000-0000-0000-0000-000000000099' },
    });
    expect(status).toBe(404);
    expect(data.error).toContain('target agent not found');
  });

  it('records a reassignment event', async () => {
    const agentA = await registerAgent('Event-Source');
    const agentB = await registerAgent('Event-Target');
    const assignId = await createAssignment(agentA, 'Event test');

    await http('/reassign', {
      method: 'POST',
      body: { assignmentId: assignId, targetAgentId: agentB },
    });

    const events = db.prepare(
      `SELECT * FROM coord_events WHERE event_type = 'reassignment'`
    ).all() as any[];
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── POST /command ──────────────────────────────────────────────

describe('POST /command', () => {
  it('creates a BUILD_FREEZE command', async () => {
    const { status, data } = await http('/command', {
      method: 'POST',
      body: { command: 'BUILD_FREEZE', reason: 'deploying v2' },
    });

    expect(status).toBe(201);
    expect(data.ok).toBe(true);
    expect(data.command).toBe('BUILD_FREEZE');
  });

  it('creates a SHUTDOWN command', async () => {
    const { status, data } = await http('/command', {
      method: 'POST',
      body: { command: 'SHUTDOWN', reason: 'maintenance' },
    });

    expect(status).toBe(201);
    expect(data.command).toBe('SHUTDOWN');
  });

  it('creates a PAUSE command', async () => {
    const { status, data } = await http('/command', {
      method: 'POST',
      body: { command: 'PAUSE' },
    });

    expect(status).toBe(201);
    expect(data.command).toBe('PAUSE');
  });
});

// ─── GET /command ───────────────────────────────────────────────

describe('GET /command', () => {
  it('returns active:false when no commands', async () => {
    const { data } = await http('/command');
    expect(data.active).toBe(false);
    expect(data.commands).toEqual([]);
  });

  it('returns active command after POST', async () => {
    await http('/command', {
      method: 'POST',
      body: { command: 'BUILD_FREEZE', reason: 'test' },
    });

    const { data } = await http('/command');
    expect(data.active).toBe(true);
    expect(data.command).toBe('BUILD_FREEZE');
    expect(data.commands.length).toBe(1);
  });

  it('returns highest priority command', async () => {
    await http('/command', { method: 'POST', body: { command: 'PAUSE' } });
    await http('/command', { method: 'POST', body: { command: 'SHUTDOWN' } });

    const { data } = await http('/command');
    // SHUTDOWN has priority 3, PAUSE has 1
    expect(data.command).toBe('SHUTDOWN');
  });
});

// ─── RESUME clears commands ─────────────────────────────────────

describe('RESUME command', () => {
  it('clears all active commands', async () => {
    await http('/command', { method: 'POST', body: { command: 'BUILD_FREEZE' } });
    await http('/command', { method: 'POST', body: { command: 'PAUSE' } });

    const { data: before } = await http('/command');
    expect(before.active).toBe(true);

    await http('/command', { method: 'POST', body: { command: 'RESUME' } });

    const { data: after } = await http('/command');
    expect(after.active).toBe(false);
  });

  it('clears only workspace-scoped commands', async () => {
    await http('/command', { method: 'POST', body: { command: 'BUILD_FREEZE', workspace: 'WORK' } });
    await http('/command', { method: 'POST', body: { command: 'PAUSE', workspace: 'PERSONAL' } });

    // Resume only WORK
    await http('/command', { method: 'POST', body: { command: 'RESUME', workspace: 'WORK' } });

    // PERSONAL should still be active
    const { data } = await http('/command');
    expect(data.active).toBe(true);
    expect(data.commands.length).toBe(1);
    expect(data.commands[0].command).toBe('PAUSE');
  });
});

// ─── Assignment status transitions ──────────────────────────────

describe('assignment status transitions', () => {
  it('allows assigned -> in_progress', async () => {
    const agentId = await registerAgent('Trans-A');
    const assignId = await createAssignment(agentId, 'Transition test');

    const { status } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    expect(status).toBe(200);
  });

  it('allows assigned -> failed', async () => {
    const agentId = await registerAgent('Trans-B');
    const assignId = await createAssignment(agentId, 'Fail from assigned');

    const { status } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'failed', result: 'Agent crashed before starting work on the task' },
    });
    expect(status).toBe(200);
  });

  it('allows in_progress -> completed', async () => {
    const agentId = await registerAgent('Trans-C');
    const assignId = await createAssignment(agentId, 'Complete test');

    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });

    const { status } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully' },
    });
    expect(status).toBe(200);
  });

  it('allows in_progress -> blocked', async () => {
    const agentId = await registerAgent('Trans-D');
    const assignId = await createAssignment(agentId, 'Block test');

    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });

    const { status } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'blocked' },
    });
    expect(status).toBe(200);
  });

  it('rejects assigned -> completed (must go through in_progress)', async () => {
    const agentId = await registerAgent('Trans-E');
    const assignId = await createAssignment(agentId, 'Skip in_progress');

    const { status, data } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully' },
    });
    expect(status).toBe(400);
    expect(data.error).toContain('invalid transition');
  });

  it('rejects completed -> in_progress', async () => {
    const agentId = await registerAgent('Trans-F');
    const assignId = await createAssignment(agentId, 'Reverse test');

    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully' },
    });

    const { status, data } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    expect(status).toBe(400);
    expect(data.error).toContain('cannot update completed');
  });

  it('rejects failed -> in_progress', async () => {
    const agentId = await registerAgent('Trans-G');
    const assignId = await createAssignment(agentId, 'Failed reverse');

    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'failed', result: 'Agent disconnected and could not complete the work' },
    });

    const { status, data } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    expect(status).toBe(400);
    expect(data.error).toContain('cannot update failed');
  });

  it('allows blocked -> in_progress (unblock)', async () => {
    const agentId = await registerAgent('Trans-H');
    const assignId = await createAssignment(agentId, 'Unblock test');

    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'blocked' },
    });

    const { status } = await http(`/assignment/${assignId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    expect(status).toBe(200);
  });
});
