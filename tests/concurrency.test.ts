/**
 * Concurrency Tests — Parallel /next claims
 *
 * Verifies that when multiple agents race to claim a single pending
 * assignment via POST /next, exactly one gets it.
 *
 * Run: npx vitest run tests/concurrency.test.ts
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

const DB_PATH = join(tmpdir(), `awm-concurrency-test-${Date.now()}.db`);
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

// ─── Setup / Teardown ───────────────────────────────────────────

beforeAll(async () => {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
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
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  }
});

beforeEach(() => {
  db.exec(`DELETE FROM coord_events`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Concurrency — parallel /next claims', () => {
  it('exactly one agent claims a single pending assignment', async () => {
    // Create a pending assignment (no agent)
    await http('/assign', {
      method: 'POST',
      body: { task: 'Race condition test task' },
    });

    // Fire 5 concurrent /next calls from different agents
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        http('/next', {
          method: 'POST',
          body: { name: `Racer-${i}`, role: 'worker' },
        })
      )
    );

    // Count how many agents received the assignment
    const claimed = results.filter(r => r.data.assignment !== null);
    expect(claimed.length).toBe(1);

    // The assignment should be in 'assigned' status
    const winner = claimed[0];
    expect(winner.data.assignment.task).toBe('Race condition test task');
    expect(winner.data.assignment.status).toBe('assigned');

    // DB should show exactly 1 assigned, 0 pending
    const assignments = db.prepare(
      `SELECT status, COUNT(*) AS count FROM coord_assignments GROUP BY status`
    ).all() as Array<{ status: string; count: number }>;
    const assigned = assignments.find(a => a.status === 'assigned');
    const pending = assignments.find(a => a.status === 'pending');
    expect(assigned?.count).toBe(1);
    expect(pending).toBeUndefined();
  });

  it('multiple pending assignments are distributed across agents', async () => {
    // Create 3 pending assignments
    for (let i = 0; i < 3; i++) {
      await http('/assign', {
        method: 'POST',
        body: { task: `Distributed task ${i}` },
      });
    }

    // Fire 3 concurrent /next calls
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        http('/next', {
          method: 'POST',
          body: { name: `Dist-${i}`, role: 'worker' },
        })
      )
    );

    const claimed = results.filter(r => r.data.assignment !== null);
    // At least 1 should get an assignment (may not be all 3 due to race)
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    // No two agents should have the same assignment
    const ids = claimed.map(r => r.data.assignment.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rapid sequential /next from same agent does not duplicate', async () => {
    await http('/assign', {
      method: 'POST',
      body: { task: 'Sequential claim task' },
    });

    // Same agent calls /next 5 times rapidly
    const results: Array<{ status: number; data: any }> = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await http('/next', {
          method: 'POST',
          body: { name: 'Sequential-Agent', role: 'worker' },
        })
      );
    }

    // First call should get the assignment
    const firstClaim = results.find(r => r.data.assignment !== null);
    expect(firstClaim).toBeDefined();

    // All subsequent calls with assignment should be the same one
    const withAssignment = results.filter(r => r.data.assignment !== null);
    const uniqueIds = new Set(withAssignment.map(r => r.data.assignment.id));
    expect(uniqueIds.size).toBe(1);
  });
});
