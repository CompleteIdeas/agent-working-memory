# AWM 2.0 — Architecture (historical design proposal)

> Cognitive memory layer for AI agents.
> Multi-consumer infrastructure with consciousness-inspired cognition preserved.

**Status:** Historical design proposal (originally 2026-05-25).
**Disposition:** The "AWM 2.0" codename in this document refers to the body
of architecture work — PGlite + worker-thread ML + sleep-only consolidation
+ async engines + new cognitive primitives — that actually shipped as
**v0.8.0 → v0.8.5** under semver. We're still pre-1.0; the "2.0" label here
is a project codename, not a semver. The semver roadmap is in
[CHANGELOG.md](../CHANGELOG.md). For the current SQLite ↔ PGlite parity
status, see [pglite-feature-parity.md](pglite-feature-parity.md).
**Author:** Robert Winter / Complete Ideas

---

## "AWM 2.0" Scope — Shipped

**The codename "AWM 2.0" covered three structural moves, all shipped:**

1. ✓ **SQLite → PGlite** (Postgres-compatible embedded WASM, pgvector native,
   single-file UX preserved). PGlite is opt-in via `AWM_STORE_BACKEND=pglite`
   in v0.8.x. Auto-detect from disk in v0.8.5. SQLite remains default
   pending v0.9.x flip.
2. ✓ **Worker-thread ML pool** — *reverted*. See `src/core/ml-worker.ts`:
   onnxruntime-node's native bindings store V8 handles that don't cross
   isolate boundaries safely. Inference is in-process; the dispatch
   abstraction is preserved for a future child_process / HTTP sidecar pool.
3. ✓ **Sleep-only consolidation** — cron + quiescence-gated, no in-band
   triggers. Per-write connection discovery also moved to consolidation
   Phase 0 in v0.8.5 (was a hot path).

**Beyond the original 2.0 scope, v0.8.x also shipped six research-grounded
features** (PR-1 confidence, PR-2 abstention, coherence-weighted retraction,
counter-narrative inheritance, content fade, adaptive granularity) plus
the Recall@5 / entity-bridge / BM25-sanitize fixes. See CHANGELOG.md.

**Deferred ideas** captured during the 2.0 design (not blocking 1.0):

- **"Operational hardening"** — port collision fix, structured error envelope,
  validation at boundaries, snapshot endpoint, smoke harness.
- **"Query primitives"** — `batch_fetch`, scoped tag queries with SQL
  pushdown, materialized views, `supersede_strict`, scoped embedding recall.
- **"CLS two-tier"** — per-agent PGlite hippocampus + shared Postgres
  neocortex. Triggered when scale demands it.

**Postgres-server backend is not deferred** — comes for free once PGlite is
the default. Hive operators can use `AWM_STORE_URL=postgres://...` once the
PGlite codepath is promoted to default (target: v0.9.x).

### Validation gate (mandatory before 2.0 ships)

The full test battery must pass on the PGlite backend before migration ships to any consumer:

| Suite | Gate | Why it matters |
|---|---|---|
| `test:run` (vitest unit) | 100% pass (current: 384/384) | Functional parity |
| `test:self` (composite self-test) | ≥ 91.4% composite (current 0.8.0 baseline) | Recall-quality parity |
| `test:locomo` (LoCoMo benchmark) | Match or beat SQLite baseline | Long-context conversational memory |
| `test:stress` (6-phase) | 52/52 (current 0.8.0 baseline) | Engine reliability under load |
| `test:ab` (vs baseline) | Match or beat SQLite | A/B confirmation |
| `test:workday` | Match baseline | Real-world consumer scenarios |
| `test:perf` (NEW) | p95 recall latency under load ≤ SQLite; no main-thread block > 100ms during embed/rerank/expand | Confirms the freeze fix is real |
| **NovelForge substrate smoke** | Same `latest_by_tag`, `top_by`, `resolve` chains as SQLite on a representative 36k-word project | Substrate-primitives parity (the 0.8 feature set must survive) |

**If any test regresses, the migration pauses.** PGlite should be retrieval-quality neutral or better (pgvector ≥ BLOB+manual cosine) and perf-neutral or better. Any regression is a bug to understand, not a tradeoff to accept.

