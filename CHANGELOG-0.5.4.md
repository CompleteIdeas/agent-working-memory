# AWM v0.5.4 Changelog

**Version:** 0.4.3 → 0.5.4
**Date:** 2026-03-24
**Scope:** 16 files changed, +806 / -291 lines

---

## 1. Reinforce-on-Duplicate (salience.ts, mcp.ts, sqlite.ts, agent.ts, engram.ts)

**Before:** `computeNovelty()` returned a scalar 0–1. Duplicate writes were silently discarded by the salience filter. No mechanism to strengthen existing memories when the same fact was written again.

**After:** `computeNoveltyWithMatch()` returns `NoveltyResult { novelty, matchedEngramId, matchScore }`, identifying the closest existing memory. `memory_write` now checks for duplicates (novelty < 0.3 AND BM25 > 0.85) and either:
- **True duplicate** (content overlap > 60%): reinforces the existing engram (confidence +0.05, salience +0.02, reinforcementCount++) and skips creation.
- **Partial match** (overlap ≤ 60%): reinforces at half-rate AND creates the new memory.

**v0.5.4 regression fix:** Tightened thresholds from earlier v0.5.0 draft. The original thresholds (novelty < 0.5, BM25 > 0.7) were too aggressive — they suppressed genuinely new memories that shared keywords with existing ones.

New type fields: `Engram.reinforcementCount`, `AgentConfig.reinforce*` (4 config knobs), `EngramStore.reinforceEngram()`.

## 2. No-Discard Salience (mcp.ts, routes.ts)

**Before:** Memories with `disposition === 'discard'` were dropped entirely — never stored. This caused 57% of answer-bearing turns to be lost in LoCoMo evaluation.

**After:** All memories are stored. Low-salience memories receive confidence 0.25 and a `low-salience` tag. They rank below high-salience memories in retrieval but remain available. The salience score is still computed for ranking purposes.

**Files:** `mcp.ts` (memory_write handler), `routes.ts` (HTTP write endpoint) — both updated identically.

## 3. Multi-Channel Agreement Gate (activation.ts)

**Before:** Phase 8a applied a 0.5x penalty when max vector similarity < 0.05 (semantic drift). Phase 8b used entropy gating on reranker scores. These were independent, weak OOD detectors.

**After:** Replaced with a unified multi-channel OOD detector requiring **≥2 of 3 channels** (BM25 > 0.3, vector > 0.05, reranker > 0.25) to agree the query is in-domain. Additionally checks reranker score margin (top-1 vs top-2) and raw cosine distribution.

- **Hard abstention:** < 2 channels agree AND max cosine < mean + 1.5σ → return empty.
- **Soft penalty:** < 2 channels agree OR margin < 0.05 → 0.4x score multiplier (was 0.5x).

Legacy `abstentionThreshold` gate preserved for backward compatibility.

## 4. Dual BM25 Keyword-Stripped Query (activation.ts)

**Before:** Single BM25 pass using the expanded query (from query expander). Conversational queries with stopwords diluted BM25 precision.

**After:** Two-pass BM25: (1) keyword-stripped query (tokenized, stopwords removed) for precision, (2) expanded query for recall. Per-engram scores merged (max wins). This improves precision on conversational recall queries without sacrificing coverage.

## 5. Async Consolidation with Embedding Backfill (consolidation.ts, consolidation-scheduler.ts, routes.ts, mcp.ts)

**Before:** `consolidate()` was synchronous. Engrams written without embeddings (async pipeline) were skipped during consolidation — they never got clustered, bridged, or decayed.

**After:** `consolidate()` is now `async`. Phase 1 (Replay) backfills missing embeddings via `await embed()` before clustering. Diagnostic log shows embedding coverage percentage.

**Callers updated:** `ConsolidationScheduler.runMiniConsolidation()`, `runFullConsolidation()`, `routes.ts /system/consolidate`, `mcp.ts` (memory_restore, onConsolidate hook).

## 6. Diameter-Enforced Clustering (consolidation.ts)

**Before:** Greedy single-link clustering — a candidate joined a cluster if it was similar to *any* member (cosine ≥ 0.65). This caused chaining: e.g., physics → biophysics → molecular biology → cooking all in one cluster.

**After:** Two-gate clustering:
1. **Single-link entry** (cosine ≥ 0.65 to any member) — same as before.
2. **Diameter enforcement** (cosine ≥ 0.50 to ALL members) — prevents chaining.

Precomputes O(n²) pairwise cosine matrix for speed. Iterates until no more candidates pass both gates.

## 7. Direct Cross-Cluster Bridging (consolidation.ts)

**Before:** Phase 3 compared cluster centroids (cosine between 0.25–0.65) and bridged representative nodes. This almost never triggered — centroid similarity was too blunt for small clusters.

**After:** `findBoundaryBridges()` finds the **closest pair of memories** between each pair of clusters and bridges them if cosine > 0.15. Creates bidirectional bridge edges. Logs each bridge with concept names and similarity score.

## 8. Contradiction Detection (consolidation.ts)

**Before:** No contradiction detection.

**After:** Phase 1.5 — for clusters with 3+ members, pairwise checks for conflicting memories using:
- Confidence delta > 0.2 between two memories.
- Heuristic negation-polarity check (`hasContradictionSignal()`): one text contains negation patterns (not, never, removed, replaced, wrong, etc.) the other doesn't.

Suspect memory (lower confidence) gets tagged `contradiction_candidate` + `contradicts:<authority_id>`. Flags only — does not auto-retract.

`ConsolidationResult.contradictionsFound` field added.

## 9. Confidence Drift (consolidation.ts)

**Before:** Confidence only changed via explicit `memory_feedback` calls.

