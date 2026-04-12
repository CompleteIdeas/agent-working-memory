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
| **Correction** | Delete and re-insert | Retraction: wrong memories invalidated, corrections linked, penalties propagate (depth 2, decaying) |
| **Noise rejection** | None | Multi-channel agreement gate: requires 2+ retrieval channels to agree before returning results |
| **Duplicates** | Stored repeatedly | Reinforce-on-duplicate: near-exact matches boost existing memory instead of creating copies |

The design is based on cognitive science — ACT-R activation decay, Hebbian learning, complementary learning systems, synaptic homeostasis, and synaptic tagging — rather than ad-hoc heuristics. See [How It Works](#how-it-works) and [docs/cognitive-model.md](docs/cognitive-model.md) for details.

---

## Benchmarks (v0.6.0)

### Eval Harness (new in v0.6.0)

| Suite | Score | Threshold | What it tests |
|-------|-------|-----------|---------------|
| Retrieval | **Recall@5 = 0.800** | >= 0.80 | 200 facts, 50 queries — BM25 + vector + reranker pipeline precision |
| Associative | **success@10 = 1.000** | >= 0.70 | 20 multi-hop causal chains — graph walk finds non-obvious connections |
| Redundancy | **dedup F1 = 0.966** | >= 0.80 | 50 clusters × 4 paraphrases — consolidation removes duplicates correctly |
| Temporal | **Spearman = 0.932** | >= 0.75 | 25 facts with controlled age/access — ACT-R decay ranking accuracy |

Key finding: **consolidation improves retrieval by 30%** — post-consolidation recall (0.950) exceeds pre-consolidation (0.650). Removing redundant noise helps ranking.

### Full Test Suite

| Command | Score | What it tests |
|---------|-------|---------------|
| `npm run eval` | **4/4 suites pass** | Retrieval, associative, redundancy, temporal benchmarks with ablation support |
| `npm run test:run` | **77/77 tests** | Unit tests: salience, decay, hebbian, supersession, coordination |
| `npm run test:mcp` | **5/5 pass** | MCP protocol: write, recall, feedback, retract, stats |
| `npm run test:self` | **94.1% EXCELLENT** | Pipeline component checks across all cognitive subsystems |
| `npm run test:edge` | **All pass** | 9 failure modes: narcissistic interference, identity collision, contradiction trapping, bridge overshoot, noise forgetting |
| `npm run test:stress` | **96.2% (50/52)** | 500 memories, 100 sleep cycles, catastrophic forgetting, adversarial spam, recovery |
| `npm run test:workday` | **93.3% EXCELLENT** | 43 memories across 4 projects, cross-cutting queries, noise filtering |
| `npm run test:ab` | **AWM 20/22 vs Baseline 18/22** | AWM outperforms keyword baseline on architecture + testing topics |
| `npm run test:sleep` | **71.4%** | 60 memories, 4 topic clusters, consolidation impact across 3 cycles |
| `npm run test:tokens` | **56.3% savings, 2.3x efficiency** | Memory-guided context vs full history, keyword accuracy 72.5% |
| `npm run test:pilot` | **14/15 pass** | Production-like queries with noise rejection (5/5 noise rejected) |
| `npm run test:locomo` | **28.2%** | Industry-standard LoCoMo conversational memory benchmark (1,986 QA pairs) |

### Consolidation Health (v0.6.0)

| Metric | Value |
|--------|-------|
| Topic clusters formed | **10** per consolidation cycle |
| Cross-topic bridges | **20** in first cycle |
| Edges strengthened | **135** per cycle (access-weighted) |
| Graph size at scale | **3,000-4,500 edges** (500 memories) |
| Recall after 100 cycles | **90%** stable |
| Catastrophic forgetting survival | **5/5** (100%) |
| Post-dedup retrieval | **0.950** (consolidation improves recall) |

All evals are reproducible. See [Testing & Evaluation](#testing--evaluation).

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

## What's New in v0.6.1

- **Embedding version tracking** — new `embedding_model` column prevents silent drift when changing models. Each embedding records its source model.
- **Batch embedding backfill** — consolidation uses `embedBatch()` (batch size 32) instead of single-item loop. 10x faster for large backfills.
- **Deeper retraction propagation** — confidence penalties now propagate 2 hops (was 1) with 50% decay per hop, capped at 20 affected nodes.
- **Retrieval timeouts** — 5s timeout on query expansion, 10s on cross-encoder reranker. Both fail gracefully to text-only signals.
- **Channel push delivery** — assignments delivered directly to worker HTTP endpoints with mailbox fallback.
- **Cross-UUID assignment migration** — resolves assignments across alternate agent UUIDs.

### v0.6.0

- **Memory taxonomy** — memories classified as `episodic`, `semantic`, `procedural`, or `unclassified`. Auto-classified on write. Filter by type on recall.
- **Query-adaptive retrieval** — pipeline adapts to query type: `targeted` | `exploratory` | `balanced` | `auto`.
- **Decision propagation** — decisions broadcast to coordination layer for cross-agent discovery.
- **Eval harness** — `npm run eval` benchmarks retrieval, associative, redundancy, and temporal performance.
- **DB hardening** — busy_timeout, integrity check on startup, hot backups every 10 min, WAL checkpoint on shutdown.

See [CHANGELOG.md](CHANGELOG.md) for full details.

## Project Status

AWM is in active development (v0.6.1). The core memory pipeline, consolidation system, multi-agent coordination, and MCP integration are stable and used daily in production coding workflows.

- Core retrieval and consolidation: **stable**
- MCP tools and Claude Code integration: **stable**
- Multi-agent coordination: **stable** (v0.6.0)
- Task management: **stable**
- Hook sidecar and auto-checkpoint: **stable**
- HTTP API: **stable** (for custom agents)
- Eval harness: **stable** (v0.6.0)

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