The same suite runs once with `MLWorkerPool` enabled vs disabled — isolates the worker-thread change's perf delta and confirms it's quality-neutral (workers shouldn't change embeddings, just where they're computed).

`test:perf` does not exist today; it gets built as part of P1 (worker-thread ML) since that's the change it primarily validates.

---

## TL;DR

AWM 2.0 evolves the substrate without disturbing the cognitive layer. Three structural moves:

1. **Storage abstraction.** One `EngramStore` interface, two Postgres-compatible backends: **PGlite** (embedded WASM, replaces SQLite) for single-process consumers; **Postgres server** (Docker) for concurrent multi-agent consumers. Same SQL surface, same extensions (`pgvector` + BM25 via `pgroonga`).
2. **ML inference moves off the event loop.** A `worker_threads` pool serves the embedder, reranker, and query expander. The main loop never blocks on inference.
3. **Multi-instance native.** UNIX socket default for embedded mode; explicit port allocation for server mode; refuse-to-start on collision. Multiple AWM consumers coexist on one host without killing each other.

The **10-phase activation pipeline, Hebbian engine, ACT-R decay, salience filter, staging buffer, consolidation, eviction, retraction, connection engine, and abstention gate** are unchanged. AWM's biological faithfulness is the product; 2.0 is about giving it room to scale.

Feature additions (batch operations, scoped tag queries, strong-consistency variants, materialized views, scoped embedding recall) ride on top of the new infrastructure in a later phase. They are real wins for consumers like NovelForge, but they are not the headline change — the infra is.

---

## Vision

AWM is a **cognitive memory layer**, not a vector database. The right reference class is ACT-R / Soar / HippoRAG / Complementary Learning Systems (McClelland 1995, refined through 2026), not Mem0 / Letta / Zep.

Among production agent-memory systems in 2026, AWM is uniquely positioned: it is the only system that combines ACT-R base-level activation decay, Hebbian LTP-style edge strengthening, sleep-cycle consolidation, salience-gated writes, staging-buffer working memory, active retraction, and beam-search spreading activation. No production peer synthesizes all of these. The closest research peer is HippoRAG (NeurIPS 2024).

AWM 2.0 preserves this. The substrate evolves; the cognition does not.

---

## Reference class & guiding principles

### Where biological faithfulness wins

The cognitive cycle is the product. Preserve it.

- **Activation pipeline (10 phases)** — query expansion → vector+BM25+entity multi-signal retrieval → Rocchio PRF → ACT-R decay → Hebbian boost → composite scoring → beam-search graph walk → cross-encoder rerank → abstention gate
- **Hebbian edge strengthening** — LTP analog
- **ACT-R base-level activation decay** — forgetting curve
- **Sleep-based consolidation** — offline, not in-band (this is corrected in 2.0)
- **Salience filter as attention gate** — LC-NE system analog
- **Staging buffer** — working memory before consolidation
- **Active retraction** — Anderson & Green 2001 suppression
- **Abstention** — metacognition / tip-of-tongue

### Where engineering pragmatism wins

The substrate is implementation detail. Modernize it.

- **Concurrency** — `worker_threads` (not "massive neural parallelism")
- **Storage** — Postgres-compatible SQL (not biological substrate)
- **Embedding model location** — in-process pool, sidecar, or remote API (implementation choice)
- **Cross-agent sharing** — biology gives no clear answer; AWM 2.0 supports both shared substrate (one Postgres serving multiple agents) and per-agent substrate (one PGlite file per agent)

### Where the two reconcile: CLS two-tier (optional, advanced)

The Complementary Learning Systems framework (fast hippocampus, slow neocortex, sleep-mediated transfer) maps cleanly onto AWM's substrate options:

- **Hippocampus** = per-agent PGlite file. Fast, sparse, episodic. New memories land here. Hebbian LTP fires fast. Recall is fast for recent material.
- **Neocortex** = shared Postgres server. Slow, distributed, integrated. Sleep-based consolidation moves stable engrams from hippocampus to neocortex. Cross-agent recall goes here.

This is opt-in (P4b in the phase plan) and reserved for consumers that need both per-agent isolation and cross-agent integration (AgentSynapse hive). Other consumers run single-tier (PGlite alone or Postgres alone).

