# User Guide

> **New to AWM?** If terms like *engram, salience, activation, Hebbian,
> staging* are unfamiliar, start with
> [`onboarding-vocabulary.md`](onboarding-vocabulary.md) — a 5-minute read
> that defines the seven core terms in plain language.

## Prerequisites

- **Node.js** >= 22.0.0 (Node 20 reached EOL on 2026-04-30; v0.8.6+ requires Node 22 LTS)
- **npm** (bundled with Node)
- **~175 MB** disk space for ML models (downloaded automatically on first run — see the table below for the per-model split)

## Quick Start

**Most people want the npm install, not this section.** For Claude Code (or Codex, Cursor), run:

```bash
npm install -g agent-working-memory
awm setup --global
```

and follow [`quickstart.md`](quickstart.md). The steps below are for working **from a source
checkout over the HTTP API** — for developing AWM itself, or integrating a non-MCP agent.

### From a source checkout (HTTP API)

#### 1. Install Dependencies

```bash
npm install
```

#### 2. Start the HTTP Server

```bash
npx tsx src/index.ts
```

The server starts on port 8400 (configurable via `AWM_PORT` env var). On first run, three ML models download automatically — **~175 MB in total**, once per cache (the 377 MB query expander only if expansion is turned on):

| Model | Size | Purpose |
|-------|------|---------|
| bge-small-en-v1.5 | 134 MB | Vector embeddings (384 dimensions) — BAAI, retrieval-optimized |
| ms-marco-MiniLM-L-6-v2 | 23 MB | Cross-encoder reranking for keyword-shaped queries (int8 by default; 92 MB at `AWM_RERANKER_DTYPE=fp32`) |
| ettin-reranker-17m-v1 | 17 MB | Cross-encoder reranking for natural-language questions (int8) |
| flan-t5-small | 377 MB | Query expansion, downloaded only when expansion is on (`AWM_DEFAULT_EXPANSION=1`) |

> These are per-model **downloads** at the precision AWM actually loads: the embedder (and
> flan-t5, when expansion is on) at **fp32**, both rerankers at **int8** by default (since
> 0.19 for MiniLM; Ettin since it shipped in 0.22). The MiniLM reranker's 91 MB ONNX file is
> downloaded only at `AWM_RERANKER_DTYPE=fp32`. Sizes include each model's tokenizer and
> config (verified against the Hugging Face hub's file listing, not just a local cache; there
> are no `.onnx_data` sidecars). Until 2026-10-09 this table quoted ~33/~22/~80 MB, which
> tracked each model's *parameter count* rather than the fp32 weights the code then requested
> for all three — an understatement of about 4.5x at the time.

Verify the server is running:

```bash
curl http://localhost:8400/health
# {"status":"ok","timestamp":"...","version":"<your installed version>","coordination":false,"agents_alive":0,...}
```

#### 3. Write Your First Memory

```bash
curl -X POST http://localhost:8400/memory/write \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "concept": "Express error handling pattern",
    "content": "Use app.use((err, req, res, next) => {...}) as the last middleware for centralized error handling in Express 5",
    "tags": ["express", "error-handling"],
    "eventType": "causal",
    "surprise": 0.5,
    "causalDepth": 0.7
  }'
```

The salience filter evaluates the memory and returns its disposition:

```json
{
  "stored": true,
  "disposition": "active",
  "salience": 0.62,
  "reasonCodes": ["causal_insight", "event:causal", "disposition:active"],
  "engram": { "id": "abc-123", "concept": "Express error handling pattern", ... }
}
```

#### 4. Recall Memories

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "How should I handle errors in my Express API?",
    "limit": 5
  }'
```

Returns ranked results with per-phase scoring explanations:

```json
{
  "results": [{
    "engram": { "concept": "Express error handling pattern", ... },
    "score": 0.82,
    "why": "composite=0.820 | text=0.75 | vector=0.68 | decay=1.20 | conf=0.80 | access=1",
    "phaseScores": { "textMatch": 0.75, "vectorMatch": 0.68, ... }
  }]
}
```

#### 5. Give Feedback

```bash
curl -X POST http://localhost:8400/memory/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "engramId": "abc-123",
    "useful": true,
    "context": "Used this pattern to fix my error handler"
  }'
