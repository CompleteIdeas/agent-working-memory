/**
 * Event emitter + dependency auto-unblock — Integration Tests
 *
 * Tests:
 * 1. POST /assign emits assignment.created event
 * 2. PATCH /assignment/:id to completed emits assignment.completed
 * 3. Completing an assignment auto-unblocks dependents (blocked_by)
 *
 * Run: npx vitest run tests/events-unblock.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';
import { createEventBus, type CoordinationEventBus, type AssignmentCreatedEvent, type AssignmentCompletedEvent } from '../src/coordination/events.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-events-unblock-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;
let eventBus: CoordinationEventBus;

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

// ─── Setup / Teardown ───────────────────────────────────────────

beforeAll(async () => {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCoordinationTables(db);

  eventBus = createEventBus();

  app = Fastify({ logger: false });
  registerCoordinationRoutes(app, db, undefined, eventBus);
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
  eventBus.removeAllListeners();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Event emission', () => {
  it('POST /assign emits assignment.created event', async () => {
    const agentId = insertAgent('Worker-E1');
    const events: AssignmentCreatedEvent[] = [];
    eventBus.on('assignment.created', (e) => events.push(e));

    const { status, data } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'test task for event emission' },
    });

    expect(status).toBe(201);
    expect(data.assignmentId).toBeDefined();
    expect(events.length).toBe(1);
    expect(events[0].agentId).toBe(agentId);
    expect(events[0].task).toBe('test task for event emission');
    expect(events[0].assignmentId).toBe(data.assignmentId);
  });

  it('PATCH /assignment/:id to completed emits assignment.completed event', async () => {
    const agentId = insertAgent('Worker-E2');
    const { data: assignData } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'task to complete for event test' },
    });
    const assignmentId = assignData.assignmentId;

    // Move to in_progress first
    await http(`/assignment/${assignmentId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });

    const events: AssignmentCompletedEvent[] = [];
    eventBus.on('assignment.completed', (e) => events.push(e));

    const { status } = await http(`/assignment/${assignmentId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Implemented and tested the feature successfully, commit abc1234' },
    });

    expect(status).toBe(200);
    expect(events.length).toBe(1);
    expect(events[0].assignmentId).toBe(assignmentId);
    expect(events[0].agentId).toBe(agentId);
  });
});

describe('Dependency auto-unblock', () => {
  it('completing a blocker assignment auto-unblocks dependents', async () => {
    const agentA = insertAgent('Worker-Blocker');
    const agentB = insertAgent('Worker-Blocked');

    // Create blocker assignment
    const { data: blockerData } = await http('/assign', {
      method: 'POST',
      body: { agentId: agentA, task: 'blocker task that others depend on' },
    });
    const blockerId = blockerData.assignmentId;

    // Create dependent assignment with blocked_by
    const depId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, status, blocked_by) VALUES (?, ?, ?, 'blocked', ?)`
    ).run(depId, agentB, 'dependent task waiting for blocker', blockerId);

    // Verify dependent is blocked
    const before = db.prepare(`SELECT status, blocked_by FROM coord_assignments WHERE id = ?`).get(depId) as any;
    expect(before.status).toBe('blocked');
    expect(before.blocked_by).toBe(blockerId);

    // Complete the blocker
    await http(`/assignment/${blockerId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    await http(`/assignment/${blockerId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Completed blocker task — implemented and verified the feature' },
    });

    // Verify dependent is now unblocked
    const after = db.prepare(`SELECT status, blocked_by FROM coord_assignments WHERE id = ?`).get(depId) as any;
    expect(after.status).toBe('assigned');
    expect(after.blocked_by).toBeNull();

    // Verify unblock event was created
    const unblockEvent = db.prepare(
      `SELECT * FROM coord_events WHERE event_type = 'assignment_unblocked' AND agent_id = ?`
    ).get(agentB) as any;
    expect(unblockEvent).toBeDefined();
    expect(unblockEvent.detail).toContain(blockerId);
  });

  it('completing an assignment with no dependents does not error', async () => {
    const agentId = insertAgent('Worker-NoDeps');

    const { data } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'standalone task with no dependents' },
    });

    await http(`/assignment/${data.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });

    const { status } = await http(`/assignment/${data.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Completed standalone task — created and verified output' },
    });

    expect(status).toBe(200);
  });

  it('auto-unblock handles multiple dependents', async () => {
    const agentA = insertAgent('Worker-MultiBlocker');
    const agentB = insertAgent('Worker-Dep1');
    const agentC = insertAgent('Worker-Dep2');

    // Create blocker
    const { data: blockerData } = await http('/assign', {
      method: 'POST',
      body: { agentId: agentA, task: 'shared blocker task' },
    });
    const blockerId = blockerData.assignmentId;

    // Create two dependents
    const dep1Id = crypto.randomUUID();
    const dep2Id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, status, blocked_by) VALUES (?, ?, ?, 'blocked', ?)`
    ).run(dep1Id, agentB, 'first dependent', blockerId);
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, status, blocked_by) VALUES (?, ?, ?, 'blocked', ?)`
    ).run(dep2Id, agentC, 'second dependent', blockerId);

    // Complete blocker
    await http(`/assignment/${blockerId}`, { method: 'PATCH', body: { status: 'in_progress' } });
    await http(`/assignment/${blockerId}`, {
      method: 'PATCH',
      body: { status: 'completed', result: 'Completed shared blocker — implemented and tested all changes' },
    });

    // Both should be unblocked
    const dep1 = db.prepare(`SELECT status, blocked_by FROM coord_assignments WHERE id = ?`).get(dep1Id) as any;
    const dep2 = db.prepare(`SELECT status, blocked_by FROM coord_assignments WHERE id = ?`).get(dep2Id) as any;
    expect(dep1.status).toBe('assigned');
    expect(dep1.blocked_by).toBeNull();
    expect(dep2.status).toBe('assigned');
    expect(dep2.blocked_by).toBeNull();
  });
});
