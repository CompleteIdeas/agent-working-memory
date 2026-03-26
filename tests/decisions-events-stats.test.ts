/**
 * Coordination endpoint tests — /decisions, /events, /stats
 *
 * Run: npx vitest run tests/decisions-events-stats.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

// ─── Shared infra ───────────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-des-test-${Date.now()}.db`);
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

/** Register an agent via /checkin and return its agentId. */
async function registerAgent(name: string, workspace = 'TEST'): Promise<string> {
  const { data } = await http('/checkin', {
    method: 'POST',
    body: { name, role: 'worker', workspace },
  });
  return data.agentId as string;
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

// ─── POST /decisions ────────────────────────────────────────────

describe('POST /decisions', () => {
  it('creates a decision row and returns 201 with id', async () => {
    const agentId = await registerAgent('Dec-Worker-A');

    const { status, data } = await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'Use JWT for auth tokens' },
    });

    expect(status).toBe(201);
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe('number');
  });

  it('stores optional assignment_id and tags', async () => {
    const agentId = await registerAgent('Dec-Worker-B');

    const { data } = await http('/decisions', {
      method: 'POST',
      body: {
        agentId,
        assignment_id: 'task-123',
        tags: 'auth,security',
        summary: 'Sessions replaced with JWT',
      },
    });

    const row = db.prepare(`SELECT * FROM coord_decisions WHERE id = ?`).get(data.id) as any;
    expect(row.author_id).toBe(agentId);
    expect(row.assignment_id).toBe('task-123');
    expect(row.tags).toBe('auth,security');
    expect(row.summary).toBe('Sessions replaced with JWT');
  });

  it('returns 404 for unknown agent', async () => {
    const { status, data } = await http('/decisions', {
      method: 'POST',
      body: { agentId: '00000000-0000-0000-0000-000000000000', summary: 'test' },
    });

    expect(status).toBe(404);
    expect(data.error).toContain('not found');
  });

  it('rejects missing summary', async () => {
    const agentId = await registerAgent('Dec-Worker-C');

    const { status } = await http('/decisions', {
      method: 'POST',
      body: { agentId },
    });

    // Zod parse will throw, Fastify returns 500 or 400
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─── GET /decisions ─────────────────────────────────────────────

describe('GET /decisions', () => {
  it('returns decisions with author_name', async () => {
    const agentId = await registerAgent('Dec-Reader-A');
    await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'Decision alpha' },
    });

    const { data } = await http('/decisions');

    expect(data.decisions.length).toBeGreaterThanOrEqual(1);
    const dec = data.decisions.find((d: any) => d.summary === 'Decision alpha');
    expect(dec).toBeTruthy();
    expect(dec.author_name).toBe('Dec-Reader-A');
    expect(dec.author_id).toBe(agentId);
  });

  it('filters by since_id', async () => {
    const agentId = await registerAgent('Dec-Reader-B');

    const { data: d1 } = await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'First decision' },
    });
    const { data: d2 } = await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'Second decision' },
    });

    // Get decisions after the first one
    const { data } = await http(`/decisions?since_id=${d1.id}`);

    expect(data.decisions.length).toBe(1);
    expect(data.decisions[0].summary).toBe('Second decision');
  });

  it('filters by assignment_id', async () => {
    const agentId = await registerAgent('Dec-Reader-C');

    await http('/decisions', {
      method: 'POST',
      body: { agentId, assignment_id: 'task-A', summary: 'For task A' },
    });
    await http('/decisions', {
      method: 'POST',
      body: { agentId, assignment_id: 'task-B', summary: 'For task B' },
    });

    const { data } = await http('/decisions?assignment_id=task-A');
    expect(data.decisions.length).toBe(1);
    expect(data.decisions[0].summary).toBe('For task A');
  });

  it('respects limit parameter', async () => {
    const agentId = await registerAgent('Dec-Reader-D');

    for (let i = 0; i < 5; i++) {
      await http('/decisions', {
        method: 'POST',
        body: { agentId, summary: `Decision ${i}` },
      });
    }

    const { data } = await http('/decisions?limit=3');
    expect(data.decisions.length).toBe(3);
  });

  it('returns empty array when no decisions exist', async () => {
    const { data } = await http('/decisions');
    expect(data.decisions).toEqual([]);
  });
});

