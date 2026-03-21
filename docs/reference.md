# Reference

## API Request/Response Reference

### POST /memory/write

**Request:**
```json
{
  "agentId": "string (required)",
  "concept": "string (required) — short label, 3-8 words",
  "content": "string (required) — full detail",
  "tags": ["string"] ,
  "eventType": "observation | decision | friction | surprise | causal",
  "surprise": 0.0-1.0,
  "decisionMade": true/false,
  "causalDepth": 0.0-1.0,
  "resolutionEffort": 0.0-1.0,
  "confidence": 0.0-1.0
}
```

**Response (201 if stored, 200 if discarded):**
```json
{
  "stored": true,
  "disposition": "active | staging | discard",
  "salience": 0.62,
  "reasonCodes": ["causal_insight", "event:causal", "disposition:active"],
  "engram": { ... }
}
```

### POST /memory/activate

**Request:**
```json
{
  "agentId": "string (required)",
  "context": "string (required) — what you're thinking about",
  "limit": 10,
  "minScore": 0.01,
  "includeStaging": false,
  "useReranker": true,
  "useExpansion": true,
  "abstentionThreshold": 0
}
```

**Response:**
```json
{
  "results": [{
    "engram": { "id": "...", "concept": "...", "content": "...", ... },
    "score": 0.82,
    "phaseScores": {
      "textMatch": 0.75,
      "vectorMatch": 0.68,
      "decayScore": 1.20,
      "hebbianBoost": 0.15,
      "graphBoost": 0.05,
      "confidenceGate": 0.80,
      "composite": 0.72,
      "rerankerScore": 0.88
    },
    "why": "composite=0.820 | text=0.75 | vector=0.68 | ...",
    "associations": [...]
  }]
}
```

### POST /memory/feedback

**Request:**
```json
{
  "engramId": "string (required)",
  "useful": true,
  "activationEventId": "string (optional)",
  "context": "string (optional)"
}
```

**Response:** `{ "recorded": true }`

### POST /memory/retract

**Request:**
```json
{
  "agentId": "string (required)",
  "targetEngramId": "string (required)",
  "reason": "string (required)",
  "counterContent": "string (optional) — correct information"
}
```

**Response:**
```json
{
  "retractedId": "...",
  "correctionId": "... (if counterContent provided)",
  "associatesAffected": 3
}
```

### POST /memory/search

**Request:**
```json
{
  "agentId": "string (required)",
  "text": "string (optional) — keyword search",
  "concept": "string (optional) — exact concept match",
  "tags": ["string"] ,
  "stage": "active | staging | archived | consolidated",
  "retracted": false,
  "limit": 20,
  "offset": 0
}
```

**Response:** `{ "results": [...], "count": 5 }`

### GET /memory/:id

**Response:** `{ "engram": {...}, "associations": [...] }`

### GET /agent/:id/stats

**Response:**
```json
{
  "agentId": "...",
  "engrams": { "active": 42, "staging": 3, "retracted": 1, "total": 46 },
  "associations": 128,
  "avgConfidence": 0.72
}
```

### GET /agent/:id/metrics

**Query:** `?window=24` (hours, default 24)

**Response:**
```json
{
  "metrics": {
    "activationCount": 150,
    "avgPrecisionAtK": 0.73,
    "avgLatencyMs": 45.2,
    "p95LatencyMs": 120.5,
    "totalEdges": 512,
    "edgeUtilityRate": 0.65,
    "activeEngramCount": 200,
    "stagingEngramCount": 15,
    "retractedCount": 3,
    "avgConfidence": 0.68,
    "retractionRate": 0.015
  }
}
```

### POST /system/evict

**Request:** `{ "agentId": "string" }`
**Response:** `{ "evicted": 5, "edgesPruned": 12 }`

### POST /system/decay

**Request:** `{ "agentId": "string", "halfLifeDays": 7 }`
**Response:** `{ "edgesDecayed": 23 }`

### POST /task/create

