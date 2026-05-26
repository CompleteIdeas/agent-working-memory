# PGlite ↔ SQLite Feature Parity

> Status as of v0.8.5 — 2026-05-26.
> Audit source: `git grep -E "BACKEND === 'sqlite'|getDb\(\)|warmSlimCache|walCheckpoint|backup\(|integrityCheck"` over `src/`.

AWM ships with two storage backends. **SQLite is the current default** for new
and upgrading users. PGlite is opt-in via `AWM_STORE_BACKEND=pglite` (or
auto-detected when a `memory-pglite/` directory is present on disk).

| Capability | SQLite | PGlite |
|---|---|---|
| Cognitive engines (write, recall, consolidation, retraction, eviction) | ✓ | ✓ |
| Vector search | JS cosine over slim cache | **pgvector** (ivfflat index) |
| Full-text search | FTS5 (BM25, unicode61) | tsvector + websearch_to_tsquery |
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

## Backend selection (v0.8.5+)

In precedence order:

1. `AWM_STORE_BACKEND` env var (`sqlite` or `pglite`) — always wins.
2. Auto-detect: `memory-pglite/` directory exists → PGlite.
3. Auto-detect: `memory.db` file exists → SQLite.
4. Fresh install fallback → SQLite.

`openStore()` prints a warning to stderr when the configured backend disagrees
with what's on disk (e.g. env says pglite, but only `memory.db` is present
with data — the user probably needs to run `awm migrate`). The warning never
fails or silently switches backends.

Suppress with `AWM_SUPPRESS_BACKEND_WARNINGS=1`.

---

## SQLite-only code paths (audit)

All 7 paths below are properly gated on `BACKEND === 'sqlite'` and degrade
gracefully on PGlite. No path *crashes* — they either skip the operation
with a log line or return HTTP 501.

### 1. Hive coordination plugin — `src/coordination/`
- **Gated at:** `src/mcp.ts:1108`, `src/index.ts:136`
- **What it does:** worker registry, assignment dispatch, channel push,
  circuit breaker, peer-decision propagation. The plugin uses raw
  `better-sqlite3` calls via `store.getDb()` against `coord_*` tables.
- **PGlite behavior:** auto-disabled. Stderr warning:
  *"coordination requested but disabled — coordination plugin requires
  SQLite backend"*. Cognitive engines work normally.
- **Effort to port:** ~3-5 days. ~1500 LOC across `src/coordination/`,
  all using sync better-sqlite3 prepared statements. Needs full async
  refactor + adapter layer for prepared-statement caching on PGlite.

### 2. Hot backup timer — `src/index.ts:169-183`
- **What it does:** every 10 minutes, calls `store.backup(targetPath)`
  (SQLite's online backup API) to write a `.db` snapshot into
  `<dbDir>/backups/`. Prunes to last 6 snapshots.
- **PGlite behavior:** timer not started. Stderr log on shutdown:
  *"backup timer disabled (pglite backend — use OS-level dir snapshots)"*.
- **Effort to port:** trivial-to-moderate. PGlite stores a directory; an
  OS-level `cp -r memory-pglite memory-pglite-backup-<ts>` works
  cross-platform via Node's `fs.cp`. Need to confirm PGlite is checkpointed
  before copy (write-pause or flush API).

### 3. Slim-cache pre-warm — `src/index.ts:190-201`
- **What it does:** on startup, populates an in-memory `Map<id, {id,
  concept, embedding}>` for fast vector search (SQLite has no native
  vector index).
- **PGlite behavior:** skipped — PGlite uses pgvector's `ivfflat` index
  natively, no JS-side cache needed.
- **Effort to port:** none required — PGlite already has the equivalent
  via its index.

### 4. WAL checkpoint on shutdown — `src/index.ts:213-215`
- **What it does:** before close, runs SQLite's `PRAGMA wal_checkpoint`
  to flush WAL into the main db file.
- **PGlite behavior:** skipped — PGlite WAL is internal to the WASM engine.
- **Effort to port:** none required.

### 5. Integrity check on startup — `src/index.ts:71-72`
- **What it does:** SQLite `PRAGMA integrity_check`. If it fails, attempts
  to restore the most recent backup before failing the boot.
- **PGlite behavior:** returns `{ok: true, result: 'pglite: skipped'}`.
  PGlite has its own catalog consistency at startup.
- **Effort to port:** moderate. PG has `pg_amcheck` and `VACUUM ANALYZE`
  for similar checks; would need a wrapper.

### 6. `/memory/export` HTTP endpoint — `src/api/routes.ts:903-906`
- **What it does:** stream-exports engrams + associations as JSON for
  backup or migration. Uses raw `SELECT` against the SQLite DB.
- **PGlite behavior:** returns HTTP 501 *"export endpoint requires the
  SQLite backend"*. Recommends using the `awm migrate` CLI instead.
- **Effort to port:** small (~50 LOC). Rewrite the export queries against
  the IEngramStore async interface.

### 7. `/health` coordination stats — `src/api/routes.ts:958-967`
- **What it does:** when coordination is enabled, includes counts of
  alive agents, pending tasks, active locks in the health response.
- **PGlite behavior:** the `if (typeof getDb === 'function')` guard
  silently skips the coord stats block. Base health response still returned.
- **Effort to port:** depends on coordination plugin port (#1). Same time.

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

## Roadmap

- **0.8.x:** SQLite default. PGlite opt-in. Auto-detect + warnings (this release).
- **0.9.x (target):** PGlite default for new installs. Existing `memory.db`
  installs continue on SQLite via auto-detect. Slim-cache code path removed
  (PGlite uses pgvector). Hot-backup parity (dir snapshots).
- **1.0:** Coordination plugin ported to async PGlite. SQLite still supported
  but deprecated. `/memory/export` ported.
- **Post-1.0:** Real-Postgres backend for scale (same code as PGlite, swap
  the connection layer). SQLite removed from the package.
