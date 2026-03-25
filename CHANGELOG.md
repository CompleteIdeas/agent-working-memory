# Changelog

## 0.6.0 (2026-03-25)

### New Features
- **Memory taxonomy** — `episodic` | `semantic` | `procedural` | `unclassified` classification on all engrams. Auto-classified on write based on content heuristics. Optional `memory_type` filter on `memory_recall`.
- **Query-adaptive retrieval** — `targeted` | `exploratory` | `balanced` | `auto` pipeline modes. Targeted queries boost BM25 and narrow beam search; exploratory queries boost vector signals and widen graph walk.
- **Decision propagation** — `coord_decisions` table + `GET /decisions` endpoint. When `decision_made=true` on `memory_write`, automatically broadcasts to coordination layer for cross-agent discovery. `memory_restore` shows peer decisions from last 30 minutes.
- **Completion verification gates** — Workers must provide non-empty result (min 10 chars) when marking assignments completed. Optional `commit_sha` field stored on assignment. `GET /assignment/:id` endpoint for verification.
- **Task priority & dependencies** — `priority` (0-10) and `blocked_by` fields on `coord_assignments`. Higher priority tasks dispatched first.
- **Eval harness** — `npm run eval` runs 4 benchmark suites: Retrieval (Recall@5), Associative (multi-hop success@10), Redundancy (dedup F1), Temporal (Spearman correlation). Includes ablation mode (`--no-graph-walk`, `--bm25-only`, etc.).

### Improvements
- **Worker registration dedup** — `UNIQUE` index on `(name, workspace)` prevents duplicate agent rows. Checkin and `/next` reuse dead agent UUIDs instead of creating new ones.
- **Consolidation recall fix** — Redundancy pruning now transfers associations and merges tags from pruned memory to survivor, preventing post-consolidation recall drops.
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
