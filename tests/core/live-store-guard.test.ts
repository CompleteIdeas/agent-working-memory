/**
 * A harness must not open the live store (A-3, 2026-10-12).
 *
 * Every launcher defaults AWM_DB_PATH to ~/.awm/memory.db — right for the product,
 * wrong for a harness that forgot to override it, because harnesses write. 4,745
 * LoCoMo fixture engrams were found in the live store across 51 unpinned UUID agent
 * spaces and purged on 2026-10-11; nine real memories sat among them, and a naive
 * filter would have destroyed those too.
 *
 * The guard sits where a store is OPENED (storage/factory.ts), not where a path is
 * computed — resolving a string is harmless, and putting it there broke an existing
 * setup test that legitimately asserts the default path.
 *
 * Run: npx vitest run tests/core/live-store-guard.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  isLiveStorePath,
  isTestOrBenchContext,
  assertNotLiveStoreUnderTest,
} from '../../src/adapters/common.js';

const LIVE = join(homedir(), '.awm', 'memory.db');

describe('live-store guard', () => {
  afterEach(() => {
    delete process.env.AWM_ALLOW_LIVE_STORE;
  });

  it('identifies the live store path', () => {
    expect(isLiveStorePath(LIVE)).toBe(true);
  });

  it('identifies it regardless of separator or redundant segments', () => {
    expect(isLiveStorePath(join(homedir(), '.awm', '..', '.awm', 'memory.db'))).toBe(true);
    expect(isLiveStorePath(LIVE.replace(/\\/g, '/'))).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('identifies it however Windows spells the same file', () => {
    // A tool that lowercases the drive letter, or a long-path prefix, is still the live store.
    expect(isLiveStorePath(LIVE.replace(/^[A-Z]:/, d => d.toLowerCase()))).toBe(true);
    expect(isLiveStorePath(LIVE.toUpperCase())).toBe(true);
    expect(isLiveStorePath(`\\\\?\\${LIVE}`)).toBe(true);
  });

  it('covers the default PGlite store directory as well', () => {
    expect(isLiveStorePath(join(homedir(), '.awm', 'memory-pglite'))).toBe(true);
  });

  it('does not treat NODE_ENV=test as a harness: a developer shell exporting it would take the MCP server down', () => {
    const vitest = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'test';
      expect(isTestOrBenchContext()).toBe(false);
      expect(() => assertNotLiveStoreUnderTest(LIVE)).not.toThrow();
      process.env.AWM_BENCH = '1';
      expect(isTestOrBenchContext()).toBe(true);
    } finally {
      if (vitest === undefined) delete process.env.VITEST; else process.env.VITEST = vitest;
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
      delete process.env.AWM_BENCH;
    }
  });

  it('does not mistake a scratch or snapshot store for the live one', () => {
    expect(isLiveStorePath(join(homedir(), '.awm', 'scratch.db'))).toBe(false);
    expect(isLiveStorePath('tests/realstore-eval/snapshot/store-backfilled.db')).toBe(false);
    expect(isLiveStorePath('memory.db')).toBe(false);
  });

  it('knows this process is a test context', () => {
    // Set by the runner itself, so it needs no cooperation from the test.
    expect(isTestOrBenchContext()).toBe(true);
  });

  it('throws on the live store, naming the path and the fix', () => {
    try {
      assertNotLiveStoreUnderTest(LIVE);
      throw new Error('expected assertNotLiveStoreUnderTest to throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('refused to open the live store');
      expect(msg).toContain(LIVE);
      expect(msg).toContain('AWM_DB_PATH');
    }
  });

  it('allows any other path', () => {
    expect(() => assertNotLiveStoreUnderTest(join(homedir(), '.awm', 'scratch.db'))).not.toThrow();
  });

  it('honors the deliberate AWM_ALLOW_LIVE_STORE escape hatch', () => {
    // eval-gap-2026-10-11.md DOES want measurements against the real store,
    // read-only. Opt-in and loud beats a silent default.
    process.env.AWM_ALLOW_LIVE_STORE = '1';
    expect(() => assertNotLiveStoreUnderTest(LIVE)).not.toThrow();
  });
});
