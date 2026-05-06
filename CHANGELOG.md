# Changelog

## [Unreleased]

## 0.7.4 (2026-05-06)

### Channel Push — Telemetry + Role-Based Addressing + Stale Cleanup

**Why:** Production sessions reported "agents alive but not seeing each other for work."
Cyber-investigation revealed three concrete failures:
1. Channel push delivery had no observability — no way to measure failure rates.
2. Workers can't notify the coordinator after a coordinator restart because the
   coordinator's UUID changes (cleanSlate marks all agents dead, fresh agentId
   on next checkin) — workers had no way to address "the coordinator" abstractly.
3. `cleanupStale` existed but was only invoked manually; zombie agents
   accumulated between coordinator sessions until /stale/cleanup was hit.

### New: `GET /telemetry/channels` + Prometheus counters

**`src/coordination/routes.ts`** — process-scoped counters around channel push:

| Counter | What it tracks |
|---|---|
| `attempts` | Every call to `deliverToChannel` |
| `delivered` | Fetch returned 2xx |
| `failed_http` | Fetch returned non-2xx (worker reachable, rejected) |
| `failed_unreachable` | Fetch threw (timeout, ECONNREFUSED) — session marked disconnected |
| `no_session` | Push intent existed but no connected session for that agent |
| `fallback_mailbox` | Live delivery failed, message queued to coord_mailbox |
| `session_disconnects` | Sessions marked 'disconnected' after delivery failure |

JSON endpoint `GET /telemetry/channels` returns counters + `delivery_rate` + per-agent
`push_count`/`last_push_at`/`status`. Prometheus scrape `GET /metrics` exposes:
`coord_channel_push_attempts_total`, `..._delivered_total`,
`..._failed_total{reason="http|unreachable"}`, `..._no_session_total`,
`..._fallback_mailbox_total`, `..._session_disconnects_total`.

Counters reset on coordinator restart (process-scoped) — intended for short-window
observability. Persistent counters require a `coord_metrics` table, deferred until
we know which series are worth keeping.

### New: Role-based addressing on `POST /channel/push`

**`src/coordination/schemas.ts` + `src/coordination/routes.ts`** — `channelPushSchema`
now accepts either `{agentId, message}` (existing) OR `{role, workspace, message}`
(new). Server resolves role+workspace via:

```sql
SELECT id FROM coord_agents
WHERE role = ? AND workspace = ? AND status != 'dead'
ORDER BY last_seen DESC LIMIT 1
```

This lets workers notify the coordinator without hardcoding its UUID. Use case:
worker pushes `COMPLETED <assignment_id>: result` to `role:"coordinator"` after
finishing a task — coordinator wakes immediately and chains the next assignment.

Returns 404 with descriptive error if no alive agent matches role+workspace:
```
{"error":"No alive agent found for role='coordinator' workspace='WORK'"}
```

Returns 400 (Zod) if neither `agentId` nor `role+workspace` provided.

### New: `cleanupStale` runs on a 5-minute schedule

**`src/coordination/index.ts`** — `cleanupStale(db, 600)` now fires every
5 minutes via setInterval. 600s threshold is forgiving for long edits (workers
should pulse every 60s during active work; 10 min silence means genuinely dead).
Logs `[stale-cleanup] auto-cleaned N stale agent(s), M resource(s) released`
when cleanup happens.

Without this, only an explicit `POST /stale/cleanup?seconds=N` call (made by the
coordinator agent on startup) ever fires cleanupStale, leaving zombie agents
accumulating between coordinator sessions.

### New: `user_feedback` salience event type + auto-detect

**`src/core/salience.ts`** — direct user-stated content was getting
discarded by the BM25 novelty floor when it shared terminology with prior
memories ("LMS", "ECP", project terms). A pivotal user UX decision was lost
this way.

**Fix** — two-part:

1. New `SalienceEventType` value `'user_feedback'` with bonus 0.3 (highest of
   any event type — outranks decision/causal/friction).

2. Auto-detect at the top of `evaluateSalience`:
   ```typescript
   const USER_FEEDBACK_PATTERN =
     /^(Robert|Katherine|Catherine|Nancy|Brandy|Brandi|Hannah|Marilyn|Kaylee|
        Pete|Abby|Tom|Wendy|Sita|Nick|Rob|Joan|Jennifer|Cindy|Jason|Alex|Molly)
       \s+(said|verbatim|feedback|asked|wants|prefers|requested|directed|
            decided|confirmed|clarified|chose|specified|explained)\b/i;
   ```
   When content matches, eventType is forced to `'user_feedback'` and
   memoryClass to `'canonical'` (which provides salience floor 0.7).

