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

### Implicit feedback (0.20)

Agents rarely call `memory_feedback`, so since 0.20 a recall is also credited without a call
(`src/core/implicit-feedback.ts`, `ActivationEngine.noteImplicitUse`). A memory returned by a
recent recall counts as *used* when its id prefix or enough of its distinctive tokens
(identifiers, dates, file paths, tag values, proper nouns) show up in what the agent did next:

- a `memory_write` whose content carries the same identifiers;
- a `memory_supersede` of that memory;
- a task summary (`memory_task_end`);
- the assistant's reply and tool calls in the following turn. The Stop hook `awm-used.cjs`
  posts the transcript tail to the sidecar's `POST /hooks/used`.

An implicit credit logs a `retrieval_feedback` row (context `implicit:<source>`) and raises
confidence by half the explicit boost (0.025). It is positive only: a recall the agent did not
use is simply not credited. `memory_feedback` is still the only way to say a recall was **not**
useful.

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

Confidence acts as a **multiplier** (`confidenceGate`) on the composite score computed in
phase 3b of `src/engine/activation.ts`:
```
composite = (textWeight * textMatch + temporalWeight * temporal * relevanceGate + ...boosts) * confidenceGate
```

A memory with confidence 0.3 has a composite 40% lower than one with confidence 0.5 (0.3 / 0.5 = 0.6), even if text relevance and temporal signals are identical. The composite decides which candidates reach the cross-encoder; the final order is set by the reranker blend. Over time, consistently useful memories rise and consistently useless ones fade.

## Code References

- HTTP handler: `POST /memory/feedback` in `src/api/routes.ts`
- MCP tool: `memory_feedback` in `src/mcp.ts`
- Confidence update: `updateConfidence()` in `src/storage/sqlite.ts` (clamps to [0, 1])
- Feedback logging: `logRetrievalFeedback()` in `src/storage/sqlite.ts`
- Implicit feedback: `matchUses()` in `src/core/implicit-feedback.ts`, `noteImplicitUse()` in `src/engine/activation.ts` (`IMPLICIT_FEEDBACK_FACTOR = 0.5`), `/hooks/used` in `src/hooks/sidecar.ts`
- Default boost/penalty: `DEFAULT_AGENT_CONFIG` in `src/types/agent.ts` — `feedbackPositiveBoost: 0.05`, `feedbackNegativePenalty: 0.1`
