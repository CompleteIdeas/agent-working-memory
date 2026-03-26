/**
 * Context → Engram Bridge Tests
 *
 * Verifies that POST /assign with context JSON creates an engram in the
 * engrams table for cross-agent recall.
 *
 * Run: npx vitest run tests/context-bridge.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { EngramStore } from '../src/storage/sqlite.js';
import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-bridge-test-${Date.now()}.db`);
let store: EngramStore;
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
  store = new EngramStore(DB_PATH);
  const db = store.getDb();
  initCoordinationTables(db);

  app = Fastify({ logger: false });
  registerCoordinationRoutes(app, db, store);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('unexpected address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  store.getDb().close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  // Clean up WAL and SHM files
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  }
});

beforeEach(() => {
  const db = store.getDb();
  db.exec(`DELETE FROM coord_events`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
  db.exec(`DELETE FROM engrams`);
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Context → Engram Bridge', () => {
  it('creates engram when POST /assign includes valid context JSON', async () => {
    // Register an agent first
    const { data: checkin } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Bridge-Worker', role: 'worker' },
    });

    const context = JSON.stringify({
      files: [{ path: 'src/index.ts', note: 'main entry' }],
      references: [{ type: 'doc', value: 'docs/api.md' }],
      decisions: ['Use REST over WebSocket'],
      acceptance_criteria: ['All tests pass'],
    });

    const { status, data } = await http('/assign', {
      method: 'POST',
      body: { agentId: checkin.agentId, task: 'Build the bridge feature', context },
    });
    expect(status).toBe(201);

    // Check engrams table for the bridged context
    const db = store.getDb();
    const engrams = db.prepare(
      `SELECT * FROM engrams WHERE concept LIKE '%Build the bridge%'`
    ).all() as Array<{ concept: string; content: string; tags: string; memory_class: string }>;

    expect(engrams.length).toBe(1);
    expect(engrams[0].concept).toContain('Task context');
    expect(engrams[0].content).toContain('src/index.ts');
    expect(engrams[0].content).toContain('REST over WebSocket');
    expect(engrams[0].tags).toContain(`task/${data.assignmentId}`);
    expect(engrams[0].memory_class).toBe('canonical');
  });

  it('does NOT create engram when context is omitted', async () => {
    const { data: checkin } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Bridge-Worker-2', role: 'worker' },
    });

    await http('/assign', {
      method: 'POST',
      body: { agentId: checkin.agentId, task: 'No context task' },
    });

    const db = store.getDb();
    const engrams = db.prepare(
      `SELECT * FROM engrams WHERE concept LIKE '%No context%'`
    ).all();

    expect(engrams.length).toBe(0);
  });

  it('does NOT create engram when context is invalid JSON', async () => {
    const { data: checkin } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Bridge-Worker-3', role: 'worker' },
    });

    await http('/assign', {
      method: 'POST',
      body: { agentId: checkin.agentId, task: 'Bad context task', context: 'not json' },
    });

    const db = store.getDb();
    const engrams = db.prepare(
      `SELECT * FROM engrams WHERE concept LIKE '%Bad context%'`
    ).all();

    expect(engrams.length).toBe(0);
  });

  it('does NOT create engram when store is not provided', async () => {
    // Create a separate server instance WITHOUT store
    const noStoreApp = Fastify({ logger: false });
    const db = store.getDb();
    registerCoordinationRoutes(noStoreApp, db); // no store param

    await noStoreApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = noStoreApp.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('unexpected address');
    const noStoreUrl = `http://127.0.0.1:${addr.port}`;

    const { data: checkin } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Bridge-Worker-4', role: 'worker' },
    });

    const context = JSON.stringify({ files: [{ path: 'test.ts' }] });
    const preCount = (db.prepare(`SELECT COUNT(*) AS c FROM engrams`).get() as { c: number }).c;

    await globalThis.fetch(`${noStoreUrl}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: checkin.agentId, task: 'No store task', context }),
    });

    const postCount = (db.prepare(`SELECT COUNT(*) AS c FROM engrams`).get() as { c: number }).c;
    expect(postCount).toBe(preCount);

    await noStoreApp.close();
  });
});
