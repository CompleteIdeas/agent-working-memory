/**
 * Channel Sessions — Integration Tests
 *
 * Tests: POST /channel/register, GET /channel/sessions, POST /channel/push,
 * DELETE /channel/register, and POST /checkout cleanup of channel sessions.
 *
 * Run: npx vitest run tests/channel-sessions.test.ts
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

const DB_PATH = join(tmpdir(), `awm-channel-sessions-test-${Date.now()}.db`);
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
  db.exec(`DELETE FROM coord_channel_sessions`);
  db.exec(`DELETE FROM coord_locks`);
  db.exec(`DELETE FROM coord_assignments`);
  db.exec(`DELETE FROM coord_agents`);
});

// ─── POST /channel/register ─────────────────────────────────────

describe('POST /channel/register', () => {
  it('registers a channel session for an existing agent', async () => {
    const agentId = insertAgent('Worker-A');
    const { status, data } = await http('/channel/register', {
      method: 'POST',
      body: { agentId, channelId: 'mcp-channel-abc' },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify in DB
    const row = db.prepare('SELECT * FROM coord_channel_sessions WHERE agent_id = ?').get(agentId) as any;
    expect(row).toBeTruthy();
    expect(row.channel_id).toBe('mcp-channel-abc');
    expect(row.status).toBe('connected');
    expect(row.push_count).toBe(0);
  });

  it('upserts on re-register (resets push_count and status)', async () => {
    const agentId = insertAgent('Worker-A');

    // First register
    await http('/channel/register', {
      method: 'POST',
      body: { agentId, channelId: 'channel-1' },
    });

    // Simulate some pushes
    db.prepare('UPDATE coord_channel_sessions SET push_count = 5 WHERE agent_id = ?').run(agentId);

    // Re-register with different channel
    const { status, data } = await http('/channel/register', {
      method: 'POST',
      body: { agentId, channelId: 'channel-2' },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const row = db.prepare('SELECT * FROM coord_channel_sessions WHERE agent_id = ?').get(agentId) as any;
    expect(row.channel_id).toBe('channel-2');
    expect(row.push_count).toBe(0);
    expect(row.status).toBe('connected');
  });

  it('rejects unknown agentId with 404', async () => {
    const { status } = await http('/channel/register', {
      method: 'POST',
      body: { agentId: crypto.randomUUID(), channelId: 'channel-x' },
    });
    expect(status).toBe(404);
  });

  it('rejects missing channelId with 400', async () => {
    const agentId = insertAgent('Worker-A');
    const { status } = await http('/channel/register', {
      method: 'POST',
      body: { agentId },
    });
    expect(status).toBe(400);
  });
});

// ─── GET /channel/sessions ──────────────────────────────────────

describe('GET /channel/sessions', () => {
  it('returns empty list when no sessions', async () => {
    const { status, data } = await http('/channel/sessions');
    expect(status).toBe(200);
    expect(data.sessions).toEqual([]);
  });

  it('returns sessions with agent names joined', async () => {
    const id1 = insertAgent('Worker-A');
    const id2 = insertAgent('Worker-B');

    await http('/channel/register', { method: 'POST', body: { agentId: id1, channelId: 'ch-a' } });
    await http('/channel/register', { method: 'POST', body: { agentId: id2, channelId: 'ch-b' } });

    const { status, data } = await http('/channel/sessions');
    expect(status).toBe(200);
    expect(data.sessions).toHaveLength(2);

    const names = data.sessions.map((s: any) => s.agent_name).sort();
    expect(names).toEqual(['Worker-A', 'Worker-B']);

    const session = data.sessions.find((s: any) => s.agent_name === 'Worker-A');
    expect(session.channel_id).toBe('ch-a');
    expect(session.status).toBe('connected');
    expect(session.push_count).toBe(0);
  });
});

// ─── POST /channel/push ─────────────────────────────────────────

describe('POST /channel/push', () => {
  it('pushes a message and increments push_count', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-push' } });

    const { status, data } = await http('/channel/push', {
      method: 'POST',
      body: { agentId, message: 'New assignment: implement feature X' },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.channelId).toBe('ch-push');

    const row = db.prepare('SELECT push_count, last_push_at FROM coord_channel_sessions WHERE agent_id = ?').get(agentId) as any;
    expect(row.push_count).toBe(1);
    expect(row.last_push_at).toBeTruthy();
  });

  it('returns 404 when no channel session exists', async () => {
    const agentId = insertAgent('Worker-A');
    const { status } = await http('/channel/push', {
      method: 'POST',
      body: { agentId, message: 'test' },
    });
    expect(status).toBe(404);
  });

  it('increments push_count on successive pushes', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-multi' } });

    await http('/channel/push', { method: 'POST', body: { agentId, message: 'msg 1' } });
    await http('/channel/push', { method: 'POST', body: { agentId, message: 'msg 2' } });
    await http('/channel/push', { method: 'POST', body: { agentId, message: 'msg 3' } });

    const row = db.prepare('SELECT push_count FROM coord_channel_sessions WHERE agent_id = ?').get(agentId) as any;
    expect(row.push_count).toBe(3);
  });

  it('creates an event for each push', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-evt' } });

    await http('/channel/push', { method: 'POST', body: { agentId, message: 'hello world' } });

    const events = db.prepare(
      `SELECT * FROM coord_events WHERE agent_id = ? AND event_type = 'channel_push'`
    ).all(agentId) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].detail).toBe('hello world');
  });
});

// ─── DELETE /channel/register ───────────────────────────────────

describe('DELETE /channel/register', () => {
  it('removes a channel session', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-del' } });

    const { status, data } = await http('/channel/register', {
      method: 'DELETE',
      body: { agentId },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const row = db.prepare('SELECT * FROM coord_channel_sessions WHERE agent_id = ?').get(agentId);
    expect(row).toBeUndefined();
  });

  it('returns ok even if no session exists (idempotent)', async () => {
    const agentId = insertAgent('Worker-A');
    const { status, data } = await http('/channel/register', {
      method: 'DELETE',
      body: { agentId },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it('push fails after deregister', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-gone' } });
    await http('/channel/register', { method: 'DELETE', body: { agentId } });

    const { status } = await http('/channel/push', {
      method: 'POST',
      body: { agentId, message: 'should fail' },
    });
    expect(status).toBe(404);
  });
});

// ─── POST /checkout cleans up channel sessions ──────────────────

describe('POST /checkout cleans up channel sessions', () => {
  it('removes channel session when agent checks out', async () => {
    const agentId = insertAgent('Worker-A');
    await http('/channel/register', { method: 'POST', body: { agentId, channelId: 'ch-checkout' } });

    // Verify session exists
    let row = db.prepare('SELECT * FROM coord_channel_sessions WHERE agent_id = ?').get(agentId);
    expect(row).toBeTruthy();

    // Checkout
    const { status, data } = await http('/checkout', {
      method: 'POST',
      body: { agentId },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Session should be gone
    row = db.prepare('SELECT * FROM coord_channel_sessions WHERE agent_id = ?').get(agentId);
    expect(row).toBeUndefined();
  });

  it('session list excludes checked-out agents', async () => {
    const id1 = insertAgent('Worker-A');
    const id2 = insertAgent('Worker-B');

    await http('/channel/register', { method: 'POST', body: { agentId: id1, channelId: 'ch-1' } });
    await http('/channel/register', { method: 'POST', body: { agentId: id2, channelId: 'ch-2' } });

    // Checkout Worker-A
    await http('/checkout', { method: 'POST', body: { agentId: id1 } });

    const { data } = await http('/channel/sessions');
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].agent_name).toBe('Worker-B');
  });
});