```

Useful feedback increases confidence (+0.05); not useful decreases it (-0.1).

## Claude Code Integration (MCP)

AWM integrates directly with Claude Code via the Model Context Protocol.

### Setup

Run `awm setup claude-code --global` and it writes the config for you — prefer that to
hand-writing it. For a per-project pool, run `awm setup --agent-id <name>` in the project
folder instead. The entry it writes has this shape (trimmed — setup also writes the hook port,
the hook secret it generates, and a few other keys, so treat this as a sketch rather than a copy):

```json
{
  "mcpServers": {
    "agent-working-memory": {
      "command": "node",
      "args": ["C:/Users/you/AppData/Roaming/npm/node_modules/agent-working-memory/dist/mcp.js"],
      "env": {
        "AWM_DB_PATH": "C:/Users/you/.awm/memory.db",
        "AWM_AGENT_ID": "work"
      }
    }
  }
}
```

Two things matter here. **`AWM_DB_PATH` must point outside the installed package** —
`~/.awm/memory.db` is the default for exactly that reason, because a store inside
`node_modules` is deleted by `npm update`. And **`AWM_AGENT_ID` is the memory pool**:
any name works. Unset, the server falls back to `WORKER_NAME`, then to `work` (or `personal`
under a `Personal-Projects` path), which may not be the pool you meant — pin it, and check
with `memory_whoami`.

After restarting Claude Code, check `/mcp` to verify the server is connected with **22 tools** (18 memory, 2 onboarding, 2 output).

### MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_write` | Store a memory with salience metadata |
| `memory_recall` | Retrieve relevant memories by context |
| `memory_about` | Every memory about one person, organisation or thing, oldest first |
| `memory_alias` | Record other names for an entity ("Jenna", "Jenna Park") so `memory_about` finds it by any of them |
| `memory_set_questions` | Attach the natural questions a memory answers, so it is found when someone asks in their own words |
| `memory_feedback` | Report if a memory was useful |
| `memory_retract` | Invalidate a wrong memory |
| `memory_supersede` | Replace outdated memory with a current version |
| `memory_stats` | View memory health metrics |
| `memory_whoami` | Identify the instance — agent id, workspace, backend, store path, sibling agent spaces |
| `memory_checkpoint` | Save execution state (survives context compaction) |
| `memory_restore` | Recover state + relevant context at session start |
| `memory_task_add` | Create a prioritized task |
| `memory_task_update` | Change task status/priority/blocking |
| `memory_task_list` | List tasks filtered by status |
| `memory_task_next` | Get highest-priority actionable task |
| `memory_task_begin` | Start a task — auto-checkpoints and recalls context |
| `memory_task_end` | End a task — writes summary and checkpoints |
| `compress_output` | Encode a structured tool output as TOON — ~50-65% fewer tokens, lossless, output-only |
| `retrieve_original` | Get the verbatim source back for a `compress_output` ref |
| `onboard_scan` | Extract candidate memories from a project's docs/repo for review |
| `onboard_questions` | Anchored interview questions to refine what a cold store should know |

For substrate-style structured projects (chapter analyses, plot beats, etc.) the HTTP API also exposes `latest-by-tag`, `top-by`, `resolve`, `supersede` Form B, and a race-free `sequence/next` allocator — see [`reference.md`](reference.md) for full details.

### Usage Example (in Claude Code)

Claude Code will automatically use these tools when appropriate. You can also trigger them explicitly:

- "Remember that we decided to use PostgreSQL connection pooling with pgBouncer" (triggers `memory_write`)
- "What do we know about error handling in this project?" (triggers `memory_recall`)
- "That memory about Redis caching was wrong" (triggers `memory_retract`)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWM_PORT` | `8400` | HTTP server port |
| `AWM_DB_PATH` | `memory.db` | SQLite database file path |
| `AWM_AGENT_ID` | derived — `work` or `personal` | The agent id **is** the memory pool. Unset, the MCP server falls back to `WORKER_NAME` and then derives from the project directory, which yields only `work` or `personal` (`src/core/agent-id.ts`) — never `claude-code`, which this row claimed until 2026-10-09. Pin it explicitly if you want a specific pool. |
| `AWM_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model (BAAI retrieval-optimized, default since 0.7) |
| `AWM_EMBED_DIMS` | `384` | Embedding dimensions |
| `AWM_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranker model (keyword-shaped queries) |
| `AWM_RERANKER_MODEL_NATURAL` | `cross-encoder/ettin-reranker-17m-v1` | Second cross-encoder for natural-language questions (since 0.22); `off` uses the main one for every query |
| `AWM_RERANKER_DTYPE` | `q8` | Reranker precision (q8 since 0.19); `fp32` restores the pre-0.19 ranker and gives back the ~30% latency saving (process restart needed) |

## Building for Production

```bash
npx tsc                    # Compile to dist/
node dist/index.js         # Run compiled version
```

## Development Mode

```bash
npx tsx watch src/index.ts  # Auto-reload on file changes
npm run dev                 # Same thing via npm script
```

## Running Tests

```bash
# Unit tests (no server required)
npx vitest run              # 1232 tests

# MCP protocol test (no server required)
npm run test:mcp            # 7 checks

# Self-test (requires live server)
npm run test:self           # 31 dimensions, scored report

# Workday eval (requires live server)
npm run test:workday        # 14 recall challenges

# A/B test vs keyword baseline
npm run test:ab             # 100 events, 24 quiz questions

# Real-world codebase eval
npm run test:realworld      # 300 code chunks, 16 challenges

# LOCOMO benchmark (requires live server)
npm run test:locomo         # 199 QA pairs, industry benchmark

# Token savings benchmark
npm run test:tokens         # Measures memory-guided context efficiency
```
