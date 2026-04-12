# Changelog

## [Unreleased]

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
