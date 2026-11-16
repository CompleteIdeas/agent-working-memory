# FAQ

## General

### What's the difference between activation and search?

**Activation** (`/memory/activate`) is cognitive retrieval — it combines text relevance, vector similarity, temporal decay, Hebbian associations, and graph walking to find contextually relevant memories. It also has side effects: touching memories (increasing access count), updating Hebbian weights, and logging metrics.

**Search** (`/memory/search`) is deterministic SQL-based retrieval — exact text matching, tag filtering, stage filtering. No side effects, no scoring pipeline. Use it for debugging and inspection.

### Why is my memory not being recalled?

The salience filter may have scored it below 0.2. Such a write is kept, but at low confidence
(0.25, tagged `low-salience`), so it rarely ranks. This happens when:
- `eventType` is `"observation"` (no bonus)
- `surprise`, `causalDepth`, and `resolutionEffort` are all low
- `decisionMade` is false

To ensure storage, use `eventType: "decision"` or `"causal"` with higher feature scores. See [Salience Scoring Formula](reference.md#salience-scoring-formula).

### Why is my memory in staging instead of active?

Its salience score was between 0.2 and 0.4. Staging memories are promoted to active if they resonate with existing knowledge (checked on each staging sweep, every 24 hours, and during consolidation), or discarded after 24 hours if they don't.

### How long do memories last?

Active memories persist indefinitely but their retrieval priority decays over time (ACT-R model). Frequently accessed memories stay strong. Unused memories become harder to retrieve but are never automatically deleted unless capacity limits are hit (default: 10,000 active memories).

### Are there any external API calls?

No calls with your data. Every model runs locally via ONNX: the embedder, the MiniLM cross-encoder
for keyword-shaped queries, Ettin-17m for natural-language questions (0.22) and, only when expansion is turned on, the query
expander.
The models are downloaded once, on first use (Ettin is a 17 MB int8 file); after that nothing
leaves your machine. `AWM_RERANKER_MODEL_NATURAL=off` skips Ettin and uses MiniLM for everything.

AWM never calls a hosted model. When a host *has* its own model, it can offer to write the
questions memories answer (see below); that runs in the host, not in AWM.

### What are memory "questions"? (0.22)

`memory_write` takes up to five `questions`: how someone would ask for this memory later, in their
own words ("when does the fall fee go up?"). They go into a second keyword index that only
natural-language recall reads, so they can't disturb identifier or topic lookups. On the real-store
benchmark, natural-language first place rises from 48.5% to 53.1% when memories carry questions
(0.22.4; 47.9% to 52.6% when the feature shipped in 0.22.0);
identifier and topic were unchanged.

Older memories have none. A host with a model can fill them in: pass `capabilities: ["questions"]`
on `memory_restore`, and AWM hands back a small batch of memories that lack questions; the host
answers with `memory_set_questions`. Re-running `awm setup --global` installs guidance that tells
Claude Code to do this.

### Can AWM learn a project I already have? (0.22.2)

Yes: type `/awm-learn` in Claude Code. The skill plans the run with a model-free ledger, shows the
token price before reading anything, and asks what to leave out. It then writes map memories
first, then up to eight memories per part of the project, and tests its own recall at the end. It
works on code, manuscripts, docs trees and data folders. Running it again refreshes only what
changed. `awm setup` installs it, and the plugin ships it. The first measured run and its limits
are in [awm-learn.md](awm-learn.md).

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
- High `graphBoost` — the memory is connected to high-scoring neighbors. Graph boost is capped at 0.25 per engram.
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

Measured on that one store with keyword-style questions (0.22.4):
- it withholds 50 of 73 questions about facts never stored;
- it withholds 1 of 718 correct answers;
- of 200 absent questions asked in familiar vocabulary (the answer deleted, its neighbours
  kept), it withholds 95. That is the hard case.

Natural-language questions get a model of their own once at least a quarter of the store's
memories carry questions, because it practises on them. It withholds 3 of 103 correct natural
answers (24% in 0.21, about 3% now), and in exchange answers 88 of 97 natural questions
whose fact was deleted — a deliberate choice to lose fewer real answers. Below that quarter, one
keyword-shaped model judges everything, as in 0.21. It has not been measured on other stores. See
[abstention.md](abstention.md) and
[abstention-signals-2026-10-30.md §14](abstention-signals-2026-10-30.md).

### Is AWM's ranking better than keyword search?

It depends on how the question is asked. On the real-store keyword fixtures, plain BM25 puts the
right memory first for 95.7% of identifier queries and 91.6% of topic queries, against AWM's 95.0%
and 96.2%. Those fixtures are keyword-friendly by construction: each question is built around an
identifier that appears in exactly one memory, which is the case BM25 is best at.

On natural-language questions — 194 of them, written the way a person asks and vetted so they
can't lean on rare words in the store — AWM puts the right memory first for 48.5%, against 42.8%
for BM25 and 45.4% for fused BM25 + vector search. With questions stored on the memories (0.22)
AWM reaches 53.1%. Those are the hard questions, and the gap to the keyword fixtures is real.

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

On the 30,000-memory benchmark store, with every model on, a warm recall takes 287–304 ms at the
median and under 0.4 s at p90 ([benchmarks-current.md](benchmarks-current.md)). Smaller stores
are faster. With ML disabled (`useReranker: false, useExpansion: false`): ~5-20 ms per query.

The first query after server start is slower while models load, and the very first
natural-language question on a new install downloads Ettin (about 2 s once).

### Does AWM actually save tokens?

Measured on real work, yes — with a caveat about sample size. The same agent, model and tools
worked four real support tickets with and without AWM:

| | with AWM | without |
|---|---|---|
| File and database lookups | 49 | 100 |
| Database queries | 47 | 79 |
| Output tokens | 73.7k | 99.0k |
| Facts the real answer needed, found (of 28) | 16 | 7 |

So 26% fewer output tokens while finding more than twice as many of the facts. On one ticket the
memoryless arm ran out of budget and answered nothing; leaving it out, AWM still meant 16% fewer
tokens, 40% fewer lookups and 22 points more of the facts found. Four tickets is directional, not
a rate ([claims.md §5](claims.md)).

AWM does cost tokens of its own: recall results, primed context and the rules in your
instructions file all ride along in context. A usage study of one heavy user put that at roughly
3–5% of Claude Code spend. Counting how often the agent still searched after a recall made it look
like a net cost — but that measures a level, not a difference; it says nothing about how much more
the agent would have searched without memory. Only the with/without comparison answers that, and
it came out in AWM's favour.

### How much disk space does the database use?

Roughly 1-2KB per memory (including FTS index). 10,000 memories = ~15-20MB. Embeddings add ~1.5KB each (384 floats * 4 bytes). With embeddings: ~30-35MB for 10,000 memories.

### Can I use a different database path?

Yes: `AWM_DB_PATH=/path/to/your/memory.db npx tsx src/index.ts`

## MCP Integration

### The MCP server isn't showing up in Claude Code

1. Run `awm doctor claude-code` — it reports what is wired and what needs a re-run of setup
2. Check the server entry: `~/.mcp.json` for a global install, `.claude/mcp.json` for a project install
3. Re-run `awm setup --global`
4. Restart Claude Code and check `/mcp`
5. Source checkout only: `npx tsx src/mcp.ts` should wait for stdin, and `npm run test:mcp` checks the protocol

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