Reason code `auto:user_feedback` surfaces when the auto-promote fires.

Pattern is intentionally conservative — anchored to start of content, requires
both name and a feedback verb, word boundary on the verb. "Roberta said good
morning" doesn't match (different name); "...as Robert said earlier..." doesn't
match (not at start).

Tunable: extend the staff name list as new staff join.

## 0.7.3 (2026-05-05)

### Salience Filter — Production Tuning

**Bug:** In a populated DB (>10K engrams), the novelty calculation pinned at the
0.10 floor for almost every write. Root cause was the linear curve
`novelty = max(0.10, 1 - topScore)` combined with BM25's `|rank|/(1+|rank|)`
normalization, which puts even loosely-related matches at topScore ≥ 0.9.
Result: most worker writes scored salience ~0.17 (below the 0.4 active threshold,
above the 0.2 staging threshold), bunched 86% of all engrams at salience 0.5
across the database, and made the salience signal effectively dead.

**Fix** (`src/core/salience.ts`):
- Quadratic dampening on the novelty curve: `novelty = max(0.05, 1 - topScore²)`.
  Mid-range matches now produce mid-range novelty instead of collapsing to floor.
- Concept-match penalty reduced from 0.4 to 0.3 and **scoped to last 30 days**.
  Re-using a concept name for a different topic months later is no longer punished.
- Floor lowered from 0.10 → 0.05 so true duplicates can clearly score below the
  staging threshold (0.2) and discriminate.
- Same fix applied to `computeNoveltyWithMatch` for consistency.

Curve comparison (topScore → new novelty):
- 0.30 → 0.91 (different topic — strong signal)
- 0.60 → 0.64 (loosely related — partial credit)
- 0.80 → 0.36 (related but distinct)
- 0.95 → 0.10 (near-duplicate — still suppressed)

### Maintenance Scripts (new)

- **`scripts/prune-backups.cjs`** — keeps all backups from last 24h plus the most
  recent N older snapshots (configurable via `AWM_BACKUP_KEEP`, default 6).
  Manual snapshots (`memory-pre-*`, `memory-safety-*`) are preserved for human
  curation. Supports `--dry-run`. Run hourly via cron / Task Scheduler.
- **`scripts/evict-stale.cjs`** — drops working-class engrams that meet ALL of:
  salience < 0.30, access_count < 2, last_accessed older than 90 days, not the
  head of a supersession chain, agent not in protected list (default
  `claude-code`). Uses cascading delete: associations first, then engrams, then
  FTS rebuild. Supports `--dry-run`. Run weekly or monthly.
- **`scripts/cleanup-2026-05-05.cjs`** — one-shot pruner used to reset the prod
  DB on 2026-05-05 (38,446 engrams + 197,255 associations removed; 424 → 122 MB
  after `VACUUM INTO`). Kept as a reference template for future bulk cleanups.

### Tests

- **6 new regression tests** for the novelty curve in `tests/core/salience.test.ts`
  (`Novelty curve (production-tuned)`) covering: empty DB, near-dupe suppression,
  mid-range novelty preservation, recent vs old concept-match penalty.
- All 321 existing tests still pass.

### Operational notes

- Old backups deleted (kept latest 1) — freed ~2 GB.
- `lme_*` LongMemEval and `bench_*` benchmark agent leftovers were pruned along
  with low-salience non-claude-code memories. Going forward, evals should write
  to a separate test DB to avoid polluting prod.
- The salience filter fix takes effect after `npm run build && restart`.

## 0.7.1 (2026-04-13)

### Agent-Provided Metadata Tags
- **`memory_write` accepts structured metadata** — `project`, `topic`, `source`, `confidence_level`, `session_id`, `intent` parameters on both MCP and HTTP API.
- **Stored as prefixed searchable tags** — `proj=EquiHub`, `topic=database-migration`, `sid=abc123`, `src=debugging`, `conf=verified`, `intent=decision`. Indexed in FTS5 for BM25 recall boost.
- **Session ID tags** proven to improve recall 3x on LongMemEval (20% → 50-62%) by enabling AWM's entity-bridge boost to associate memories from the same conversation.
- **Batch write supports sessionId** at batch level or per-memory.

