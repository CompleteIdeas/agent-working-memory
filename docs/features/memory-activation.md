# Feature: Activate (Recall) Memories

## When You'd Use It

When an agent needs context-aware recall — starting a new task, debugging a familiar issue, making a decision that relates to past experience, or returning to previous work.

## How It Works

### Steps (Happy Path)

1. Call `POST /memory/activate` (or MCP `memory_recall`) with a natural language context
2. The activation pipeline (`ActivationEngine.activate()` in `src/engine/activation.ts`; the phase
   numbers below are the code's own, and [architecture.md](../architecture.md#retrieval-pipeline)
   has the full table) runs:

   **Query shape**: `isNaturalQuery()` (`src/core/query-shape.ts`) classifies the query as a
   natural-language question or a keyword lookup. The shape routes the questions index, the
   cross-encoder and the final blend weight.

   **Phase 0 — Query expansion**: flan-t5-small. **Off by default since 0.22.1**
   (`AWM_DEFAULT_EXPANSION=1` or `use_expansion: true` turns it on).

   **Phase 1 — Embed query**: bge-small-en-v1.5, 384 dimensions.

   **Phase 2 — Candidates**: BM25 (FTS5) and vector top-K, in parallel. A natural-language query
   also searches the questions each memory carries (0.22, `withQuestions`); keyword lookups never
   read that index.

   **Phase 3 — Per-candidate scoring**: BM25, Jaccard, raw-cosine floor, ACT-R decay, Hebbian
   boost and the confidence gate, combined into a cheap `composite`; then the entity-bridge
   boost (3.7) and a graph walk over Hebbian + temporal edges (4–5).

   **Phase 6 — Shortlist and pool**: candidates are shortlisted by reciprocal-rank fusion of their
   BM25, vector and composite ranks (0.21.1), and the cross-encoder pool is `max(limit*4, 32)`
   (32 at the MCP default of 3 results).

   **Phase 7 — Cross-encoder**: every pooled candidate is scored by ms-marco-MiniLM (int8, the
   default since 0.19) for keyword queries, or by Ettin-17m for natural-language questions.

   **Phase 8 — Agreement gate**: when BM25, vector and cross-encoder disagree and nothing is
   semantically close, returns nothing. Superseded memories and memories outside their
   `valid_from`/`valid_to` window are down-ranked (×0.15).

   **Phase 9 — Final order**: a blend of the cross-encoder with the fused BM25 + vector rank, with
   the weight set by query shape (keyword 0.95; natural 0.7 by rank with Ettin, 0.5 when half
   the pool carries questions, else 0.85). Then the 0.22.4 first-place rule
   (`src/core/blend-rule.ts`): a sure cross-encoder (top-two logit margin ≥ 1 keyword, ≥ 1.5
   natural) puts its own #1 first; otherwise a keyword query re-blends first place with the
   vector rank weighted 0.25, unless both channels rank it in their top two. Places 2+ keep the
   blend's order.

   **Calibrated gate (opt-in)**: with `AWM_ABSTAIN_GATE=calibrated`, a store-fitted model reads
   the blend's order and answers, flags `⚠ LOW SIGNAL`, or withholds with `RECALL ABSTAINED`
   ([abstention.md](../abstention.md)).

   **Results**: the top `limit` memories with per-phase explanations.

3. Side effects: access counts updated, Hebbian weights strengthened, activation event logged

### Session scope (0.20, MCP)

`memory_recall` takes `scope: "session"` to return only memories this session wrote (filtered on
`writer_session` before the cross-encoder), and `session_first: true` to put this session's own
memories ahead of older ones without changing membership or scores. The HTTP route does not take
these options.

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

- Default `limit`: 10 results on HTTP and in the engine; 3 on MCP `memory_recall`
- Default `minScore`: 0.01 on HTTP and in the engine; 0.05 on MCP
- Warm recall with every model on: p50 287–304 ms on the 30,000-memory benchmark store
  ([benchmarks-current.md](../benchmarks-current.md)); smaller stores are faster. The first
  recall in a session can take seconds while models load. The cross-encoder is ~83% of warm
  recall time.

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

- HTTP handler: `POST /memory/activate` in `src/api/routes.ts`
- MCP tool: `memory_recall` in `src/mcp.ts`
- Activation pipeline: `ActivationEngine.activate()` in `src/engine/activation.ts`
- Graph walk: `graphWalk()` / `spreadActivation()` in `src/engine/activation.ts`
- Explain: `explain()` in `src/engine/activation.ts`
- Query shape: `isNaturalQuery()` in `src/core/query-shape.ts`
- Rerankers: `rerank()` in `src/core/reranker.ts`
- Final blend: phase 9b in `src/engine/activation.ts`; first-place rule in `src/core/blend-rule.ts`; rerank2 fallback in `src/core/rerank2.ts`
- Calibrated gate: `classify()` in `src/engine/abstention-gate.ts`
- Recall confidence: `computeRecallConfidence()` in `src/engine/confidence.ts`
- Query expansion: `expandQuery()` in `src/core/query-expander.ts`
- BM25 search: `searchBM25WithRank()` in `src/storage/sqlite.ts`
