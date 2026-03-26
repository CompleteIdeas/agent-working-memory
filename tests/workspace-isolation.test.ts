/**
 * Workspace isolation tests
 *
 * Verifies that workspace filtering works correctly on key endpoints.
 * Run: npx vitest run tests/workspace-isolation.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

const DB_PATH = join(tmpdir(), `awm-ws-test-${Date.now()}.db`);
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

async function registerAgent(name: string, workspace: string): Promise<string> {
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

// ─── GET /workers — workspace filtering ─────────────────────────

describe('GET /workers — workspace isolation', () => {
  it('returns only workers in the requested workspace', async () => {
    await registerAgent('WS-A', 'WORK');
    await registerAgent('WS-B', 'PERSONAL');
    await registerAgent('WS-C', 'WORK');

    const { data } = await http('/workers?workspace=WORK');
    const names = data.workers.map((w: any) => w.name);
    expect(names).toContain('WS-A');
    expect(names).toContain('WS-C');
    expect(names).not.toContain('WS-B');
  });

  it('returns all workers when no workspace filter', async () => {
    await registerAgent('All-A', 'WORK');
    await registerAgent('All-B', 'PERSONAL');

    const { data } = await http('/workers');
    expect(data.count).toBe(2);
  });

  it('returns empty when workspace has no workers', async () => {
    await registerAgent('Ghost-A', 'WORK');

    const { data } = await http('/workers?workspace=NONEXISTENT');
    expect(data.count).toBe(0);
    expect(data.workers).toEqual([]);
  });

  it('status filter works with workspace filter', async () => {
    const agentA = await registerAgent('Combo-A', 'WORK');
    await registerAgent('Combo-B', 'WORK');

    // Make Combo-A working
    await http('/assign', { method: 'POST', body: { agentId: agentA, task: 'busy' } });

    const { data } = await http('/workers?workspace=WORK&status=idle');
    expect(data.count).toBe(1);
    expect(data.workers[0].name).toBe('Combo-B');
  });
});

// ─── GET /events — agent_id filtering ───────────────────────────

describe('GET /events — agent_id isolation', () => {
  it('returns only events for the specified agent', async () => {
    const agentA = await registerAgent('Evt-A', 'WORK');
    const agentB = await registerAgent('Evt-B', 'PERSONAL');

    const { data } = await http(`/events?agent_id=${agentA}`);
    for (const e of data.events) {
      expect(e.agent_id).toBe(agentA);
    }
    const agentBEvents = data.events.filter((e: any) => e.agent_id === agentB);
    expect(agentBEvents).toHaveLength(0);
  });

  it('returns all events when no agent_id filter', async () => {
    await registerAgent('Evt-C', 'WORK');
    await registerAgent('Evt-D', 'PERSONAL');

    const { data } = await http('/events');
    expect(data.events.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── POST /next — workspace-scoped agent reuse ──────────────────

describe('POST /next — workspace scoping', () => {
  it('same name in different workspaces reuses agent (name-only fallback)', async () => {
    // /next falls back to name-only lookup to prevent orphaned assignments
    const { data: d1 } = await http('/next', {
      method: 'POST',
      body: { name: 'Worker-X', role: 'worker', workspace: 'WORK' },
    });
    const { data: d2 } = await http('/next', {
      method: 'POST',
      body: { name: 'Worker-X', role: 'worker', workspace: 'PERSONAL' },
    });

    // Same agent reused — workspace updated on the existing record
    expect(d1.agentId).toBe(d2.agentId);
  });

  it('same name and workspace reuses the same agent', async () => {
    const { data: d1 } = await http('/next', {
      method: 'POST',
      body: { name: 'Worker-Y', role: 'worker', workspace: 'WORK' },
    });
    const { data: d2 } = await http('/next', {
      method: 'POST',
      body: { name: 'Worker-Y', role: 'worker', workspace: 'WORK' },
    });

    expect(d1.agentId).toBe(d2.agentId);
  });
});

// ─── POST /command — workspace-scoped commands ──────────────────

describe('POST /command — workspace isolation', () => {
  it('workspace-scoped command only visible to that workspace', async () => {
    await http('/command', {
      method: 'POST',
      body: { command: 'BUILD_FREEZE', workspace: 'WORK' },
    });

    const { data: work } = await http('/command?workspace=WORK');
    expect(work.active).toBe(true);

    // PERSONAL should also see it (workspace=NULL commands are global,
    // and workspace-scoped commands include workspace match OR NULL)
    // but PERSONAL shouldn't see WORK-scoped commands
    const { data: personal } = await http('/command?workspace=PERSONAL');
    // A WORK-scoped command should NOT show for PERSONAL
    const workCmds = personal.commands.filter((c: any) => c.workspace === 'WORK');
    expect(workCmds).toHaveLength(0);
  });
});
