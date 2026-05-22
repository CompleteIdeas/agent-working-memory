/**
 * Control-Layer Tests — AWM 0.8.1
 *
 * Covers: FailureMode classifier, mutation-hint retry in cleanupStale,
 * retry exhaustion, CircuitBreaker state machine, /next circuit_open,
 * and POST /assignment/:id/fail endpoint.
 *
 * Run: npx vitest run tests/coordination/control-layer.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../../src/coordination/schema.js';
import { classifyFailure, FailureMode, MUTATION_HINTS } from '../../src/coordination/failure-modes.js';
import { cleanupStale } from '../../src/coordination/stale.js';
import { recordFailure, recordSuccess, getState, isAvailable } from '../../src/coordination/circuit-breaker.js';
import { registerCoordinationRoutes } from '../../src/coordination/routes.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-control-layer-test-${Date.now()}.db`);
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

function insertAgent(name: string, status = 'idle', lastSeenOffset = '0 seconds', workspace = 'TEST'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_agents (id, name, role, status, last_seen, workspace)
     VALUES (?, ?, 'worker', ?, datetime('now', '-' || ?), ?)`
  ).run(id, name, status, lastSeenOffset, workspace);
  return id;
}

function insertAssignment(agentId: string | null, status = 'in_progress', description = 'test task'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO coord_assignments (id, agent_id, task, description, status, workspace)
     VALUES (?, ?, 'test task', ?, ?, 'TEST')`
  ).run(id, agentId, description, status);
  return id;
}

beforeAll(async () => {
  db = new Database(DB_PATH);
  initCoordinationTables(db);

  app = Fastify({ logger: false });
  registerCoordinationRoutes(app, db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'string' ? addr : `http://127.0.0.1:${(addr as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
  db.close();
  try { require('fs').unlinkSync(DB_PATH); } catch { /* ok */ }
});

beforeEach(() => {
  // Clean up between tests — child tables first to avoid FK violations
  db.prepare(`DELETE FROM coord_circuit_state`).run();
  db.prepare(`DELETE FROM coord_assignments`).run();
  db.prepare(`DELETE FROM coord_agents`).run();
  db.prepare(`DELETE FROM coord_events`).run();
});

// ─── CL-01: FailureMode classifier ──────────────────────────────

describe('classifyFailure', () => {
  it('classifies null as UNKNOWN', () => {
    expect(classifyFailure(null)).toBe(FailureMode.UNKNOWN);
  });

  it('classifies stale/disconnected as AGENT_STALE', () => {
    expect(classifyFailure('agent disconnected (stale)')).toBe(FailureMode.AGENT_STALE);
    expect(classifyFailure('Worker went stale after 600s')).toBe(FailureMode.AGENT_STALE);
  });

  it('classifies timeout as TIMEOUT', () => {
    expect(classifyFailure('operation timed out after 120s')).toBe(FailureMode.TIMEOUT);
  });

  it('classifies json/schema/parse errors as OUTPUT_INVALID', () => {
    expect(classifyFailure('JSON parse error at line 3')).toBe(FailureMode.OUTPUT_INVALID);
    expect(classifyFailure('schema validation failed')).toBe(FailureMode.OUTPUT_INVALID);
  });

  it('classifies test failures as TEST_FAIL', () => {
    expect(classifyFailure('vitest 3 tests failed')).toBe(FailureMode.TEST_FAIL);
    expect(classifyFailure('test fail: assertion error')).toBe(FailureMode.TEST_FAIL);
    expect(classifyFailure('jest suite failed')).toBe(FailureMode.TEST_FAIL);
  });

  it('classifies lint/typecheck errors as LINT_FAIL', () => {
    expect(classifyFailure('eslint: 5 errors')).toBe(FailureMode.LINT_FAIL);
    expect(classifyFailure('typecheck failed with 2 errors')).toBe(FailureMode.LINT_FAIL);
  });

  it('classifies merge conflicts as MERGE_CONFLICT', () => {
    expect(classifyFailure('merge conflict in src/index.ts')).toBe(FailureMode.MERGE_CONFLICT);
  });

  it('classifies unrecognized strings as UNKNOWN', () => {
    expect(classifyFailure('something unexpected happened')).toBe(FailureMode.UNKNOWN);
  });

  it('all 7 FailureModes have a MUTATION_HINT', () => {
    for (const mode of Object.values(FailureMode)) {
      expect(MUTATION_HINTS[mode]).toBeTruthy();
      expect(typeof MUTATION_HINTS[mode]).toBe('string');
    }
  });
});