### Dual Synthesis (Consolidation Phase 2.5)
- **Session synthesis (Type A)** — groups memories by shared metadata tags (`sid=`, `proj=`, `topic=`), creates keyword-extracted summaries. Helps perfect recall by providing topical anchors.
- **Pattern synthesis (Type B)** — uses vector-similarity clusters that span multiple sessions/projects. Discovers cross-domain patterns for novel recall. Lower confidence (0.4) — these are speculative connections.
- Synthesis memories tagged `synth=true` + `synth-type=session|pattern`. Linked to sources via causal/bridge edges.
- Recursive synthesis prevention — existing syntheses excluded from clustering.
- Capped at 5 syntheses per consolidation cycle.

### Bulk Write & Supersession
- **`POST /memory/write-batch`** — batch ingestion with synchronous embedding and inline supersession.
- **`POST /memory/supersede`** — HTTP endpoint for marking outdated memories (was MCP-only).
- **Superseded engrams filtered from BM25 and retrieval** — `superseded_by IS NULL` on search queries.

### Retrieval Improvements
- **BM25 hyphen preservation** — entity names like "Salem-Keizer" no longer stripped of hyphens.
- **`bm25Only` mode** on ActivationQuery — skip embedding for fast text-only retrieval in bulk scenarios.
- **Auto-tagger module** created (`core/auto-tagger.ts`) with 13 categories + entity extraction. Disabled by default — generic tags dilute BM25 signal. Preserved for future use with smarter context models.

### Benchmarks
- **LongMemEval baseline established** — 40-50% with gpt-4o-mini (session tags + synthesis). Adapter at `LongMemEval/awm_benchmark.py`.
- **MemoryAgentBench CR** — 21% exact match on FactConsolidation. Adapter built.
- **Internal eval maintained** — 4/4 suites pass (Recall@5=0.800, Associative=1.000, Redundancy=0.966, Temporal=0.932).
- **Stress test improved** — 96.2% (up from 94.2%), catastrophic forgetting 100% (was 80%).

## 0.7.0 (2026-04-12)

### Workspace-Scoped Recall
- **`workspace` parameter on `memory_recall`** — search across all agents in a workspace for hive memory sharing. Omit for agent-scoped recall (standalone mode). Set `AWM_WORKSPACE` env var for automatic workspace scoping on all recalls.
- **Workspace-aware BM25 and retrieval** — `searchBM25WithRankMultiAgent()` and `getEngramsByAgents()` for multi-agent corpus search.
- **`getWorkspaceAgentIds()`** — resolves all live agents in a workspace via coordination tables. Falls back to single-agent if coordination is disabled.
- Also added to HTTP API (`POST /memory/activate`) and internal `memory_restore` / `memory_task_begin` recalls.

### Validation-Gated Hebbian Learning (Kairos-Inspired)
- **Edges no longer strengthen on co-retrieval alone.** Co-activated pairs are held in a `ValidationGatedBuffer` until `memory_feedback` is called.
- **Positive feedback → strengthen** associations between co-retrieved memories (signal=1.0).
- **Negative feedback → slight weakening** (signal=-0.3).
- **No feedback within 60 seconds → discard** (neutral — no strengthening or weakening).
- This structurally prevents hub toxicity from noisy co-retrieval (e.g., "Task completed" memories that co-activate with everything but add no value).
- `memory_feedback` response now reports how many associations were strengthened/weakened.

### Multi-Graph Traversal (MAGMA-Inspired)
- **Graph walk decomposed into four orthogonal sub-graphs** instead of one beam search over all edge types:
  - **Semantic** (connection + hebbian edges, weight 0.40) — standard weight-based walk
  - **Temporal** (temporal edges, weight 0.20) — recency-weighted connections
  - **Causal** (causal edges, weight 0.25) — 2x boost (high-value reasoning chains)
  - **Entity** (bridge edges, weight 0.15) — cross-topic entity connections
- Each sub-graph runs an independent beam search with proportional beam width.
- Boosts are **fused** across sub-graphs and capped at 0.25 total per engram.
- Inspired by MAGMA (Jiang et al., Jan 2026) which demonstrated 45.5% accuracy gains from multi-graph decomposition.

### Power-Law Edge Decay (DASH Model)
- **Replaced exponential decay** (`weight × 0.5^(t/halfLife)`) with **power-law decay** (`weight × (1 + t/scale)^(-0.8)`).
- Power law retains associations longer: at 30 days, retains ~32% vs exponential's ~6%. At 90 days: ~20% vs ~0.02%.
- Matches empirical forgetting research (Averell & Heathcote, 2011) and prevents premature loss of valuable old associations.

