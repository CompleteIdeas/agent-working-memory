# AWM Telemetry & Health Metrics — Recommended DB Additions

> **Purpose:** Recommend additional database columns and tables AWM should track to evaluate system health, diagnose degradation, and tune parameters over time.
>
> **Current state:** AWM tracks basic operational data (engrams, edges, activation_events, staging_events, retrieval_feedback, conscious_state). This document identifies gaps where additional telemetry would improve observability.

---

## 1. Engram-Level Telemetry

### Current `engrams` table columns (relevant)

```
confidence, salience, access_count, last_accessed, created_at, stage, retracted
```

### Recommended additions

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `useful_count` | INTEGER | 0 | Times marked useful via `memory_feedback` |
| `not_useful_count` | INTEGER | 0 | Times marked not-useful |
| `recall_count` | INTEGER | 0 | Times returned by activation pipeline (distinct from `access_count` which includes graph walks) |
| `decay_score_at_last_access` | REAL | NULL | ACT-R decay score when last retrieved — tracks how "alive" the memory was |
| `last_consolidated_at` | TEXT | NULL | When consolidation last touched this engram (strengthened, decayed, or swept) |
| `consolidation_count` | INTEGER | 0 | Number of consolidation cycles this engram has survived |
| `source_tool` | TEXT | NULL | Which tool created it: `memory_write`, `memory_task_end`, `memory_checkpoint`, `auto_checkpoint` |
| `write_latency_ms` | REAL | NULL | Time from write request to storage (includes salience scoring + embedding) |
| `content_length` | INTEGER | 0 | Character count of `content` — helps detect bloated memories |
| `embedding_norm` | REAL | NULL | L2 norm of the embedding vector — helps detect degenerate embeddings |

**Why these matter:**

- `useful_count / not_useful_count` gives a precision ratio per memory. Currently feedback adjusts confidence but the raw counts aren't persisted — you can't query "what % of my memories are actually useful."
- `recall_count` vs `access_count` distinguishes "returned to user" from "touched during graph walk." A memory with high `access_count` but zero `recall_count` is a graph hub, not a useful result.
- `decay_score_at_last_access` lets you plot decay curves and tune the ACT-R parameters (`d=0.5`) without re-running the pipeline.
- `consolidation_count` identifies memories that have survived many sleep cycles (durable knowledge) vs fresh memories.
- `source_tool` enables write-path analysis: are checkpoints producing useful memories? Are manual writes better than task summaries?
- `content_length` catches bloated memories that degrade retrieval quality.

---

## 2. Activation Event Telemetry

### Current `activation_events` table

```
id, agent_id, timestamp, context, results_returned, top_score, latency_ms, engram_ids
```

### Recommended additions

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `candidates_considered` | INTEGER | 0 | Total candidates before filtering (BM25 + semantic) |
| `bm25_hits` | INTEGER | 0 | Candidates from BM25 phase |
| `semantic_hits` | INTEGER | 0 | Candidates from vector search phase |
| `reranker_applied` | INTEGER | 0 | 1 if cross-encoder ran, 0 if skipped |
| `graph_walk_additions` | INTEGER | 0 | Memories added by graph walk phase |
| `confidence_filtered` | INTEGER | 0 | Candidates removed by confidence gating |
| `abstained` | INTEGER | 0 | 1 if pipeline abstained (no results above threshold) |
| `min_score` | REAL | NULL | Lowest score in returned results |
| `mean_score` | REAL | NULL | Average score of returned results |
| `query_embedding_norm` | REAL | NULL | L2 norm of query embedding — detect degenerate queries |
| `expansion_applied` | INTEGER | 0 | 1 if Rocchio expansion ran |
| `phase_latencies` | TEXT | '{}' | JSON: `{"bm25_ms": 2, "semantic_ms": 5, "rerank_ms": 15, ...}` |

**Why these matter:**

- `candidates_considered` vs `results_returned` is the funnel ratio. If you start with 50 candidates but return 2, the pipeline is highly selective (good). If it starts with 3 and returns 3, there's no filtering (potentially noisy).
- `bm25_hits` vs `semantic_hits` shows which retrieval path is doing the work. If BM25 always dominates, semantic search may be miscalibrated.
- `confidence_filtered` tracks how many memories are "known but untrusted." A high count means many low-confidence memories exist.
- `abstained` rate is a key health metric: too high = memory isn't useful; too low = pipeline may not be selective enough.
- `phase_latencies` enables per-phase performance profiling to identify bottlenecks.

---

## 3. Consolidation Telemetry

### Current state

No consolidation telemetry is persisted. Consolidation results are logged to `awm.log` but not queryable.

### Recommended new table: `consolidation_events`

