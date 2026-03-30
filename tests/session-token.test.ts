/**
 * Session Token — hijack prevention tests.
 *
 * Covers:
 * - /checkin and /next return sessionToken in every response
 * - Token is stable across heartbeats; fresh token issued on reconnect (was dead)
 * - Routes that accept agentId reject mismatched X-Session-Token with 403
 * - Absent X-Session-Token is always accepted (backward compat)
 *
 * Run: npx vitest run tests/session-token.test.ts
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

const DB_PATH = join(tmpdir(), `awm-session-token-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;

async function http(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; data: any }> {
  const resp = await globalThis.fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json();
  return { status: resp.status, data };
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
  // Clear in FK-safe order: dependents first, then referenced tables
  db.exec(`DELETE FROM coord_events`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_channel_sessions`);
  db.exec(`DELETE FROM coord_findings`);
  db.exec(`DELETE FROM coord_decisions`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
  db.exec(`DELETE FROM coord_commands`);
});

// ─── Token issuance ─────────────────────────────────────────────

describe('session token issuance', () => {
  it('/checkin returns a sessionToken on registration', async () => {
    const { status, data } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-A', role: 'worker', workspace: 'TEST' },
    });
    expect(status).toBe(201);
    expect(data.sessionToken).toBeDefined();
    expect(typeof data.sessionToken).toBe('string');
    expect(data.sessionToken.length).toBeGreaterThan(10);
  });

  it('/checkin returns same token on heartbeat (stable while alive)', async () => {
    const { data: reg } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-B', role: 'worker', workspace: 'TEST' },
    });
    const token = reg.sessionToken;

    const { data: hb } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-B', role: 'worker', workspace: 'TEST' },
    });
    expect(hb.sessionToken).toBe(token);
    expect(hb.action).toBe('heartbeat');
  });

  it('/checkin returns fresh token after dead reconnect', async () => {
    const { data: reg } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-C', role: 'worker', workspace: 'TEST' },
    });
    const oldToken = reg.sessionToken;
    const agentId = reg.agentId;

    // Kill the agent
    db.prepare(`UPDATE coord_agents SET status = 'dead' WHERE id = ?`).run(agentId);

    const { data: recon } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-C', role: 'worker', workspace: 'TEST' },
    });
    expect(recon.action).toBe('reconnected');
    expect(recon.sessionToken).toBeDefined();
    expect(recon.sessionToken).not.toBe(oldToken); // New token on reconnect
  });

  it('/next returns a sessionToken on registration', async () => {
    const { data } = await http('/next', {
      method: 'POST',
      body: { name: 'Token-D', role: 'worker', workspace: 'TEST' },
    });
    expect(data.sessionToken).toBeDefined();
    expect(typeof data.sessionToken).toBe('string');
  });

  it('/next returns same token on heartbeat', async () => {
    const { data: first } = await http('/next', {
      method: 'POST',
      body: { name: 'Token-E', role: 'worker', workspace: 'TEST' },
    });
    const token = first.sessionToken;

    const { data: second } = await http('/next', {
      method: 'POST',
      body: { name: 'Token-E', role: 'worker', workspace: 'TEST' },
    });
    expect(second.sessionToken).toBe(token);
  });

  it('/next returns fresh token after dead reconnect', async () => {
    const { data: first } = await http('/next', {
      method: 'POST',
      body: { name: 'Token-F', role: 'worker', workspace: 'TEST' },
    });
    const oldToken = first.sessionToken;

    db.prepare(`UPDATE coord_agents SET status = 'dead' WHERE id = ?`).run(first.agentId);

    const { data: recon } = await http('/next', {
      method: 'POST',
      body: { name: 'Token-F', role: 'worker', workspace: 'TEST' },
    });
    expect(recon.sessionToken).not.toBe(oldToken);
  });

  it('session_token is stored in coord_agents table', async () => {
    const { data } = await http('/checkin', {
      method: 'POST',
      body: { name: 'Token-G', role: 'worker', workspace: 'TEST' },
    });
    const row = db.prepare(`SELECT session_token FROM coord_agents WHERE id = ?`).get(data.agentId) as any;
    expect(row.session_token).toBe(data.sessionToken);
  });
});

// ─── Token validation ────────────────────────────────────────────

describe('session token validation', () => {
  async function register(name: string): Promise<{ agentId: string; sessionToken: string }> {
    const { data } = await http('/checkin', {
      method: 'POST',
      body: { name, role: 'worker', workspace: 'TEST' },
    });
    return { agentId: data.agentId, sessionToken: data.sessionToken };
  }

  it('/checkout: valid token is accepted', async () => {
    const { agentId, sessionToken } = await register('Checkout-Valid');
    const { status } = await http('/checkout', {
      method: 'POST',
      body: { agentId },
      headers: { 'x-session-token': sessionToken },
    });
    expect(status).toBe(200);
  });

  it('/checkout: invalid token returns 403', async () => {
    const { agentId } = await register('Checkout-Invalid');
    const { status, data } = await http('/checkout', {
      method: 'POST',
      body: { agentId },
      headers: { 'x-session-token': 'wrong-token' },
    });
    expect(status).toBe(403);
    expect(data.error).toBe('invalid session token');
  });

  it('/checkout: no token header is accepted (backward compat)', async () => {
    const { agentId } = await register('Checkout-NoToken');
    const { status } = await http('/checkout', {
      method: 'POST',
      body: { agentId },
    });
    expect(status).toBe(200);
  });

  it('/pulse: invalid token returns 403', async () => {
    const { agentId } = await register('Pulse-Invalid');
    const { status } = await http('/pulse', {
      method: 'PATCH',
      body: { agentId },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });

  it('/pulse: no token is accepted', async () => {
    const { agentId } = await register('Pulse-NoToken');
    const { status } = await http('/pulse', {
      method: 'PATCH',
      body: { agentId },
    });
    expect(status).toBe(200);
  });

  it('/lock (acquire): invalid token returns 403', async () => {
    const { agentId } = await register('Lock-Invalid');
    const { status } = await http('/lock', {
      method: 'POST',
      body: { agentId, filePath: 'src/test.ts' },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });

  it('/lock (acquire): valid token is accepted', async () => {
    const { agentId, sessionToken } = await register('Lock-Valid');
    const { status } = await http('/lock', {
      method: 'POST',
      body: { agentId, filePath: 'src/valid.ts' },
      headers: { 'x-session-token': sessionToken },
    });
    expect(status).toBe(200);
  });

  it('/lock (release): invalid token returns 403', async () => {
    const { agentId, sessionToken } = await register('LockRel-Test');
    // Acquire first with valid token
    await http('/lock', {
      method: 'POST',
      body: { agentId, filePath: 'src/release.ts' },
      headers: { 'x-session-token': sessionToken },
    });
    // Try to release with bad token
    const { status } = await http('/lock', {
      method: 'DELETE',
      body: { agentId, filePath: 'src/release.ts' },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });

  it('/finding: invalid token returns 403', async () => {
    const { agentId } = await register('Finding-Invalid');
    const { status } = await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', description: 'test finding' },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });

  it('/finding: no token is accepted', async () => {
    const { agentId } = await register('Finding-NoToken');
    const { status } = await http('/finding', {
      method: 'POST',
      body: { agentId, category: 'bug', description: 'test finding' },
    });
    expect(status).toBe(201);
  });

  it('/decisions: invalid token returns 403', async () => {
    const { agentId } = await register('Decision-Invalid');
    const { status } = await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'test decision' },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });

  it('/decisions: valid token is accepted', async () => {
    const { agentId, sessionToken } = await register('Decision-Valid');
    const { status } = await http('/decisions', {
      method: 'POST',
      body: { agentId, summary: 'test decision' },
      headers: { 'x-session-token': sessionToken },
    });
    expect(status).toBe(201);
  });

  it('/assignment/:id/claim: invalid token returns 403', async () => {
    const { agentId } = await register('Claim-Invalid');

    // Create a pending assignment
    const assignId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO coord_assignments (id, task, status) VALUES (?, 'test task', 'pending')`
    ).run(assignId);

    const { status } = await http(`/assignment/${assignId}/claim`, {
      method: 'POST',
      body: { agentId },
      headers: { 'x-session-token': 'bad-token' },
    });
    expect(status).toBe(403);
  });
});
