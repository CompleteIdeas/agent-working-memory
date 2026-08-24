import { describe, it, expect, afterEach } from 'vitest';
import { buildWhoami, formatWhoami } from '../../src/core/whoami.js';

describe('whoami (D3 instance identity)', () => {
  const store = { listAgentIds: () => ['personal', 'work', 'lme_test'] };

  it('builds identity with siblings excluding self, sorted', async () => {
    const w = await buildWhoami(store, 'work', 'mcp');
    expect(w.agentId).toBe('work');
    expect(w.surface).toBe('mcp');
    expect(w.siblingAgents).toEqual(['lme_test', 'personal']);
    expect(w.mode === 'standalone' || w.mode === 'hive').toBe(true);
    expect(w.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(w.backend.length).toBeGreaterThan(0);
    expect(w.codePath.length).toBeGreaterThan(0);
    expect(w.pid).toBe(process.pid);
  });

  it('never fails when the store listing throws', async () => {
    const bad = { listAgentIds: () => { throw new Error('boom'); } };
    const w = await buildWhoami(bad, 'work', 'http');
    expect(w.siblingAgents).toEqual([]);
    expect(w.surface).toBe('http');
  });

  it('formats a readable multi-line identity incl. sibling guidance', async () => {
    const w = await buildWhoami(store, 'work', 'mcp');
    const s = formatWhoami(w);
    expect(s).toContain('Agent: work');
    expect(s).toContain('Sibling agent spaces in this store: lme_test, personal');
    expect(s).toContain("recall is scoped to 'work'");
    const none = formatWhoami({ ...w, siblingAgents: [] });
    expect(none).toContain('Sibling agent spaces in this store: none');
  });
});

describe('whoami — effective recall configuration', () => {
  const store = { listAgentIds: () => ['work'] };
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['AWM_RERANK2', 'AWM_RERANK_WINDOW']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('reports "default" when no recall flag is set', async () => {
    delete process.env.AWM_RERANK2;
    delete process.env.AWM_RERANK_WINDOW;
    const w = await buildWhoami(store, 'work', 'mcp');
    expect(w.recall.fingerprint).toBe('default');
    expect(w.recall.flags).toEqual({});
    expect(formatWhoami(w)).toContain('Recall config: default');
  });

  it('surfaces the flags that are actually live', async () => {
    // The reason this exists: `whoami` is the "what am I actually running"
    // tool, and version alone does not answer it — a current build can have
    // the behaviour-changing flags unset, or set to something unintended.
    process.env.AWM_RERANK2 = '1';
    process.env.AWM_RERANK_WINDOW = 'query';
    const w = await buildWhoami(store, 'work', 'mcp');
    expect(w.recall.flags).toMatchObject({ AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query' });
    const out = formatWhoami(w);
    expect(out).toContain('rerank2=1');
    expect(out).toContain('rerank_window=query');
  });
});