**After:** Phase 6.7 adjusts confidence based on structural signals each consolidation cycle:
- **Cluster membership:** +0.01 (integrated into knowledge graph).
- **Zero edges:** -0.02 (isolated, possibly noise).
- **Neglected 30+ days:** -0.01 drift toward 0.3.

Capped at ±0.03/cycle. Floor 0.15, ceiling 0.85 (only explicit feedback can push above).

`ConsolidationResult.confidenceAdjusted` field added.

## 10. Profile Stage (engram.ts, consolidation.ts, mcp.ts, sqlite.ts)

**Before:** 4 stages: staging, active, consolidated, archived.

**After:** 5 stages — added `profile`. Profiles are:
- Created via new `memory_profile_set` MCP tool.
- High salience (0.95), high confidence (0.9).
- Never age out (exempt from Phase 6 forgetting).
- Injected into `memory_restore` results (workspace profiles section).
- Keyword-filtered when > 3 profiles exist and recall context is available.

New store methods: `getProfiles()`, `updateContent()`, `updateTags()`.

## 11. Workspace Scoping (engram.ts, sqlite.ts, salience.ts, mcp.ts)

**Before:** All memories were agent-scoped. No cross-agent sharing.

**After:** Engrams have `scope: 'agent' | 'workspace'` and `workspace: string | null`. Workspace-scoped memories are visible to all agents in the same workspace.

- `computeNoveltyWithMatch()` accepts optional `workspace` param for cross-agent dedup.
- `searchBM25WithRank()` accepts `{ includeWorkspace }` option for cross-scope search.
- `memory_recall` passes workspace to activation engine.
- `deriveWorkspace()` utility extracts workspace from agent ID convention (`prefix:AgentName`).

SQLite migrations: `scope`, `workspace` columns + index.

## 12. Source Provenance (engram.ts, sqlite.ts, mcp.ts)

**Before:** No tracking of where a memory came from.

**After:** `EngramSource { agent, task?, file?, context? }` stored as JSON in `source` column. Auto-populated with agent ID on write. Displayed in recall results when source agent differs from querying agent.

SQLite migration: `source TEXT NOT NULL DEFAULT '{}'`.

## 13. initLogger (index.ts)

Added `initLogger(DB_PATH)` call at HTTP server startup to write activity logs to `data/awm.log` alongside the database.

## 14. Version Bump

`package.json`: 0.4.3 → 0.5.4
`mcp.ts` server version: 0.4.0 → 0.5.4
MCP tool count: 11 → 12 (added `memory_profile_set`)

---

## Test Results (Before → After)

### A/B Test
| Metric | v0.4.3 | v0.5.4 | Delta |
|--------|--------|--------|-------|
| Fact Recall | 22/22 (100%) | 21/22 (95.5%) | -1 (Q8 search tech missed) |
| Noise Rejection | 2/2 (100%) | 0/2 (0%) | -2 (no-discard stores noise) |
| Overall Score | 100% | 81.8% | -18.2pp |

**Note:** The no-discard change intentionally trades noise rejection for recall coverage. The v0.4.3 score was misleadingly high — it rejected noise perfectly but also discarded 57% of answer-bearing turns in LoCoMo scenarios. The v0.5.4 approach stores everything with low confidence and relies on retrieval ranking to surface the right memories.

### Sleep Cycle Test
| Metric | v0.4.3 | v0.5.4 | Delta |
|--------|--------|--------|-------|
| Single-Topic (all phases) | 5/6 stable | 5/6 stable | Same |
| Cross-Topic (after sleep) | 4/6 → 4/6 | 3/6 → 3/6 | -1 (no improvement from bridging yet) |
| Noise Rejection | 1/2 | 2/2 | +1 |
| Edges after 100 cycles | 1649 | 132 | Much tighter graph |
| Active memories (100 cycles) | 13 | 12 | Stable |

**Key insight:** v0.5.4 produces a dramatically tighter graph (132 edges vs 1649) that stabilizes after ~20 cycles. Cross-topic bridging now fires (100% cross-topic recall in stress test) but the sleep cycle test's cross-topic queries are harder.

### Stress Test
| Metric | v0.4.3 | v0.5.4 | Delta |
|--------|--------|--------|-------|
| Overall | 48/52 (92.3%) | 45/52 (86.5%) | -5.8pp |
| Phase 2 (100 Cycles) | 5/5 (100%) | 0/5 (0%) | -5 (edge ratio 0.05x fails threshold) |
| Phase 4 (Bridge) | Pre: 1/5, Post: 5/5 | Pre: 4/5, Post: 5/5 | Better pre-bridge baseline |
| Phase 5 (Adversarial) | 5/7 (71%) | 6/7 (86%) | +1 |
| Phase 6 (Recovery) | 8/10 (80%) | 9/10 (90%) | +1 |

**Regression:** Phase 2 fails because the new diameter-enforced clustering + aggressive decay produces a 0.05x edge ratio (threshold expects ≥ some minimum). The graph is actually healthier (stable at 132 edges, 80% recall) but the test's edge-ratio assertion needs updating.

**Improvements:** Adversarial resilience +15pp, recovery +10pp, pre-bridge cross-topic +60pp.

### Edge Cases
No change in scores (still passing).

---

## New Files
- `packages/memory/src/core/workspace.ts` — `deriveWorkspace()` utility

## Risk Areas for Future Work
1. Phase 2 stress test threshold needs recalibration for tighter graph
2. A/B test noise rejection metric needs reframing (no-discard is intentional)
3. Cross-topic bridging fires in stress test but not sleep cycle — threshold tuning needed
4. `consolidate()` is now async — all callers must await it