## 0.6.1 (2026-04-12)

### Memory Integrity
- **Embedding version tracking** — New `embedding_model` column on engrams table. Every embedding now records which model generated it, preventing silent drift when the embedding model is changed. `updateEmbedding()` accepts optional `modelId` parameter.
- **Batch embedding backfill** — Consolidation Phase 1 now uses `embedBatch()` (batch size 32) instead of single-item loop. 10x faster for large backfill operations. Logs progress: "Backfilled N/M embeddings (model: X)".
- **`getModelId()` export** — New function in `core/embeddings.ts` returns the current embedding model ID for version tracking.
- **Deeper retraction propagation** — `propagateConfidenceReduction` now traverses depth 2 (was 1) with 50% penalty decay per hop. Capped at 20 total affected nodes to prevent graph-wide cascades. Uses `visited` set for cycle safety.

### Retrieval Reliability
- **Query expansion timeout** — 5-second timeout on flan-t5-small expansion model. Falls back to original query on timeout. Timer properly cleaned up on the happy path.
- **Reranker timeout** — 10-second timeout on ms-marco cross-encoder reranker. Falls back to composite scores on timeout. Timer properly cleaned up.

### Coordination
- **Channel push delivery** — POST /assign now delivers assignments directly to worker channel HTTP endpoints (not just recording in DB). Falls back to mailbox queue if live delivery fails.
- **Mailbox queue** — Persistent message queue for workers that survive disconnects. Delivered on next /next poll. Messages queued when live push fails.
- **Channel auto-registration** — `channelUrl` parameter on /checkin and /next auto-registers channel sessions.
- **Cross-UUID assignment migration** — /next and GET /assignment resolve assignments across alternate UUIDs for the same agent name.
- **Channel liveness probe** — Periodic 60s health check marks unreachable channel sessions as disconnected. Manual POST /channel/probe endpoint.
- **POST /channel/push** — Now tries live delivery first, falls back to mailbox. Returns `{ delivered, queued }` status.
- **RESUME clears global commands** — RESUME for a workspace now also clears global (workspace=NULL) commands that would otherwise persist forever.
- **Stale threshold** — Agent alive threshold increased from 120s to 300s to accommodate longer task execution.

### Added
- **POST /decisions** — Explicit decision creation endpoint (previously only via memory_write hook).
- **POST /reassign** — Move assignments between workers or return to pending.
- **GET /assignments** — Paginated listing with status/workspace/agent_id filters and total count.
- **DELETE /command/:id** — Clear individual commands by ID.
- **GET /metrics** — Prometheus exposition format metrics (agents, assignments, locks, findings, events, uptime).
- **GET /timeline** — Unified activity feed combining events and decisions.
- **GET /agent/:id** — Individual agent details with active assignment and locks.
- **DELETE /agent/:id** — Kill an agent and fail its assignments.
- **GET /health/deep** — DB integrity and agent health check.
- **PATCH /finding/:id** — Update finding status/severity/suggestion.
- **Context field** — `context` TEXT column on `coord_assignments` for structured task references (files, decisions, acceptance criteria).
- **Engram bridge** — POST /assign with valid context JSON auto-creates canonical engrams for cross-agent recall.
- **Request logging** — All requests logged with method, URL, status code, and response time. Noisy polling endpoints suppressed at 2xx.
- **Rate limiting** — 60 requests/minute per agent (sliding window). /health exempt.
- **Workspace isolation** — GET /decisions now filters by workspace.
- **API docs** — `docs/coordination-api.md` with all 38 endpoints.
- **Tests** — context-bridge (4), concurrency (3), assignments (11), error-handling (18), reassign/command tests.

### Fixed
- **started_at on direct assign** — POST /assign now sets `started_at` when agentId is provided, fixing avg_completion_seconds.
- **Stats null handling** — COALESCE on decisions.last_hour, Math.round on avg_completion_seconds.
- **Multi-assign guard** — POST /assign rejects if agent already has active assignment (409).
- **cleanSlate order** — Fixed initialization ordering in coordination startup.
- **Unbounded queries** — LIMIT 200 added to GET /status, /workers, /locks.
- **Assignment list status enum** — Expanded to include `pending` and `assigned` (was missing from query schema).
- **Legacy test file** — Removed empty coordination.test.ts that caused vitest "no suite found" failure.

### Security
- **Rate limiting** — Per-agent 60 req/min sliding window prevents runaway polling.
- **Query limits** — All list endpoints capped at LIMIT 200.
- **Assignment status validation** — State transition validation on PATCH (e.g., cannot go from completed to in_progress).