// ─── CL-02: Mutation-hint retry in cleanupStale ──────────────────

describe('cleanupStale — retry logic', () => {
  it('re-queues assignment with hint on first stale (attempt_count=0→1)', () => {
    const agentId = insertAgent('stale-worker', 'working', '700 seconds');
    const assignId = insertAssignment(agentId);

    cleanupStale(db, 600);

    const updated = db.prepare(
      `SELECT status, attempt_count, last_failure_mode, description FROM coord_assignments WHERE id = ?`
    ).get(assignId) as { status: string; attempt_count: number; last_failure_mode: string; description: string };

    expect(updated.status).toBe('pending');
    expect(updated.attempt_count).toBe(1);
    expect(updated.last_failure_mode).toBe(FailureMode.AGENT_STALE);
    expect(updated.description).toContain('RETRY HINT (attempt 1)');
    expect(updated.description).toContain(MUTATION_HINTS[FailureMode.AGENT_STALE]);
  });

  it('re-queues again on 2nd stale (attempt_count=1→2)', () => {
    const agentId = insertAgent('stale-worker2', 'working', '700 seconds');
    const assignId = insertAssignment(agentId);
    db.prepare(`UPDATE coord_assignments SET attempt_count = 1 WHERE id = ?`).run(assignId);

    cleanupStale(db, 600);

    const updated = db.prepare(`SELECT status, attempt_count FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(updated.status).toBe('pending');
    expect(updated.attempt_count).toBe(2);
  });

  it('re-queues again on 3rd stale (attempt_count=2→3)', () => {
    const agentId = insertAgent('stale-worker3', 'working', '700 seconds');
    const assignId = insertAssignment(agentId);
    db.prepare(`UPDATE coord_assignments SET attempt_count = 2 WHERE id = ?`).run(assignId);

    cleanupStale(db, 600);

    const updated = db.prepare(`SELECT status, attempt_count FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(updated.status).toBe('pending');
    expect(updated.attempt_count).toBe(3);
  });

  it('permanently fails after 3 retries (attempt_count=3 → failed)', () => {
    const agentId = insertAgent('stale-exhaust', 'working', '700 seconds');
    const assignId = insertAssignment(agentId);
    db.prepare(`UPDATE coord_assignments SET attempt_count = 3 WHERE id = ?`).run(assignId);

    cleanupStale(db, 600);

    const updated = db.prepare(`SELECT status, attempt_count FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(updated.status).toBe('failed');
    expect(updated.attempt_count).toBe(3); // not incremented — permanently failed
  });

  it('agent is marked dead after cleanup regardless of retry', () => {
    const agentId = insertAgent('stale-dead', 'working', '700 seconds');
    insertAssignment(agentId);

    cleanupStale(db, 600);

    const agent = db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(agentId) as any;
    expect(agent.status).toBe('dead');
  });
});

// ─── CL-03: CircuitBreaker ──────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts closed for a new agent (no row)', () => {
    const agentId = insertAgent('fresh-agent');
    expect(getState(db, agentId)).toBe('closed');
    expect(isAvailable(db, agentId)).toBe(true);
  });

  it('stays closed below the threshold (4 failures)', () => {
    const agentId = insertAgent('almost-open');
    for (let i = 0; i < 4; i++) recordFailure(db, agentId);
    expect(getState(db, agentId)).toBe('closed');
    expect(isAvailable(db, agentId)).toBe(true);
  });

  it('opens at exactly 5 consecutive failures', () => {
    const agentId = insertAgent('open-circuit');
    for (let i = 0; i < 5; i++) recordFailure(db, agentId);
    expect(getState(db, agentId)).toBe('open');
    expect(isAvailable(db, agentId)).toBe(false);
  });

  it('resets to closed on success', () => {
    const agentId = insertAgent('recovering');
    for (let i = 0; i < 5; i++) recordFailure(db, agentId);
    expect(isAvailable(db, agentId)).toBe(false);
    recordSuccess(db, agentId);
    expect(getState(db, agentId)).toBe('closed');
    expect(isAvailable(db, agentId)).toBe(true);
  });

  it('transitions open→half_open after 30s by backdating opened_at', () => {
    const agentId = insertAgent('half-open-test');
    for (let i = 0; i < 5; i++) recordFailure(db, agentId);
    // Backdate opened_at by 31 seconds
    db.prepare(
      `UPDATE coord_circuit_state SET opened_at = datetime('now', '-31 seconds') WHERE agent_id = ?`
    ).run(agentId);
    expect(getState(db, agentId)).toBe('half_open');
    expect(isAvailable(db, agentId)).toBe(true);
  });
});

// ─── CL-03: Integration — /next returns circuit_open ────────────

describe('/next — circuit_open', () => {
  it('returns 423 with circuit_open when worker circuit is open', async () => {
    // Register worker via checkin
    const { data: ci } = await http('/checkin', {
      method: 'POST',
      body: { name: 'circuit-worker', role: 'worker', workspace: 'TEST' },
    });
    const agentId: string = ci.agentId;

    // Queue a pending task
    await http('/assign', {
      method: 'POST',
      body: { task: 'some task', workspace: 'TEST' },
    });

    // Force the circuit open
    for (let i = 0; i < 5; i++) recordFailure(db, agentId);

    // /next should refuse
    const { status, data } = await http('/next', {
      method: 'POST',
      body: { name: 'circuit-worker', workspace: 'TEST' },
    });
    expect(status).toBe(423);
    expect(data.circuit_open).toBe(true);
    expect(data.reason).toBe('circuit_open');
  });
});

// ─── CL-03: POST /assignment/:id/fail ────────────────────────────

describe('POST /assignment/:id/fail', () => {
  it('re-queues with test_fail mode and hint (attempt 0→1)', async () => {
    // Register agent
    const { data: ci } = await http('/checkin', {
      method: 'POST',
      body: { name: 'fail-worker', role: 'worker', workspace: 'TEST' },
    });
    const agentId: string = ci.agentId;
    const assignId = insertAssignment(agentId, 'assigned');

    const { status, data } = await http(`/assignment/${assignId}/fail`, {
      method: 'POST',
      body: { result: 'vitest 3 tests failed in auth.test.ts' },
    });

    expect(status).toBe(200);
    expect(data.outcome).toBe('retried');
    expect(data.attempt_count).toBe(1);
    expect(data.last_failure_mode).toBe(FailureMode.TEST_FAIL);

    const row = db.prepare(
      `SELECT status, description FROM coord_assignments WHERE id = ?`
    ).get(assignId) as any;
    expect(row.status).toBe('pending');
    expect(row.description).toContain('RETRY HINT');
    expect(row.description).toContain(MUTATION_HINTS[FailureMode.TEST_FAIL]);
  });

  it('permanently fails after 3 prior attempts', async () => {
    const { data: ci } = await http('/checkin', {
      method: 'POST',
      body: { name: 'fail-exhaust', role: 'worker', workspace: 'TEST' },
    });
    const agentId: string = ci.agentId;
    const assignId = insertAssignment(agentId, 'assigned');
    db.prepare(`UPDATE coord_assignments SET attempt_count = 3 WHERE id = ?`).run(assignId);

    const { status, data } = await http(`/assignment/${assignId}/fail`, {
      method: 'POST',
      body: { result: 'typecheck failed again' },
    });

    expect(status).toBe(200);
    expect(data.outcome).toBe('failed');

    const row = db.prepare(`SELECT status FROM coord_assignments WHERE id = ?`).get(assignId) as any;
    expect(row.status).toBe('failed');
  });

  it('returns 404 for unknown assignment', async () => {
    const { status } = await http(`/assignment/${crypto.randomUUID()}/fail`, {
      method: 'POST',
      body: { result: 'some error' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 for already-completed assignment', async () => {
    const agentId = insertAgent('done-agent');
    const assignId = insertAssignment(agentId, 'completed');

    const { status } = await http(`/assignment/${assignId}/fail`, {
      method: 'POST',
      body: { result: 'late failure' },
    });
    expect(status).toBe(400);
  });
});
