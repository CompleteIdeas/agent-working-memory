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
store grows and ages?

### 1 · The 0.13.x retrieval wins

Three changes shipped in 0.13.4–0.13.6. Each row names **the corpus it was measured
on** — they are not the same, and the difference matters. Enable all three together:

```bash
AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1
```

| Change | Flag | Measured result | Measured on |
|---|---|---|---|
| **Second-stage rerank** — let the cross-encoder's own score decide final order, instead of a blend that capped its vote at 70% | `AWM_RERANK2=1` | **+9.7pp success@1** (37.8 → 47.6), p<0.001, paired McNemar. Costs no extra inference — the scores already existed and were being partly discarded. | 616 LoCoMo probes — ⚠ the benchmark retired below |
| **Query-aware rerank window** — spend the same 400-char budget on the window densest in query terms instead of the prefix | `AWM_RERANK_WINDOW=query` | **25.0% → 87.5%** long-memory success@1 (3.5×), at **+0.07%** CPU and **zero** added tokens. | Generated long-memory corpus, calibrated to real-store statistics, answer planted at a controlled offset |
| **Tags into the rerank passage** — put words that exist only as tags in front of the component that decides | `AWM_RERANK_TAGS=1` | **+7.4pp success@1** (56.4 → 63.8) on category queries. | 450 probes on a **frozen real-store snapshot** |

**Combined, on the real store** (450 category probes, frozen 11,294-engram snapshot):
**s@1 56.4 → 63.8%**, **s@5 66.2 → 68.4%**, **MRR 60.6 → 66.0%** — with adversarial
abstention held at **90.0%** in every arm. Selectivity was not traded away to buy accuracy.

> **On the +9.7pp figure.** It comes from LoCoMo, which this page retires two sections
> below. Reported as-measured rather than quietly dropped, because the provenance is part
> of the story: LoCoMo's short passages are exactly why it could not see the 400-char
> truncation, and that blind spot is what made the standalone `AWM_RERANK2`
> recommendation wrong. The combined real-store number above is the one to trust.

> **End-to-end, this did not move the acceptance test.** See the gauntlet row below.

> **⚠ Enable them together.** `AWM_RERANK2` *alone* regresses long-memory s@5 from
> 91.7% to 25.0%. BM25 over full content had been quietly compensating for the
> reranker's 400-char blindness; making a blind reranker authoritative removes that
> cover. Ship both, or neither.

The finding underneath all three: **a memory is unreachable when a word it needs was
never written into its body.** On this store, 66.2% of topical tag terms never appear
in the text at all. Three other approaches to the same defect were tested and
rejected — re-embedding with tags (+0.3pp), mined dialect aliases (−0.2pp), and a
larger 768d embedder (+0.7pp alone, −1.1pp combined). You cannot recover a word that
was never written; you can only put the word that *is* recorded in front of the ranker.
That is also why 0.13.6 rewrote the **writing guidance**, not just the ranker.

Full evidence, protocol, and the rejected arms: [`docs/archive/`](docs/archive/README.md).

### 2 · Everything else, in one table

| What | Result | Detail |
|---|---|---|
| **Eval harness** (retrieval / associative / redundancy / temporal) | Recall@5 **0.980** · success@10 **1.000** · dedup F1 **0.966** · Spearman **0.932** — all four above threshold | [`docs/benchmarks.md`](docs/benchmarks.md) |
| **Unit + subsystem** | `test:run` **569/569** · `test:self` **93.9%** · `test:edge` **~32/34** · `test:mcp` **5/5** | [`docs/benchmarks.md`](docs/benchmarks.md) |
| **Adversarial / noise rejection** | `test:pilot` **14/15** (5/5 distractors rejected) · `test:ab` **AWM 10/11 vs keyword 8/11** | [`docs/benchmarks.md`](docs/benchmarks.md) |
| **End-to-end ablation** (the gauntlet) | **74%±5pp memory-dependent vs 0% no-memory control** (0.11.x baseline); only the memory substrate varies. **The 0.13.x flags did not move it** — 81% vs 78% baseline at k=3, confidence intervals overlapping | [`gauntlet-baseline`](docs/archive/gauntlet-baseline-2026-07-30.md) |
| **Consolidation under stress** | Recall **holds 90–100%** across 100 cycles; edges grow to ~2,300 then self-prune to ~1,500 | [`docs/benchmarks.md`](docs/benchmarks.md) |
| **Token economics** | **9.8× lower** aggregate cost than the Read/Grep/Glob rediscovery it replaces | [`docs/benchmarks.md`](docs/benchmarks.md) |

**The retrieval gains above have not yet shown up end-to-end.** Re-running the gauntlet
on 0.13.6 gave 81% with the flags vs 78% without at k=3 (±5pp, CI [78,89]) — a null
result, with `multihop` at 0/6 in both arms and four probes flipping between identical
runs. Ranking improved measurably at the retrieval layer; whether that converts into
task success at this sample size is unresolved, and a k≥10 run is what would settle it.