**Request:**
```json
{
  "agentId": "string (required)",
  "concept": "string (required) — short task title",
  "content": "string (required) — full task description",
  "tags": ["string"],
  "priority": "urgent | high | medium | low",
  "blockedBy": "string (optional) — ID of blocking task"
}
```

**Response:** Full engram object with `taskStatus`, `taskPriority`, `blockedBy` fields.

### POST /task/update

**Request:**
```json
{
  "taskId": "string (required)",
  "status": "open | in_progress | blocked | done",
  "priority": "urgent | high | medium | low",
  "blockedBy": "string | null"
}
```

**Response:** Updated engram object.

### GET /task/list/:agentId

**Query:** `?status=open&includeDone=true`

**Response:**
```json
{
  "tasks": [{ "id": "...", "concept": "...", "taskStatus": "open", "taskPriority": "high", ... }],
  "count": 3
}
```

Tasks ordered by priority (urgent first), then creation date.

### GET /task/next/:agentId

**Response:**
```json
{
  "task": { "id": "...", "concept": "...", "taskStatus": "open", "taskPriority": "urgent", ... }
}
```

Returns the single highest-priority non-blocked task. Prefers in_progress tasks (finish what you started).

### GET /health

**Response:** `{ "status": "ok", "timestamp": "2026-03-09T...", "version": "0.3.0" }`

---

## Configuration Defaults

All values from `DEFAULT_AGENT_CONFIG` in `src/types/agent.ts`:

### Salience

| Setting | Default | Meaning |
|---------|---------|---------|
| `salienceThreshold` | `0.4` | Minimum score for active storage |
| `stagingThreshold` | `0.2` | Minimum score for staging (below = discard) |
| `stagingTtlMs` | `86,400,000` | 24 hours in staging before sweep |

### Capacity

| Setting | Default | Meaning |
|---------|---------|---------|
| `maxActiveEngrams` | `10,000` | Hard cap on active memories |
| `maxStagingEngrams` | `1,000` | Hard cap on staging buffer |
| `maxEdgesPerEngram` | `20` | Max associations per memory |

### Activation Pipeline

| Setting | Default | Meaning |
|---------|---------|---------|
| `activationLimit` | `10` | Default max results per query |
| `hebbianRate` | `0.25` | Association learning rate |
| `decayExponent` | `0.5` | ACT-R *d* parameter (higher = faster forgetting) |
| `edgeDecayHalfLifeDays` | `7` | Unused edges halve in weight every 7 days |

### Feedback

| Setting | Default | Meaning |
|---------|---------|---------|
| `feedbackPositiveBoost` | `0.05` | Confidence increase for "useful" |
| `feedbackNegativePenalty` | `0.1` | Confidence decrease for "not useful" |

### Connection Discovery

| Setting | Default | Meaning |
|---------|---------|---------|
| `connectionThreshold` | `0.7` | Min activation score to form a new edge |
| `connectionCheckIntervalMs` | `60,000` | Queue processing frequency |

---

## Salience Scoring Formula

**Weights:**
- Surprise: 30%
- Decision made: 25%
- Causal depth: 25%
- Resolution effort: 20%

**Event type bonuses:**
- `observation`: +0.0
- `decision`: +0.15
- `friction`: +0.20
- `causal`: +0.20
- `surprise`: +0.25

**Disposition thresholds:**
- Score >= 0.4 -> `active`
- Score >= 0.2 -> `staging`
- Score < 0.2 -> `discard`

**Reason codes (audit trail):**
- `high_surprise` — surprise > 0.5
- `decision_point` — decision was made
- `causal_insight` — causalDepth > 0.5
- `high_effort_resolution` — resolutionEffort > 0.5
- `event:{type}` — event type used
- `disposition:{result}` — final placement

---

## Activation Pipeline Phases

