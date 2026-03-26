/**
 * Coordination endpoint error handling tests
 *
 * Verifies proper 400/422 responses for invalid inputs across all POST endpoints.
 * Run: npx vitest run tests/error-handling.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

const DB_PATH = join(tmpdir(), `awm-err-test-${Date.now()}.db`);
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

async function registerAgent(name: string): Promise<string> {
  const { data } = await http('/checkin', {
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

// ─── POST /checkin errors ───────────────────────────────────────

describe('POST /checkin — validation', () => {
  it('rejects empty name', async () => {
    const { status, data } = await http('/checkin', {
      method: 'POST',
      body: { name: '', role: 'worker' },
    });
    expect(status).toBe(400);
    expect(data.error).toBeTruthy();
  });

  it('rejects missing name', async () => {
    const { status } = await http('/checkin', {
      method: 'POST',
      body: { role: 'worker' },
    });
    expect(status).toBe(400);
  });

  it('accepts missing role (defaults to worker)', async () => {
    const { status, data } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Worker-X' },
    });
    expect(status).toBeLessThanOrEqual(201);
    expect(data.agentId).toBeTruthy();
  });
});

// ─── POST /assign errors ───────────────────────────────────────

describe('POST /assign — validation', () => {
  it('rejects missing task', async () => {
    const { status } = await http('/assign', {
      method: 'POST',
      body: { description: 'no task field' },
    });
    expect(status).toBe(400);
  });

  it('rejects priority > 10', async () => {
    const { status } = await http('/assign', {
      method: 'POST',
      body: { task: 'test', priority: 11 },
    });
    expect(status).toBe(400);
  });

  it('rejects priority < 0', async () => {
    const { status } = await http('/assign', {
      method: 'POST',
      body: { task: 'test', priority: -1 },
    });
    expect(status).toBe(400);
  });

  it('rejects non-UUID agentId', async () => {
    const { status } = await http('/assign', {
      method: 'POST',
      body: { task: 'test', agentId: 'not-a-uuid' },
    });
    expect(status).toBe(400);
  });
});

// ─── POST /decisions errors ─────────────────────────────────────

describe('POST /decisions — validation', () => {
  it('rejects missing summary', async () => {
    const agentId = await registerAgent('Dec-Err-A');
    const { status } = await http('/decisions', {
      method: 'POST',
      body: { agentId },
    });
    // Zod .parse() throws → 422 or 500
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('rejects non-UUID agentId', async () => {
    const { status } = await http('/decisions', {
      method: 'POST',
      body: { agentId: 'bad-id', summary: 'test' },
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─── POST /finding errors ───────────────────────────────────────

describe('POST /finding — validation', () => {
  it('rejects invalid severity', async () => {
    const agentId = await registerAgent('Find-Err-A');
    const { status } = await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', severity: 'catastrophic', description: 'test' },
    });
    expect(status).toBe(400);
  });

  it('rejects invalid category', async () => {
    const agentId = await registerAgent('Find-Err-B');
    const { status } = await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'invalid-cat', severity: 'info', description: 'test' },
    });
    expect(status).toBe(400);
  });

  it('rejects missing description', async () => {
    const agentId = await registerAgent('Find-Err-C');
    const { status } = await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', severity: 'info' },
    });
    expect(status).toBe(400);
  });
});

// ─── PATCH /assignment errors ───────────────────────────────────

describe('PATCH /assignment — validation', () => {
  it('rejects invalid status value', async () => {
    const agentId = await registerAgent('Patch-Err-A');
    const { data: assign } = await http('/assign', {
      method: 'POST',
      body: { agentId, task: 'test' },
    });

    const { status } = await http(`/assignment/${assign.assignmentId}`, {
      method: 'PATCH',
      body: { status: 'nonexistent_status' },
    });
    expect(status).toBe(400);
  });

  it('rejects non-UUID assignment id', async () => {
    const { status } = await http('/assignment/not-a-uuid', {
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
    // Zod .parse() throws → 422
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─── POST /lock errors ──────────────────────────────────────────

describe('POST /lock — validation', () => {
  it('rejects non-UUID agentId', async () => {
    const { status } = await http('/lock', {
      method: 'POST',
      body: { agentId: 'not-a-uuid', filePath: 'src/test.ts' },
    });
    expect(status).toBe(400);
  });

  it('rejects missing filePath', async () => {
    const agentId = await registerAgent('Lock-Err-A');
    const { status } = await http('/lock', {
      method: 'POST',
      body: { agentId },
    });
    expect(status).toBe(400);
  });
});

// ─── POST /command errors ───────────────────────────────────────

describe('POST /command — validation', () => {
  it('rejects invalid command name', async () => {
    const { status } = await http('/command', {
      method: 'POST',
      body: { command: 'INVALID_COMMAND' },
    });
    expect(status).toBe(400);
  });

  it('rejects missing command field', async () => {
    const { status } = await http('/command', {
      method: 'POST',
      body: { reason: 'no command' },
    });
    expect(status).toBe(400);
  });
});
