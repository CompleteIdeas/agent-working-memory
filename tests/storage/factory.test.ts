/**
 * Tests for the storage backend factory — verifies that AWM_STORE_BACKEND
 * routes to the right concrete class and that openStore returns a store
 * satisfying the IEngramStore contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { openStore, getConfiguredBackend } from '../../src/storage/factory.js';

const TMP_BASE = join(tmpdir(), `awm-factory-${Date.now()}`);
const originalCwd = process.cwd();

beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
});
afterEach(() => {
  delete process.env.AWM_STORE_BACKEND;
  delete process.env.AWM_DB_PATH;
  process.chdir(originalCwd);
  try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch { /* noop */ }
});

  // REGRESSION. A brand-new store at an explicit AWM_DB_PATH used to inherit its backend
  // from whatever happened to be lying in the current working directory, because
  // detectBackendFromDisk fell through to the `memory-pglite` / `memory.db` conventions
  // when the named path did not exist yet.
  //
  // Running from a checkout containing memory-pglite/ therefore turned
  // AWM_DB_PATH=/tmp/new.db into a PGlite DIRECTORY. PGlite is single-process, so two
  // surfaces pointed at "one shared store" would have had the second refuse to start —
  // which is the entire premise of the Desktop extension. Found by the cross-surface
  // end-to-end test, not by any unit test.
  it('does not take the backend from cwd when AWM_DB_PATH names a store that does not exist yet', () => {
    const cwdWithPglite = join(TMP_BASE, 'checkout');
    mkdirSync(join(cwdWithPglite, 'memory-pglite'), { recursive: true });
    process.chdir(cwdWithPglite);

    process.env.AWM_DB_PATH = join(TMP_BASE, 'brand-new', 'store.db');
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('still honours an explicit AWM_STORE_BACKEND=pglite at a new path', () => {
    const cwdWithPglite = join(TMP_BASE, 'checkout2');
    mkdirSync(cwdWithPglite, { recursive: true });
    process.chdir(cwdWithPglite);

    process.env.AWM_DB_PATH = join(TMP_BASE, 'brand-new-2');
    process.env.AWM_STORE_BACKEND = 'pglite';
    expect(getConfiguredBackend()).toBe('pglite');
  });

  it('still detects pglite from an AWM_DB_PATH that already exists as a directory', () => {
    const dir = join(TMP_BASE, 'existing-pglite');
    mkdirSync(dir, { recursive: true });
    process.env.AWM_DB_PATH = dir;
    expect(getConfiguredBackend()).toBe('pglite');
  });


describe('Storage factory', () => {
  it('honors explicit AWM_STORE_BACKEND=sqlite', () => {
    process.env.AWM_STORE_BACKEND = 'sqlite';
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('accepts AWM_STORE_BACKEND=pglite', () => {
    process.env.AWM_STORE_BACKEND = 'pglite';
    expect(getConfiguredBackend()).toBe('pglite');
  });

  it('falls back to sqlite on unknown values', () => {
    process.env.AWM_STORE_BACKEND = 'cassandra';
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  // --- Auto-detect (v0.8.5) ---

  it('auto-detect: fresh install with no on-disk data → sqlite', () => {
    // Empty cwd with no existing memory.db or memory-pglite/
    const cleanDir = join(TMP_BASE, 'fresh-' + Date.now());
    mkdirSync(cleanDir, { recursive: true });
    process.chdir(cleanDir);
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('auto-detect: memory.db on disk → sqlite', () => {
    const cleanDir = join(TMP_BASE, 'sqlite-on-disk-' + Date.now());
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, 'memory.db'), ''); // empty file, just for existence check
    process.chdir(cleanDir);
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('auto-detect: memory-pglite/ on disk → pglite', () => {
    const cleanDir = join(TMP_BASE, 'pglite-on-disk-' + Date.now());
    mkdirSync(cleanDir, { recursive: true });
    mkdirSync(join(cleanDir, 'memory-pglite'), { recursive: true });
    process.chdir(cleanDir);
    expect(getConfiguredBackend()).toBe('pglite');
  });

  it('auto-detect: BOTH on disk → pglite wins (assume active migration)', () => {
    const cleanDir = join(TMP_BASE, 'both-on-disk-' + Date.now());
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, 'memory.db'), '');
    mkdirSync(join(cleanDir, 'memory-pglite'), { recursive: true });
    process.chdir(cleanDir);
    expect(getConfiguredBackend()).toBe('pglite');
  });

  it('auto-detect: explicit env var beats disk', () => {
    const cleanDir = join(TMP_BASE, 'env-wins-' + Date.now());
    mkdirSync(cleanDir, { recursive: true });
    mkdirSync(join(cleanDir, 'memory-pglite'), { recursive: true });
    process.chdir(cleanDir);
    process.env.AWM_STORE_BACKEND = 'sqlite';
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('auto-detect: AWM_DB_PATH pointing at a directory → pglite', () => {
    const dirPath = join(TMP_BASE, 'custom-dir-' + Date.now());
    mkdirSync(dirPath, { recursive: true });
    process.env.AWM_DB_PATH = dirPath;
    expect(getConfiguredBackend()).toBe('pglite');
  });

  it('auto-detect: AWM_DB_PATH pointing at a file → sqlite', () => {
    const filePath = join(TMP_BASE, 'custom-file-' + Date.now() + '.db');
    writeFileSync(filePath, '');
    process.env.AWM_DB_PATH = filePath;
    expect(getConfiguredBackend()).toBe('sqlite');
  });

  it('opens a sqlite store when configured', async () => {
    process.env.AWM_STORE_BACKEND = 'sqlite';
    process.env.AWM_DB_PATH = join(TMP_BASE, 'sqlite.db');
    const { store, backend, path } = await openStore();
    expect(backend).toBe('sqlite');
    expect(path).toBe(process.env.AWM_DB_PATH);

    // Smoke: write and read via the IEngramStore-shaped surface
    const created = await store.createEngram({
      agentId: 'factory-test',
      concept: 'sqlite via factory',
      content: 'works through the factory',
    } as any);
    const fetched = await store.getEngram(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.concept).toBe('sqlite via factory');

    // Cleanup
    (store as any).close?.();
  });

  it('opens a pglite store when configured', async () => {
    process.env.AWM_STORE_BACKEND = 'pglite';
    process.env.AWM_DB_PATH = join(TMP_BASE, 'pglite-dir');
    const { store, backend, path } = await openStore();
    expect(backend).toBe('pglite');
    expect(path).toBe(process.env.AWM_DB_PATH);

    const created = await store.createEngram({
      agentId: 'factory-test',
      concept: 'pglite via factory',
      content: 'works through the factory too',
      embedding: new Array(384).fill(0.01),
    } as any);
    const fetched = await store.getEngram(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.concept).toBe('pglite via factory');

    await (store as any).close?.();
  }, 60_000);
});