Two other numbers are easy to misread, so they are stated plainly:

- **`test:sleep` = 78.6% is a consolidation-*quality* score**, not recall falling to
  78.6%. It asks "after the maintenance pass, is recall at least as good and the
  structure better?" Recall is held flat across three cycles while the graph reorganizes.
- **Token savings depend entirely on the baseline you pick.** vs carrying the full
  history (what a memoryless agent must actually do): **+67% at 97.5% accuracy**. vs an
  oracle that pre-scoped context to the exactly-relevant task: **≈ −13%** — a
  deliberately brutal bar that hands the baseline the very scoping retrieval exists to
  do. 0.13.x added a third and stricter measure, **sufficiency**: does the delivered
  text actually *contain* the answer, or merely point at it?

> **LoCoMo was retired in 0.13.x.** It was useful for learning how to benchmark this
> product but does not represent it: median 115-char passages against a real store's
> 1,965; seeded in one shot, so decay, Hebbian weights and salience contribute nothing;
> no supersession, no cross-session use; it *rewards* indiscriminate retention, so the
> salience filter — the product — caps its score regardless of ranking quality; and it
> is structurally blind to the 400-char truncation that turned out to affect 79% of real
> ground-truth identifiers. `tests/realstore-eval/` replaces it.

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

```bash
# Write
curl -X POST http://localhost:8400/memory/write -H "Content-Type: application/json" -d '{
  "agentId": "my-agent",
  "concept": "Express error handling",
  "content": "Use centralized error middleware as the last app.use()",
  "eventType": "causal", "surprise": 0.5, "causalDepth": 0.7
}'

# Recall
curl -X POST http://localhost:8400/memory/activate -H "Content-Type: application/json" -d '{
  "agentId": "my-agent",
  "context": "How should I handle errors in my Express API?"
}'
```

**Substrate primitives (0.8+)** — for long-running structured projects (novels,
codebases, investigations) where an agent tracks typed state across hundreds of writes
without polluting cognitive retrieval: `/memory/latest-by-tag` (latest per tag key),
`/memory/top-by` (native filter + sort), `/memory/supersede` (atomic write-and-supersede
by concept match), `/memory/sequence/:agentId/next` (race-free chronology). The
`memory_class: "structural"` class keeps high-volume system-written records out of
cognitive `/activate` while preserving them at canonical salience.

Every endpoint, with request/response schemas and worked examples:
[`docs/reference.md`](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/reference.md).

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

```bash
npx vitest run                      # Unit: salience, decay, hebbian, supersession
npm run eval                        # 4 benchmark suites
npm run eval -- --suite=retrieval   # One suite
npm run eval -- --bm25-only         # Ablation: isolate a channel's contribution
```

### Real-store benchmark (0.13.x — replaces LoCoMo)

Measures the pipeline against a **frozen snapshot of a real store**, so passage lengths,
decay, supersession and Hebbian weights are all real rather than synthetic. Ground truth
is a unique-identifier hold-out verified through FTS, so it needs no hand labeling. And
correct **abstention scores positively** — selectivity is the product, so a benchmark
that punishes silence is measuring the wrong system.

```bash
node tests/realstore-eval/snapshot.mjs          # freeze a copy of the live store
npx tsx tests/realstore-eval/runner.ts          # identifier fixture (regression guard)
REALSTORE_FIXTURE=fixture-category.json \
  npx tsx tests/realstore-eval/runner.ts        # category fixture (retrievability)
bash tests/realstore-eval/campaign/full-comparison.sh   # baseline vs recommended, all suites
```

Each run works on a **copy** — activation mutates access counts, and a benchmark must
not drift the thing it measures. The runner prints the active flag fingerprint, so every
result records which configuration produced it.

Per-suite methodology, scoring, and the remaining `test:*` scripts:
[`docs/benchmarks.md`](docs/benchmarks.md).

---

## Environment Variables