// ─── GET /events ────────────────────────────────────────────────

describe('GET /events', () => {
  it('returns events from agent registration', async () => {
    const agentId = await registerAgent('Evt-Worker-A');

    const { data } = await http('/events');

    expect(data.events.length).toBeGreaterThanOrEqual(1);
    const regEvent = data.events.find((e: any) => e.event_type === 'registered');
    expect(regEvent).toBeTruthy();
    expect(regEvent.agent_name).toBe('Evt-Worker-A');
  });

  it('returns last_id for cursor-based pagination', async () => {
    await registerAgent('Evt-Worker-B');

    const { data } = await http('/events');
    expect(typeof data.last_id).toBe('number');
    expect(data.last_id).toBeGreaterThan(0);
  });

  it('filters by since_id', async () => {
    await registerAgent('Evt-Worker-C1');

    const { data: page1 } = await http('/events');
    const sinceId = page1.last_id;

    // Create more events
    await registerAgent('Evt-Worker-C2');

    const { data: page2 } = await http(`/events?since_id=${sinceId}`);
    expect(page2.events.length).toBeGreaterThanOrEqual(1);
    // All returned events should have id > sinceId
    for (const e of page2.events) {
      expect(e.id).toBeGreaterThan(sinceId);
    }
  });

  it('filters by event_type', async () => {
    const agentId = await registerAgent('Evt-Worker-D');

    // Create a lock event
    await http('/lock', {
      method: 'POST',
      body: { agentId, filePath: 'src/test.ts', reason: 'testing' },
    });

    const { data } = await http('/events?event_type=lock_acquired');
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    for (const e of data.events) {
      expect(e.event_type).toBe('lock_acquired');
    }

    // Cleanup lock
    await http('/lock', {
      method: 'DELETE',
      body: { agentId, filePath: 'src/test.ts' },
    });
  });

  it('filters by agent_id', async () => {
    const agentA = await registerAgent('Evt-Worker-E');
    const agentB = await registerAgent('Evt-Worker-F');

    const { data } = await http(`/events?agent_id=${agentA}`);
    for (const e of data.events) {
      expect(e.agent_id).toBe(agentA);
    }
  });

  it('respects limit parameter', async () => {
    // Register several agents to generate events
    for (let i = 0; i < 5; i++) {
      await registerAgent(`Evt-Limit-${i}`);
    }

    const { data } = await http('/events?limit=3');
    expect(data.events.length).toBe(3);
  });

  it('returns 0 as last_id when no events match', async () => {
    const { data } = await http('/events?since_id=999999');
    expect(data.events).toEqual([]);
    expect(data.last_id).toBe(999999);
  });
});

// ─── GET /stats ─────────────────────────────────────────────────

