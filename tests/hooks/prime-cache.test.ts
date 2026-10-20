import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { primeCacheGet, primeCachePut, primeCacheClear } from '../../src/hooks/sidecar.js';

const v = (kept: number) => ({ inject: `x${kept}`, kept, total: 8, tokens: 40 }) as any;

describe('prime-hook result cache (0.19)', () => {
  const saved = process.env.AWM_PRIME_CACHE_MS;
  beforeEach(() => { primeCacheClear(); delete process.env.AWM_PRIME_CACHE_MS; });
  afterEach(() => { if (saved === undefined) delete process.env.AWM_PRIME_CACHE_MS; else process.env.AWM_PRIME_CACHE_MS = saved; });

  it('serves the same shaped question again within the window', () => {
    primeCachePut('work|what port|||', v(6), 1_000);
    expect(primeCacheGet('work|what port|||', 30_000)?.kept).toBe(6);
  });

  it('expires after AWM_PRIME_CACHE_MS (default 60 s)', () => {
    primeCachePut('k', v(6), 1_000);
    expect(primeCacheGet('k', 61_001)).toBeNull();
    expect(primeCacheGet('k', 61_000)).not.toBeNull;
  });

  it('is keyed on the agent and the thresholds, not only the words', () => {
    primeCachePut('work|q|||', v(6), 1_000);
    expect(primeCacheGet('personal|q|||', 2_000)).toBeNull();
    expect(primeCacheGet('work|q|200||', 2_000)).toBeNull();
  });

  it('0 disables it entirely', () => {
    process.env.AWM_PRIME_CACHE_MS = '0';
    primeCachePut('k', v(6), 1_000);
    expect(primeCacheGet('k', 1_001)).toBeNull();
  });

  it('evicts the oldest entry past 64', () => {
    for (let i = 0; i < 65; i++) primeCachePut(`k${i}`, v(i), 1_000 + i);
    expect(primeCacheGet('k0', 2_000)).toBeNull();
    expect(primeCacheGet('k64', 2_000)?.kept).toBe(64);
  });
});
