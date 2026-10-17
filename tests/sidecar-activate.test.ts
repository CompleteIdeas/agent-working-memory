import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSidecar } from '../src/hooks/sidecar.js';
import type { IEngramStore } from '../src/storage/store.js';

/**
 * 0.12.2: POST /memory/activate on the hook sidecar — warm recall for hooks.
 * First coverage of the sidecar at all, so the auth gate is exercised too.
 */

const PORT = 18431; // ephemeral-ish, avoids the real 8401
const SECRET = 'test-secret';
const BASE = `http://127.0.0.1:${PORT}`;

// The sidecar only touches the store from its 15-min checkpoint timer, which
// never fires within a test run — a stub is sufficient.
const stubStore = { getCheckpoint: async () => null } as unknown as IEngramStore;

const activateCalls: unknown[] = [];
let handle: { close: () => void };

beforeAll(() => {
  handle = startSidecar({
    store: stubStore,
    agentId: 'sidecar-test',
    secret: SECRET,
    port: PORT,
    activate: async (q) => {
      activateCalls.push(q);
      if (q.context === 'return-nothing') return [];
      return [{
        engram: {
          id: '33333333-3333-3333-3333-333333333333',
          concept: 'test concept',
          content: 'test content',
          createdAt: '2026-08-01T00:00:00.000Z',
          memoryClass: 'canonical',
          validTo: null,
        },
        score: 0.61,
        summary: 'short summary',
        confidence: 0.4,
      }];
    },
  });
});

afterAll(() => handle.close());

const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  fetch(`${BASE}/memory/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

describe('sidecar POST /memory/activate (0.12.2)', () => {
  it('rejects without the bearer secret — recall must not be an unauthenticated surface', async () => {
    const res = await post({ context: 'anything' }, null);
    expect(res.status).toBe(401);
  });

  it('400s when neither context nor query is supplied', async () => {
    const res = await post({ limit: 5 });
    expect(res.status).toBe(400);
  });

  it('returns the trimmed result shape a hook consumes', async () => {
    const res = await post({ context: 'esignature reconciliation', limit: 5, granularity: 'compact' });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<Record<string, any>> };
    expect(body.results).toHaveLength(1);
    const r = body.results[0];
    expect(r.engram.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(r.engram.memoryClass).toBe('canonical');
    expect(r.score).toBe(0.61);
    expect(r.summary).toBe('short summary');
    // Trimmed: no embedding vectors, no phase scores.
    expect(r.engram.embedding).toBeUndefined();
    expect(r.phaseScores).toBeUndefined();
  });

  it('accepts "query" as an alias for "context" and forwards recall params', async () => {
    activateCalls.length = 0;
    const res = await post({ query: 'alias works', limit: 3, requireConfidence: 0.25 });
    expect(res.status).toBe(200);
    expect(activateCalls[0]).toMatchObject({ context: 'alias works', limit: 3, requireConfidence: 0.25 });
  });

  it('passes empty results through as an empty array, not an error', async () => {
    const res = await post({ context: 'return-nothing' });
    expect(res.status).toBe(200);
    expect((await res.json() as { results: unknown[] }).results).toEqual([]);
  });

  it('/hooks/prime recalls against the shaped question, not the whole pasted prompt', async () => {
    activateCalls.length = 0;
    const question = 'why does the reconciliation job time out?';
    const log = Array.from({ length: 40 }, (_, i) => `2026-10-16T13:${String(i).padStart(2, '0')}:07Z INFO heartbeat ok queue=${i}`).join('\n');
    const res = await fetch(`${BASE}/hooks/prime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ prompt: `${question}\n\n${log}` }),
    });
    expect(res.status).toBe(200);
    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0]).toMatchObject({ context: question, limit: 8 });
    expect((await res.json() as { inject: string }).inject).toContain('test concept');
  });

  it('/hooks/prime passes a short prompt through untouched', async () => {
    activateCalls.length = 0;
    await fetch(`${BASE}/hooks/prime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ prompt: 'commit and push the sweep evidence' }),
    });
    expect(activateCalls[0]).toMatchObject({ context: 'commit and push the sweep evidence' });
  });

  it('501s when activate is not wired (older callers)', async () => {
    const bare = startSidecar({
      store: stubStore, agentId: 'bare', secret: SECRET, port: PORT + 1,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/memory/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ context: 'x' }),
      });
      expect(res.status).toBe(501);
    } finally {
      bare.close();
    }
  });
});
