# Changelog

## [Unreleased]

## 0.7.9 (2026-05-08)

### Recall Latency Round 3 — Two-pass fetch (slim → hydrate survivors)

**Why:** After 0.7.7's pool reduction, phase-breakdown showed `getEngramsByAgent`
fetching all 10K active engrams was the new bottleneck (440ms = 40% of recall).
Most of that cost was row materialization of `content`, `tags`, and JSON columns
the pre-filter doesn't read. The pre-filter only needs `(id, concept, embedding)`.

### Fix: two-pass fetch

**`src/storage/sqlite.ts`** — three new methods:

- `getEngramsByAgentSlim(agentId, stage, includeRetracted)` — returns
  `{id, concept, embedding}` only. Avoids materializing content/tags/JSON for
  rows that will be filtered out.
- `getEngramsByAgentsSlim(agentIds, ...)` — multi-agent variant for workspace
  recall.
- `getEngramsByIds(ids[])` — chunked IN-clause hydration of full rows by ID.
  Used to load the full Engram only for survivors that pass the pool filter.

**`src/engine/activation.ts`** — Phase 3 refactored to:
1. **Pass 1 (slim):** fetch all active engrams as slim rows, run cosine similarity
   and pool filter on this minimal payload.
2. **Pass 2 (hydrate):** fetch full Engram rows only for survivor IDs (typically
   100-300, vs the 10K full rows fetched before).

The pool filter logic itself is unchanged — same survival criteria, same
`AWM_DISABLE_POOL_FILTER=1` escape hatch. Only the fetch strategy changed.

### End-to-end measurement

| Query | 0.7.7 | 0.7.9 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 1640ms | 1222ms | -25% |
| "Education LMS architecture programs certifications" | 2160ms | 1502ms | -30% |
| "short query" | 1413ms | 1017ms | -28% |
| "Stripe webhook handler transfer.paid Connect destination charges" | 1791ms | 1144ms | -36% |
| "sprint current work completed findings pending" | 1688ms | 1599ms | -5% |

**Cumulative since 0.7.4 baseline:** 11-23s → ~1.0-1.6s (~10-20× faster).

Recall floor for cheap queries is now ~1.0s.

### Recall quality preserved (and slightly improved)

A/B test on 8 representative queries:
- **8/8 top-1 results identical**
- **avg 4.75/5 top-5 overlap** (was 4.50)
- **avg 9.75/10 top-10 overlap** (was 9.38)

The slight improvement vs 0.7.7 is likely from more deterministic candidate
ordering through the explicit ID-set + hydrate pipeline.

### Tests

All 334 tests pass.

## 0.7.8 (2026-05-08)

### Documentation + install template — settings & rules for the new behaviors

This release ships only documentation/install changes — no functional code change.
A version bump is needed so `awm setup --global` reaches existing installs with
the updated CLAUDE.md template that teaches agents about the 0.7.5/0.7.6/0.7.7
behaviors.

### `AWM_INSTRUCTION_CONTENT` extended (the template `awm setup` writes to CLAUDE.md)

**`src/adapters/common.ts`** — added three sections to the agent instructions:

- **Memory classes** — `canonical | working | ephemeral`, when to use each, and the
  hive-multi-agent rule that cross-agent writes must use `canonical`.
- **Salience auto-promotion** — explains the two patterns the salience filter
  auto-promotes (`detectUserFeedback` for stakeholder quotes, `detectVerifiedFinding`
  for operational records with action-verb + concrete IDs). Defense in depth — agents
  shouldn't rely on it for important writes.
- **Diagnostics / escape hatches** — `AWM_DISABLE_POOL_FILTER=1` documented as an
  A/B testing hatch if a recall regression is suspected.

Also added a "before stating any fact, recall first" guidance and a note that recall
is fast (~1s) so agents shouldn't ration recalls.

### Env var table extended

**`README.md`** — added `AWM_COORDINATION`, `AWM_DISABLE_POOL_FILTER`, `AWM_WORKSPACE`
to the environment variables table.

### Troubleshooting guide

**`docs/troubleshooting.md`** — added "very slow recall on 0.7.7+" and "recall returning
slightly different top-K than before 0.7.7" entries with the disable hatch.

### Hive agent rules (in this repo only — not shipped via npm)

