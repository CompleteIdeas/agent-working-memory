import { describe, it, expect } from 'vitest';
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
