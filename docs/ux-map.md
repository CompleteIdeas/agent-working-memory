# API Surface Area Map

AWM exposes two interfaces: an HTTP REST API (Fastify) and an MCP stdio server. Both access the same underlying engines.

## HTTP Endpoints

### Core (Agent-Facing)

| Method | Path               | Purpose                      | Primary Actions                                                             | Code Reference          |
| ------ | ------------------ | ---------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| POST   | `/memory/write`    | Store a new memory           | Evaluate salience, create engram, generate embedding, queue for connections | `src/api/routes.ts:51`  |
| POST   | `/memory/activate` | Retrieve memories by context | 9-phase activation pipeline (expand, embed, BM25, score, rerank)            | `src/api/routes.ts:116` |
| POST   | `/memory/feedback` | Report memory usefulness     | Log feedback, update confidence score                                       | `src/api/routes.ts:136` |
| POST   | `/memory/retract`  | Invalidate wrong memory      | Mark retracted, create correction, propagate confidence penalties           | `src/api/routes.ts:164` |

### Diagnostic (Debugging/Inspection)

| Method | Path                 | Purpose                   | Primary Actions                                                   | Code Reference          |
| ------ | -------------------- | ------------------------- | ----------------------------------------------------------------- | ----------------------- |
| POST   | `/memory/search`     | Deterministic text search | SQL-based search by text, concept, tags, stage, retraction status | `src/api/routes.ts:186` |
| GET    | `/memory/:id`        | Get specific memory       | Fetch engram + all associations                                   | `src/api/routes.ts:212` |
| GET    | `/agent/:id/stats`   | Memory count summary      | Active, staging, retracted counts + avg confidence                | `src/api/routes.ts:221` |
| GET    | `/agent/:id/metrics` | Eval metrics dashboard    | Retrieval precision, latency, edge utility, staging accuracy      | `src/api/routes.ts:243` |
| POST   | `/agent/register`    | Create new agent          | Generate UUID, return default config                              | `src/api/routes.ts:250` |

### System (Maintenance)

| Method | Path            | Purpose                   | Primary Actions                             | Code Reference          |
| ------ | --------------- | ------------------------- | ------------------------------------------- | ----------------------- |
| POST   | `/system/evict` | Enforce capacity limits   | Evict low-value engrams, prune excess edges | `src/api/routes.ts:264` |
| POST   | `/system/decay` | Decay association weights | Exponential decay on unused edges           | `src/api/routes.ts:270` |
| GET    | `/health`       | Health check              | Return status, timestamp, version           | `src/api/routes.ts:276` |

## MCP Tools

| Tool              | Purpose           | Key Parameters                                                                               | Code Reference   |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `memory_write`    | Store a memory    | concept, content, tags, event_type, surprise, decision_made, causal_depth, resolution_effort | `src/mcp.ts:55`  |
| `memory_recall`   | Retrieve memories | context, limit, min_score, include_staging, use_reranker, use_expansion                      | `src/mcp.ts:126` |
| `memory_feedback` | Report usefulness | engram_id, useful, context                                                                   | `src/mcp.ts:174` |
| `memory_retract`  | Invalidate memory | engram_id, reason, correction                                                                | `src/mcp.ts:204` |
| `memory_stats`    | Health metrics    | (none)                                                                                       | `src/mcp.ts:237` |

## Data Flow Diagram

```
Agent/User
    |
    v
[HTTP API / MCP Server]
    |
    ├── /memory/write ────> Salience Filter ──> EngramStore.createEngram()
    |                                              |
    |                                              ├── embed() (async)
    |                                              └── ConnectionEngine.enqueue()
    |
    ├── /memory/activate ──> ActivationEngine.activate()
    |                           |
    |                           ├── Phase 0: Query Expansion (flan-t5-small)
    |                           ├── Phase 1: Embed Query (MiniLM)
    |                           ├── Phase 2: BM25 + All Active Retrieval
    |                           ├── Phase 3: Multi-Signal Scoring
    |                           ├── Phase 4-5: Graph Walk (BFS depth 2)
    |                           ├── Phase 6: Filter + Sort
    |                           ├── Phase 7: Cross-Encoder Rerank (ms-marco)
    |                           ├── Phase 8: Abstention Check
    |                           └── Phase 9: Final Results + Explain
    |
    ├── /memory/feedback ──> Update Confidence
    |
    └── /memory/retract ──> RetractionEngine.retract()
                               |
                               ├── Mark retracted
                               ├── Create correction engram
                               └── Propagate confidence penalties

[Background Processes]
    ├── StagingBuffer (every 60s): promote or discard staging memories
    ├── ConnectionEngine (on write): discover semantic links
    └── Hebbian updates (on activate): strengthen co-activated edges
```
