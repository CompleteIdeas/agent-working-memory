# API Surface Area Map

AWM exposes two interfaces: an HTTP REST API (Fastify) and an MCP stdio server. Both access the same underlying engines.

Reviewed against v0.22.4. Code references name the route or tool registration to search for, not a line number. The HTTP tables below list the original core routes; [`reference.md`](reference.md) documents the full HTTP surface (batch writes, supersede, about/alias, tasks, checkpoint/restore, export, whoami and more).

## HTTP Endpoints

### Core (Agent-Facing)

| Method | Path               | Purpose                      | Primary Actions                                                             | Code Reference          |
| ------ | ------------------ | ---------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| POST   | `/memory/write`    | Store a new memory           | Evaluate salience, create engram, generate embedding, queue for connections | `src/api/routes.ts` — `app.post('/memory/write')`  |
| POST   | `/memory/activate` | Retrieve memories by context | 9-phase activation pipeline (expand, embed, BM25, score, rerank)            | `src/api/routes.ts` — `app.post('/memory/activate')` |
| POST   | `/memory/feedback` | Report memory usefulness     | Log feedback, update confidence score                                       | `src/api/routes.ts` — `app.post('/memory/feedback')` |
| POST   | `/memory/retract`  | Invalidate wrong memory      | Mark retracted, create correction, propagate confidence penalties           | `src/api/routes.ts` — `app.post('/memory/retract')` |

### Diagnostic (Debugging/Inspection)

| Method | Path                 | Purpose                   | Primary Actions                                                   | Code Reference          |
| ------ | -------------------- | ------------------------- | ----------------------------------------------------------------- | ----------------------- |
| POST   | `/memory/search`     | Deterministic text search | SQL-based search by text, concept, tags, stage, retraction status | `src/api/routes.ts` — `app.post('/memory/search')` |
| GET    | `/memory/:id`        | Get specific memory       | Fetch engram + all associations                                   | `src/api/routes.ts` — `app.get('/memory/:id')` |
| GET    | `/agent/:id/stats`   | Memory count summary      | Active, staging, retracted counts + avg confidence                | `src/api/routes.ts` — `app.get('/agent/:id/stats')` |
| GET    | `/agent/:id/metrics` | Eval metrics dashboard    | Retrieval precision, latency, edge utility, staging accuracy      | `src/api/routes.ts` — `app.get('/agent/:id/metrics')` |
| POST   | `/agent/register`    | Create new agent          | Generate UUID, return default config                              | `src/api/routes.ts` — `app.post('/agent/register')` |

### System (Maintenance)

| Method | Path            | Purpose                   | Primary Actions                             | Code Reference          |
| ------ | --------------- | ------------------------- | ------------------------------------------- | ----------------------- |
| POST   | `/system/evict` | Enforce capacity limits   | Evict low-value engrams, prune excess edges | `src/api/routes.ts` — `app.post('/system/evict')` |
| POST   | `/system/decay` | Decay association weights | Exponential decay on unused edges           | `src/api/routes.ts` — `app.post('/system/decay')` |
| GET    | `/health`       | Health check              | Return status, timestamp, version           | `src/api/routes.ts` — `app.get('/health')` |

## MCP Tools

All 22 tools registered in `src/mcp.ts` (search for `server.tool(` and the tool name):

| Tool | Purpose | Key Parameters |
| --- | --- | --- |
| `memory_write` | Store a memory (salience-gated) | concept, content, project, topic, intent, confidence_level, memory_class, tags, slot, questions, correction, scope, valid_from/valid_to |
| `memory_recall` | Retrieve memories | query, limit, min_score, workspace, require_confidence, granularity, scope, session_first, max_tokens, use_reranker, use_expansion |
| `memory_about` | Everything stored about a named entity | entity, workspace, limit, include_superseded, granularity, max_tokens |
| `memory_alias` | Manage entity aliases | action, alias, entity |
| `memory_feedback` | Report usefulness | engram_id, useful, context, recall_id |
| `memory_retract` | Invalidate a wrong memory | engram_id, reason, correction |
| `memory_supersede` | Replace an outdated memory | old_engram_id, new_engram_id, reason |
| `memory_whoami` | Identify the instance, agent, workspace and store | (none) |
| `memory_stats` | Health metrics | (none) |
| `memory_checkpoint` | Save working state | current_task, decisions, active_files, next_steps, related_memory_ids, notes |
| `memory_restore` | Restore working state at session start | capabilities |
| `memory_set_questions` | Attach recall questions to memories | items |
| `onboard_scan` | Propose seed memories from docs/repo | docs, repo, project, purpose |
| `onboard_questions` | Questions for the owner while onboarding | (none) |
| `memory_task_add` | Create a task | concept, content, tags, priority, blocked_by |
| `memory_task_update` | Update a task | task_id, status, priority, blocked_by |
| `memory_task_list` | List tasks | status, include_done |
| `memory_task_next` | Next actionable task | (none) |
| `memory_task_begin` | Checkpoint and recall at task start | topic, files, notes |
| `memory_task_end` | Summarise and close a task | summary, tags, supersedes |
| `compress_output` | TOON-compress a structured tool output (output-only, lossless) | output, min_saving_chars |
| `retrieve_original` | Get the verbatim source for a compress_output ref | ref |

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
    |                           ├── Phase 0: Query Expansion (flan-t5-small; opt-in, off since 0.22.1)
    |                           ├── Phase 1: Embed Query (bge-small-en-v1.5)
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
