/**
 * Coordination endpoint tests — GET /metrics, GET /timeline
 *
 * Run: npx vitest run tests/metrics-timeline.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

const DB_PATH = join(tmpdir(), `awm-mt-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;

async function httpJson(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const resp = await globalThis.fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

async function httpText(path: string): Promise<{ status: number; text: string; contentType: string }> {
  const resp = await globalThis.fetch(`${baseUrl}${path}`);
  const text = await resp.text();
  return { status: resp.status, text, contentType: resp.headers.get('content-type') ?? '' };
}

async function registerAgent(name: string): Promise<string> {
  const { data } = await httpJson('/checkin', {
    method: 'POST',
    body: { name, role: 'worker', workspace: 'TEST' },
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

// ─── GET /metrics ───────────────────────────────────────────────

describe('GET /metrics', () => {
  it('returns text/plain content type', async () => {
    const { contentType } = await httpText('/metrics');
    expect(contentType).toContain('text/plain');
  });

  it('returns Prometheus-style lines', async () => {
    await registerAgent('Metric-A');

    const { text } = await httpText('/metrics');
    expect(text).toContain('# HELP coord_agents_total');
    expect(text).toContain('# TYPE coord_agents_total gauge');
    expect(text).toContain('coord_agents_total{status="idle"} 1');
  });

  it('includes assignment metrics', async () => {
    const agentId = await registerAgent('Metric-B');
    await httpJson('/assign', { method: 'POST', body: { task: 'pending task' } });
    await httpJson('/assign', { method: 'POST', body: { agentId, task: 'assigned task' } });

    const { text } = await httpText('/metrics');
    expect(text).toContain('coord_assignments_total');
    expect(text).toContain('coord_assignments_total{status="pending"} 1');
    expect(text).toContain('coord_assignments_total{status="assigned"} 1');
  });

  it('includes locks, events, and uptime metrics', async () => {
    await registerAgent('Metric-C');

    const { text } = await httpText('/metrics');
    expect(text).toContain('coord_locks_active');
    expect(text).toContain('coord_events_total');
    expect(text).toContain('coord_uptime_seconds');
  });

  it('agent counts match /stats counts', async () => {
    const agentId = await registerAgent('Metric-D');
    await registerAgent('Metric-E');
    await httpJson('/assign', { method: 'POST', body: { agentId, task: 'work' } });

    const { text } = await httpText('/metrics');
    const { data: stats } = await httpJson('/stats');

    // Extract idle count from metrics
    const idleMatch = text.match(/coord_agents_total\{status="idle"\} (\d+)/);
    const workingMatch = text.match(/coord_agents_total\{status="working"\} (\d+)/);

    expect(Number(idleMatch?.[1] ?? 0)).toBe(stats.workers.idle);
    expect(Number(workingMatch?.[1] ?? 0)).toBe(stats.workers.working);
  });

  it('returns valid output with empty database', async () => {
    const { status, text } = await httpText('/metrics');
    expect(status).toBe(200);
    expect(text).toContain('coord_agents_total');
    expect(text).toContain('coord_uptime_seconds 0');
  });
});

// ─── GET /timeline ──────────────────────────────────────────────

describe('GET /timeline', () => {
  it('returns events with agent_name enrichment', async () => {
    await registerAgent('Timeline-A');

    const { data } = await httpJson('/timeline');
    expect(data.timeline.length).toBeGreaterThanOrEqual(1);

    const regEvent = data.timeline.find((e: any) => e.event_type === 'registered');
    expect(regEvent).toBeTruthy();
    expect(regEvent.agent_name).toBe('Timeline-A');
    expect(regEvent.timestamp).toBeTruthy();
  });

  it('returns events in reverse chronological order', async () => {
    await registerAgent('Timeline-B');
    await registerAgent('Timeline-C');

    const { data } = await httpJson('/timeline');
    // First event should be the most recent
    for (let i = 1; i < data.timeline.length; i++) {
      expect(data.timeline[i - 1].timestamp >= data.timeline[i].timestamp).toBe(true);
    }
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await registerAgent(`Timeline-Lim-${i}`);
    }

    const { data } = await httpJson('/timeline?limit=3');
    expect(data.timeline.length).toBe(3);
  });

  it('returns empty timeline when no events', async () => {
    const { data } = await httpJson('/timeline');
    expect(data.timeline).toEqual([]);
  });

  it('includes multiple event types', async () => {
    const agentId = await registerAgent('Timeline-D');
    await httpJson('/lock', {
      method: 'POST',
      body: { agentId, filePath: 'src/test.ts', reason: 'testing' },
    });
    await httpJson('/lock', {
      method: 'DELETE',
      body: { agentId, filePath: 'src/test.ts' },
    });

    const { data } = await httpJson('/timeline');
    const types = new Set(data.timeline.map((e: any) => e.event_type));
    expect(types.has('registered')).toBe(true);
    expect(types.has('lock_acquired')).toBe(true);
    expect(types.has('lock_released')).toBe(true);
  });
});