```sql
CREATE TABLE IF NOT EXISTS consolidation_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  trigger TEXT NOT NULL,            -- 'session_end', 'mini', 'manual', 'scheduled'
  duration_ms REAL NOT NULL,

  -- Phase-level metrics
  clusters_found INTEGER NOT NULL DEFAULT 0,
  edges_strengthened INTEGER NOT NULL DEFAULT 0,
  edges_created INTEGER NOT NULL DEFAULT 0,    -- bridge edges
  edges_decayed INTEGER NOT NULL DEFAULT 0,
  edges_pruned INTEGER NOT NULL DEFAULT 0,     -- removed (weight < threshold)

  memories_decayed INTEGER NOT NULL DEFAULT 0,
  memories_archived INTEGER NOT NULL DEFAULT 0,
  memories_forgotten INTEGER NOT NULL DEFAULT 0, -- deleted
  memories_promoted INTEGER NOT NULL DEFAULT 0,  -- staging → active
  memories_discarded INTEGER NOT NULL DEFAULT 0, -- staging → deleted
  redundancy_pruned INTEGER NOT NULL DEFAULT 0,  -- similar duplicates archived

  -- Health indicators
  hub_max_degree INTEGER,            -- highest edge count after homeostasis
  hub_max_weight_sum REAL,           -- highest total weight after homeostasis
  mean_confidence_before REAL,       -- avg confidence pre-consolidation
  mean_confidence_after REAL,        -- avg confidence post-consolidation
  active_count_before INTEGER,       -- active engrams pre
  active_count_after INTEGER,        -- active engrams post
  staging_count_before INTEGER,
  staging_count_after INTEGER,

  phase_latencies TEXT NOT NULL DEFAULT '{}'  -- JSON per-phase timing
);

CREATE INDEX IF NOT EXISTS idx_consolidation_agent
  ON consolidation_events(agent_id, timestamp);
```

**Why this matters:**

- Consolidation is the least observable part of AWM. Without this table, you can't answer: "Is consolidation actually helping? How much noise is it removing? Are bridges forming between topics?"
- `memories_archived` + `memories_forgotten` over time shows the forgetting rate. Too aggressive = losing useful memories. Too passive = noise accumulates.
- `mean_confidence_before/after` tracks whether consolidation is improving overall quality.
- `hub_max_degree` detects hub domination (a key failure mode).
- Trend analysis: plot `active_count` over time to see if memory is growing sustainably or bloating.

---

## 4. Write-Path Telemetry

### Current state

Write dispositions are returned to the caller but not persisted beyond the engram itself.

### Recommended new table: `write_events`

```sql
CREATE TABLE IF NOT EXISTS write_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  engram_id TEXT,                     -- NULL if discarded
  disposition TEXT NOT NULL,          -- 'active', 'staging', 'discard'
  salience_score REAL NOT NULL,
  novelty_score REAL,                -- from duplicate detection
  event_type TEXT,                   -- observation, decision, causal, etc.
  reason_codes TEXT NOT NULL DEFAULT '[]',
  content_length INTEGER NOT NULL,
  latency_ms REAL NOT NULL,          -- total write path time
  embed_latency_ms REAL,             -- embedding generation time
  duplicate_of TEXT                   -- if discarded as duplicate, which engram
);

CREATE INDEX IF NOT EXISTS idx_write_events_agent
  ON write_events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_write_events_disposition
  ON write_events(disposition);
```

**Why this matters:**

