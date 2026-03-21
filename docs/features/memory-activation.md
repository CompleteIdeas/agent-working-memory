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
