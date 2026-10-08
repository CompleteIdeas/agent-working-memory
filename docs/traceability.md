# Traceability Matrix

Maps user-facing features to their implementation across the codebase.

> **File and symbol, deliberately no line numbers.** This page used to cite
> them and every one had rotted — off by two to four times — while all 42
> symbols it names still resolved. A line number is wrong the next time anyone
> inserts a function above it; a symbol name survives. `check:release` now
> verifies that every symbol on this page still exists in the file beside it,
> so the page fails loudly instead of ageing quietly.

## Memory Write

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `POST /memory/write` |
| API | MCP tool | `src/mcp.ts` | `memory_write` |
| Core | Salience scoring | `src/core/salience.ts` | `evaluateSalience()` |
| Core | Embedding generation | `src/core/embeddings.ts` | `embed()` |
| Storage | Create engram | `src/storage/sqlite.ts` | `createEngram()` |
| Storage | Update embedding | `src/storage/sqlite.ts` | `updateEmbedding()` |
| Engine | Connection discovery | `src/engine/connections.ts` | `enqueue()` |

## Memory Activation (Recall)

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `POST /memory/activate` |
| API | MCP tool | `src/mcp.ts` | `memory_recall` |
| Engine | Activation pipeline | `src/engine/activation.ts` | `activate()` |
| Core | Query expansion | `src/core/query-expander.ts` | `expandQuery()` |
| Core | Query embedding | `src/core/embeddings.ts` | `embed()` |
| Core | Vector similarity | `src/core/embeddings.ts` | `cosineSimilarity()` |
| Core | Cross-encoder rerank | `src/core/reranker.ts` | `rerank()` |
| Core | ACT-R decay | `src/core/decay.ts` | `baseLevelActivation()` |
| Core | Hebbian boost | `src/core/hebbian.ts` | `strengthenAssociation()` |
| Storage | BM25 search | `src/storage/sqlite.ts` | `searchBM25WithRank()` |
| Storage | Log activation | `src/storage/sqlite.ts` | `logActivationEvent()` |
| Engine | Graph walk | `src/engine/activation.ts` | `graphWalk()` |

## Feedback

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `POST /memory/feedback` |
| API | MCP tool | `src/mcp.ts` | `memory_feedback` |
| Storage | Log feedback | `src/storage/sqlite.ts` | `logRetrievalFeedback()` |
| Storage | Update confidence | `src/storage/sqlite.ts` | `updateConfidence()` |

## Retraction

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `POST /memory/retract` |
| API | MCP tool | `src/mcp.ts` | `memory_retract` |
| Engine | Retraction logic | `src/engine/retraction.ts` | `retract()` |
| Engine | Confidence spread | `src/engine/retraction.ts` | `propagateConfidenceReduction()` |
| Storage | Mark retracted | `src/storage/sqlite.ts` | `retractEngram()` |

## Eviction & Decay

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `POST /system/evict` |
| API | HTTP endpoint | `src/api/routes.ts` | `POST /system/decay` |
| Engine | Capacity enforcement | `src/engine/eviction.ts` | `enforceCapacity()` |
| Engine | Edge decay | `src/engine/eviction.ts` | `decayEdges()` |
| Core | Decay formula | `src/core/hebbian.ts` | `decayAssociation()` |
| Storage | Eviction candidates | `src/storage/sqlite.ts` | `getEvictionCandidates()` |

## Staging (Consolidation)

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| Engine | Staging sweep | `src/engine/staging.ts` | `sweep()` |
| Engine | Timer start/stop | `src/engine/staging.ts` | `start()`, `stop()` |
| Storage | Expired staging | `src/storage/sqlite.ts` | `getExpiredStaging()` |
| Storage | Log staging event | `src/storage/sqlite.ts` | `logStagingEvent()` |

## Eval Metrics

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts` | `GET /agent/:id/metrics` |
| API | MCP tool | `src/mcp.ts` | `memory_stats` |
| Engine | Metrics computation | `src/engine/eval.ts` | `computeMetrics()` |
| Storage | Retrieval precision | `src/storage/sqlite.ts` | `getRetrievalPrecision()` |
| Storage | Activation stats | `src/storage/sqlite.ts` | `getActivationStats()` |

## Test Suites

| Suite | File | Covers |
|-------|------|--------|
| ACT-R decay | `tests/core/decay.test.ts` | `baseLevelActivation()`, `softplus()`, `compositeScore()` |
| Hebbian learning | `tests/core/hebbian.test.ts` | `strengthenAssociation()`, `decayAssociation()`, `CoActivationBuffer` |
| Salience filter | `tests/core/salience.test.ts` | `evaluateSalience()` |
| Full lifecycle | `tests/integration/memory-lifecycle.test.ts` | Write, activate, feedback, retract, evict, search, isolation |
| MCP protocol | `tests/mcp-smoke.ts` | The MCP tool surface via JSON-RPC (19 tools) |
| Self-test | `tests/self-test/runner.ts` | 31 dimensions across 11 categories |
| Workday eval | `tests/workday-eval/runner.ts` | 14 coding recall challenges |
| Real-store retrieval | `tests/realstore-eval/runner.ts` | Identifier + topic hold-out, abstention, token economics |
| Public retrieval (reproducible) | `scripts/bench-public.mjs` | Same hold-out over a synthetic corpus anyone can rebuild |
| LOCOMO (retired) | `tests/locomo-eval/runner.ts` | **Retired in 0.13.x** — kept runnable for history only. It rewards indiscriminate retention, so it caps the salience filter at ~50% no matter how good ranking gets. See `docs/benchmarks.md`. |
