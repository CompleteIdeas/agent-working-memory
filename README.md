# AgentWorkingMemory (AWM)

**Persistent working memory for AI agents.**

AWM helps agents retain important project knowledge across conversations and sessions. Instead of storing everything and retrieving by similarity alone, it filters for salience, builds associative links between related memories, and periodically consolidates useful knowledge while letting noise fade.

Use it through Claude Code via MCP or as a local HTTP service for custom agents. Everything runs locally: SQLite + ONNX models + Node.js. No cloud, no API keys.

### Without AWM
- Agent forgets earlier architecture decision
- Suggests Redux after project standardized on Zustand
- Repeats discussion already settled three days ago
- Every new conversation starts from scratch

### With AWM
- Recalls prior state-management decision and rationale
- Surfaces related implementation patterns from past sessions
- Continues work without re-asking for context
- Gets more consistent the longer you use it

---

## Quick Start

**Node.js 22 LTS+** required — check with `node --version`. (Node 20 reached EOL 2026-04-30; AWM 0.8.6+ requires 22.)

```bash
npm install -g agent-working-memory
awm setup --global
```

Restart Claude Code. That's it — 19 tools appear automatically (17 memory + 2 onboarding).

### Upgrading

```bash
npm install -g agent-working-memory@latest
awm setup --global          # Updates MCP config, CLAUDE.md instructions, and hooks
```

Restart Claude Code after upgrading. Your existing memory database is preserved — all upgrades are backward compatible. New features (metadata tags, workspace recall, synthesis) are opt-in.

> **From v0.6.x → v0.7.x:** The `memory_write` tool now accepts optional metadata parameters (`project`, `topic`, `session_id`, etc.) that improve recall quality. Re-running `awm setup --global` updates your CLAUDE.md with instructions for the agent to use them.

First conversation will be ~30 seconds slower while ML models download (~200MB total, cached locally). After that, everything runs on your machine.

