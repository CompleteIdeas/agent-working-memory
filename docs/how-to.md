# How-To Recipes

## 1. Store a high-importance memory

Set `eventType: "decision"` or `"causal"` with high `surprise` and `causalDepth` to ensure the memory lands in `active` (not staging or discarded).

```bash
curl -X POST http://localhost:8400/memory/write \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "concept": "Database migration strategy",
    "content": "Decided to use Prisma migrate instead of raw SQL files because it handles rollbacks and generates typed client automatically",
    "tags": ["database", "prisma", "decision"],
    "eventType": "decision",
    "surprise": 0.4,
    "decisionMade": true,
    "causalDepth": 0.7,
    "resolutionEffort": 0.5
  }'
```

See [Salience Scoring Formula](reference.md#salience-scoring-formula) for how these values determine disposition.

## 2. Recall memories for a current task

Describe what you're working on in natural language. The activation pipeline handles the rest.

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "Setting up database migrations for a new service",
    "limit": 5,
    "includeStaging": false
  }'
```

## 3. Recall with maximum quality (reranker + expansion)

Both are on by default, but you can explicitly control them:

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "error handling patterns",
    "useReranker": true,
    "useExpansion": true,
    "limit": 10
  }'
```

## 4. Fast recall without ML overhead

Disable the reranker and query expander for faster responses (~10ms vs ~200ms):

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "error handling patterns",
    "useReranker": false,
    "useExpansion": false
  }'
```

## 5. Correct a wrong memory

```bash
curl -X POST http://localhost:8400/memory/retract \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "targetEngramId": "abc-123",
    "reason": "The port number was wrong",
    "counterContent": "The service runs on port 3000, not 8080"
  }'
```

This marks the original as retracted, creates a correction memory, and reduces confidence in associated memories.

## 6. Give feedback on a recalled memory

After using a memory from activation results, report whether it was helpful:

```bash
curl -X POST http://localhost:8400/memory/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "engramId": "abc-123",
    "useful": true,
    "context": "Applied the migration strategy to the new service"
  }'
```

## 7. Search memories deterministically

Unlike activation (cognitive/associative), search is a direct SQL query:

```bash
curl -X POST http://localhost:8400/memory/search \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "tags": ["database"],
    "stage": "active",
    "limit": 20
  }'
```

## 8. Check memory health

```bash
curl http://localhost:8400/agent/my-agent/stats
curl http://localhost:8400/agent/my-agent/metrics?window=24
```

Healthy indicators:

- Average confidence between 0.3-0.8
- Retraction rate < 5%
- Edge utility rate > 50%
- P95 latency < 100ms

## 9. Run capacity enforcement manually

```bash
curl -X POST http://localhost:8400/system/evict \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "my-agent" }'
```

## 10. Decay unused associations

Run periodically (e.g., daily) to clean up stale edges:

```bash
curl -X POST http://localhost:8400/system/decay \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "my-agent", "halfLifeDays": 7 }'
```

## 11. Isolate memories per project

Use different `agentId` values per project. Memories are fully isolated by agent:

```bash
# Project A memories
curl -X POST http://localhost:8400/memory/write \
  -d '{ "agentId": "project-a", "concept": "...", "content": "..." }'

# Project B memories (completely separate)
curl -X POST http://localhost:8400/memory/write \
  -d '{ "agentId": "project-b", "concept": "...", "content": "..." }'
```

## 12. Run the full test suite

```bash
# Start server
npx tsx src/index.ts &

# Unit tests (no server needed)
npx vitest run

# Self-test (scored report, 31 dimensions)
npm run test:self

# Workday eval (14 coding recall challenges)
npm run test:workday

# LOCOMO benchmark (199 QA pairs, industry standard)
npm run test:locomo
```