---

## The four AWM consumers

| Consumer | What it is | Scale today | Concurrency | 2.0 deployment shape |
|---|---|---|---|---|
| **USEA Agent** (Gallop Support) | Production Freshdesk support agent on Azure VM | ~222 engrams, growing slowly | 1 agent, low write rate | **PGlite embedded.** Same single-file UX as today's SQLite, gains pgvector. |
| **NovelForge** (single-user) | Novel-writing platform with substrate primitives | 36k-word test bed; modest per-project | 1 user per project | **PGlite per-project file.** Substrate primitives unchanged. |
| **NovelForge** (multi-user, future) | Same, with multiple users | TBD | N concurrent users | **PGlite files per user/project, served by one Node process.** Migrate to shared Postgres + schema-per-user when growth demands. |
| **AgentSynapse hive** | Multi-agent coordination platform | 10,939 engrams, 150k edges, growing | 5+ concurrent agents | **Postgres server (Docker).** Resolves multi-agent contention. CLS two-tier (P4b) when ready. |
| **Standalone library** | `npm i agent-working-memory` | Variable | Typically 1 agent | **PGlite embedded.** Zero-infra promise preserved. |

**Three of four are happiest on PGlite.** The hive is the one that earns Postgres-server. So 2.0 ships both shapes; consumers pick by `AWM_STORE_URL`.

---

## Six design pillars

### Infrastructure (priority for 2.0)

#### Pillar 1: Storage abstraction

One `EngramStore` interface. Two Postgres-compatible backends.

```
┌─────────────────────────────────────────────────┐
│  Cognitive Layer (unchanged)                    │
│  Salience · Staging · Activation · Hebbian      │
│  ACT-R · Consolidation · Eviction · Retraction  │
│  Connection · Abstention                        │
└────────────────────┬────────────────────────────┘
                     │
           EngramStore (interface)
                     │
       ┌─────────────┴───────────────┐
       │                             │
  ┌────▼──────────┐         ┌────────▼──────────┐
  │ PGlite        │         │ Postgres server   │
  │ (embedded)    │         │ (Docker)          │
  │ • <3MB WASM   │         │ • pgvector        │
  │ • single file │         │ • pgroonga (BM25) │
  │ • pgvector    │         │ • Docker compose  │
  │ • no server   │         │ • shared          │
  └───────────────┘         └───────────────────┘
       ▲                             ▲
       │                             │
  USEA, NovelForge,            AgentSynapse hive,
  Standalone                   future NovelForge SaaS
```

**Configuration via single env var:**

```bash
# Embedded (PGlite, single file)
AWM_STORE_URL=file:./memory.db

# Server (Postgres, Docker)
AWM_STORE_URL=postgres://awm:password@localhost:5432/awm
```

**SQL surface is identical** across both. Same vector extension, same BM25 extension, same indexes, same tag prefix-tag semantics. Migration between shapes is a `pg_dump | psql` operation, not a rewrite.

