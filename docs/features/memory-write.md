# Feature: Write a Memory

## When You'd Use It

When an agent learns something worth remembering — a codebase pattern, a decision and its reasoning, a debugging solution, a user preference, or an architectural insight.

## How It Works

### Steps (Happy Path)

1. Call `POST /memory/write` (or MCP `memory_write`) with concept, content, and optional salience metadata
2. The **salience filter** evaluates the memory's importance using weighted features:
   - Surprise (30%), decision made (25%), causal depth (25%), resolution effort (20%)
   - Plus event type bonus (observation +0, decision +0.15, friction +0.2, causal +0.2, surprise +0.25)
3. Based on score, the memory is routed:
   - **Active** (>= 0.4): stored immediately, queued for connection discovery
   - **Staging** (>= 0.2): stored in buffer, promoted if it resonates within 24h
   - **Discarded** (< 0.2): not stored, response indicates discard
4. An embedding vector is generated asynchronously (non-blocking) and stored alongside the memory
5. If active, the connection engine discovers semantic links to existing memories

### What Gets Persisted

- Engram record (concept, content, confidence, salience, tags, stage)
- Salience features and reason codes (for auditability)
- Embedding vector (384 floats, generated async)
- FTS5 index entry (for BM25 search)

### Requirements

- `agentId`, `concept`, and `content` are required
- `concept` should be 3-8 words (short label)
- `content` is the full detail (no length limit but practical limit ~10KB for FTS performance)

### Limits

- Default max active memories: 10,000 per agent
- Default max staging: 1,000 per agent
- Memories below salience 0.2 are discarded (not stored at all)

### Error States

- Missing required fields: Fastify returns 400 (schema validation)
- Database write failure: 500 error (rare, SQLite is robust)

### Side Effects

- Embedding generation (async, ~50-100ms per memory)
- Connection discovery for active memories (async, ~200ms)
- FTS5 index update (synchronous, <1ms)

## Code References

- HTTP handler: `src/api/routes.ts:51-114`
- MCP tool: `src/mcp.ts:55-124`
- Salience evaluation: `src/core/salience.ts:60-100`
- Engram creation: `src/storage/sqlite.ts:148-180`
- Embedding: `src/core/embeddings.ts:32-40`
- Connection engine: `src/engine/connections.ts:18-50`