## 0.6.0 (2026-03-25)

### New Features
- **Memory taxonomy** — `episodic` | `semantic` | `procedural` | `unclassified` classification on all engrams. Auto-classified on write based on content heuristics. Optional `memory_type` filter on `memory_recall`.
- **Query-adaptive retrieval** — `targeted` | `exploratory` | `balanced` | `auto` pipeline modes. Targeted queries boost BM25 and narrow beam search; exploratory queries boost vector signals and widen graph walk.
- **Decision propagation** — `coord_decisions` table + `GET /decisions` endpoint. When `decision_made=true` on `memory_write`, automatically broadcasts to coordination layer for cross-agent discovery. `memory_restore` shows peer decisions from last 30 minutes.
- **Completion verification gates** — Workers must provide a result summary (min 20 chars) containing an action word (commit, build, test, verified, etc.) or commit SHA when marking assignments completed. Optional `commit_sha` field stored on assignment. `GET /assignment/:id` endpoint for verification.
- **Task priority & dependencies** — `priority` (0-10) and `blocked_by` fields on `coord_assignments`. Higher priority tasks dispatched first.
- **Eval harness** — `npm run eval` runs 4 benchmark suites: Retrieval (Recall@5), Associative (multi-hop success@10), Redundancy (dedup F1), Temporal (Spearman correlation). Includes ablation mode (`--no-graph-walk`, `--bm25-only`, etc.).

### Fixes
- **Engram ID in write response** — `memory_write` now returns the engram ID (`ID: <uuid>`) so downstream tools (feedback, retract, supersede) can reference the written memory. Fixes MCP smoke test failures.
- **Retrieval pipeline tuning** — Softened z-score gate (1.0 → 0.5) for homogeneous corpora. Blended BM25+vector scoring replaces max(). Rocchio feedback uses consistent gate.
- **Consolidation threshold** — Lowered redundancy cosine threshold from 0.85 to 0.75 to catch MiniLM paraphrases (which score 0.75-0.88). Dedup F1: 0.078 → 0.966.

### Improvements
- **Worker registration dedup** — Checkin and `/next` reuse dead agent UUIDs instead of creating new ones.
- **Consolidation recall fix** — Redundancy pruning now transfers associations and merges tags from pruned memory to survivor. Post-consolidation retrieval improves by 30% (0.650 → 0.950).
- **SQLite DB hardening** — `busy_timeout=5000`, `synchronous=NORMAL` pragmas. Integrity check on startup with auto-restore from backups. Hot backup every 10 min (keeps last 6). WAL checkpoint on shutdown.
- **Dead agent cleanup** — `purgeDeadAgents()` removes agents dead >24h. Runs on the heartbeat prune interval.
- **Confidence boost on retrieval** — Frequently accessed memories gain confidence over time.

### Infrastructure
- **Docker Compose** updated to run AWM on port 8400 with `AWM_COORDINATION=true` (replaces legacy coordinator on 8410).
- **Architecture evaluation** — Comprehensive competitive analysis at `docs/architecture-evaluation.md`.

## 0.5.7 (2026-03-25)

- **`POST /next` endpoint** — combined checkin + command check + assignment poll in one call. Agents identify by `(name, workspace)` instead of tracking UUIDs. Eliminates the most common agent polling failure (forgetting `agentId` across tool calls).
- **Name+workspace fallback on `GET /assignment`** — when `agentId` query param is missing, accepts `?name=X&workspace=Y` and resolves the agent internally. Backward-compatible with existing UUID-based polling.
- **`nextSchema`** added to coordination schemas.

## 0.5.2 (2026-03-20)

- **Fix: Multi-port hook fallback** — `awm setup --global` now installs PreCompact and SessionEnd hooks that try the primary port then fall back to the alternate port. Fixes silent checkpoint failures when using separate memory pools (work on 8401, personal on 8402) with global hooks.
- **Agent ID fallback** — MCP server checks `WORKER_NAME` env var as fallback for `AWM_AGENT_ID`, improving multi-agent hive compatibility.

## 0.5.1 (2026-03-18)