**Recommended recall configuration (0.13.x)** — default-OFF, but measured wins. Enable
all three together (see [Benchmarks](#benchmarks)):

```bash
AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1
```

| Variable | Effect |
|---|---|
| `AWM_RERANK2=1` | Second-stage reorder of the returned window by cross-encoder score alone, after the abstention gate. **+9.7pp s@1.** Must be paired with `AWM_RERANK_WINDOW=query` |
| `AWM_RERANK_WINDOW=query` | Spend the rerank char budget on the window densest in query terms instead of the first N chars. **25% → 87.5%** long-memory s@1 |
| `AWM_RERANK_TAGS=1` | Append structured tags to the rerank passage, so category words that exist only as tags reach the deciding stage. **+7.4pp s@1** |

Verify what a running process actually has — `memory_whoami` prints a `Recall config:`
line and `GET /health` reports the same fingerprint. A submodule bump can report a new
version while the flags never reached the process; on version alone that looks like success.

**Core settings:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWM_DB_PATH` | `memory.db` (SQLite) / `./memory-pglite` (PGlite) | Storage path — file for SQLite, directory for PGlite |
| `AWM_STORE_BACKEND` | `sqlite` | `sqlite` (WAL, multi-process safe) · `pglite` (single-process) · `postgres` (networked, **experimental**) |
| `AWM_AGENT_ID` | `claude-code` | Agent id — the memory namespace. Pin it explicitly; an unpinned session lands in a per-directory UUID space nothing else can recall |
| `AWM_WORKSPACE` | *(unset)* | Default workspace for cross-agent recall in hive setups |
| `AWM_PORT` / `AWM_HOOK_PORT` | `8400` / `8401` | HTTP server and hook sidecar ports |
| `AWM_API_KEY` / `AWM_HOOK_SECRET` | *(none)* | Bearer tokens. Binding beyond loopback without an API key fails closed |
| `AWM_INCOGNITO` | *(unset)* | `1` disables all tools |
| `AWM_EMBED_MODEL` / `AWM_EMBED_DIMS` | `Xenova/bge-small-en-v1.5` / `384` | ⚠ `cosineSimilarity` returns **0** on dimension mismatch — migrate the whole corpus or not at all |

Every variable — including the salience, decay, fade, confidence, granularity and
diagnostic knobs, each with its measured effect and the **rejected** experiments and why
they lost — is documented in [`docs/reference.md`](https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/reference.md).

---

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

## What's New in v0.13.x (latest)

Retrieval-quality releases, all additive. Corpus provenance differs per result and is
named in [Benchmarks](#benchmarks) — only the tags result and the combined figure come
from a real-store snapshot.

- **Second-stage rerank (`AWM_RERANK2`)** — final order was a blend that capped the
  cross-encoder at 70% of the vote. It disagrees with that blend about rank 1 on 38.6%
  of queries, and where the disagreement is decidable **the cross-encoder is right 77%
  of the time**. Re-sorting by its score: **+9.7pp s@1**, no added inference. Placed
  after the abstention gate so it cannot affect selectivity — predicted 0 broken / 0
  fixed on adversarial, and measured exactly that.
- **Query-aware rerank window (`AWM_RERANK_WINDOW=query`)** — truncating passages to
  the first 400 chars is necessary (cross-encoders pad to the longest passage in a
  batch), but a *prefix* is the wrong 400. Real canonical memories are median 1,965
  chars, 98.7% exceed 400, and **99.9%** of long ones carry their identifiers only
  past char 400. Same budget, densest window: **25% → 87.5%**.
- **`memory_whoami` reports the effective recall config** — version alone does not
  answer "what am I actually running". This caught a real deployment failure the day
  it shipped: a project-level `.mcp.json` was overriding the config being edited, so
  the new version reported success while the flags never reached the process.
- **Tags into the rerank passage (`AWM_RERANK_TAGS`)** — **+7.4pp s@1**, with no
  re-embed, no new model and no write-path change; existing corpora benefit immediately
  because the tags are already stored.
- **Writing guidance corrected at the source** — the shipped advice was *causing* the
  problem it warned about. "Pick the most specific topic" pushed authors away from
  category words, reliably producing memories that are maximally specific and
  categorically anonymous. Two new rules: **name the CATEGORY as well as the
  specifics**, and **tags are not a substitute for body text** (only BM25 indexes tags —
  the embedding and the rerank passage are both built from `concept + content`, so a
  tag-only word is invisible to two of three channels, including the one that now
  decides ordering).

### Previously, in v0.12.x

`memory_whoami` instance identity · entity inverted index (`AWM_ENTITY_INDEX_FETCH=1`,
opt-in) · local-first security defaults (loopback bind, fail-closed without an API key)
· write-path slow-write telemetry · memory-spine provenance (`origin_class`,
`valid_from`/`valid_to`) · cognition recipes at `memory_task_end` · engram ids in
recall results · eager warm at MCP startup + sidecar warm recall.

Full version-by-version history — every release back to v0.6.0, including the
0.7.6→0.7.14 latency work (11s→300ms) and the 0.8.5 recall-quality hardening pass —
lives in [CHANGELOG.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/CHANGELOG.md).

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

AWM is in active development (v0.13.6). The core memory pipeline, consolidation
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
- Second-stage rerank, query-aware rerank window, tags-into-rerank: **stable, opt-in** (`AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1` — enable together) (v0.13.4-0.13.6)
- Real-store benchmark (`tests/realstore-eval/`), replacing LoCoMo: **stable** (v0.13.x)

See [CHANGELOG.md](https://github.com/CompleteIdeas/agent-working-memory/blob/master/CHANGELOG.md) for version history.

---

## License

Apache 2.0 — see [LICENSE](https://github.com/CompleteIdeas/agent-working-memory/blob/master/LICENSE) and [NOTICE](https://github.com/CompleteIdeas/agent-working-memory/blob/master/NOTICE).
