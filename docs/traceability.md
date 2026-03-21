# Traceability Matrix

Maps user-facing features to their implementation across the codebase.

## Memory Write

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:51` | `POST /memory/write` |
| API | MCP tool | `src/mcp.ts:55` | `memory_write` |
| Core | Salience scoring | `src/core/salience.ts:60` | `evaluateSalience()` |
| Core | Embedding generation | `src/core/embeddings.ts:32` | `embed()` |
| Storage | Create engram | `src/storage/sqlite.ts:148` | `createEngram()` |
| Storage | Update embedding | `src/storage/sqlite.ts:220` | `updateEmbedding()` |
| Engine | Connection discovery | `src/engine/connections.ts:18` | `enqueue()` |

## Memory Activation (Recall)

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:116` | `POST /memory/activate` |
| API | MCP tool | `src/mcp.ts:126` | `memory_recall` |
| Engine | Activation pipeline | `src/engine/activation.ts:80` | `activate()` |
| Core | Query expansion | `src/core/query-expander.ts:44` | `expandQuery()` |
| Core | Query embedding | `src/core/embeddings.ts:32` | `embed()` |
| Core | Vector similarity | `src/core/embeddings.ts:50` | `cosineSimilarity()` |
| Core | Cross-encoder rerank | `src/core/reranker.ts:47` | `rerank()` |
| Core | ACT-R decay | `src/core/decay.ts:12` | `baseLevelActivation()` |
| Core | Hebbian boost | `src/core/hebbian.ts:10` | `strengthenAssociation()` |
| Storage | BM25 search | `src/storage/sqlite.ts:228` | `searchBM25WithRank()` |
| Storage | Log activation | `src/storage/sqlite.ts:350` | `logActivationEvent()` |
| Engine | Graph walk | `src/engine/activation.ts:281` | `graphWalk()` |

## Feedback

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:136` | `POST /memory/feedback` |
| API | MCP tool | `src/mcp.ts:174` | `memory_feedback` |
| Storage | Log feedback | `src/storage/sqlite.ts:370` | `logRetrievalFeedback()` |
| Storage | Update confidence | `src/storage/sqlite.ts:210` | `updateConfidence()` |

## Retraction

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:164` | `POST /memory/retract` |
| API | MCP tool | `src/mcp.ts:204` | `memory_retract` |
| Engine | Retraction logic | `src/engine/retraction.ts:12` | `retract()` |
| Engine | Confidence spread | `src/engine/retraction.ts:55` | `propagateConfidenceReduction()` |
| Storage | Mark retracted | `src/storage/sqlite.ts:200` | `retractEngram()` |

## Eviction & Decay

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:264` | `POST /system/evict` |
| API | HTTP endpoint | `src/api/routes.ts:270` | `POST /system/decay` |
| Engine | Capacity enforcement | `src/engine/eviction.ts:10` | `enforceCapacity()` |
| Engine | Edge decay | `src/engine/eviction.ts:60` | `decayEdges()` |
| Core | Decay formula | `src/core/hebbian.ts:25` | `decayAssociation()` |
| Storage | Eviction candidates | `src/storage/sqlite.ts:270` | `getEvictionCandidates()` |

## Staging (Consolidation)

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| Engine | Staging sweep | `src/engine/staging.ts:15` | `sweep()` |
| Engine | Timer start/stop | `src/engine/staging.ts:10` | `start()`, `stop()` |
| Storage | Expired staging | `src/storage/sqlite.ts:290` | `getExpiredStaging()` |
| Storage | Log staging event | `src/storage/sqlite.ts:360` | `logStagingEvent()` |

## Eval Metrics

| Layer | Component | File | Symbol |
|-------|-----------|------|--------|
| API | HTTP endpoint | `src/api/routes.ts:243` | `GET /agent/:id/metrics` |
| API | MCP tool | `src/mcp.ts:237` | `memory_stats` |
| Engine | Metrics computation | `src/engine/eval.ts:10` | `computeMetrics()` |
| Storage | Retrieval precision | `src/storage/sqlite.ts:380` | `getRetrievalPrecision()` |
| Storage | Activation stats | `src/storage/sqlite.ts:390` | `getActivationStats()` |

## Test Suites

| Suite | File | Covers |
|-------|------|--------|
| ACT-R decay | `tests/core/decay.test.ts` | `baseLevelActivation()`, `softplus()`, `compositeScore()` |
| Hebbian learning | `tests/core/hebbian.test.ts` | `strengthenAssociation()`, `decayAssociation()`, `CoActivationBuffer` |
| Salience filter | `tests/core/salience.test.ts` | `evaluateSalience()` |
| Full lifecycle | `tests/integration/memory-lifecycle.test.ts` | Write, activate, feedback, retract, evict, search, isolation |
| MCP protocol | `tests/mcp-smoke.ts` | All 5 MCP tools via JSON-RPC |
| Self-test | `tests/self-test/runner.ts` | 31 dimensions across 11 categories |
| Workday eval | `tests/workday-eval/runner.ts` | 14 coding recall challenges |
| LOCOMO benchmark | `tests/locomo-eval/runner.ts` | 199 QA pairs, 5 categories |