- **Fix: Task-end hub toxicity** — `memory_task_end` no longer falls back to generic "Task completed" concept. Unknown/auto-checkpoint tasks now use the first 60 chars of the summary as concept. Salience floor (0.7) only applies to named tasks, not unknown ones.
- **Fix: Novelty penalty for duplicate concepts** — `computeNovelty` now detects exact concept string matches in existing memories and applies a 0.4 novelty penalty. Prevents hub formation from repeated identical concepts.
- **Fix: Relative edge protection in consolidation** — Phase 6 forgetting now uses 25th-percentile edge count as protection threshold instead of absolute 3. With dense graphs (avg 12 edges/node), the old absolute threshold protected everything.
- **Cycle-based archiving** — Memories with 0 accesses after 5 consolidation cycles are archived regardless of age. Tracks `consolidation_cycle_count` in `conscious_state` table. Handles young/small pools where time-based thresholds are too generous.
- **DB migration** — Auto-adds `consolidation_cycle_count` column to existing databases on startup.
- **Agent ID fallback** — MCP server now checks `WORKER_NAME` env var as fallback for `AWM_AGENT_ID`.
- New docs: `claude-code-setup.md` (standalone setup guide), `telemetry-recommendations.md`

## 0.5.0 (2026-03-12)

- **Supersession mechanism** — replace outdated memories without deleting them. New `memory_supersede` MCP tool, `supersedes` param on `memory_write` and `memory_task_end`, bidirectional `superseded_by`/`supersedes` columns on engrams. Superseded memories are down-ranked 85% in recall but remain searchable for history.
- **Memory classes** — `canonical` | `working` | `ephemeral`. Canonical memories bypass staging (minimum salience 0.7, always active). Ephemeral memories tagged for faster decay. New `memory_class` param on `memory_write`.
- **Enhanced task_end hygiene** — `memory_task_end` accepts optional `supersedes[]` to auto-mark old memories as superseded during task completion.
- **Stable CI config** — `vitest.config.ts` with `pool: 'forks'` and `maxWorkers: 1` to prevent ONNX/thread crashes on Windows.
- **Supersession tests** — 9 new tests covering down-ranking, bidirectional links, memory class behavior, and storage persistence.
- Total MCP tools: 12 (was 11)

## 0.4.3 (2026-03-11)

- **Fix:** Novelty scoring thresholds now match 0..1 normalized BM25 scores (was comparing against unreachable 25/15/8/3)
- **Fix:** Embedding deserialization respects Node Buffer byteOffset/byteLength (prevents silent similarity corruption)
- **Fix:** Homeostasis phase normalizes outgoing edges only, tracks processed edges to prevent double-scaling
- **Fix:** `/memory/write` validates required fields, returns 400 instead of 500 on malformed requests
- SPDX license headers on all source files
- Added docs: architecture, cognitive model, benchmarks
- Added examples: Claude Code configs, task ledger pattern
- Community files: NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG

## 0.4.2 (2026-03-11)

- Restructured README — quick start first, tighter claims, before/after example
- Memory invocation strategy with specific trigger policies
- Compact tool responses (single-line, less visual noise)
- `/stats` endpoint on hook sidecar (daily activity counts)
- 15-minute silent auto-checkpoint timer in sidecar
- Stop hook now nudges recall and task switching
- Faster SessionEnd hook timeout (2s) to avoid cancellation
- CLI setup now installs all 3 hooks (Stop, PreCompact, SessionEnd)
- License changed from MIT to Apache 2.0

## 0.4.1 (2026-03-11)

- Compact tool responses
- `/stats` endpoint
- Recall nudge in Stop hook

## 0.4.0 (2026-03-10)

- Hook sidecar — lightweight HTTP server for Claude Code hooks
- Novelty-based salience scoring (BM25 duplicate check before write)
- Activity logging (`data/awm.log`)
- Task bracket tools (`memory_task_begin`, `memory_task_end`)
- `memory_recall` accepts `query` parameter (alias for `context`)
- Consolidation on graceful exit (SessionEnd hook)
- Consolidation fallback on restore (if graceful exit missed)
- Incognito mode (`AWM_INCOGNITO=1` — registers zero tools)
- Memory pool isolation (per-folder `AWM_AGENT_ID`)
- CLI installs hooks in `~/.claude/settings.json`

## 0.3.2 (2026-03-09)

- Global setup writes `~/.claude/CLAUDE.md` with AWM workflow instructions

## 0.3.1 (2026-03-09)

- `--global` flag for CLI setup

## 0.3.0 (2026-03-08)

- Checkpointing system (save/restore execution state)
- Consolidation scheduler (idle/volume/time/adaptive triggers)
- CLI onboarding (`awm setup`)
- HTTP auth (`AWM_API_KEY`)
- Task management tools (add, update, list, next)
- 11 MCP tools
- 8 eval suites