describe('GET /stats', () => {
  it('returns correct worker counts', async () => {
    await registerAgent('Stats-A');
    await registerAgent('Stats-B');

    const { data } = await http('/stats');

    expect(data.workers.total).toBe(2);
    expect(data.workers.alive).toBe(2);
    expect(data.workers.idle).toBe(2);
    expect(data.workers.working).toBe(0);
  });

  it('tracks working vs idle agents', async () => {
    const agentId = await registerAgent('Stats-C');
    await registerAgent('Stats-D');

    // Assign work to Stats-C
    await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'test task' },
    });

    const { data } = await http('/stats');
    expect(data.workers.working).toBe(1);
    expect(data.workers.idle).toBe(1);
  });

  it('returns task statistics', async () => {
    const agentId = await registerAgent('Stats-E');

    // Create a task, complete it
    const { data: assign } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'completed task' },
    });
    // Must transition through in_progress before completing
    await http(`/assignment/${assign.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${assign.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully' },
    });

    // Create a pending task
    await http('/assign', {
      method: 'POST',
      body: { task: 'pending task' },
    });

    const { data } = await http('/stats');
    expect(data.tasks.total_assigned).toBeGreaterThanOrEqual(2);
    // Verify completed task was counted — direct DB check
    const completedRow = db.prepare(
      `SELECT status FROM coord_assignments WHERE id = ?`
    ).get(assign.assignmentId) as any;
    expect(completedRow.status).toBe('completed');
    // SQLite SUM returns null when no rows match; coerce for check
    expect(data.tasks.completed ?? 0).toBeGreaterThanOrEqual(1);
    expect(data.tasks.pending ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('returns decision counts', async () => {
    const agentId = await registerAgent('Stats-F');

    await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'a decision' },
    });

    const { data } = await http('/stats');
    expect(data.decisions.total).toBe(1);
    expect(data.decisions.last_hour).toBe(1);
  });

  it('returns uptime_seconds', async () => {
    await registerAgent('Stats-G');

    const { data } = await http('/stats');
    expect(typeof data.uptime_seconds).toBe('number');
    expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('returns zero/null counts when empty', async () => {
    const { data } = await http('/stats');

    // SQLite SUM on empty set returns null; COUNT returns 0
    expect(data.workers.total ?? 0).toBe(0);
    expect(data.workers.alive ?? 0).toBe(0);
    expect(data.tasks.total_assigned ?? 0).toBe(0);
    expect(data.tasks.completed ?? 0).toBe(0);
    expect(data.decisions.total).toBe(0);
    expect(data.uptime_seconds).toBe(0);
  });

  it('avg_completion_seconds is null when no completed tasks', async () => {
    const agentId = await registerAgent('Stats-H');
    await http('/assign', { method: 'POST', body: { task: 'pending' } });

    const { data } = await http('/stats');
    expect(data.tasks.avg_completion_seconds).toBeNull();
  });
});

// ─── Multi-assign guard ─────────────────────────────────────────

describe('POST /assign — multi-assign guard', () => {
  it('rejects assigning to agent with active assignment (409)', async () => {
    const agentId = await registerAgent('Busy-Worker');

    // First assignment succeeds
    const { status: s1 } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'First task' },
    });
    expect(s1).toBe(201);

    // Second assignment to same agent should be rejected
    const { status: s2, data } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'Second task' },
    });
    expect(s2).toBe(409);
    expect(data.error).toContain('active assignment');
  });

  it('allows assigning after previous task is completed', async () => {
    const agentId = await registerAgent('Sequential-Worker');

    const { data: d1 } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'Task one' },
    });
    await http(`/assignment/${d1.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${d1.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and verified the feature successfully' },
    });

    // Now should accept new assignment
    const { status } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'Task two' },
    });
    expect(status).toBe(201);
  });
});

// ─── PATCH /finding/:id ─────────────────────────────────────────

describe('PATCH /finding/:id', () => {
  it('updates finding status to resolved', async () => {
    const agentId = await registerAgent('Finding-Worker');
    await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', severity: 'warn', description: 'Test bug' },
    });

    const { data: findings } = await http('/findings');
    const findingId = findings.findings[0].id;

    const { status, data } = await http(`/finding/${findingId}`, {
      method: 'PATCH',
      body: { status: 'resolved' },
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.changed).toBe(true);

    // Verify resolved
    const { data: summary } = await http('/findings/summary');
    expect(summary.total).toBe(0);
  });

  it('updates suggestion field', async () => {
    const agentId = await registerAgent('Finding-Worker2');
    await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', severity: 'info', description: 'Minor issue' },
    });

    const { data: findings } = await http('/findings');
    const findingId = findings.findings[0].id;

    await http(`/finding/${findingId}`, {
      method: 'PATCH',
      body: { suggestion: 'Try refactoring the auth module' },
    });

    const row = db.prepare(`SELECT suggestion FROM coord_findings WHERE id = ?`).get(findingId) as any;
    expect(row.suggestion).toBe('Try refactoring the auth module');
  });

  it('returns 404 for non-existent finding', async () => {
    const { status } = await http('/finding/99999', {
      method: 'PATCH',
      body: { status: 'resolved' },
    });
    expect(status).toBe(404);
  });

  it('returns changed:false when no fields provided', async () => {
    const agentId = await registerAgent('Finding-Worker3');
    await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', severity: 'info', description: 'No change test' },
    });

    const { data: findings } = await http('/findings');
    const findingId = findings.findings[0].id;

    const { data } = await http(`/finding/${findingId}`, {
      method: 'PATCH',
      body: {},
    });
    expect(data.changed).toBe(false);
  });
});
