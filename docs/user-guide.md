# User Guide

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** (bundled with Node)
- ~150MB disk space for ML models (downloaded automatically on first run)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the HTTP Server

```bash
npx tsx src/index.ts
```

The server starts on port 8400 (configurable via `AWM_PORT` env var). On first run, three ML models download automatically:

| Model | Size | Purpose |
|-------|------|---------|
| all-MiniLM-L6-v2 | ~22MB | Vector embeddings (384 dimensions) |
| ms-marco-MiniLM-L-6-v2 | ~22MB | Cross-encoder reranking |
| flan-t5-small | ~80MB | Query expansion |

Verify the server is running:

```bash
curl http://localhost:8400/health
# {"status":"ok","timestamp":"...","version":"0.3.0"}
```

### 3. Write Your First Memory

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

### 4. Recall Memories

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

### 5. Give Feedback

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

The project includes a `.mcp.json` that registers the MCP server:

```json
{
  "mcpServers": {
    "agent-working-memory": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "env": {
        "AWM_DB_PATH": "memory.db",
        "AWM_AGENT_ID": "claude-code"
      }
    }
  }
}
```

After restarting Claude Code, check `/mcp` to verify the server is connected with 9 tools.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_write` | Store a memory with salience metadata |
| `memory_recall` | Retrieve relevant memories by context |
| `memory_feedback` | Report if a memory was useful |
| `memory_retract` | Invalidate a wrong memory |
| `memory_stats` | View memory health metrics |
| `memory_task_add` | Create a prioritized task |
| `memory_task_update` | Change task status/priority/blocking |
| `memory_task_list` | List tasks filtered by status |
| `memory_task_next` | Get highest-priority actionable task |

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
| `AWM_AGENT_ID` | `claude-code` | Default agent ID for MCP server |
| `AWM_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `AWM_EMBED_DIMS` | `384` | Embedding dimensions |
| `AWM_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranker model |

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
npx vitest run              # 47 tests, ~1.5s

# MCP protocol test (no server required)
npm run test:mcp            # 7 tests

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
