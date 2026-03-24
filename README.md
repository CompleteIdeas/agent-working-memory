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

**Node.js 20+** required — check with `node --version`.

```bash
npm install -g agent-working-memory
awm setup --global
```

Restart Claude Code. That's it — 14 memory tools appear automatically.

First conversation will be ~30 seconds slower while ML models download (~200MB total, cached locally). After that, everything runs on your machine.

> For isolated memory per folder, see [Separate Memory Pools](#separate-memory-pools). For team onboarding, see [docs/quickstart.md](docs/quickstart.md).

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

Most "memory for AI" projects are vector databases with a retrieval wrapper. AWM goes further:

| | Typical RAG / Vector Store | AWM |
|---|---|---|
| **Storage** | Everything | Salience-filtered with low-confidence fallback (novel events go active, borderline enter staging, low-salience stored at reduced confidence) |
| **Retrieval** | Cosine similarity | 10-phase pipeline: dual BM25 (keyword + expanded) + vectors + reranking + graph walk + decay + coref expansion |
| **Connections** | None | Hebbian edges that strengthen when memories co-activate |
| **Over time** | Grows forever, gets noisier | Consolidation: diameter-enforced clustering, cross-topic bridges, synaptic-tagged decay |
| **Forgetting** | Manual cleanup | Cognitive forgetting: unused memories fade, reinforced knowledge persists (access-count modulated) |
| **Feedback** | None | Useful/not-useful signals tune confidence and retrieval rank |
| **Correction** | Delete and re-insert | Retraction: wrong memories invalidated, corrections linked, penalties propagate |
| **Noise rejection** | None | Multi-channel agreement gate: requires 2+ retrieval channels to agree before returning results |
| **Duplicates** | Stored repeatedly | Reinforce-on-duplicate: near-exact matches boost existing memory instead of creating copies |

The design is based on cognitive science — ACT-R activation decay, Hebbian learning, complementary learning systems, synaptic homeostasis, and synaptic tagging — rather than ad-hoc heuristics. See [How It Works](#how-it-works) and [docs/cognitive-model.md](docs/cognitive-model.md) for details.

---

## Benchmarks (v0.5.4)

| Eval | Score | What it tests |
|------|-------|---------------|
| Edge Cases | **100% (34/34)** | 9 failure modes: context collapse, hub toxicity, flashbulb distortion, narcissistic interference, identity collision, contradiction trapping, bridge overshoot, noise forgetting |
| Stress Test | **96.2% (50/52)** | 500 memories, 100 sleep cycles, 10 topic clusters, 20 bridges/cycle, catastrophic forgetting, adversarial spam, recovery |
| Workday | **93.3%** | 43 memories across 4 simulated work sessions, knowledge transfer, context switching, cross-cutting queries, noise filtering |
| A/B Test | **AWM 85% vs Baseline 83%** | 100 project events, 24 recall questions, 22/22 fact recall |
| Sleep Cycle | **85.7% pre-sleep** | 60 memories, 4 topic clusters, consolidation impact measurement |
| Token Savings | **67.5% accuracy, 55% savings** | Memory-guided context vs full conversation history, 2.2x efficiency |
| LoCoMo | **28.2%** | Industry-standard conversational memory benchmark (1,986 QA pairs, 10 conversations) |
| Mini Multi-Hop | **80% (4/5)** | Entity bridging across conversation turns |

### Consolidation (v0.5.4 with BGE-small)

| Metric | Value |
|--------|-------|
| Topic clusters formed | **10** per consolidation cycle |
| Cross-topic bridges | **20** in first cycle |
| Edges strengthened | **127** per cycle |
| Graph size at scale | **3,000-4,500 edges** (500 memories) |
| Recall after 100 cycles | **90%** stable |
| Catastrophic forgetting survival | **5/5** (100%) |

All evals are reproducible: `npm run test:edge`, `npm run test:stress`, `npm run test:workday`, etc. See [Testing & Evaluation](#testing--evaluation).

---

## Features

### Memory Tools (14)

| Tool | Purpose |
|------|---------|
| `memory_write` | Store a memory (salience filter + reinforce-on-duplicate) |
| `memory_recall` | Retrieve relevant memories by context (dual BM25 + coref expansion) |
| `memory_feedback` | Report whether a recalled memory was useful |
| `memory_retract` | Invalidate a wrong memory with optional correction |
| `memory_supersede` | Replace outdated memory with current version |
| `memory_stats` | View memory health metrics and activity |
| `memory_checkpoint` | Save execution state (survives context compaction) |
| `memory_restore` | Recover state + relevant context at session start |
| `memory_task_add` | Create a prioritized task |
| `memory_task_update` | Change task status/priority |
| `memory_task_list` | List tasks by status |
| `memory_task_next` | Get the highest-priority actionable task |
| `memory_task_begin` | Start a task — auto-checkpoints and recalls context |
| `memory_task_end` | End a task — writes summary and checkpoints |

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
  mcp.ts            - MCP server (14 tools, incognito support)
  cli.ts            - CLI (setup, serve, hook config)
  index.ts          - HTTP server entry point (auto-backup on startup)
```

For detailed architecture including pipeline phases, database schema, and system diagrams, see [docs/architecture.md](docs/architecture.md).

---

## Testing & Evaluation

### Unit Tests

```bash
npx vitest run    # 68 tests
```

### Eval Suites

| Command | What it tests | Score |
|---------|--------------|-------|
| `npm run test:edge` | 9 adversarial failure modes: context collapse, hub toxicity, flashbulb distortion, narcissistic interference, identity collision, contradiction trapping, bridge overshoot, noise benefit | **100% (34/34)** |
| `npm run test:stress` | 500 memories, 100 sleep cycles, 10 clusters, 20 bridges, catastrophic forgetting, adversarial spam, recovery | **96.2% (50/52)** |
| `npm run test:workday` | 43 memories across 4 projects, 14 recall challenges, noise filtering | **93.3%** |
| `npm run test:ab` | AWM vs keyword baseline, 100 events, 24 questions | **AWM 85% (22/22 recall)** |
| `npm run test:sleep` | 60 memories, 4 topic clusters, consolidation impact | **85.7% pre-sleep** |
| `npm run test:tokens` | Token savings vs full conversation history | **67.5% accuracy, 55% savings** |
| `npm run test:locomo` | LoCoMo conversational memory benchmark (1,986 QA pairs) | **28.2%** |
| `npm run test:self` | Pipeline component checks | **97.4%** |

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

## What's New in v0.5.4

- **BGE-small-en-v1.5 embedding model** — retrieval-optimized, 60% higher cosine for related short texts
- **Diameter-enforced clustering** — prevents semantic chaining, forms 10 distinct topic clusters
- **Direct cross-topic bridging** — 20 bridges per consolidation cycle
- **Dual BM25 retrieval** — keyword-stripped + expanded queries for better precision
- **Multi-channel agreement gate** — OOD detection prevents off-topic results
- **Reinforce-on-duplicate** — near-duplicate writes boost existing memories
- **No-discard salience** — low-salience memories stored at reduced confidence (available for fallback recall)
- **Synaptic tagging** — access count modulates decay (heavily-used memories persist longer)
- **Coref expansion** — pronoun queries auto-expanded with recent entity names
- **Async consolidation** — embedding backfill ensures all memories are clusterable
- **Auto-backup** — database copied to backups/ on server startup

See [CHANGELOG-0.5.4.md](CHANGELOG-0.5.4.md) for full details.

## Project Status

AWM is in active development (v0.5.4). The core memory pipeline, consolidation system, and MCP integration are stable and used daily in production coding workflows.

- Core retrieval and consolidation: **stable**
- MCP tools and Claude Code integration: **stable**
- Task management: **stable**
- Hook sidecar and auto-checkpoint: **stable**
- HTTP API: **stable** (for custom agents)
- Cognitive consolidation (clustering, bridging): **stable** (v0.5.4)

See [CHANGELOG-0.5.4.md](CHANGELOG-0.5.4.md) for version history.

---

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