- The salience filter rejects ~77% of writes. But which 77%? Are good memories being filtered? Are bad ones getting through?
- `disposition` distribution over time shows filter calibration: should be ~20-30% active, ~5% staging, ~65-75% discard for a well-tuned system.
- `duplicate_of` enables duplicate analysis: are agents repeatedly writing the same thing? (indicates the recall side isn't working well)
- `embed_latency_ms` tracks ML model performance over time.

---

## 5. Feedback Telemetry Enhancements

### Current `retrieval_feedback` table

```
id, activation_event_id, engram_id, useful, context, timestamp
```

### Recommended additions

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `recall_rank` | INTEGER | NULL | What rank was this memory in the results? (1 = top) |
| `recall_score` | REAL | NULL | What was its composite score when recalled? |
| `confidence_before` | REAL | NULL | Engram confidence before feedback applied |
| `confidence_after` | REAL | NULL | Engram confidence after feedback applied |
| `agent_id` | TEXT | NULL | Currently missing — can't filter feedback by agent |

**Why these matter:**

- `recall_rank` answers: "Are top-ranked results actually useful?" If rank-1 results are frequently not-useful, the ranking pipeline needs tuning.
- `confidence_before/after` tracks the actual feedback delta. Over many feedbacks, you can measure whether the +0.05/-0.1 adjustment is well-calibrated.
- `agent_id` enables per-pool feedback analysis (currently you'd need to join through activation_events).

---

## 6. System Health Dashboard Queries

With the tables above, these queries become possible:

### Memory precision (most important metric)

```sql
-- What % of recalled memories are marked useful?
SELECT
  COUNT(CASE WHEN useful = 1 THEN 1 END) * 100.0 / COUNT(*) AS precision_pct
FROM retrieval_feedback
WHERE timestamp > datetime('now', '-7 days');
```

### Write acceptance rate

```sql
-- Are we filtering the right amount?
SELECT disposition, COUNT(*) AS cnt,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) AS pct
FROM write_events
WHERE timestamp > datetime('now', '-7 days')
GROUP BY disposition;
```

### Consolidation effectiveness

```sql
-- Is consolidation reducing noise?
SELECT
  date(timestamp) AS day,
  SUM(memories_archived + memories_forgotten) AS cleaned,
  SUM(memories_promoted) AS promoted,
  AVG(mean_confidence_after - mean_confidence_before) AS avg_confidence_delta
FROM consolidation_events
GROUP BY date(timestamp)
ORDER BY day DESC LIMIT 14;
```

### Retrieval funnel

```sql
-- Where do candidates get filtered?
SELECT
  date(timestamp) AS day,
  AVG(candidates_considered) AS avg_candidates,
  AVG(results_returned) AS avg_results,
  AVG(confidence_filtered) AS avg_conf_filtered,
  SUM(abstained) * 100.0 / COUNT(*) AS abstention_rate_pct
FROM activation_events
WHERE timestamp > datetime('now', '-7 days')
GROUP BY date(timestamp);
```

### Memory lifespan

```sql
-- How long do memories survive?
SELECT
  CASE
    WHEN consolidation_count = 0 THEN 'new (0 cycles)'
    WHEN consolidation_count < 5 THEN 'young (1-4 cycles)'
    WHEN consolidation_count < 20 THEN 'mature (5-19 cycles)'
    ELSE 'durable (20+ cycles)'
  END AS lifecycle_stage,
  COUNT(*) AS count,
  ROUND(AVG(confidence), 2) AS avg_confidence,
  ROUND(AVG(useful_count), 1) AS avg_useful
FROM engrams
WHERE stage = 'active' AND retracted = 0
GROUP BY lifecycle_stage;
```

---

## 7. Implementation Priority

| Priority | Addition | Effort | Value |
|----------|----------|--------|-------|
| **P1** | `consolidation_events` table | Medium | Highest — zero visibility currently |
| **P1** | `write_events` table | Medium | High — filter calibration |
| **P2** | `useful_count` / `not_useful_count` on engrams | Low | High — precision tracking |
| **P2** | `recall_count` on engrams | Low | Medium — distinguish hub vs useful |
| **P2** | `candidates_considered` + funnel cols on activation_events | Low | Medium — retrieval diagnostics |
| **P3** | `source_tool` on engrams | Low | Medium — write-path analysis |
| **P3** | `phase_latencies` on activation_events | Low | Medium — performance profiling |
| **P3** | `recall_rank` / `recall_score` on retrieval_feedback | Low | Medium — ranking quality |
| **P4** | `embedding_norm` / `content_length` on engrams | Low | Low — edge case detection |
| **P4** | `agent_id` on retrieval_feedback | Low | Low — multi-pool analysis |

### Migration strategy

All additions are backward-compatible `ALTER TABLE ADD COLUMN` with defaults. No data migration needed. The new tables (`consolidation_events`, `write_events`) are additive. Can be rolled out incrementally:

1. Add columns to existing tables (one migration)
2. Add `write_events` table + populate on write path
3. Add `consolidation_events` table + populate in consolidation pipeline
4. Build `/health` dashboard endpoint that runs the queries above

---

## 8. Proposed `/health` Endpoint

```json
GET /health/detailed

{
  "status": "healthy",
  "metrics": {
    "active_memories": 142,
    "staging_memories": 8,
    "precision_7d": 0.82,
    "write_acceptance_rate_7d": 0.23,
    "abstention_rate_7d": 0.05,
    "avg_recall_latency_ms": 45,
    "consolidation_last_run": "2026-03-18T09:30:00Z",
    "consolidation_memories_cleaned_7d": 31,
    "hub_max_degree": 12,
    "mean_confidence": 0.61,
    "feedback_count_7d": 18,
    "duplicate_write_rate_7d": 0.34
  },
  "alerts": [
    // Only if thresholds exceeded
    { "level": "warn", "message": "Staging buffer at 47 (threshold: 30)" },
    { "level": "warn", "message": "Abstention rate 15% (threshold: 10%)" }
  ]
}
```

This gives operators a single endpoint to monitor AWM health, suitable for dashboards or automated alerting.
