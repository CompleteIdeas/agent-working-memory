# FAQ

## General

### What's the difference between activation and search?

**Activation** (`/memory/activate`) is cognitive retrieval — it combines text relevance, vector similarity, temporal decay, Hebbian associations, and graph walking to find contextually relevant memories. It also has side effects: touching memories (increasing access count), updating Hebbian weights, and logging metrics.

**Search** (`/memory/search`) is deterministic SQL-based retrieval — exact text matching, tag filtering, stage filtering. No side effects, no scoring pipeline. Use it for debugging and inspection.

### Why was my memory discarded?

The salience filter scored it below 0.2. This happens when:
- `eventType` is `"observation"` (no bonus)
- `surprise`, `causalDepth`, and `resolutionEffort` are all low
- `decisionMade` is false

To ensure storage, use `eventType: "decision"` or `"causal"` with higher feature scores. See [Salience Scoring Formula](reference.md#salience-scoring-formula).

### Why is my memory in staging instead of active?

Its salience score was between 0.2 and 0.4. Staging memories are promoted to active if they resonate with existing knowledge (tested every 60 seconds), or discarded after 24 hours if they don't.

### How long do memories last?

Active memories persist indefinitely but their retrieval priority decays over time (ACT-R model). Frequently accessed memories stay strong. Unused memories become harder to retrieve but are never automatically deleted unless capacity limits are hit (default: 10,000 active memories).

### Are there any external API calls?

No. All three ML models (embeddings, reranker, query expander) run locally via ONNX. No data leaves your machine.

## Activation & Retrieval

### Why did an irrelevant memory rank highly?

Check the `phaseScores` in the result:
- High `hebbianBoost` — the memory was frequently co-activated with relevant memories. Hebbian boost is capped at 0.5.
- High `graphBoost` — the memory is connected to high-scoring neighbors. Graph boost is capped at 0.2 per engram.
- High `rerankerScore` — the cross-encoder thinks it's relevant. This usually indicates genuine semantic overlap.

### Why did activation return no results?

Possible causes:
- No memories stored for the `agentId`
- All memories scored below `minScore` (default 0.01)
- `abstentionThreshold` is set and the reranker scored everything below it
- All memories are in staging and `includeStaging` is false (default)

### What does the `why` string mean?

Example: `composite=0.820 | text=0.75 | vector=0.68 | decay=1.20 | hebbian=0.15 | graph=0.05 | reranker=0.88 | conf=0.80 | access=3 | edges=5`

- `composite` — pre-reranker combined score
- `text` — best of BM25 and Jaccard keyword matching
- `vector` — cosine similarity from embeddings
- `decay` — ACT-R activation (higher = more recent/accessed)
- `hebbian` — average association weight with co-activated memories
- `graph` — boost from connected high-scoring neighbors
- `reranker` — cross-encoder relevance score
- `conf` — confidence multiplier (affected by feedback)
- `access` — how many times this memory has been retrieved
- `edges` — number of associations

## Performance

### How fast is activation?

With all ML models enabled (reranker + expansion): ~200-300ms per query.
With ML disabled (`useReranker: false, useExpansion: false`): ~5-20ms per query.

The first query after server start is slower while models warm up.

### How much disk space does the database use?

Roughly 1-2KB per memory (including FTS index). 10,000 memories = ~15-20MB. Embeddings add ~1.5KB each (384 floats * 4 bytes). With embeddings: ~30-35MB for 10,000 memories.

### Can I use a different database path?

Yes: `AWM_DB_PATH=/path/to/your/memory.db npx tsx src/index.ts`

## MCP Integration

### The MCP server isn't showing up in Claude Code

1. Check that `.mcp.json` exists in the project root
2. Verify `npx tsx` works: `npx tsx --version`
3. Test manually: `npx tsx src/mcp.ts` (should wait for stdin)
4. Run `npm run test:mcp` to verify the protocol works
5. Restart Claude Code and check `/mcp`

### Can I use a different agent ID for MCP?

Yes: set `AWM_AGENT_ID` in `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-working-memory": {
      "env": { "AWM_AGENT_ID": "my-custom-agent" }
    }
  }
}
```
