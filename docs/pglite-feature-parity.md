# PGlite ↔ SQLite Feature Parity

> Originally audited at v0.8.5 — 2026-05-26.
> **Last verified v0.22.4 (2026-11-15)** for: backend selection and the env values
> (`src/storage/factory.ts`), the seven SQLite-only paths below (re-located by symbol), the
> questions index on each backend, and the `AWM_PGLITE_BM25_M` / `AWM_IVFFLAT_PROBES` tunables.
> The upgrade Q&A and the "effort to port" estimates were not re-checked.
> Audit source: `git grep -E "BACKEND === 'sqlite'|getDb\(\)|warmSlimCache|walCheckpoint|backup\(|integrityCheck"` over `src/`.

AWM ships three storage backends behind one `IEngramStore` interface. **SQLite is the
default** for new and upgrading users. PGlite is opt-in via `AWM_STORE_BACKEND=pglite` (or
auto-detected when a `memory-pglite/` directory is present on disk). A networked **Postgres**
backend (`AWM_STORE_BACKEND=postgres` + `AWM_DATABASE_URL`, **experimental**) shares PGlite's
SQL surface and is the only backend that is genuinely shared across processes and machines;
see [Networked Postgres](#networked-postgres-experimental) below. The table compares the two
embedded backends.

| Capability | SQLite | PGlite |
|---|---|---|
| Cognitive engines (write, recall, consolidation, retraction, eviction) | ✓ | ✓ |
| Vector search | JS cosine over slim cache | **pgvector** (ivfflat index) |
| Full-text search | FTS5 (BM25, unicode61) | tsvector + websearch_to_tsquery |
| Questions index (0.22) | second FTS5 table `engrams_qfts` (concept, content, tags + questions), read only when recall asks `withQuestions` | separate `fts_q` tsvector (GIN-indexed), read only when recall asks `withQuestions` |
| Hive coordination plugin | ✓ | ✗ (auto-disabled with warning) |
| Hot backups (every 10 min) | ✓ | ✗ (use OS-level dir snapshots) |
| WAL checkpoint on shutdown | ✓ | n/a (PGlite has its own WAL) |
| Integrity check on startup | ✓ | skipped (PGlite has its own consistency model) |
| Slim-cache pre-warm | ✓ | n/a (pgvector replaces the need) |
| `/memory/export` HTTP endpoint | ✓ | returns **501 Not Implemented** |
| `/health` coordination stats | ✓ (when coord enabled) | silently skipped |
| Path-to-real-Postgres for scale | ✗ | ✓ (same SQL surface) |
| Single-file portability | ✓ (`memory.db`) | ✓ (`memory-pglite/` directory) |
| Native bindings required at install | yes (better-sqlite3 prebuilds) | no (pure-JS WASM) |
| **Multi-process safety** (concurrent Claude sessions) | ✓ (WAL mode) | ✗ (single-process WASM — second process aborts) |

The graceful degradation is by design — picking PGlite shouldn't crash the
process, just disable the SQLite-only extras with a warning.

---

## Backend selection (v0.8.5+; `postgres` since 0.10)

In precedence order:

1. `AWM_STORE_BACKEND` env var (`sqlite`, `pglite` or `postgres`) — always wins. An unknown
   value warns and falls back to SQLite. `postgres` reads its connection string from
   `AWM_DATABASE_URL` (default `postgres://localhost:5432/awm`).
2. Auto-detect: `memory-pglite/` directory exists → PGlite.
3. Auto-detect: `memory.db` file exists → SQLite.
4. Fresh install fallback → SQLite.

`openStore()` prints a warning to stderr when a file/directory backend disagrees
with what's on disk (Postgres has nothing on disk, so it is never checked) (e.g. env says pglite, but only `memory.db` is present
with data — the user probably needs to run `awm migrate`). The warning never
fails or silently switches backends.

Suppress with `AWM_SUPPRESS_BACKEND_WARNINGS=1`.

---

## SQLite-only code paths (audit)

All 7 paths below are gated on `BACKEND === 'sqlite'` (or on `store.getDb` existing) and
degrade gracefully on PGlite and Postgres alike. No path *crashes* — they either skip the operation
with a log line or return HTTP 501.

