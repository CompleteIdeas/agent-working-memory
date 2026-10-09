# Architecture

## System Overview

AWM has **two entry points over one SQLite database**, and they are not designed to run at the same time (see "Process model" below). `src/mcp.ts` is the MCP server (stdio) and it starts the hook sidecar; `src/index.ts` is the HTTP API (Fastify) and it does not. The cognitive engine is identical behind both.

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code / Custom Agent                             │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │  MCP (stdio) │   │  HTTP API    │   │  Hooks     │  │
│  │  19 tools    │   │  28 routes   │   │  (scripts) │  │
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
    embeddings.ts     Local vector embeddings (bge-small-en-v1.5, 384d ONNX)
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
    sqlite.ts         SQLite + FTS5 persistence (~2,020 lines)
  api/
    routes.ts         HTTP endpoints (memory + task + system)
  mcp.ts            MCP server (19 tools: 17 memory + 2 onboarding, incognito support)
  cli.ts            CLI (setup, serve, hook config)
  index.ts          HTTP server entry point
```

## Retrieval Pipeline

The activation pipeline in `src/engine/activation.ts` runs these phases in order.
**The numbers are the code's own**, so they can be grepped — the header comment at
the top of that file is the other copy of this list.

| Phase | Name | What it does |
|-------|------|-------------|
| −1 | Coreference expansion | Conditional: only when the query contains pronouns. |
| 0 | Query expansion | flan-t5-small adds related terms. The **engine** default is off (`AWM_DEFAULT_EXPANSION=1` flips it), but MCP `memory_recall` defaults `use_expansion` to **true**, so it runs on the path most callers use. |
| 1 | Vector embedding | Embed the query, bge-small 384d. |
| 2 | Parallel retrieval | Dual FTS5/BM25 + native vector top-K, concurrently. |
| 3a | Candidate fetch | Hydrate candidates. Entity-index injection splices in here when `AWM_ENTITY_INDEX_FETCH=1` (default off) — *before* scoring, not after it. |
| 3b | Per-candidate scoring | BM25, Jaccard, raw-cosine floor (`AWM_SIM_FLOOR_*`, 0.50/0.35), ACT-R decay, Hebbian boost and the confidence gate are all computed **together here** — not as separate later passes. |
| 3.5 | Rocchio expansion | Pseudo-relevance feedback: take the top 3, harvest novel terms, re-search BM25. **Default OFF since 2026-10-09** (`AWM_FEEDBACK_BM25=1`) — it cost 6.7–7.0% of every recall and moved 3 gold ranks in 950 queries, two of them the wrong way. |
| 3.7 | Entity-bridge boost | Boost candidates sharing entity tags with the top text matches. **Default ON.** |
| 4–5 | Graph walk | Beam search over Hebbian + temporal edges. |
| 6 | Rerank pool | Select the wide candidate pool, default `max(limit*4, 40)` (`AWM_RERANK_POOL`), capped by `limit × AWM_TOPN_MULT`. The composite is a deliberately cheap pre-filter; the cross-encoder does the discrimination. |
| 7 | Cross-encoder rerank | ms-marco-MiniLM scores every pooled candidate and decides final order. ~83% of warm recall latency. |
| 8 | Abstention gate | Multi-channel OOD agreement judged on the **post-rerank top-K** (`AWM_ABSTAIN_GATE_K`, default 5), so pool width (recall) is decoupled from precision. Returns nothing if the channels disagree. Phase 8c applies supersession. |
| 9b | rerank2 | Second-pass reorder using feedback/edge-strength/class bonuses. Engine default off (`AWM_RERANK2=1`), but `awm setup`, the plugin and the Desktop bundle all switch it on. |

> **Corrected 2026-10-09.** This table previously listed temporal decay, graph
> walk, confidence gating and vector scoring as phases 5–8, *after* rerank and
> the abstention gate. They are not: decay, Hebbian boost, the confidence gate
> and the cosine floor are computed together in phase 3b, and rerank is phase 7
> with the gate at 8. Every phase number also disagreed with the code's, so
> grepping for "phase 4.5" found nothing. Phase 0, 3a, 8c and 9b were missing.

## Consolidation Pipeline (8 phases)

The sleep cycle in `src/engine/consolidation.ts`:

| Phase | Name | What it does |
|-------|------|-------------|
| 0 | Connection drain | Discover associations for engrams enqueued since the last cycle. Runs first, before any replay — this row was missing until 2026-10-09, which is why the heading said seven phases. |
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
- `origin_class`, `writer_session`, `recipe_id`, `valid_from`, `valid_to` — memory-spine
  provenance + bi-temporal validity (2026-07-30, log-only: never used in ranking)

**associations** — Edges between memories
- `from_engram_id`, `to_engram_id`, `weight`, `type` (hebbian / connection / invalidation / temporal / causal)

**episodes** — Grouping of related memories
- `id`, `agent_id`, `name`, `created_at`

**entity_mentions / entity_aliases** — Inverted entity index (D9, 2026-07-30). Normalized
`key:value` entities (from prefix tags + auto-tagger `entity:` tags) → engram ids, with an
alias table for alternate names. Write-time bookkeeping on all three backends; retrieval
reads it only behind `AWM_ENTITY_INDEX_FETCH` (D11 guarded injection).

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

AWM ships three backends behind one `IEngramStore` interface — embedded SQLite,
embedded PGlite, and networked Postgres (`AWM_DATABASE_URL`), the last being the
only one that is genuinely shared across processes and machines. The cognitive engines (write, recall, consolidation, retraction,
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

> **Status as of v0.12.2:** the 0.9.x/1.0 targets below were written at v0.8.x and
> have not tracked actual version numbers since — SQLite is still the default for
> new installs (unchanged), and the plan shifted to shipping a **networked Postgres
> backend** (below) directly rather than making PGlite the default first. Left as
> a record of the original plan; treat the version labels as historical, not a
> live schedule.

- **0.8.x** — SQLite default; PGlite opt-in; auto-detect + warnings. (shipped)
- **0.10.0** — networked Postgres backend shipped as **experimental**
  (`AWM_STORE_BACKEND=postgres`) — see "What's New in v0.12.x" in the README and
  CHANGELOG.md for what actually shipped between 0.9.0 and 0.12.2. SQLite remains
  the default; PGlite and Postgres are both opt-in.
- **Still open** — coordination plugin + `/memory/export` on PGlite/Postgres,
  cross-backend recall-quality parity confirmation, a server-DB backup/integrity
  story for Postgres. No committed version for these.

## ML Models

All models run locally via ONNX Runtime (no API calls):

| Model | Size | Purpose |
|-------|------|---------|
| `Xenova/bge-small-en-v1.5` | 134 MB | Sentence embeddings (384d) |
| `Xenova/ms-marco-MiniLM-L-6-v2` | 92 MB | Cross-encoder reranking (23 MB at `AWM_RERANKER_DTYPE=q8`) |
| `Xenova/flan-t5-small` | 377 MB | Query expansion (a 141 MB encoder + a 233 MB merged decoder + a 2.4 MB tokenizer) |

Sizes are the per-model **download** at the fp32 precision AWM loads, measured against the
Hugging Face hub file listing — **~600 MB in total**. This table named `all-MiniLM-L6-v2` and
quantized-file sizes until 2026-10-09; the embedder is `bge-small-en-v1.5` and the loaded
weights are full precision.

Models are downloaded on first use and cached in `<package-root>/data/models/` by default. Override with
`AWM_CACHE_DIR` (AWM-specific) or `HF_HOME` (also respected — the standard Hugging Face convention, useful for
sharing a cache across multiple tools). Precedence: `AWM_CACHE_DIR` > `HF_HOME` > the built-in default. Set one of
these to a persistent volume path (e.g. `/data/models`) in ephemeral/container deployments so models survive
rebuilds instead of re-downloading on every cold start — see `docs/deployment.md`.

Before 0.13.1, `HF_HOME`/`AWM_CACHE_DIR` were both silently ignored (the underlying `@huggingface/transformers`
library has no env-var support of its own — this required an explicit `env.cacheDir` set in code, added in
`src/core/model-cache.ts`), and models defaulted to a path inside `node_modules/@huggingface/transformers/`,
which is wiped on every `npm install`/`npm ci`. If you deployed with the documented `HF_HOME` setting before
0.13.1, upgrade — it now actually takes effect.

## Concurrency Model

- **Single writer**: SQLite WAL mode, one process at a time
- MCP (stdio) and HTTP API are not designed to run simultaneously
- Hook sidecar runs inside the MCP process on a separate port
- Consolidation runs synchronously (blocks during sleep cycle)
