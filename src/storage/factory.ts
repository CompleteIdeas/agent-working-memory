// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Storage backend factory.
 *
 * Picks between SQLite (mature, full features) and PGlite (portable, async,
 * pgvector). Both backends satisfy the IEngramStore contract — the cognitive
 * engines work with either through `await`.
 *
 *   AWM_STORE_BACKEND=sqlite  — better-sqlite3 + FTS5 + BLOB embeddings
 *   AWM_STORE_BACKEND=pglite  — PGlite + pgvector + tsvector
 *
 * **Backend selection (v0.8.5):** auto-detect on disk when the env var is
 * unset, so upgrading users on existing `memory.db` files keep working
 * without setting anything. Order of precedence:
 *
 *   1. `AWM_STORE_BACKEND` env var (explicit override — always wins).
 *   2. Auto-detect: if `memory-pglite/` exists on disk → pglite.
 *   3. Auto-detect: else if `memory.db` exists on disk → sqlite.
 *   4. Fall back to sqlite (the default for fresh installs).
 *
 * If `AWM_STORE_BACKEND` is set but the on-disk state disagrees (e.g. env
 * says pglite but only `memory.db` is present), `openStore` prints a one-line
 * warning suggesting `awm migrate`. The env var still wins — we never
 * silently switch backends behind the user's back.
 *
 * The `AWM_DB_PATH` env var carries the file path (SQLite) or directory
 * path (PGlite). When unset, default is `memory.db` (sqlite) or
 * `memory-pglite/` (pglite).
 *
 * **Feature parity gaps** (see `docs/pglite-feature-parity.md`):
 * a few legacy code paths reach for SQLite-specific methods
 * (coordination plugin needs `store.getDb()`, slim-cache warming, hot
 * backups). PGlite-backed AWM is fully functional for the cognitive
 * engines (write, recall, consolidation, retraction, eviction). Opt-in
 * `AWM_STORE_BACKEND=pglite` skips the SQLite-only extras.
 */

import { existsSync, statSync } from 'node:fs';
import type { IEngramStore } from './store.js';

export type StoreBackend = 'sqlite' | 'pglite';

/**
 * Auto-detect the backend from on-disk state. Used when `AWM_STORE_BACKEND`
 * is unset. Looks in the current working directory; honors `AWM_DB_PATH`
 * if it points at a known shape.
 */
function detectBackendFromDisk(): StoreBackend | null {
  // If AWM_DB_PATH is set, infer from its shape.
  const explicitPath = process.env.AWM_DB_PATH;
  if (explicitPath && existsSync(explicitPath)) {
    try {
      const stat = statSync(explicitPath);
      if (stat.isDirectory()) return 'pglite'; // PGlite uses a directory
      if (stat.isFile()) return 'sqlite';      // SQLite is a single file
    } catch { /* fall through */ }
  }

  // Otherwise look for the conventional defaults in cwd.
  // PGlite directory wins over SQLite file when both exist — assume the
  // user actively migrated and forgot to set the env var. We warn below.
  if (existsSync('memory-pglite')) return 'pglite';
  if (existsSync('memory.db')) return 'sqlite';
  return null;
}

export function getConfiguredBackend(): StoreBackend {
  const raw = process.env.AWM_STORE_BACKEND;
  if (raw !== undefined && raw !== '') {
    const normalized = raw.toLowerCase();
    if (normalized === 'pglite') return 'pglite';
    if (normalized === 'sqlite') return 'sqlite';
    console.warn(`Unknown AWM_STORE_BACKEND=${raw}; falling back to sqlite`);
    return 'sqlite';
  }
  // Env unset → auto-detect from on-disk state.
  const detected = detectBackendFromDisk();
  return detected ?? 'sqlite';
}

export function getConfiguredPath(): string {
  if (process.env.AWM_DB_PATH) return process.env.AWM_DB_PATH;
  return getConfiguredBackend() === 'pglite' ? 'memory-pglite' : 'memory.db';
}

/**
 * Print a one-line warning to stderr when the configured backend disagrees
 * with what's actually on disk. We never fail or silently switch backends
 * — the explicit configuration always wins. The warning helps users notice
 * that they may have stranded data on the other backend.
 */
function warnIfBackendDisagreesWithDisk(backend: StoreBackend, path: string): void {
  if (process.env.AWM_SUPPRESS_BACKEND_WARNINGS === '1') return;

  // Only warn when env var was explicit (auto-detect already follows disk).
  if (!process.env.AWM_STORE_BACKEND) return;

  const otherPath = backend === 'pglite' ? 'memory.db' : 'memory-pglite';
  const otherBackend = backend === 'pglite' ? 'sqlite' : 'pglite';

  // The "real" check: configured target doesn't exist yet (fresh / empty) AND
  // the other backend's conventional file exists with data. Likely stranded.
  const configuredExists = existsSync(path);
  const otherExists = existsSync(otherPath);

  if (!configuredExists && otherExists) {
    console.warn(
      `[awm] AWM_STORE_BACKEND=${backend} but no data at "${path}". ` +
      `Existing ${otherBackend} data at "${otherPath}" — run \`awm migrate\` ` +
      `to convert it to ${backend}, or unset AWM_STORE_BACKEND to use ${otherBackend}. ` +
      `Suppress with AWM_SUPPRESS_BACKEND_WARNINGS=1.`,
    );
  }
}

/**
 * Open a store using the env-configured (or auto-detected) backend and path.
 * Returns the concrete store class (cast to IEngramStore at call sites
 * that need the async contract; SQLite callers can keep the concrete class
 * to retain access to SQLite-specific methods like getDb()).
 *
 * Never fails on backend/disk mismatch — only warns. Existing users
 * upgrading without setting env vars get auto-detect; users on the legacy
 * `memory.db` keep working without touching anything.
 */
export async function openStore(): Promise<{
  store: IEngramStore;
  backend: StoreBackend;
  path: string;
}> {
  const backend = getConfiguredBackend();
  const path = getConfiguredPath();

  warnIfBackendDisagreesWithDisk(backend, path);

  if (backend === 'pglite') {
    const { PGliteEngramStore } = await import('./pglite.js');
    const store = new PGliteEngramStore(path);
    await store.ready();
    return { store: store as unknown as IEngramStore, backend, path };
  }

  const { EngramStore } = await import('./sqlite.js');
  const store = new EngramStore(path);
  return { store: store as unknown as IEngramStore, backend, path };
}
