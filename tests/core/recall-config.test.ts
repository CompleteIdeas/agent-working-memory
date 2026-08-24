import { describe, it, expect } from 'vitest';
import {
  RECALL_FLAGS, activeRecallConfig, recallConfigFingerprint, diffRecallConfig,
} from '../../src/core/recall-config.js';

/** Explicit env objects — never mutate process.env, which would leak across tests. */
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('activeRecallConfig', () => {
  it('reports nothing when no recall flag is set', () => {
    expect(activeRecallConfig(env({ PATH: '/usr/bin', HOME: '/root' }))).toEqual({});
  });

  it('reports only recall-affecting flags, ignoring unrelated env', () => {
    const c = activeRecallConfig(env({ AWM_RERANK2: '1', PATH: '/x', AWM_DB_PATH: '/db' }));
    expect(c).toEqual({ AWM_RERANK2: '1' });
  });

  it('treats an empty string as unset', () => {
    expect(activeRecallConfig(env({ AWM_RERANK2: '' }))).toEqual({});
  });
});

describe('recallConfigFingerprint', () => {
  it('is "default" for an unconfigured process', () => {
    expect(recallConfigFingerprint(env({}))).toBe('default');
  });

  it('is stable regardless of env ordering', () => {
    const a = recallConfigFingerprint(env({ AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query' }));
    const b = recallConfigFingerprint(env({ AWM_RERANK_WINDOW: 'query', AWM_RERANK2: '1' }));
    expect(a).toBe(b);
  });

  it('distinguishes configurations that differ only in a VALUE', () => {
    // The D11 failure mode: AWM_SPREAD=1 vs AWM_SPREAD=1 + INHIBIT=0.3 both
    // printed `arm=spread` under the old hardcoded label, so two materially
    // different arms were indistinguishable in their own output.
    const noInhibit = recallConfigFingerprint(env({ AWM_SPREAD: '1' }));
    const inhibit = recallConfigFingerprint(env({ AWM_SPREAD: '1', AWM_SPREAD_INHIBIT: '0.3' }));
    expect(noInhibit).not.toBe(inhibit);
    expect(inhibit).toContain('spread_inhibit=0.3');
  });

  it('covers every flag in RECALL_FLAGS', () => {
    for (const f of RECALL_FLAGS) {
      expect(recallConfigFingerprint(env({ [f]: 'x' }))).not.toBe('default');
    }
  });
});

describe('diffRecallConfig — the guard against measuring a differently-configured system', () => {
  it('passes when the running config matches what was asked for', () => {
    expect(diffRecallConfig({ AWM_RERANK2: '1' }, env({ AWM_RERANK2: '1' }))).toEqual([]);
  });

  it('catches a flag that is not set at all (the stale-baseline-server case)', () => {
    const bad = diffRecallConfig({ AWM_RERANK2: '1' }, env({}));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ flag: 'AWM_RERANK2', expected: '1', actual: undefined });
  });

  it('catches a server left over from a DIFFERENT arm', () => {
    const bad = diffRecallConfig({ AWM_RERANK2: '1' }, env({ AWM_RERANK_WINDOW: 'query' }));
    expect(bad).toHaveLength(1);
  });

  it('catches a wrong VALUE, not just a missing flag', () => {
    const bad = diffRecallConfig({ AWM_SPREAD_INHIBIT: '0.3' }, env({ AWM_SPREAD_INHIBIT: '0' }));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ expected: '0.3', actual: '0' });
  });

  it('reports every mismatch, not just the first', () => {
    const bad = diffRecallConfig(
      { AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query' },
      env({}));
    expect(bad).toHaveLength(2);
  });

  it('ignores extra flags the running system has beyond what was asserted', () => {
    // Asserting a subset is legitimate; only the named flags must match.
    expect(diffRecallConfig({ AWM_RERANK2: '1' },
      env({ AWM_RERANK2: '1', AWM_TOPN_MULT: '8' }))).toEqual([]);
  });
});