### 1. Hive coordination plugin — `src/coordination/`
- **Gated at:** `coordEnabled` in `src/mcp.ts` (before `registerCoordinationTools`) and
  `isCoordinationEnabled() && BACKEND === 'sqlite'` in `main()` of `src/index.ts`
- **What it does:** worker registry, assignment dispatch, channel push,
  circuit breaker, peer-decision propagation. The plugin uses raw
  `better-sqlite3` calls via `store.getDb()` against `coord_*` tables.
- **PGlite / Postgres behavior:** auto-disabled. Stderr warning:
  *"coordination requested but disabled — coordination plugin requires
  SQLite backend"* (the MCP server prints it on PGlite; on Postgres it prints the generic
  "coordination tools disabled" line). Cognitive engines work normally.
- **Effort to port:** ~3-5 days. ~1500 LOC across `src/coordination/`,
  all using sync better-sqlite3 prepared statements. Needs full async
  refactor + adapter layer for prepared-statement caching on PGlite.

### 2. Hot backup timer — `backupTimer` in `main()`, `src/index.ts`
- **What it does:** every 10 minutes, calls `store.backup(targetPath)`
  (SQLite's online backup API) to write a `.db` snapshot into
  `<dbDir>/backups/`. Prunes to last 6 snapshots.
- **PGlite behavior:** timer not started. Stderr log on shutdown:
  *"backup timer disabled (pglite backend — use OS-level dir snapshots)"*.
- **Effort to port:** trivial-to-moderate. PGlite stores a directory; an
  OS-level `cp -r memory-pglite memory-pglite-backup-<ts>` works
  cross-platform via Node's `fs.cp`. Need to confirm PGlite is checkpointed
  before copy (write-pause or flush API).

### 3. Slim-cache pre-warm — `store.warmSlimCache()` in `src/index.ts` and `src/mcp.ts`
- **What it does:** on startup, populates an in-memory `Map<id, {id,
  concept, embedding}>` for fast vector search (SQLite has no native
  vector index).
- **PGlite behavior:** skipped — PGlite uses pgvector's `ivfflat` index
  natively, no JS-side cache needed.
- **Effort to port:** none required — PGlite already has the equivalent
  via its index.

### 4. WAL checkpoint on shutdown — `store.walCheckpoint()` in the shutdown handlers of `src/index.ts` and `src/mcp.ts`
- **What it does:** before close, runs SQLite's `PRAGMA wal_checkpoint`
  to flush WAL into the main db file.
- **PGlite behavior:** skipped — PGlite WAL is internal to the WASM engine.
- **Effort to port:** none required.

### 5. Integrity check on startup — `store.integrityCheck()` in `main()`, `src/index.ts`
- **What it does:** SQLite `PRAGMA integrity_check`. If it fails, attempts
  to restore the most recent backup before failing the boot.
- **PGlite behavior:** returns `{ok: true, result: 'pglite: skipped'}`.
  PGlite has its own catalog consistency at startup.
- **Effort to port:** moderate. PG has `pg_amcheck` and `VACUUM ANALYZE`
  for similar checks; would need a wrapper.

### 6. `/memory/export` HTTP endpoint — `GET /memory/export` in `src/api/routes.ts`
- **What it does:** stream-exports engrams + associations as JSON for
  backup or migration. Uses raw `SELECT` against the SQLite DB.
- **PGlite behavior:** returns HTTP 501 *"export endpoint requires the
  SQLite backend"*. Recommends using the `awm migrate` CLI instead.
- **Effort to port:** small (~50 LOC). Rewrite the export queries against
  the IEngramStore async interface.

### 7. `/health` coordination stats — the `coordEnabled && typeof store.getDb === 'function'` block of `GET /health` in `src/api/routes.ts`
- **What it does:** when coordination is enabled, includes counts of
  alive agents, pending tasks, active locks in the health response.
- **PGlite behavior:** the `if (typeof getDb === 'function')` guard
  silently skips the coord stats block. Base health response still returned.
- **Effort to port:** depends on coordination plugin port (#1). Same time.

---

## Networked Postgres (experimental)

- **Select:** `AWM_STORE_BACKEND=postgres` and `AWM_DATABASE_URL=postgres://…` (the server needs
  the `pgvector` extension). Implemented by `PostgresEngramStore` in `src/storage/postgres.ts`.
- **Same SQL surface as PGlite:** tsvector full-text search (`fts`, plus `fts_q` for questions),
  pgvector `ivfflat` vector search, the same tunables below.
- **Same SQLite-only gaps:** the seven paths above are skipped exactly as on PGlite (no
  coordination plugin, no hot backups, `/memory/export` returns 501).
- **Open:** a server-DB backup/integrity story and cross-backend recall-quality parity are not
  done; treat it as experimental.

## Tuning the Postgres-family backends

Both apply to PGlite **and** Postgres; neither touches SQLite.

| Env var | Default | What it does |
|---|---|---|
| `AWM_PGLITE_BM25_M` | `1` (no change) | Multiplier on `ts_rank_cd` before it is used as a BM25-like score (`calibrateBm25()`), to bring it closer to the SQLite FTS5 BM25 distribution. Higher M raises scores at the cost of ranking precision. |
| `AWM_IVFFLAT_PROBES` | `5` | `ivfflat.probes` set at connection start. More probes = better vector recall, slower queries (the index is built with `lists = 100`). |

---

## Upgrade safety for existing users

> Q: I'm on AWM 0.7.x or 0.8.0 with `memory.db`. I update to 0.8.5. What happens?

You keep working with no action required. AWM finds your existing
`memory.db`, opens it as SQLite, and continues. PGlite is opt-in only.

> Q: I want to move to PGlite. How?

```sh
awm migrate                      # reads memory.db, writes memory-pglite/
# Then either:
export AWM_STORE_BACKEND=pglite  # explicit
# OR delete memory.db so auto-detect picks pglite next launch
```

> Q: I migrated but my env var still says `sqlite`. What happens?

Auto-detect is overridden by the env var, so you'd open the (now-stale)
`memory.db`. You'd see new memories landing there. To switch:
unset `AWM_STORE_BACKEND` (auto-detect picks pglite if both files exist
because `memory-pglite/` wins), or set it explicitly.

> Q: Can I run two Claude Code sessions against the same PGlite database?

No. PGlite WASM is single-process — the second session's MCP launches
abort with `RuntimeError: Aborted()` from `@electric-sql/pglite`. SQLite
(WAL mode) is the multi-process-safe backend. **MCP configs should point
at SQLite when multi-session use is expected** — which is the common case
for AWM. PGlite is best suited for the long-running HTTP server path where
exactly one process owns the database.

> Q: I run with `AWM_STORE_BACKEND=pglite` but I haven't migrated yet.
> What happens to my `memory.db`?

It's left alone. You'll see this warning on startup:

```
[awm] AWM_STORE_BACKEND=pglite but no data at "memory-pglite". Existing
sqlite data at "memory.db" — run `awm migrate` to convert it to pglite,
or unset AWM_STORE_BACKEND to use sqlite.
```

A fresh empty `memory-pglite/` directory is created, and you start with
0 memories. The old data isn't lost — re-running `awm migrate` picks it up.

---

## Roadmap (history, written at v0.8.5)

> **History, not a plan.** PGlite never became the default: SQLite is still the default in
> v0.22.4, and the networked Postgres backend shipped (experimental, 0.10) instead of PGlite
> taking over first. The coordination plugin and `/memory/export` are still SQLite-only, and
> SQLite has not been deprecated. Kept as a record of the original plan.

- **0.8.x:** SQLite default. PGlite opt-in. Auto-detect + warnings (this release).
- **0.9.x (target):** PGlite default for new installs. Existing `memory.db`
  installs continue on SQLite via auto-detect. Slim-cache code path removed
  (PGlite uses pgvector). Hot-backup parity (dir snapshots).
- **1.0:** Coordination plugin ported to async PGlite. SQLite still supported
  but deprecated. `/memory/export` ported.
- **Post-1.0:** Real-Postgres backend for scale (same code as PGlite, swap
  the connection layer). SQLite removed from the package.
