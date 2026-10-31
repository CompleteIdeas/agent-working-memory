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

### Will AWM store my API keys?

Not by default. Write-time redaction is on: provider keys with a known shape, private keys, JWTs,
passwords in connection URLs, `Bearer` tokens and labelled values (`password=`, `API_KEY:`) are
masked before the write is stored, indexed, embedded or logged. The mask keeps the rule name and,
for long keys, the last four characters (`[REDACTED:stripe_key …0dWz]`), and the write response
says what was masked. Email addresses and phone numbers are reported but kept, unless you set
`AWM_REDACT_PII=mask`.

Two limits. Detection is shape-based, so a bare random string with no label is not caught. And
memories written before redaction shipped are not rewritten; `scripts/redact-scan.ts` scans a
store read-only to show what is there. See [redaction.md](redaction.md).

If you want the agent to be able to *use* a key later, the opt-in vault (`AWM_VAULT=on`) keeps
the value encrypted in a separate `vault.db`, with the key in your OS credential store. The memory
holds a handle, and `awm vault run` injects the value into commands you have allowed. No MCP tool
returns a value. See [vault.md](vault.md).

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
- `AWM_ABSTAIN_GATE=calibrated` is on and the recall fell in the withhold band. Over MCP this is
  reported as `RECALL ABSTAINED — this store most likely does not hold this`, never as a silent
  empty result. `require_confidence: 0` opens the gate for one call.
- All memories are in staging and `includeStaging` is false (default)

### How does AWM know it doesn't have something?

By default it does not try very hard. The shipped `require_confidence` gate (0.05) judges the
*shape* of one query's scores, and on a real 29,853-memory store it could not separate "stored"
from "never stored" at any threshold. With the default it withheld 0 of 10 adversarial probes.
An earlier "90.0% correct abstention" figure came from a strict, non-default setting on those 10
probes and has been withdrawn.

The opt-in calibrated gate (`AWM_ABSTAIN_GATE=calibrated`) listens to the cross-encoder instead,
which reads the question and the top memory together. It learns a noise floor from the store
itself: about 300 synthetic queries the store generates (answerable ones, and familiar-sounding
nonsense), with no labels. Fit it with `awm calibrate`; it is refitted after consolidation when it
goes stale. Each recall is then answered, answered with a `⚠ LOW SIGNAL` flag, or withheld.

Measured on that one store with keyword-style questions:
- it withholds 66 of 73 questions about facts never stored;
- it withholds 2 of 706 correct answers, and flags 3;
- of 200 absent questions asked in familiar vocabulary (the answer deleted, its neighbours
  kept), it withholds 98 and flags 28. That is the hard case.

On natural-language questions it is much less careful: it withholds 21 of 88 correct answers,
because its calibration probes are keyword-shaped. It has not been measured on other stores. See
[abstention.md](abstention.md).

### Is AWM's ranking better than keyword search?

Not on its own benchmark. On the real-store fixtures, plain BM25 puts the right memory first for
95.7% of identifier queries and 91.6% of topic queries, against AWM's 93.3% and 96.0%. The
fixtures are keyword-friendly by construction: each question is built around an identifier that
appears in exactly one memory, which is the case BM25 is best at.

Where AWM measurably differs is its lifecycle: supersession and retraction. The BM25 figures above
were measured on the pool AWM's lifecycle leaves retrievable. Run over the raw store, with
superseded and retracted memories still in it, BM25 falls to 87.7% / 79.8% and returns a superseded
memory first 8–15% of the time. Knowing which version of a fact is current is what AWM adds. A
plain retriever also cannot abstain: it always returns something. The baselines are in
`tests/realstore-eval/baselines.ts`.

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
3. Test manually: `node <path>/dist/mcp.js` (should wait for stdin). In a source checkout: `npx tsx src/mcp.ts`
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