`.claude/agents/coordinator.md`, `dev-lead.md`, `worker.md` — added auto-promotion
backstop note and the latency claim update so hive agents know:
1. Always set `memory_class: canonical` explicitly for shared writes
2. The auto-promote patterns are a backstop, not the primary mechanism
3. Recall is now ~1s (so don't avoid it for perceived cost)

### Upgrade path

For existing installs:
```
npm install -g agent-working-memory@latest
awm setup --global   # rewrites CLAUDE.md with the new instructions
```
Restart Claude Code to pick up the new CLAUDE.md.

## 0.7.7 (2026-05-08)

### Recall Latency Round 2 — 2.5s → 1.0s end-to-end (~50% on top of 0.7.6)

**Why:** Phase-breakdown spike (`spike/phase-breakdown.ts`) showed that after the
0.7.6 BM25 fix, the new dominant cost was `getAssociationsForBatch` over all
~10K candidates: **1518ms / 2226ms total = 68% of recall latency**. Most of those
candidates had zero text relevance and would score below the relevance gate
(`textMatch > 0.1`) anyway — so fetching their associations and tokenizing their
full content was wasted work.

### Pool reduction — pre-filter before deep scoring

**`src/engine/activation.ts`** — added a cheap pre-filter pass before the
batch-association fetch. Candidates survive into deep scoring only if they have:

1. **BM25 hit** (`bm25Score > 0`), OR
2. **Cosine z-score above the gate** (would produce non-zero vectorMatch), OR
3. **Concept-token overlap** with the query (cheap — concept is short)

Anything else gets dropped before the expensive phase. From ~10K candidates
down to typically 100-300 survivors. Graph walk preserves correctness because
it only boosts neighbors whose own `textMatch >= 0.05` — and any candidate
meeting that floor would also pass this filter.

### End-to-end measurement

| Query | 0.7.6 | 0.7.7 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 2683ms | **1143ms** | -57% |
| "Education LMS architecture programs certifications" | 2801ms | **1554ms** | -45% |
| "short query" | 2494ms | **884ms** | -65% |
| "Stripe webhook handler transfer.paid Connect destination charges" | 2642ms | **1146ms** | -57% |
| "sprint current work completed findings pending" | 2685ms | **1225ms** | -54% |

**Cumulative since 0.7.4 baseline:** 11-23s → 0.9-1.6s (~10-15× faster).

### Recall quality preserved

A/B test (`spike/recall-quality.ts`) on 8 representative queries:
- **8/8 top-1 results identical**
- **avg 4.50/5 top-5 overlap** (90%)
- **avg 9.38/10 top-10 overlap** (94%)

The few reorderings happen at the bottom of top-K and swap between memories
that are all relevant — typically a re-rank, not a recall miss.

### Escape hatch

Set `AWM_DISABLE_POOL_FILTER=1` to revert to the pre-0.7.7 path. For A/B
testing or if a regression appears in production. Same recall semantics,
just slower.

### Tests

All 334 tests pass. New `spike/phase-breakdown.ts` and `spike/recall-quality.ts`
captured for future regression diagnosis.

## 0.7.6 (2026-05-08)

### Recall Latency — 11-23s → 2.5s end-to-end

**Why:** 24h telemetry showed activate() floor of 11-23s with p95 of 257s. Initial
hypothesis was vector-search cost (cosine over 17K vectors). Measurement spike
revealed the actual culprits:

1. **BM25 JOIN materialized too early.** SQLite's planner ran FTS5 MATCH, then
   joined ALL matching rows with engrams (including 1.5KB embedding blobs per
   row), then sorted by rank, then applied LIMIT. With wide OR queries on a
   17K-engram corpus, that's thousands of materializations before the LIMIT fires.
   - Pure SQL test (better-sqlite3 12.6.2, SQLite 3.51.2):
     - Original query: **3682ms** for `"USEF" OR "results" OR "submission" OR "Staff" OR "Services"`
     - CTE-prefilter rewrite: **6.5ms** (567× faster)
   - Same SQLite, same data — pure plan rewrite.
   - Equivalence verified: top-30 results identical, ranks identical.
2. **N+1 association lookups.** `getAssociationsFor` called once per candidate
   (10K+ calls per recall) accumulated 1300ms of per-call overhead.

### Fix 1: CTE-prefilter BM25

**`src/storage/sqlite.ts`** — `searchBM25WithRank` and `searchBM25WithRankMultiAgent`
now use a Common Table Expression to force FTS5 LIMIT before the engrams JOIN:

```sql
WITH top_fts AS (
  SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
)
SELECT e.*, top_fts.rank FROM top_fts
JOIN engrams e ON e.rowid = top_fts.rowid
WHERE e.agent_id = ? AND e.retracted = 0
ORDER BY top_fts.rank LIMIT ?
```

The inner LIMIT (5× outer LIMIT, min 50) over-fetches to give headroom for the
agent + retracted filter applied after the CTE.

### Fix 2: Batch association lookup

**`src/storage/sqlite.ts`** — added `getAssociationsForBatch(engramIds[])` which
chunks IDs into IN-clause queries (400 per chunk to stay under SQLite's
SQLITE_LIMIT_VARIABLE_NUMBER) and returns a Map keyed by engram id.

**`src/engine/activation.ts`** — Phase 3b scoring loop now batch-fetches
associations once per recall instead of per-candidate.

### End-to-end measurement

`activate()` benchmarked on production memory.db (17K engrams, 133K associations):

| Query | Before | After | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | ~5400ms | 2683ms | -50% |
| "Education LMS architecture programs certifications" | ~3100ms | 2801ms | -10% |
| "short query" | ~2400ms | 2494ms | flat |
| Wide-OR floor (telemetry) | 11000-23000ms | 2500-2800ms | **~5× faster** |

The remaining ~2.5s is dominated by query expansion (flan-t5-small) and the
per-candidate scoring loop over 10K candidates. Pool reduction (filter to
relevant subset before deep scoring) is a follow-up — it's a behavioral change
and needs its own evaluation.

### Tests

All 334 existing tests pass. Equivalence test verifies top-30 BM25 results are
identical between old and new queries (same IDs, same ranks).

### Investigation artifacts

`spike/` directory contains the measurement scripts used to localize the
bottleneck:
- `recall-phases.ts` — phase-instrumented activate()
- `bm25-only.ts` — better-sqlite3 vs SQL plan isolation
- `bm25-equivalence.ts` — top-K equivalence check
- `activate-e2e.ts` — end-to-end production-path timing

## 0.7.5 (2026-05-07)

### Salience Filter — Auto-Promote Verified Operational Records

**Why:** 24h telemetry review surfaced a salience filter gap: verified operational
records (batch summaries, completion reconciliations, incident triages) were
being discarded at 0.14 because they share terminology with prior session
memories — BM25 novelty couldn't distinguish "useful new operational record"
from "duplicate observation." Specific case: a 6-event USEF results submission
summary 2026-05-07 was discarded at salience 0.14 despite naming concrete event
IDs and dates that future-recall would care about. The procedural memory
written 90 seconds later (same topic, "how to" framing) scored 0.70.

### New: `detectVerifiedFinding(content)` auto-promoter

**`src/core/salience.ts`** — pattern detector parallel to `detectUserFeedback()`.

Pattern requires BOTH:
1. An action-verb header — Submitted, Finalized, Completed, Reconciled, Triaged,
   Posted, Resolved, Stamped, Pushed, Deployed, Migrated, Imported, Exported,
   Backfilled.
2. At least 2 concrete identifiers — absolute dates (YYYY-MM-DD) OR contextual
   numeric IDs (event/ticket/comp/usef/usea/class/case/order/payment + digits).

**Behavior on match:**
- Bumps `eventType` from 'observation' to 'decision' (typeBonus +0.15)
- Applies salience floor of 0.45 (active disposition)
- Tags with reasonCode `auto:verified_finding`
- Does NOT promote to canonical — operational records are verified, not source-of-truth

**Distinction vs `detectUserFeedback`:**
- User feedback (e.g., "Robert said X") → canonical, salience floor 0.7
- Verified finding (e.g., "Submitted 6 events 2026-05-07 — IDs 18969, 18971...") → working, salience floor 0.45

### Tests

**`tests/core/salience.test.ts`** — 7 new test cases covering pattern matching
(USEF batch, Freshdesk triage), pattern rejection (no verb, no IDs, empty input),
end-to-end disposition (low-novelty operational record → active not discard),
and confirms ordinary observations still discard.

23 salience tests pass; full core suite (56 tests) green.

### Known issue: recall latency

Same telemetry review found activate() floor of 11-23s (warm) with outliers
extending to 11+ minutes. Outliers correlate with multiple MCP server startups
in rapid succession (5 startups in 13s on 2026-05-08 02:10 UTC). Root cause:
SQLite WAL contention when concurrent Claude Code sessions all spawn MCP
channel-server instances and hammer memory.db simultaneously. Not addressed
in this release — needs a launcher-side fix to debounce MCP startups.

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
