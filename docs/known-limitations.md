# Known Limitations

## Architecture

### Consolidation is basic
The consolidation engine clusters similar memories by cosine similarity and creates summary bridge nodes. However, it doesn't use LLM-powered summarization — summaries are concatenations, not semantic merges.
- **Code reference:** `src/engine/consolidation.ts`

### Single-writer database
SQLite supports only one writer process. Running the HTTP server and MCP server against the same `memory.db` file simultaneously will cause locking issues. The MCP server creates its own in-process store.
- **Workaround:** Use separate DB paths, or use only one interface at a time.

### No authentication or access control
All endpoints are unauthenticated. Agent isolation is by convention (`agentId` parameter), not enforced at the API level. Any caller can read/write any agent's memories.
- **Code reference:** `src/api/routes.ts` — no auth middleware.

## Retrieval Quality

### Multi-hop reasoning is weak
The LOCOMO benchmark shows 15.4% composite on multi-hop queries (questions requiring evidence from multiple dialogue turns). The activation pipeline retrieves individual memories well but doesn't chain evidence.
- **Evidence:** LOCOMO eval category 1 (Multi-hop) scores.

### Salience filter tuned for coding, not conversation
The salience heuristics were designed for coding assistant memories (decisions, bugs, architecture). Conversational content (personal facts, daily events) often scores too low and lands in staging or gets discarded.
- **Evidence:** LOCOMO seeding: 47% of dialogue turns land in staging.
- **Code reference:** `src/core/salience.ts` — event type weights favor `decision`, `causal`, `friction`.

### No cross-agent memory
Memories are strictly isolated by `agentId`. There's no mechanism for shared knowledge bases or cross-agent learning.

## Performance

### First query is slow
The three ML models (~124MB total) load on first use. First activation query takes 3-10 seconds depending on hardware. Subsequent queries: ~200-300ms with ML, ~5-20ms without.
- **Workaround:** Models are pre-loaded on server start (`src/index.ts`), but still take a few seconds.

### Large memory stores not tested at scale
The system is tested with up to ~300 memories (real-world eval). Performance with 5,000+ active memories and dense association graphs is untested.
- **Config:** `maxActiveEngrams: 10,000` — the cap exists but hasn't been stress-tested.

### No batch embedding
Memories are embedded one at a time via async fire-and-forget on write. There's no batch embedding endpoint for bulk imports.
- **Code reference:** `embedBatch()` exists in `src/core/embeddings.ts` but is not wired to any API endpoint.

## Data

### No backup/restore mechanism
No built-in export/import for memory databases. The SQLite file can be copied manually.

### No migration system
Schema changes require manual database recreation. There's no versioned migration system.

### Embedding dimension is fixed
The system uses 384-dimensional embeddings (all-MiniLM-L6-v2). Switching to a different embedding model requires re-embedding all existing memories.

## Eval

### Discard regret not tracked
The eval engine defines `discardRegret` as a metric but it's marked TODO. There's no way to know if a discarded memory would have been useful later.
- **Code reference:** `src/engine/eval.ts` — `discardRegret` field exists but always returns 0.

### Stale usage count not tracked
The `staleUsageCount` metric (memories activated but not recently useful) is defined but not implemented.
- **Code reference:** `src/engine/eval.ts` — `staleUsageCount` field exists but always returns 0.
