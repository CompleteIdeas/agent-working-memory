// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Backend-agnostic storage contract for AWM.
 *
 * AWM 0.8.x introduces a pluggable storage layer:
 *   - SQLiteEngramStore: better-sqlite3 + FTS5 + BLOB embeddings (current default)
 *   - PGliteEngramStore: @electric-sql/pglite + pgvector + tsvector (opt-in via
 *     `AWM_STORE_BACKEND=pglite`, planned default in 0.9.x)
 *   - PostgresEngramStore: real Postgres backend for scale (planned, post-1.0)
 *
 * All backends provide the same public surface — defined here as `IEngramStore`.
 * The cognitive engines (activation, consolidation, Hebbian, eviction, etc.)
 * accept `IEngramStore` and work against any conforming backend.
 *
 * The interface is derived from the SQLite implementation via TypeScript's
 * `Omit<>` so it stays in sync automatically. SQLite-specific methods
 * (DB handle access, WAL checkpointing, slim-cache management, integrity
 * checks) are excluded — these are implementation-internal and don't belong
 * in a backend-agnostic contract.
 *
 * Future backends MUST implement every method on `IEngramStore`. They MAY
 * additionally expose backend-specific methods (e.g., PGlite-specific tooling,
 * Postgres pool management) — those are not part of the contract.
 */

import type { EngramStore as SqliteEngramStore } from './sqlite.js';

/**
 * Backend-specific methods on SqliteEngramStore that are NOT part of the
 * shared contract. Other backends may provide functionally-similar methods
 * under different names or not at all.
 */
type SqliteSpecificMethods =
  | 'getDb'              // Returns better-sqlite3 Database — SQLite-only API
  | 'integrityCheck'     // SQLite PRAGMA integrity_check
  | 'walCheckpoint'      // SQLite WAL checkpoint
  | 'stopWalCheckpointTimer'
  | 'backup'             // SQLite backup API; PGlite/Postgres use pg_dump
  | 'warmSlimCache'      // In-memory cache pre-population (SQLite-specific perf opt)
  | 'resetSlimCache'
  | 'getSlimCacheStats'
  | 'transaction';       // SQLite sync transaction helper — PGlite uses withTransaction

/**
 * MaybePromise — covariant union that lets sync and async backends share one contract.
 *
 * Engines `await` every store call. `await T` resolves to T immediately when
 * the backend is sync (SQLite, returning bare values) and resolves the Promise
 * when the backend is async (PGlite). Both shapes satisfy the same interface.
 */
type MaybePromise<T> = T | Promise<T>;

/**
 * Turn every method return type R into `MaybePromise<Awaited<R>>` so the
 * contract accepts both sync and async backends.
 */
type AsyncifyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => MaybePromise<Awaited<R>>
    : T[K];
};

/**
 * The backend-agnostic storage contract.
 *
 * Any class with this shape can be used as the EngramStore for the AWM
 * cognitive engines. New backends should `implements IEngramStore` to get
 * compile-time enforcement of the full surface.
 */
export type IEngramStore = AsyncifyMethods<Omit<SqliteEngramStore, SqliteSpecificMethods>>;

/**
 * Convenience type-only re-export so consumers can `import type { EngramStore }`
 * from this module and get the backend-agnostic contract instead of the
 * SQLite-specific class. Existing imports from `'../storage/sqlite.js'`
 * continue to work and resolve to the SQLite class (which is a structural
 * supertype of IEngramStore).
 */
export type EngramStore = IEngramStore;