**Why PGlite over SQLite:**
- Single-file UX preserved (the value prop of embedded)
- pgvector native (today's AWM uses Buffer→Float32Array conversions; PGlite uses real vector indexes)
- Same SQL as server-Postgres — no dialect divergence between embedded and server consumers
- <3MB gzipped, faster than wa-sqlite on CRUD per ElectricSQL benchmarks
- Maintained by ElectricSQL + Neon (active, well-resourced)

**Caveat:** PGlite is newer than SQLite. Migrate AgentSynapse hive first (where Postgres server is going anyway and contention is the active problem). USEA Agent and NovelForge migrate after PGlite is validated against AWM's heaviest queries (10-phase activation, beam-search graph walk, sleep consolidation).

#### Pillar 2: ML layer — worker thread pool

Today: `@huggingface/transformers` loads three models (embedder, reranker, query expander) into the main Node event loop. Inference blocks HTTP. Observed: 10,333 CPU-seconds accumulated in 5 hours, requests time out.

2.0: a single `MLWorkerPool` owns the three pipelines. The main loop dispatches inference requests via `MessagePort`; workers return embeddings/scores. Event loop never blocks on inference.

```
   Main thread
   ──────────────
   HTTP routes, SQL, cognitive engines (orchestration only)
       │
       │ port.postMessage({ kind: 'embed', text })
       ▼
   ┌──────────────────────────────────┐
   │ MLWorkerPool (worker_threads)    │
   │ ├─ Worker 1: embedder            │
   │ ├─ Worker 2: reranker            │
   │ └─ Worker 3: query expander      │
   └──────────────────────────────────┘
       │
       │ port.postMessage({ vector: [...] })
       ▼
   Main thread continues
```

**Decisions:**
- 3 dedicated workers (one per model). Models stay loaded; no swap thrashing.
- Queue per worker. Backpressure via Promise chaining.
- Optional sidecar mode (`AWM_ML_SIDECAR_URL=http://localhost:8401`) for sharing models across multiple AWM processes (future P3).
- Workers respond to `shutdown` cleanly on SIGINT.

**Memory cost:** Today AWM is ~920MB resident even idle, mostly from loaded models. Worker threads share heap with the parent, so no doubling — same footprint, different threading. Sidecar mode trades a small IPC overhead for the ability to run N AWM processes sharing one model load.

#### Pillar 3: Consolidation timing — sleep-only

Today: 4 triggers fire consolidation per agent (idle 10min / 50 writes / 30min time / precision drop). With 5+ agents, at least one fires every few minutes. Consolidation runs in-band, blocking HTTP.

This is biologically wrong (the brain consolidates during sleep, not in the middle of waking activity) AND operationally bad.

2.0:
- **Cron-based primary trigger.** Default: 3 AM local time. Configurable via `AWM_CONSOLIDATION_CRON='0 3 * * *'`.
- **Quiescence-gated secondary trigger.** Fires only when all registered agents have been idle >30min AND no active recalls in the last 5min. Truly "asleep."
- **Kill switch.** `AWM_DISABLE_SCHEDULER=1` skips both triggers; consolidation only via explicit `POST /memory/consolidate`.
- **Always async.** Even when consolidation is firing, HTTP stays responsive (because ML is in worker threads and consolidation chunks the work).

#### Pillar 4: Operational reliability

Today's silent-failure pattern (6 of 8 recent NovelForge bugs were silent — CORS missing, typo crashes returning 500, background task never starting, port collision killing other AWM instances) traces to one root cause: **validation at boundaries is sparse, exceptions swallowed in `except Exception`, no integration tests catch any of these before merge.**

2.0 commits to:

- **Multi-instance native.** UNIX socket default for embedded consumers. Explicit `AWM_PORT` for server mode. Refuse-to-start with a clear error if the port is occupied. NovelForge and AgentSynapse coexist on one host out of the box.
- **Structured error envelope.** Every 4xx/5xx returns `{code, category, hint, request_id}`. No raw exception stack traces leaking to clients. No silent 500s.
- **Loud failure mode.** No `except Exception:` in the codebase (lint rule + CI gate). Background tasks register at startup AND must be visible in `/health/deep` as alive before the server signals ready. Lazy imports forbidden in code paths that run after startup.
- **Validation at every write boundary.** Required tags, project field, intent field — validated at the API surface. Refuse with `400 {code: "TAG_REQUIRED", missing: [...], hint: ...}` instead of partial-write or silent drop.
- **Transactional multi-step writes.** Operations that touch multiple engrams (consolidation, supersede with cross-ref) wrap in a transaction; either all succeed or all roll back.
- **Snapshot / backup endpoint.** `POST /admin/snapshot` returns a portable backup of the DB + metadata. PGlite mode: a copy of the file. Postgres mode: `pg_dump`. Documented restore procedure.
- **Integration smoke harness shipped with AWM.** `npm run test:smoke` spins up an in-memory PGlite, writes 100 engrams across 3 simulated agents, runs consolidation, recalls by tag, supersedes, and verifies final state. One test catches the majority of silent-failure bug classes before merge.

### Features (build on infra — later phases)

#### Pillar 5: Query primitives evolution

Several primitives that emerged from production use cases are first-class in 2.0. They depend on the SQL surface of pgvector + pgroonga and the worker-thread ML layer.

| Primitive | What it does | Why it matters |
|---|---|---|
| **Scoped tag queries with SQL pushdown** | `list_by_topic(tagsAll=[topic=..., chapter=latest_5])` filtered in SQL, not client-side | Removes N+1 query traps where consumers fetch large engram sets to filter |
| **Batch read by concept** | `batch_fetch([{concept, tags}, ...])` returns N results in one query | 5-10× speedup on consumer hot paths that look up multiple entities |
| **Strong-consistency mutations** | `supersede_strict()`, `write_strict()` — atomic, return final state, wait for durability | Removes defensive duplicate-check sites in consumer code |
| **Materialized derived views** | Computed-on-write views like `active_promises`, `character_latest_emotional_state`, `latest_motif_phases` | Eliminates client-side reduction loops; natural observability hook |
| **Scoped embedding recall** | `recall(context, scope_tags=[topic=..., state=...])` — semantic search within a structural slice | Enables semantic + structural filters in one query |

These are **AWM features**, not consumer-specific. They emerged from production feedback (notably NovelForge) but are useful across all consumers.

### Preserved

#### Pillar 6: Cognitive layer (unchanged)

The 10-phase activation pipeline, Hebbian engine, ACT-R decay, salience filter, staging buffer, consolidation engine, eviction engine, retraction engine, connection engine, and abstention gate carry forward from 0.8.x with no behavioral change.

What changes:
- They run on top of the new EngramStore interface (so they work against PGlite or Postgres)
- Inference calls go through the worker pool (so they don't block the event loop)
- Consolidation fires only via cron or quiescence (so it doesn't interrupt active work)

What doesn't change:
- Decay constants, Hebbian strength formulas, activation phase order, salience thresholds, staging buffer semantics, eviction policy, retraction semantics

---

## Per-consumer impact

What does each consumer get from AWM 2.0?

### USEA Agent

**Wins:**
- Event loop never freezes during embedding (worker threads)
- Sleep-only consolidation: background work happens at 3 AM, not mid-conversation
- pgvector native (today uses BLOB Buffers + manual cosine)
- Single-file persistence preserved (PGlite)
- Multi-instance support — can run a dev/test AWM next to production without port conflict

**Effort to migrate:**
- Update `AWM_USE_EMBEDDED=true` → `AWM_STORE_URL=file:/app/data/memory/usea-agent.db`
- Rebuild Docker image with new AWM
- Migration script runs once on first start: SQLite → PGlite (same schema, batch copy)

### NovelForge (single-user, current)

**Wins:**
- Substrate primitives (`latest-by-tag`, `top-by`, `resolve`, sequence allocation) all preserved
- pgvector enables faster vector recall on per-project files
- Worker-thread ML removes the perceptible latency on embedding-on-write during long episode imports
- Structured error envelope replaces silent failures
- Snapshot endpoint enables a proper backup story

**Effort to migrate:** Same as USEA Agent — file path change + one-shot migration.

### NovelForge (multi-user, future)

**Wins:**
- Per-user PGlite files: simple ops, full isolation, scales to one server's disk
- Same Node process can manage many files (one open connection per active user)
- Graduation path to Postgres + schema-per-user when growth requires it — same SQL, no rewrite

**Effort to build (NovelForge side):** Per-user file path routing in NovelForge's data layer. AWM provides the building block; the multi-user routing is NovelForge's responsibility.

### AgentSynapse hive

**Wins:**
- True concurrent writes (Postgres) — no more SQLite single-writer deadlocks
- pgvector + pgroonga at scale — 50M-engram benchmarks support 471 QPS at 99% recall
- Multi-instance support — coordinator and workers can each run independent AWM processes (or share one server)
- CLS two-tier (P4b) — per-agent PGlite hippocampus + shared Postgres neocortex; biologically faithful AND solves contention

**Effort to migrate:**
- Stand up Postgres via Docker compose (one container)
- Migration: `pg_dump` from existing SQLite via the new EngramStore tooling, restore into Postgres
- Update `AWM_STORE_URL` env vars on all agent launchers

### Standalone library

**Wins:**
- Same `npm i` UX
- pgvector built-in (no SQLite-vec configuration)
- Worker-thread ML available out of the box
- Test smoke harness ships with the package

**Effort to migrate:** Zero for new users. Existing users: re-`npm i` plus one-shot migration script.

---

## Phased implementation plan

| Phase | Work | Effort | Outcome | Blocks |
|---|---|---|---|---|
| **P0** | Port collision fix + sleep-only consolidation + kill-switch env var | 4h | NovelForge ↔ hive coexist; freeze trigger removed | — |
| **P1** | Worker-thread ML pool | 1 day | Event loop never blocks on inference; freeze symptom ends | P0 |
| **P2** | Structured error envelope + DMN status endpoint + validation-at-boundaries | 1 day | Silent-failure bug class eliminated; observability for operators | P0 |
| **P3** | EngramStore interface extraction; current SQLite impl refactored behind it | 1 day | Backend pluggable; no behavior change | — |
| **P4a** | PGlite embedded backend; Postgres server backend; migration tooling | 3-5 days | Multi-instance native at the storage layer; pgvector everywhere | P3 |
| **P4b** | CLS two-tier (per-agent PGlite hippocampus + shared Postgres neocortex) | 1-2 weeks | Hive scales without losing biological faithfulness | P4a |
| **P5** | Feature evolution: scoped tag queries, batch_fetch, supersede_strict, materialized views, scoped embedding recall | 1 week | Hot-path query primitives available to all consumers | P4a |

**Total scope: ~3 weeks of focused work** for the full P0–P5 path. P0–P2 alone (1.5 days) resolve the immediate freeze + silent-failure pain.

---

## Migration plan (existing 0.8.x → 2.0)

### Compatibility

- **EngramStore interface backwards-compatible at the public API level.** Existing `memory_write`, `memory_recall`, `memory_supersede`, `memory_task_*` calls work without change.
- **MCP plugin (`agent-working-memory`)** updates transparently — consumers that use it (Claude Code, Codex, Cursor) need no code change.
- **HTTP API** — request/response schemas preserved. New endpoints additive.
- **Environment variables** — `AWM_DB_PATH` deprecated in favor of `AWM_STORE_URL` but honored with a warning for one release cycle.

### One-shot migration script

`awm migrate --from 0.8 --to 2.0` (CLI tool shipped with the package):

1. Validates source DB (SQLite or 0.8.x file)
2. Spins up target backend (PGlite file or connects to Postgres server)
3. Runs schema DDL on target
4. Streams engrams + edges + tasks + sessions in batches
5. Verifies row counts match
6. Optionally retains source DB as `*.0.8.bak`

Migration is forward-only; rollback is from the bak file.

### Validation

After migration, the smoke harness (`npm run test:smoke`) runs against the migrated DB. Asserts: row counts match, sample recalls return same top-5, sample supersede roundtrips, sleep consolidation runs to completion.

---

## Acceptance criteria

### P0–P2 (week 1)

- [ ] NovelForge and AgentSynapse coordinator processes run on the same host without port collision
- [ ] `AWM_DISABLE_SCHEDULER=1` skips all consolidation triggers
- [ ] `/health/deep` reports each registered background task as alive
- [ ] Cron-triggered consolidation at 3 AM completes without blocking HTTP (verified via load test: 100 recalls/sec during consolidation)
- [ ] Worker-thread ML: 100 concurrent embed requests complete with main-thread p95 < 5ms (excluding inference time itself)
- [ ] Every 4xx/5xx response carries `{code, category, hint, request_id}`
- [ ] Lint rule + CI gate: no `except Exception:` in production code paths
- [ ] Integration smoke harness covers: write → recall by tag → supersede → consolidation → recall again. Runs in < 30s.

### P3–P4a (weeks 2-3)

- [ ] `EngramStore` interface documented; SQLite impl refactored behind it with all tests green
- [ ] `PGliteEngramStore` implementation passes the same test suite as the SQLite impl
- [ ] `PostgresEngramStore` (server, Docker compose) passes the same test suite
- [ ] `awm migrate` tool converts an existing 0.8.x SQLite DB to PGlite and to Postgres-server; row counts verified
- [ ] AgentSynapse hive runs against Postgres server for 24h with no deadlocks (load: typical hive activity ~hundreds of recalls/hour, dozens of writes/hour)
- [ ] USEA Agent runs against PGlite for 24h with no regressions (functional test: existing Freshdesk ticket workflows)
- [ ] NovelForge (single project) runs against PGlite for 24h with no regressions

### P4b (weeks 3-4)

- [ ] CLS two-tier configured for the hive: per-worker PGlite hippocampus, shared Postgres neocortex
- [ ] Consolidation engine moves engrams hippocampus → neocortex during sleep; sample verified by inspection
- [ ] Cross-agent recall from any worker against neocortex completes in < 200ms p95

### P5 (week 4+)

- [ ] `list_by_topic` with `tagsAll`/`tagsAny`/`tagsNone` pushes filters into SQL (verified by query plan inspection)
- [ ] `batch_fetch` retrieves N engrams in one query (verified by tracing one round-trip)
- [ ] `supersede_strict()` returns the new state atomically; no race window in tests using two concurrent clients
- [ ] Materialized views (`active_promises`, etc.) update on write within 100ms p95
- [ ] `recall(scope_tags=...)` returns vector-ranked results filtered by tag scope in one round-trip

---

## Open questions

1. **PGlite production readiness for USEA Agent.** PGlite is well-supported but newer than SQLite. The plan migrates AgentSynapse hive first (where Postgres server is going regardless), validates PGlite against AWM's heaviest queries on a non-production NovelForge project, THEN migrates USEA Agent. Open: how long should this validation period be — one week? One month?

2. **Embedding model upgrade.** Current `Xenova/bge-small-en-v1.5` (384d) was chosen for size. With worker-thread ML, larger models (`nomic-ai/nomic-embed-text-v1.5` 768d) become viable without blocking. Worth it for recall quality? Requires re-embedding the entire corpus (~10k engrams). Defer to a post-2.0 evaluation.

3. **Cross-agent memory isolation policy (hive).** In CLS two-tier, the shared neocortex is by definition cross-agent. Should consumers be able to mark specific engrams as agent-private (never consolidated to neocortex)? Adds complexity but matters for use cases where one agent shouldn't see another's working state.

4. **Postgres deployment for production hive.** Docker compose is the current plan. For production-grade hive deployments, managed Postgres (Supabase, Neon, RDS) is an option. Designing around either is fine; we don't need to pick now. The connection string abstraction makes both work.

5. **Backwards compatibility window.** How long do we honor `AWM_DB_PATH` and the SQLite path? One release? Two? Defer to consumer migration timing.

6. **Migration of existing engrams to pgvector.** Today's AWM stores embeddings as BLOB columns + manual cosine. PGlite has native pgvector. The migration tool re-embeds (using the same model) on the way in. Alternative: ingest BLOBs as-is and use pgvector in storage-mode-only. Decide during P4a.

---

## Related documents

- `docs/awm-2.0-novelforge-lessons.md` (forthcoming) — production feedback from NovelForge: pain table, silent-failure root cause analysis, top-5 feature ranking, NovelForge-side fixes (smoke harness, validation layer, backup CRON, decay sweep)
- `CHANGELOG.md` (existing) — 0.5.x → 0.7.x → 0.8.x release notes
- `AGENTS.md` (existing) — agent instruction template for consumers

---

## Decision log

| Date | Decision | Driver |
|---|---|---|
| 2026-05-25 | PGlite replaces SQLite as embedded default | Same single-file UX, pgvector native, unified SQL surface with Postgres server, faster than wa-sqlite on CRUD |
| 2026-05-25 | Postgres server (Docker, self-hosted) for hive | True concurrent writes, pgvector at scale, no external dependency |
| 2026-05-25 | NovelForge multi-user starts as per-user PGlite files | Simple ops; graduates to shared Postgres + schema-per-user when growth requires |
| 2026-05-25 | Infra first, features second | Storage abstraction + worker-thread ML + multi-instance are foundational; query primitives ride on top |
| 2026-05-25 | Cognitive layer (10-phase activation, Hebbian, ACT-R, etc.) unchanged | This is what makes AWM novel; substrate evolves, cognition does not |
| 2026-05-25 | Sleep-only consolidation (cron + quiescence) | Biologically correct; eliminates in-band freeze trigger |
| 2026-05-25 | NovelForge production feedback drives a separate lessons doc | Field evidence belongs with the evidence; architecture doc stays focused on the architecture |
