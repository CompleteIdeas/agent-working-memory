# Feature: Memory Feedback

## When You'd Use It

After using (or trying to use) a recalled memory, report whether it was actually helpful. This is how the system learns which memories are valuable.

## How It Works

### Steps (Happy Path)

1. Call `POST /memory/feedback` (or MCP `memory_feedback`) with the engram ID and a `useful` boolean
2. The feedback is logged in the `retrieval_feedback` table
3. The memory's confidence score is adjusted:
   - **Useful = true**: confidence += 0.05 (positive boost)
   - **Useful = false**: confidence -= 0.1 (negative penalty, asymmetric — bad feedback punishes harder)
4. Confidence is clamped to [0, 1]

### What Gets Persisted

- Feedback record: engram ID, useful flag, context, timestamp
- Updated confidence score on the engram

### Requirements

- `engramId` is required (from activation results)
- `useful` is required (boolean)

### Limits

- Confidence is clamped to [0, 1] — can't go below 0 or above 1
- No rate limiting on feedback (could theoretically spam)

### How It Affects Future Recall

Confidence acts as a **multiplier** in the composite score formula:
```
composite = (0.6 * textMatch + 0.4 * temporal * relevanceGate) * confidence
```

A memory with confidence 0.3 scores 60% lower than one with confidence 0.5, even if text relevance and temporal signals are identical. Over time, consistently useful memories rise and consistently useless ones fade.

## Code References

- HTTP handler: `src/api/routes.ts:136-162`
- MCP tool: `src/mcp.ts:174-202`
- Confidence update: `src/storage/sqlite.ts:210`
- Feedback logging: `src/storage/sqlite.ts:370`
- Default boost/penalty: `src/types/agent.ts` — `feedbackPositiveBoost: 0.05`, `feedbackNegativePenalty: 0.1`
