# Feature: Activate (Recall) Memories

## When You'd Use It

When an agent needs context-aware recall — starting a new task, debugging a familiar issue, making a decision that relates to past experience, or returning to previous work.

## How It Works

### Steps (Happy Path)

1. Call `POST /memory/activate` (or MCP `memory_recall`) with a natural language context
2. The 9-phase activation pipeline scores all candidate memories:

   **Phase 0 — Query Expansion** (optional): Flan-T5 adds synonyms/related terms to improve BM25 recall

   **Phase 1 — Embed Query**: MiniLM generates a 384-dim vector for semantic matching

   **Phase 2 — Parallel Retrieval**: BM25 (FTS5) search + all active engrams merged into candidate pool

   **Phase 3 — Multi-Signal Scoring** (per memory):
   - BM25 continuous score (0-1)
   - Jaccard similarity (stopword-filtered, 60% concept / 40% content)
   - Concept exact match bonus (up to 0.3)
   - Vector cosine similarity (mapped to 0-1)
   - ACT-R temporal decay (log-space, accounts for access frequency and age)
   - Hebbian association strength (capped at 0.5)
   - Composite: `(0.6 * textMatch + 0.4 * temporal * relevanceGate) * confidence`

   **Phase 4-5 — Graph Walk**: BFS depth 2 from high-scoring memories boosts connected neighbors (cap 0.2)

   **Phase 6 — Filter**: Remove results below `minScore`

   **Phase 7 — Reranker** (optional): Cross-encoder rescores top candidates, blended 40/60 with composite

   **Phase 8 — Abstention**: If top reranker score below threshold, return empty (noise rejection)

   **Phase 9 — Results**: Top `limit` memories with per-phase explanations

3. Side effects: access counts updated, Hebbian weights strengthened, activation event logged

### What Gets Returned

Each result includes:
- The full engram (concept, content, tags, confidence, etc.)
- Final score (0-1)
- Per-phase score breakdown (`phaseScores`)
- Human-readable explanation (`why` string)
- All associations for the engram
- **Recall confidence** (v0.8.5) — score-distribution-aware signal in
  [0, 1] attached to every result. Same value on every result in the same
  recall — it describes the *set*, not the individual.
- **Summary** (v0.8.5, optional) — present when the caller passes
  `granularity: 'compact'` or `'auto'`. A confidence-adaptive truncation of
  the engram's content. The engram body is never modified.

### Recall confidence (v0.8.5)

Three orthogonal measures of the result distribution, blended via weighted
geometric mean (default weights 0.4 / 0.3 / 0.3):

| Measure | Formula | Meaning |
|---|---|---|
| Sharpness | `top1 / mean(top5)` mapped via `(s-1)/(s+1)` | Clear winner vs flat distribution |
| Cliff | `(top1 - top10) / top1` | Sharp drop-off vs gradual decay |
| Floor | `clamp(top1, 0, 1)` | "Best from a strong pool" vs "best of bad bunch" |

The HTTP route also surfaces the same value at the top level of the response
(useful for 0-result recalls, where the array is empty but you still want
to know whether the recall *would have* been confident).

Research grounding: Geifman & El-Yaniv (NeurIPS 2017), Roitero et al
(SIGIR 2022), Carmel & Yom-Tov (Synthesis Lectures, 2010).

### Opt-in confidence-based abstention (v0.8.5)

Pass `requireConfidence: <threshold>` on the activation query to make the
engine return `[]` when the distribution shape falls below the threshold.

| Threshold | Behavior |
|---|---|
| 0.10 | Strict — only abstain on clearly noisy queries |
| 0.25 | Balanced |
| 0.40 | Aggressive — only return high-confidence recalls |

Independent of the legacy `abstentionThreshold` (which is reranker-score
based, requires a reranker in the pipeline). Either gate trips abstains.

### Adaptive output granularity (v0.8.5)

Pass `granularity` to control how much content the engine surfaces:

| Value | Behavior |
|---|---|
| `'full'` (default) | No change — callers get the raw engram content. |
| `'compact'` | Every result carries a `summary` field truncated to ~200 chars (`AWM_GRANULARITY_COMPACT_LEN`). Engram body unchanged. |
| `'auto'` | Confidence-adaptive. When recall confidence ≥ `AWM_GRANULARITY_AUTO_THRESHOLD` (0.4), the top result gets a ~1000-char summary (`AWM_GRANULARITY_FULL_LEN`) and the rest are compact. When confidence is low, all results are compact. |

The MCP `memory_recall` tool surfaces `summary` to its text-rendered output
when set. Research grounding: Brill 2018 ACT-R collaboration.

### Requirements

- `agentId` and `context` are required
- Server must be running (ML models loaded for full quality)

### Limits

- Default `limit`: 10 results
- Default `minScore`: 0.01
- With ML models: ~200-300ms per query
- Without ML models: ~5-20ms per query

### Error States

- No memories for agent: returns empty array (not an error)
- ML model unavailable: degrades gracefully (text-only matching)
- All scores below threshold: returns empty array

### Side Effects

- Each returned memory's `accessCount` incremented
- `lastAccessed` timestamp updated
- Co-activated memory pairs recorded in Hebbian buffer
- Association weights strengthened between co-activated pairs
- Activation event logged (query, latency, result count)

## Code References

- HTTP handler: `src/api/routes.ts:116-134`
- MCP tool: `src/mcp.ts:126-172`
- Activation pipeline: `src/engine/activation.ts:80-279`
- Graph walk: `src/engine/activation.ts:281-311`
- Explain: `src/engine/activation.ts:330-343`
- Query expansion: `src/core/query-expander.ts:44`
- Reranker: `src/core/reranker.ts:47`
- BM25 search: `src/storage/sqlite.ts:228`