| Phase | Signal | Weight | Description |
|-------|--------|--------|-------------|
| 0 | Query Expansion | - | Adds synonyms via flan-t5-small (optional) |
| 1 | Vector Embedding | - | Embeds query with MiniLM (384d) |
| 2 | BM25 Retrieval | - | FTS5 full-text search + all active pool |
| 3a | BM25 Score | 0-1 | Normalized FTS5 rank: `\|rank\| / (1 + \|rank\|)` |
| 3b | Jaccard Score | 0-1 | Stopword-filtered word overlap (60% concept, 40% content) |
| 3c | Concept Bonus | 0-0.3 | Exact concept term overlap |
| 3d | Vector Similarity | 0-1 | Cosine similarity mapped 0.2-0.6 -> 0-1 |
| 3e | Text Match | 0-1 | `max(keyword, vector)` |
| 4 | ACT-R Decay | real | `ln(n+1) - d * ln(age / (n+1))` |
| 5 | Hebbian Boost | 0-0.5 | Average association weight, capped |
| 6 | Composite | 0-1 | `(0.6 * text + 0.4 * temporal * relevanceGate) * confidence` |
| 7 | Graph Walk | 0-0.2 | BFS depth 2, hop penalty 0.3, per-engram cap 0.2 |
| 8 | Reranker | 0-1 | Cross-encoder blend: `0.4 * composite + 0.6 * rerankerScore` |
| 9 | Abstention | - | If top reranker score < threshold, return empty |

---

## Engram Stages (State Machine)

```
write ──> [Salience Filter]
              |
              ├── score >= 0.4 ──> ACTIVE ──> [Eviction] ──> ARCHIVED
              |                       |
              |                       └── [Retraction] ──> RETRACTED
              |
              ├── score >= 0.2 ──> STAGING ──> [Sweep: resonant?]
              |                                    |
              |                                    ├── yes ──> ACTIVE
              |                                    └── no  ──> DELETED
              |
              └── score < 0.2 ──> DISCARDED (not stored)
```

---

## Hebbian Learning

**Strengthening** (on co-activation):
```
log_new = log(weight) + signal * log(1 + rate)
weight = min(exp(log_new), 5.0)     // MAX_WEIGHT cap
```
Default rate: 0.25, default signal: 1.0

**Decay** (periodic):
```
weight = max(weight * 2^(-days / halfLife), 0.001)   // MIN_WEIGHT floor
```
Default half-life: 7 days

**Co-activation window:** 5 seconds (buffer size: 50 entries)

---

## Database Schema

### engrams
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| agent_id | TEXT | Agent isolation |
| concept | TEXT | Short label |
| content | TEXT | Full detail |
| embedding | BLOB | Float32Array (384 * 4 bytes) |
| confidence | REAL | 0-1, updated by feedback |
| salience | REAL | 0-1, set at write time |
| access_count | INTEGER | Incremented on activation |
| last_accessed | TEXT | ISO datetime |
| created_at | TEXT | ISO datetime |
| salience_features | TEXT | JSON |
| reason_codes | TEXT | JSON array |
| stage | TEXT | active/staging/archived/consolidated |
| ttl | INTEGER | Milliseconds (staging only) |
| retracted | INTEGER | 0 or 1 |
| retracted_by | TEXT | FK to correction engram |
| retracted_at | TEXT | ISO datetime |
| tags | TEXT | JSON array |
| episode_id | TEXT | FK to episodes |
| task_status | TEXT | open/in_progress/blocked/done (null if not a task) |
| task_priority | TEXT | urgent/high/medium/low (null if not a task) |
| blocked_by | TEXT | FK to blocking task engram |

### associations
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| from_engram_id | TEXT FK | |
| to_engram_id | TEXT FK | |
| weight | REAL | 0-5, learnable |
| confidence | REAL | 0-1 |
| type | TEXT | hebbian/connection/invalidation |
| activation_count | INTEGER | Times used in retrieval |
| created_at | TEXT | ISO datetime |
| last_activated | TEXT | ISO datetime |

### engrams_fts (FTS5 virtual table)
Full-text search index on concept, content, tags. Auto-synced via triggers.

### activation_events
Logs every retrieval query: context, result count, top score, latency.

### staging_events
Logs consolidation decisions: promoted, discarded, expired.

### retrieval_feedback
Ground truth: engram ID, useful (boolean), context.
