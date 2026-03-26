/**
 * Rate Limiting — Integration Tests
 *
 * Tests the per-agent sliding window rate limiter (60 req/min).
 *
 * Run: npx vitest run tests/rate-limit.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { initCoordinationTables } from '../src/coordination/schema.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';

// ─── Shared test infra ──────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-ratelimit-test-${Date.now()}.db`);
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

// ─── Tests ──────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('allows normal request rate', async () => {
    // A few requests should succeed
    for (let i = 0; i < 5; i++) {
      const { status } = await http('/next', {
        method: 'POST',
        body: { name: 'Normal-Agent', workspace: 'RL-TEST' },
      });
      expect(status).toBeLessThan(429);
    }
  });

  it('returns 429 after exceeding 60 requests/minute for same agent', async () => {
    const agentName = 'Flood-Agent';
    let hitLimit = false;

    // Fire 65 requests rapidly — should trigger 429 after 60
    for (let i = 0; i < 65; i++) {
      const { status } = await http('/next', {
        method: 'POST',
        body: { name: agentName, workspace: 'RL-TEST' },
      });
      if (status === 429) {
        hitLimit = true;
        break;
      }
    }

    expect(hitLimit).toBe(true);
  });

  it('different agents have independent rate limits', async () => {
    // Use agent B — separate from the flooded agent
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { status } = await http('/next', {
        method: 'POST',
        body: { name: 'Independent-Agent', workspace: 'RL-TEST' },
      });
      results.push(status);
    }

    // All should succeed (separate bucket from Flood-Agent)
    expect(results.every(s => s < 429)).toBe(true);
  });

  it('/health is excluded from rate limiting', async () => {
    // /health is registered by the main API, not coordination routes alone.
    // The rate limiter exempts request.url === '/health' so it never returns 429.
    // Here we verify the exemption: 70 /health requests, none should be 429.
    const results: number[] = [];
    for (let i = 0; i < 70; i++) {
      const resp = await globalThis.fetch(`${baseUrl}/health`);
      results.push(resp.status);
    }

    // /health may be 404 (not registered in this test server) but NEVER 429
    expect(results.filter(s => s === 429)).toHaveLength(0);
  });
});
