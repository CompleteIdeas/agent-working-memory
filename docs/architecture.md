# Architecture

## System Overview

AWM is a single-process system: one Node.js process runs the MCP server (stdio), an HTTP API (Fastify), and a hook sidecar — all backed by one SQLite database.

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code / Custom Agent                             │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │  MCP (stdio) │   │  HTTP API    │   │  Hooks     │  │
│  │  16 tools    │   │  18 routes   │   │  (curl)    │  │
│  └──────┬───────┘   └──────┬───────┘   └─────┬──────┘  │
│         │                  │                  │         │
│         └──────────┬───────┘                  │         │
│                    │                          │         │
│              ┌─────▼──────┐          ┌────────▼───────┐ │
│              │  Engine    │          │  Hook Sidecar  │ │
│              │            │          │  (HTTP server) │ │
│              │ activation │          │  checkpoint    │ │
│              │ consolidate│          │  consolidate   │ │
│              │ staging    │          │  stats/timer   │ │
│              │ retraction │          └────────┬───────┘ │
│              └─────┬──────┘                   │         │
│                    │                          │         │
│              ┌─────▼──────────────────────────▼───────┐ │
│              │  Storage (SQLite + FTS5)               │ │
│              │                                        │ │
│              │  engrams │ edges │ episodes │ state    │ │
│              └────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Source Layout

```
src/
  core/             # Cognitive primitives (stateless)
    embeddings.ts     Local vector embeddings (MiniLM-L6-v2, 384d ONNX)
    reranker.ts       Cross-encoder passage scoring (ms-marco-MiniLM)
    query-expander.ts Synonym expansion (flan-t5-small)
    salience.ts       Write-time importance scoring (novelty + salience)
    decay.ts          ACT-R temporal activation decay
    hebbian.ts        Association strengthening/weakening
    logger.ts         Append-only activity log (data/awm.log)
  engine/           # Processing pipelines (stateful)
    activation.ts     10-phase retrieval pipeline
    consolidation.ts  7-phase sleep cycle
    connections.ts    Discover links between memories
    staging.ts        Weak signal buffer (promote or discard)
    retraction.ts     Negative memory / corrections
    eviction.ts       Capacity enforcement
  hooks/
    sidecar.ts        Hook HTTP server (auto-checkpoint, stats, 15-min timer)
  storage/
    sqlite.ts         SQLite + FTS5 persistence (~650 lines)
  api/
    routes.ts         HTTP endpoints (memory + task + system)
  mcp.ts            MCP server (16 tools, incognito support)
  cli.ts            CLI (setup, serve, hook config)
  index.ts          HTTP server entry point
```

## Retrieval Pipeline (10 phases)

The activation pipeline in `src/engine/activation.ts` runs these phases in order:

| Phase | Name | What it does |
|-------|------|-------------|
| 1 | BM25 text search | FTS5 full-text search on concept + content |
| 2 | Semantic search | Cosine similarity on 384d embeddings |
| 3 | Score fusion | Weighted merge of BM25 + semantic candidates |
| 3.5 | Rocchio expansion | Pseudo-relevance feedback: expand query with top-3 terms, re-search |
| 3.7 | Entity-Bridge boost | Boost candidates sharing entity tags with top text matches |
| 4 | Cross-encoder rerank | ms-marco-MiniLM scores passage relevance on a **wide candidate pool** (default `max(limit*4,40)`, `AWM_RERANK_POOL`); adaptive blend. The composite is a cheap pre-filter; the reranker does the discrimination. |
| 4.5 | Abstention gate | Multi-channel OOD agreement, judged on the **post-rerank top-5** (`AWM_ABSTAIN_GATE_K`) so pool width (recall) is decoupled from precision; returns nothing if channels disagree |
| 5 | Temporal decay | ACT-R power-law decay based on time since last access |
| 6 | Graph walk | Beam search over Hebbian + temporal edges |
| 7 | Confidence gating | Filter by confidence threshold, apply feedback bonus |
| 8 | Vector scoring | Raw-cosine floor (`AWM_SIM_FLOOR_*`, default 0.50/0.35), model-tuned for BGE-small (replaced z-score normalization in 0.8.x) |

## Consolidation Pipeline (7 phases)

The sleep cycle in `src/engine/consolidation.ts`:

| Phase | Name | What it does |
|-------|------|-------------|
| 1 | Replay | Identify memory clusters for strengthening |
| 2 | Strengthen | Boost edges between co-accessed memories |
| 2.5 | Synthesis | Tag-grouped session summaries + pattern syntheses |
| 3 | Bridge | Create cross-topic edges between related clusters |
| 4 | Decay | Apply time-based decay to edge weights |
| 5 | Homeostasis | Normalize hub weights to prevent domination |
| **5.5** | **Content fade** (v0.8.5) | Trim content of accessed-but-stale engrams to 150 chars; transition `active → fading`. Preserves concept, tags, embedding. |
| 6 | Forget | Archive/delete low-confidence, low-access memories |
| 6.5 | Redundancy prune | Archive semantically similar (>0.85) low-conf duplicates |
| 6.7 | Confidence drift | Adjust confidence based on structural signals |
| 7 | Sweep staging | Promote or discard memories in staging buffer |