> For isolated memory per folder, see [Separate Memory Pools](#separate-memory-pools). For team onboarding, see [docs/quickstart.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/quickstart.md).

> **Starting on an existing project?** Warm-start the store from its own docs so recall is
> useful immediately: `awm onboard ./docs --repo . --project <name>` → review the pack →
> `awm import <pack> --db <path> --dedupe`. See [What's New in v0.11.0](#whats-new-in-v0110).

---

## Who this is for

- **Long-running coding agents** that need cross-session project knowledge
- **Multi-agent workflows** where specialized agents share a common memory
- **Local-first setups** where cloud memory is not acceptable
- **Teams using Claude Code** who want persistent context without manual notes

## What this is not

- Not a chatbot UI
- Not a hosted SaaS
- Not a generic vector database
- Not a replacement for your source of truth (code, docs, tickets)

---

## Why it's different

> **New to the vocabulary?** Terms like *engram, salience, activation, Hebbian, staging*
> are defined plainly, one paragraph each, in
> [`docs/onboarding-vocabulary.md`](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/onboarding-vocabulary.md) — a 5-minute read if any of the table below is unfamiliar.

Most "memory for AI" projects are vector databases with a retrieval wrapper. AWM goes further:

| | Typical RAG / Vector Store | AWM |
|---|---|---|
| **Storage** | Everything | Salience-filtered with low-confidence fallback (novel events go active, borderline enter staging, low-salience stored at reduced confidence) |
| **Retrieval** | Cosine similarity | 10-phase pipeline: dual BM25 (keyword + expanded) + vectors + reranking + graph walk + decay + coref expansion |
| **Named things** | Vocabulary-dependent — misses if the query doesn't lexically match | Entity inverted index: exact lookup on named entities ("ticket 19252", a person's name), immune to phrasing mismatch |
| **Connections** | None | Hebbian edges that strengthen when memories co-activate |
| **Over time** | Grows forever, gets noisier | Consolidation: diameter-enforced clustering, cross-topic bridges, synaptic-tagged decay |
| **Forgetting** | Manual cleanup | Cognitive forgetting: unused memories fade, reinforced knowledge persists (access-count modulated) |
| **Feedback** | None | Useful/not-useful signals tune confidence and retrieval rank |
| **Correction** | Delete and re-insert | Retraction: wrong memories invalidated, corrections linked, penalties propagate (depth 2, decaying) |
| **Graph** | None or single graph | Multi-graph: semantic, temporal, causal, entity — independent traversal with fused scoring |
| **Learning** | Unconditional co-activation | Validation-gated: edges strengthen only on positive feedback (Kairos-inspired) |
| **Noise rejection** | None | Multi-channel agreement gate: requires 2+ retrieval channels to agree before returning results |
| **Duplicates** | Stored repeatedly | Reinforce-on-duplicate: near-exact matches boost existing memory instead of creating copies |

The design is based on cognitive science — ACT-R activation decay, Hebbian learning, complementary learning systems, synaptic homeostasis, and synaptic tagging — rather than ad-hoc heuristics. See [How It Works](#how-it-works) and [docs/cognitive-model.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/cognitive-model.md) for details.

> **New to AWM?** [`docs/pipeline-walkthrough.html`](https://completeideas.github.io/agent-working-memory/pipeline-walkthrough.html) is a visual, plain-language walkthrough (no background required) — what happens when AWM learns and recalls a fact, why it's built this way, and how it differs from a plain vector store. Open it in a browser.

> **Build an agent on it:** the [AWM-Native Agent Harness pattern](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/patterns/awm-native-harness.md) shows how to use AWM as an always-on cognitive *substrate* (not a tool the model calls) so the agent learns automatically by working — letting a cheap model perform at a high level and get cheaper + better over time. Measured: gpt-5.4-mini + AWM beat a frontier model on a domain workload at ~1/40th the cost.

> **For builders & researchers:** [`docs/awm-for-agents.html`](https://completeideas.github.io/agent-working-memory/awm-for-agents.html) is the agent playbook — why AWM exists (the context-window wall), the PRIME→ACT→VERIFY→LEARN harness, the full agent feature surface (workspace, session IDs, bearer-token hooks, supersede/feedback), how multi-hop is solved in the harness, and the honest gauntlet findings (where AWM wins, ties, and what isn't measured yet). Open it in a browser.

---

## Why it matters at scale

The reason AWM exists: **past roughly half a million tokens, you can no longer keep a large project's context alive by carrying it.** The codebase, the docs, the decision history, and the meeting/work transcripts outgrow every model's window — and summarizing to fit silently drops the fact you needed next.

These figures come from real-world use on a large software platform project, where a single work agent has accumulated **20,000+ memories** over a multi-million-token codebase and documentation set:

| To answer one question, carry… | tokens | AWM scoped recall |
|---|---|---|
| the accumulated memory (~20K memories) | ~1.3M | **~630, flat** |
| the project's notes & transcript docs | ~2M | **~630, flat** |
| the whole system (code + docs) | ~29M — fits in no window, any tier | **~630, flat** |

A scoped recall answers from the relevant *slice*, independent of how large the store grows. Measured consequences on real questions against the real project:

- **~2,000× fewer tokens per query** than carrying the memory store — and **~5× fewer** than opening the single best-matching documentation file (a floor; agents usually open several and still miss cross-file facts).
- **At scale, "carry everything" isn't an option.** At ~20K memories no context window holds it, so retrieval is not an optimization — it is the only door. A static notes file or long-context approach is forced to truncate, which silently drops facts.

Two structural advantages a file or a flat vector store cannot match:

- **Staleness is tracked.** When a fact changes, `memory_supersede` retires the old value and recall stops returning it — the system *knows* what changed. A notes file or repo goes stale silently; you would re-scan everything to find out. (This work agent has superseded and retracted dozens of facts as the project moved.)
- **Dead weight costs nothing.** ~90% of accumulated memories are never recalled for a given task — a notes file pays for all of them in every prompt; recall pays for ≈zero.

### Honest about the trade-offs

- AWM does **not** win on small, one-shot tasks — write/recall overhead exceeds the savings until knowledge is reused or the corpus grows past what fits in context.
- Recall is not free: a few seconds of latency per query buys the token reduction.
- Recall accuracy is bounded by what was written — write quality matters (lead with the fact; tag with identifiers like file, table, ticket).
- It does not replace your source of truth. The intended pattern is: **recall first, read/grep the code for ground truth on a miss, and supersede when reality differs.**

---

## Benchmarks

Two kinds of tests, both reproducible (see [Testing & Evaluation](#testing--evaluation)).
First, **recall quality** — does the pipeline return the right memory? Second,
**behavior under stress** — does it stay honest, filter noise, and hold up as the
store grows and ages? Numbers below were last re-run on the 0.9-staged line
(2026-06-17) — the retrieval pipeline itself is unchanged since, but re-run these
yourself (`npm run eval`) if you want current-build numbers; 0.12.x added
reliability/telemetry/entity-index work on top, not retrieval-scoring changes.
See [`docs/gauntlet-baseline-2026-07-30.md`](docs/gauntlet-baseline-2026-07-30.md)
for the newer end-to-end memory-ablation acceptance test (74%±5pp memory-dependent
vs 0% no-memory control).

### 1 · Recall quality (eval harness)

Each suite has a pass threshold; all four pass.

| Suite | Score | Threshold | What it measures |
|-------|-------|-----------|------------------|
| Retrieval | **Recall@5 = 0.980** | ≥ 0.80 | 200 facts, 50 queries — does the BM25 + vector + reranker pipeline surface the right fact in the top 5? |
| Associative | **success@10 = 1.000** | ≥ 0.70 | 20 multi-hop causal chains — does the graph walk find non-obvious connections? |
| Redundancy | **dedup F1 = 0.966** | ≥ 0.80 | 50 clusters × 4 paraphrases — does consolidation merge duplicates without losing the original? |
| Temporal | **Spearman = 0.932** | ≥ 0.75 | 25 facts with controlled age/access — does ACT-R decay rank recent/used memories ahead of stale ones? |

### 2 · Behavior under stress & adversarial conditions

These are graded suites (not pass/fail). The headline risk they guard against is a
memory system that confidently returns the *wrong* thing — so the weakest area is
called out, not hidden.

| Suite | Score | What it measures |
|-------|-------|------------------|
| `test:run` (unit) | **569 / 569** | Salience, decay, Hebbian, supersession, coordination, scheduler |
| `test:self` | **93.9% (EXCELLENT)** | Every cognitive subsystem end-to-end; weakest = exact-topic retrieval |
| `test:workday` | **85.4% (GOOD)** | A realistic mixed day — 43 memories across 4 projects, cross-cutting queries; weakest = noise filtering |
| `test:edge` | **~32 / 34** | Named failure modes: identity collision, contradiction trapping, bridge overshoot, false generalization |
| `test:ab` | **AWM 10 / 11 vs keyword baseline 8 / 11** | Where the cognitive pipeline beats plain keyword search |
| `test:pilot` | **14 / 15** (5/5 noise rejected) | Production-like queries that must reject planted distractors |
| `test:locomo` | **25.7%** | LoCoMo conversational-memory benchmark (a *chatbot* benchmark — see note) |
| `test:mcp` | **5 / 5** | MCP protocol smoke: write, recall, feedback, retract, stats |

> **On LoCoMo (25.7%):** LoCoMo measures *chatbot* recall ("what did we say about X"
> across long conversations). It is not the workload AWM is tuned for (productivity /
> engineering, staying on topic, rejecting noise), and ~66% of AWM's misses there are
> retriever-coverage (the gold turn isn't in the top-10), not extraction. The 0.9 recall
> work lifted it from 22.7% with every category up. We report it for comparability, not
> as the headline.

### 3 · The sleep cycle (consolidation)

The **sleep cycle** is AWM's offline maintenance pass (the term is borrowed from how
human memory consolidates during sleep). On each cycle it **clusters** related
memories, builds **cross-topic bridges**, **strengthens** co-used edges, **decays**
unused ones, and **prunes** duplicates. You run it so the association graph stays
*healthy and navigable* as the store grows — without it, edges accumulate into noise.

> **Reading the score:** `test:sleep` = **78.6%** is a *consolidation-quality* score —
> it asks "after the maintenance pass, is recall at least as good and is the structure
> better?" **It is not recall falling to 78.6%.** In this fixture recall is held flat
> across three cycles (78.6% before = 78.6% after) while the graph reorganizes. The
> scaling picture is the real proof:

| Under a 100-cycle stress run | Observed |
|---|---|
| Recall across cycles | **holds 90–100%** (no catastrophic forgetting) |
| Cross-topic recall | **~80%**, stable |
| Graph self-pruning | edges grow to ~2,300 then prune back to ~1,500 as unused links decay |
| Clusters / bridges per cycle | ~10 clusters, bridges formed early then settle |

So consolidation *protects* recall over the long run — the per-cycle score measures the
health of the maintenance, and the stress run shows recall doesn't degrade.

### 4 · Token economics — honest

The win that matters is **structural**: at the scale AWM targets you can't carry the
project at all (see [Why it matters at scale](#why-it-matters-at-scale)). On real coding
sessions, scoped recall costs **9.8× less in aggregate** than the Read/Grep/Glob
rediscovery it replaces (`scripts/measure-claude-vs-awm.ts`).

The per-turn micro-benchmark (`test:tokens`) reports against **two** baselines, because the
baseline you pick *is* the result:

- **vs carrying the full history** (what a memoryless agent must actually do — it can't know
  which past turn matters): **+67% savings at 97.5% recall accuracy.** This is the honest,
  apples-to-apples number.
- **vs an oracle that pre-scoped context to the exactly-relevant task**: **≈ −13%.** A
  deliberately brutal bar — it gives the baseline the very scoping that retrieval exists to do —
  and on a tiny 6–8-turn task a fixed top-5 recall is break-even-to-negative *by construction*.

An earlier build reported ~56% on the oracle bar, but that was an **artifact**: pre-v0.8.5,
reinforce-on-duplicate silently *discarded* memory content, so recalls were artificially tiny.
v0.8.5 fixed the data loss (accuracy ~72% → 97.5%); better recall now fills all five slots,
which *lowers* the oracle-bar number while *raising* correctness. Net: the at-scale structural
win above is the real story; the oracle bar shows AWM roughly matches perfect manual scoping
even on a corpus far too small to play to its strengths.

---

## Features

### Memory Tools (17 + 2 onboarding = 19)

| Tool | Purpose |
|------|---------|
| `memory_write` | Store a memory (salience filter + reinforce-on-duplicate) |
| `memory_recall` | Retrieve relevant memories by context (dual BM25 + coref expansion) |
| `memory_feedback` | Report whether a recalled memory was useful |
| `memory_retract` | Invalidate a wrong memory with optional correction |
| `memory_supersede` | Replace outdated memory with current version |
| `memory_stats` | View memory health metrics and activity |
| `memory_whoami` | Identify the instance — agent id, workspace, backend, store path, sibling agent spaces |
| `memory_checkpoint` | Save execution state (survives context compaction) |
| `memory_restore` | Recover state + relevant context at session start |
| `memory_task_add` | Create a prioritized task |
| `memory_task_update` | Change task status/priority |
| `memory_task_list` | List tasks by status |
| `memory_task_next` | Get the highest-priority actionable task |
| `memory_task_begin` | Start a task — auto-checkpoints and recalls context |
| `memory_task_end` | End a task — writes summary and checkpoints |
| `compress_output` | Encode a structured tool output as TOON — ~50-65% fewer tokens, lossless, output-only |
| `retrieve_original` | Get the verbatim source back for a `compress_output` ref |

### Onboarding Tools (2)

For warm-starting a cold store from a project's own docs/repo — see [What's New in v0.11.0](#whats-new-in-v0110).

| Tool | Purpose |
|------|---------|
| `onboard_scan` | Extract candidate memories from a project's docs/repo for review |
| `onboard_questions` | Anchored interview questions to refine what a cold store should know |

### Separate Memory Pools

By default, all projects share one memory pool. For isolated pools per folder, place a `.mcp.json` in each parent folder with a different `AWM_AGENT_ID`:

```
C:\Users\you\work\.mcp.json          -> AWM_AGENT_ID: "work"
C:\Users\you\personal\.mcp.json      -> AWM_AGENT_ID: "personal"
```

Claude Code uses the closest `.mcp.json` ancestor. Same database, isolation by agent ID.

### Incognito Mode

```bash
AWM_INCOGNITO=1 claude
```

Registers zero tools — Claude doesn't see memory at all. All other tools and MCP servers work normally.

### Auto-Checkpoint Hooks

Installed by `awm setup --global`:

- **Stop** — reminds Claude to write/recall after each response
- **PreCompact** — auto-checkpoints before context compression
- **SessionEnd** — auto-checkpoints and consolidates on close
- **15-min timer** — silent auto-checkpoint while session is active

### Auto-Backup

The HTTP server automatically copies the database to a `backups/` directory on startup with a timestamp. Cheap insurance against data loss.

### Activity Log

```bash
tail -f "$(npm root -g)/agent-working-memory/data/awm.log"
```

Real-time: writes, recalls, reinforcements, checkpoints, consolidation, hook events.

### Activity Stats

```bash
curl http://127.0.0.1:8401/stats
```

Returns daily counts: `{"writes": 8, "recalls": 9, "hooks": 3, "total": 25}`

---

## Memory Invocation Strategy

AWM combines deterministic hooks for guaranteed memory operations at lifecycle transitions with agent-directed usage during active work.

### Deterministic triggers (always happen)

| Event | Action |
|-------|--------|
| Session start | `memory_restore` — recover state + recall context |
| Pre-compaction | Auto-checkpoint via hook sidecar |
| Session end | Auto-checkpoint + full consolidation |
| Every 15 min | Silent auto-checkpoint (if active) |
| Task start | `memory_task_begin` — checkpoint + recall |
| Task end | `memory_task_end` — summary + checkpoint |

### Agent-directed triggers (when these situations occur)

**Write memory when:**
- A project decision is made or changed
- A root cause is discovered
- A reusable implementation pattern is established
- A preference, constraint, or requirement is clarified
- A prior assumption is found to be wrong

**Recall memory when:**
- Starting work on a new task or subsystem
- Re-entering code you haven't touched recently
- After context compaction
- After a failed attempt (check if there's prior knowledge)
- Before refactoring or making architectural changes

**Retract when:**
- A stored memory turns out to be wrong or outdated

**Feedback when:**
- A recalled memory was used (useful) or irrelevant (not useful)

---

## HTTP API

For custom agents, scripts, or non-Claude-Code workflows:

```bash
awm serve                    # From npm install
npx tsx src/index.ts         # From source
```

Write a memory:

```bash
curl -X POST http://localhost:8400/memory/write \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "concept": "Express error handling",
    "content": "Use centralized error middleware as the last app.use()",
    "eventType": "causal",
    "surprise": 0.5,
    "causalDepth": 0.7
  }'
```

Recall:

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "How should I handle errors in my Express API?"
  }'
```

### Substrate primitives (new in 0.8)

For long-running structured projects — novels, codebases, investigations,
design docs — where the agent needs to track typed state across hundreds
of writes without polluting cognitive retrieval. Full reference at
[`docs/reference.md`](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/reference.md).

```bash
# "Latest emotional state per character" — one round trip
curl -X POST http://localhost:8400/memory/latest-by-tag -d '{
  "agentId": "novel-x", "tagKey": "character=",
  "scopeTagsAll": ["topic=emotional-state"], "sortBy": "sequence"
}'

# "Top 40 active promises by weight, excluding resolved" — filter + sort native
curl -X POST http://localhost:8400/memory/top-by -d '{
  "agentId": "novel-x", "sortField": "weight=", "order": "desc",
  "filterTagsAll": ["topic=promise", "state=active"],
  "filterTagsNone": ["kind=advancement"], "limit": 40
}'

# Atomic write-and-supersede by concept match (Form B)
curl -X POST http://localhost:8400/memory/supersede -d '{
  "agentId": "novel-x",
  "matchConcept": "Mara's deferred disclosure",
  "newEngram": {
    "concept": "Mara's disclosure — RESOLVED in Ch 3",
    "content": "...", "memory_class": "structural"
  }
}'

# Race-free chronology
curl http://localhost:8400/memory/sequence/novel-x/next
```

New `memory_class: "structural"` keeps high-volume system-written records
(chapter analyses, promise advancements, commit logs) out of cognitive
`/activate` while preserving them with canonical-level salience. See the
[CHANGELOG entry for 0.8.0](https://github.com/CompleteIdeas/agent-working-memory/blob/master/CHANGELOG.md) for the full design.

---

## How It Works

### The Memory Lifecycle

1. **Write** — Salience scoring evaluates novelty, surprise, causal depth, and effort. High-salience memories go active; borderline ones enter staging; low-salience stored at reduced confidence for recall fallback. Near-duplicates reinforce existing memories instead of creating copies.

2. **Connect** — Vector embedding (BGE-small-en-v1.5, 384d). Temporal edges link to recent memories. Hebbian edges form between co-retrieved memories. Coref expansion resolves pronouns to entity names.

3. **Retrieve** — 10-phase pipeline: coref expansion + query expansion + dual BM25 (keyword-stripped + expanded) + semantic vectors + Rocchio pseudo-relevance feedback + ACT-R temporal decay (synaptic-tagged) + Hebbian boost + entity-bridge boost + graph walk + cross-encoder reranking + multi-channel agreement gate.

4. **Consolidate** — 7-phase sleep cycle: diameter-enforced clustering (prevents chaining), edge strengthening (access-weighted), cross-topic bridge formation (direct closest-pair), confidence-modulated decay (synaptic tagging extends half-life), synaptic homeostasis, cognitive forgetting, staging sweep. Embedding backfill ensures all memories are clusterable.

5. **Feedback** — Useful/not-useful signals adjust confidence, affecting retrieval rank and forgetting resistance.

### Cognitive Foundations

- **ACT-R activation decay** (Anderson 1993) — memories decay with time, strengthen with use. Synaptic tagging: heavily-accessed memories decay slower (log-scaled).
- **Hebbian learning** — co-retrieved memories form stronger associative edges
- **Complementary Learning Systems** — fast capture (salience + staging) + slow consolidation (sleep cycle)
- **Synaptic homeostasis** — edge weight normalization prevents hub domination
- **Forgetting as feature** — noise removal improves signal-to-noise for connected memories
- **Diameter-enforced clustering** — prevents semantic chaining (e.g., physics->biophysics->cooking = 1 cluster)
- **Multi-channel agreement** — OOD detection requires multiple retrieval channels to agree

---

## Architecture

```
src/
  core/             # Cognitive primitives
    embeddings.ts     - Local vector embeddings (BGE-small-en-v1.5, 384d)
    reranker.ts       - Cross-encoder passage scoring (ms-marco-MiniLM)
    query-expander.ts - Synonym expansion (flan-t5-small)
    salience.ts       - Write-time importance scoring (novelty + salience + reinforce-on-duplicate)
    decay.ts          - ACT-R temporal activation decay
    hebbian.ts        - Association strengthening/weakening
    logger.ts         - Append-only activity log (data/awm.log)
  engine/           # Processing pipelines
    activation.ts     - 10-phase retrieval pipeline (dual BM25, coref, agreement gate)
    consolidation.ts  - 7-phase sleep cycle (diameter clustering, direct bridging, synaptic tagging)
    connections.ts    - Discover links between memories
    staging.ts        - Weak signal buffer (promote or discard)
    retraction.ts     - Negative memory / corrections
    eviction.ts       - Capacity enforcement
  hooks/
    sidecar.ts        - Hook HTTP server (auto-checkpoint, stats, timer)
  storage/
    sqlite.ts         - SQLite + FTS5 persistence layer
  api/
    routes.ts         - HTTP endpoints (memory + task + system)
  mcp.ts            - MCP server (19 tools: 17 memory + 2 onboarding, incognito support)
  cli.ts            - CLI (setup, serve, hook config)
  index.ts          - HTTP server entry point (auto-backup on startup)
```

For detailed architecture including pipeline phases, database schema, and system diagrams, see [docs/architecture.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/architecture.md).

---

## Testing & Evaluation

### Unit Tests

```bash
npx vitest run    # 77 tests (salience, decay, hebbian, supersession)
```

### Eval Harness (v0.6.0)

```bash
npm run eval                        # All 4 benchmark suites
npm run eval -- --suite=retrieval   # Single suite
npm run eval -- --bm25-only         # Ablation: BM25 only
npm run eval -- --no-graph-walk     # Ablation: disable graph walk
```

Suites: retrieval (Recall@5), associative (multi-hop), redundancy (dedup F1), temporal (Spearman vs ACT-R). Ablation flags isolate each pipeline component's contribution.

### Full Test Suite

```bash
npm run test:mcp      # MCP protocol smoke test (5/5)
npm run test:self     # Pipeline component checks (94.1%)
npm run test:edge     # 9 adversarial failure modes
npm run test:stress   # 500 memories, 100 consolidation cycles (96.2%)
npm run test:workday  # 4-session production simulation (93.3%)
npm run test:ab       # AWM vs baseline comparison
npm run test:sleep    # Consolidation impact measurement
npm run test:tokens   # Token savings analysis (56.3% savings)
npm run test:pilot    # Production-like query validation (14/15)
npm run test:locomo   # LoCoMo industry benchmark (28.2%)
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWM_PORT` | `8400` | HTTP server port |
| `AWM_DB_PATH` | `memory.db` | SQLite database path |
| `AWM_AGENT_ID` | `claude-code` | Agent ID (memory namespace) |
| `AWM_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model (retrieval-optimized) |
| `AWM_EMBED_DIMS` | `384` | Embedding dimensions |
| `AWM_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Reranker model |
| `AWM_HOOK_PORT` | `8401` | Hook sidecar port |
| `AWM_HOOK_SECRET` | *(none)* | Bearer token for hook auth |
| `AWM_API_KEY` | *(none)* | Bearer token for HTTP API auth |
| `AWM_INCOGNITO` | *(unset)* | Set to `1` to disable all tools |
| `AWM_COORDINATION` | *(unset)* | Set to `true` to enable hive coordination endpoints |
| `AWM_DISABLE_POOL_FILTER` | *(unset)* | Set to `1` to disable the candidate pool reduction (0.7.7+). Reverts recall to scoring all active candidates — slower but useful for A/B testing if a recall regression appears |
| `AWM_DISABLE_SLIM_CACHE` | *(unset)* | Set to `1` to disable the in-memory slim cache (0.7.10+). Reverts to per-recall SQL fetch — slower but useful if cache invariants are suspected of drift |
| `AWM_DISABLE_RERANK_SKIP` | *(unset)* | Set to `1` to disable the reranker skip on clear-winner queries (0.7.10+). Forces every recall through the cross-encoder |
| `AWM_DISABLE_EXPANSION_CACHE` | *(unset)* | Set to `1` to disable the query expansion skip heuristic + LRU cache (0.7.11+). Forces every recall through the flan-t5-small expander |
| `AWM_WORKSPACE` | *(unset)* | Default workspace for cross-agent recall in hive setups |
| `AWM_SLOW_WRITE_MS` | `250` | Slow-write telemetry threshold in ms; any write over this logs one stderr line with a phase-time breakdown (embed/novelty/persist, event-loop lag, cold-load ms). `0` disables (v0.12.0) |
| `AWM_ENTITY_INDEX_FETCH` | *(unset)* | Set to `1` to let query-named entities ("ticket 19252", a person's name) resolve through the entity inverted index for a guaranteed reranker audition, including alias hops. Default off pending broader eval (v0.12.0) |
| `AWM_ENTITY_INDEX_CAP` | `12` | Max entity-index candidates injected per recall when `AWM_ENTITY_INDEX_FETCH=1` (v0.12.0) |
| `AWM_STORE_BACKEND` | `sqlite` | `sqlite` (better-sqlite3 + FTS5), `pglite` (PGlite + pgvector + pgroonga), or `postgres` (node-postgres + pgvector, networked/multi-connection — **experimental**, 0.10.0). |
| `AWM_DB_PATH` | `memory.db` (SQLite) / `./memory-pglite` (PGlite) | Storage path. Directory for PGlite, file for SQLite. Ignored for `postgres` (uses `AWM_DATABASE_URL`). |
| `AWM_DATABASE_URL` | *(unset)* | Postgres connection string when `AWM_STORE_BACKEND=postgres` (0.10.0). |
| `AWM_CONF_SHARPNESS_W` | `0.4` | Weight of `top1 / mean(top5)` in recall confidence (PR-1, v0.8.5) |
| `AWM_CONF_CLIFF_W` | `0.3` | Weight of `(top1 - top10) / top1` in recall confidence (PR-1, v0.8.5) |
| `AWM_CONF_FLOOR_W` | `0.3` | Weight of `top1` absolute score in recall confidence (PR-1, v0.8.5) |
| `AWM_FADE_DAYS_SINCE_ACCESS` | `45` | Days without access before a stale active engram fades (v0.8.5) |
| `AWM_FADE_KEEP_CHARS` | `150` | Chars retained in faded engram content (v0.8.5) |
| `AWM_FADE_MIN_CONTENT_LEN` | `250` | Don't fade engrams shorter than this — nothing to trim (v0.8.5) |
| `AWM_FADE_MAX_PER_CYCLE` | `25` | Max engrams faded per consolidation cycle — gradual, not sudden (v0.8.5) |
| `AWM_GRANULARITY_COMPACT_LEN` | `200` | Char cap for `granularity: 'compact'` summaries (v0.8.5) |
| `AWM_GRANULARITY_FULL_LEN` | `1000` | Char cap for top result under `granularity: 'auto'` when confidence ≥ threshold (v0.8.5) |
| `AWM_GRANULARITY_AUTO_THRESHOLD` | `0.4` | Recall-confidence threshold above which `'auto'` granularity gives the top result a long-form summary (v0.8.5) |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ES2022, strict) |
| Database | SQLite via better-sqlite3 + FTS5 |
| HTTP | Fastify 5 |
| MCP | @modelcontextprotocol/sdk |
| ML Runtime | @huggingface/transformers (local ONNX) |
| Embeddings | BGE-small-en-v1.5 (BAAI, retrieval-optimized, 384d) |
| Reranker | ms-marco-MiniLM-L-6-v2 (cross-encoder) |
| Query Expansion | flan-t5-small (synonym generation) |
| Tests | Vitest 4 |
| Validation | Zod 4 |

All three ML models run locally via ONNX. No external API calls for retrieval. The entire system is a single SQLite file + a Node.js process.

## What's New in v0.12.x (latest)

Three releases (0.12.0-0.12.2), eval-driven. All additive, no breaking API changes.

- **Instance identity (`memory_whoami`)** — agent id, workspace, mode, backend, store
  path, code provenance, sibling agent spaces. Call it first whenever you're unsure
  which store or which running code you're talking to.
- **Entity inverted index** — structured identifier tags (`ticket=`, `person=`, bare
  ids) feed an exact-match index. A query naming an entity resolves through it even
  when the wording doesn't lexically match. Default off (`AWM_ENTITY_INDEX_FETCH=1`),
  guaranteed reranker audition, no score boost.
- **Local-first security defaults** — HTTP binds `127.0.0.1` by default; widening
  beyond loopback without `AWM_API_KEY` fails closed.
- **Write-path telemetry** — always-on slow-write attribution (`AWM_SLOW_WRITE_MS`,
  default 250ms) names the phase, event-loop lag, and cold-load cost on any write
  that's slow enough to matter.
- **Memory spine (provenance)** — `origin_class`, `recipe_id`, `valid_from`/`valid_to`
  on every write. `valid_to` expires operational facts instead of relying on the
  reader to notice they're stale; recall renders `[valid until ...]` on results
  carrying it.
- **Cognition recipes** — AWM contains no LLM. When memory needs real thinking
  (distilling a procedure, reflecting on a failure), `memory_task_end` hands the host
  agent a versioned prompt+contract pair (`skill-derivation@1`, `friction-lesson@1`)
  to run as its own focused pass, then validates the write-back.
- **Recall results carry engram ids** (`[id: <uuid>]`) — feed a recalled memory
  straight into `memory_supersede`/`memory_feedback` with no separate lookup.
- **Eager warm at MCP startup + sidecar warm recall** — model load overlaps session
  start instead of your first message; the hook sidecar gained `POST /memory/activate`
  for ~0.8s warm recall from a hook, with no standing server needed.
- **Gauntlet baseline** — end-to-end memory ablation now anchors acceptance:
  **74%±5pp memory-dependent vs 0% no-memory control**, six of nine probes at 100%.
  See [`docs/gauntlet-baseline-2026-07-30.md`](docs/gauntlet-baseline-2026-07-30.md).

Full version-by-version history — every release back to v0.6.0, including the
0.7.6→0.7.14 latency work (11s→300ms) and the 0.8.5 recall-quality hardening pass —
lives in the changelog, not here:

See [CHANGELOG.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/CHANGELOG.md) for full details.

## Integrations

AWM is a standard MCP server, so it plugs into any MCP-capable agent host with
**no adapter code** — the same server Claude Code uses. Point two hosts at the
same `AWM_DB_PATH` (with a shared `AWM_AGENT_ID`/`AWM_WORKSPACE`) and they share
one cognitive memory.

### Hermes Agent (Nous Research)

1. Make AWM available where Hermes runs (e.g. a derived Docker image — the
   Hermes image already bundles Node):

   ```dockerfile
   FROM hermes-agent:local
   USER root
   RUN npm install -g agent-working-memory@latest
   ENV HF_HOME=/opt/data/.cache/huggingface
   ```

2. Register it in `~/.hermes/config.yaml`:

   ```yaml
   mcp_servers:
     awm:
       command: node
       args: ["/usr/local/lib/node_modules/agent-working-memory/dist/mcp.js"]
       env:
         AWM_AGENT_ID: hermes
         AWM_DB_PATH: /opt/data/awm/hermes.db    # on a persistent volume
         HF_HOME: /opt/data/.cache/huggingface
       timeout: 600                              # first call downloads the embedder
   ```

3. AWM's tools appear to the agent as `mcp_awm_memory_write`,
   `mcp_awm_memory_recall`, etc. Works with any Hermes model provider
   (verified on Anthropic and Azure `gpt-5-4-mini`).

Full recipe — model-provider examples, the Azure GPT-5.x `/openai/v1` note, and
gotchas (incl. the Windows CRLF/s6 clone fix) — is in
[docs/integrations/hermes.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/integrations/hermes.md).

## Project Status

AWM is in active development (v0.12.2). The core memory pipeline, consolidation
system, multi-agent coordination, and MCP integration are stable and used
daily in production coding workflows.

- Core retrieval and consolidation: **stable**
- MCP tools and Claude Code integration: **stable** (19 tools: 17 memory + 2 onboarding)
- Other MCP hosts (e.g. [Hermes Agent](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/integrations/hermes.md)): **supported** — AWM drops in as an MCP memory server with no adapter code
- Multi-agent coordination: **stable** (v0.8.1 hardening)
- Task management: **stable**
- Hook sidecar and auto-checkpoint: **stable** — plus `POST /memory/activate` warm recall for hooks (v0.12.2)
- HTTP API: **stable** (for custom agents)
- Eval harness: **stable** (v0.6.0, extended through 0.8.x); gauntlet acceptance test added (v0.12.0)
- Recall confidence + opt-in abstention (PR-1, PR-2): **stable** (v0.8.5)
- Coherence-weighted retraction + counter-narrative inheritance: **stable** (v0.8.5)
- Content fade stage + adaptive output granularity: **stable** (v0.8.5)
- PGlite backend (alternative to SQLite, with pgvector + ivfflat): **stable** (v0.8.x)
- Networked Postgres backend (`pg` + pgvector, multi-connection): **experimental** (v0.10.0)
- Backend-agnostic `import`/`export` (embeddings included, cross-backend port): **stable** (v0.10.0)
- Instance identity (`memory_whoami`), local-first security defaults, write-path telemetry, memory-spine provenance (`origin_class`/`valid_from`/`valid_to`), cognition recipes: **stable** (v0.12.0)
- Entity inverted index + guarded index-backed retrieval: **stable, opt-in** (`AWM_ENTITY_INDEX_FETCH=1`, default off pending broader eval) (v0.12.0)

See [CHANGELOG.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/CHANGELOG.md) for version history.

---

## License

Apache 2.0 — see [LICENSE](https://github.com/CompleteIdeas/agent-working-memory/blob/master/LICENSE) and [NOTICE](https://github.com/CompleteIdeas/agent-working-memory/blob/master/NOTICE).