## Database Schema

SQLite with FTS5 for full-text search. The full schema (all `CREATE TABLE`
statements, indices, and triggers) lives at
[`src/storage/sqlite.ts`](../src/storage/sqlite.ts) — read that file
directly for the canonical definition. The full column reference is also
in [`reference.md` → Database Schema](reference.md#database-schema). The
section below is a high-level orientation.

Key tables:

**engrams** — Individual memories
- `id` (UUID), `agent_id`, `concept`, `content`, `event_type`
- `salience`, `confidence`, `access_count`, `last_access`
- `embedding` (384d float array, stored as blob)
- `task_status`, `task_priority`, `blocked_by` (task management)
- `stage` (`staging` / `active` / `fading` / `consolidated` / `archived`) — `fading` added in v0.8.5
- `retracted` (boolean), `retracted_by`, `retracted_at` (soft-delete metadata)

**associations** — Edges between memories
- `from_engram_id`, `to_engram_id`, `weight`, `type` (hebbian / connection / invalidation / temporal / causal)

**episodes** — Grouping of related memories
- `id`, `agent_id`, `name`, `created_at`

**engrams_fts** — FTS5 virtual table on concept + content + tags. Auto-synced via triggers.

**conscious_state** — Checkpoint storage
- `agent_id`, `state` (JSON blob), `updated_at`

**activation_events** — Every recall: context, result count, top score, latency.

**retrieval_feedback** — Useful / not-useful ground truth from `memory_feedback`.

**staging_events** — Consolidation decisions: promoted, discarded, expired.

> If you need to audit memory health or write a custom export, the schema
> file is the source of truth — table names and column orders here may
> drift slightly between minor releases, but `sqlite.ts` is always current.

## Storage Backends

AWM ships two functionally-equivalent backends behind one `IEngramStore`
interface. The cognitive engines (write, recall, consolidation, retraction,
eviction) are identical on both — the difference is operational.

| | SQLite (**default**) | PGlite |
|---|---|---|
| Engine | `better-sqlite3` + FTS5 (BM25) | embedded Postgres-in-WASM + pgvector (ivfflat) |
| Vector search | JS cosine over an in-memory slim cache | native `ivfflat` index |
| Multi-process safe | ✓ (WAL mode — concurrent Claude sessions OK) | ✗ single-process WASM (2nd process aborts) |
| Hive coordination plugin | ✓ | ✗ (auto-disabled with a warning) |
| Hot backups / `/memory/export` | ✓ | ✗ (use OS-level dir snapshots; export returns 501) |
| Native bindings at install | yes (prebuilds) | no (pure-JS) |
| Path to a networked Postgres server | ✗ | ✓ (same SQL surface) |

**Backend selection** (precedence): `AWM_STORE_BACKEND` env (`sqlite`/`pglite`)
→ auto-detect (`memory-pglite/` dir → PGlite, `memory.db` file → SQLite) →
fresh-install fallback to SQLite. A mismatch between the configured backend and
what's on disk prints a warning; it never silently switches.

> **MCP / multi-session setups should use SQLite** — it's the multi-process-safe
> backend. PGlite is best for the single long-running HTTP-server path that owns
> the database. Full capability/parity detail (the 7 SQLite-only code paths and
> their graceful degradation) is in
> [`pglite-feature-parity.md`](pglite-feature-parity.md).

### Roadmap

- **0.8.x** — SQLite default; PGlite opt-in; auto-detect + warnings.
- **0.9.x** — recall-quality + agent-feature improvements (this line); PGlite
  the default for *new* installs (target); existing `memory.db` stays on SQLite.
- **1.0** — coordination plugin + `/memory/export` ported to async PGlite;
  SQLite still supported.
- **Post-1.0 (v1 target)** — a **networked Postgres backend for scale**: same
  engine code as PGlite, swap the connection layer (`AWM_STORE_URL`). Remaining
  work before it ships: cognitive engines made fully `await`-correct at every
  call site, an async adapter for the SQLite path, ported export/coordination,
  and a server-DB backup/integrity story. A deliberate milestone, not a flag flip.

## ML Models

All models run locally via ONNX Runtime (no API calls):

| Model | Size | Purpose |
|-------|------|---------|
| `Xenova/all-MiniLM-L6-v2` | ~23MB | Sentence embeddings (384d) |
| `Xenova/ms-marco-MiniLM-L-6-v2` | ~23MB | Cross-encoder reranking |
| `Xenova/flan-t5-small` | ~78MB | Query expansion |

Models are downloaded on first use and cached in `~/.cache/huggingface/` (or `AWM_CACHE_DIR`).

## Concurrency Model

- **Single writer**: SQLite WAL mode, one process at a time
- MCP (stdio) and HTTP API are not designed to run simultaneously
- Hook sidecar runs inside the MCP process on a separate port
- Consolidation runs synchronously (blocks during sleep cycle)
