# Feature: Write a Memory

## When You'd Use It

When an agent learns something worth remembering — a codebase pattern, a decision and its reasoning, a debugging solution, a user preference, or an architectural insight.

## How It Works

### Steps (Happy Path)

Both entry points run the same pipeline, `performWrite()` in `src/core/write-pipeline.ts`.

1. Call `POST /memory/write` (or MCP `memory_write`) with concept, content, and optional metadata
   (tags, `memory_class`, `intent`, `questions`, `slot`, `aliases`, `correction`, `scope`, `valid_from`/`valid_to`).
2. **Redaction first.** Concept, content, tags and questions are masked for secrets before any
   later step sees them ([redaction.md](../redaction.md)).
3. **Slot check (0.22).** A write naming a `slot` (`robert.flight-time`) replaces the slot's current
   holder for the same agent and memory class; an older fact (earlier `valid_from`) is kept as
   history instead. A slot write is never concept-merged.
4. **Embedding, synchronously.** The bge-small vector is computed *before* the write (since
   0.8.5), because novelty matching uses it; the same vector is stored on the engram.
   `AWM_NOVELTY_EMBED=0` skips it (BM25-only novelty, embedding filled in afterwards).
5. **Novelty match.** The write is compared with the agent's existing memories (BM25 + cosine).
   Then, for a match owned by the same agent and not blocked by the trust check:
   - **Reinforce:** the same concept with a healthy match merges the new content into the existing
     memory and bumps its confidence (+0.05, capped at 0.95) instead of creating a duplicate;
   - **Supersede:** a correction-shaped write (or explicit `supersedes`) retires the match and is
     stored active;
   - **`correction: true`:** supersedes the closest match (match score ≥ 0.6) without its id, and
     never merges. With nothing close enough it is stored as new and says so.
6. The **salience filter** (`evaluateSalience()` in `src/core/salience.ts`) scores the write:
   - Weighted features: novelty 0.45, surprise 0.15, decision made 0.15, causal depth 0.15,
     resolution effort 0.10;
   - plus an event-type bonus (observation +0, decision +0.15, friction +0.2, causal +0.2,
     surprise +0.25, user feedback +0.3), attenuated when the write carries no other signal;
   - floors: canonical and structural writes 0.7 (always active), verified operational records
     0.45; trivial routine operations are capped at 0.1.
7. Based on score, the memory is routed:
   - **Active** (>= 0.4): stored immediately, queued for connection discovery
   - **Staging** (>= 0.2): stored in the buffer (confidence 0.40, 24h TTL), promoted if it resonates
   - **Low-salience** (< 0.2): **still stored**, active, at confidence 0.25 and tagged
     `low-salience` (HTTP reports disposition `low-salience`). It ranks low and is first in line
     for forgetting.
   - **`scope: "session"` (0.20):** a working note for this session is always kept, whatever its
     salience; it is never merged into a durable memory, is tagged with the session, and expires
     after `AWM_SESSION_TTL_DAYS` (7).
8. **Tags and indexes.** `client=` provenance is added from `AWM_CLIENT`; with `AWM_AUTOTAG=1`,
   `entity:`/`cat:` tags are extracted from the text. Structured entity tags (`person=`,
   `ticket=`, `entity:`, ...) are recorded in the entity index (`recordEntityMentions`), and
   `aliases` are registered against the write's one name-like entity (or `alias_for`).
9. **Questions (0.22).** Up to 5 natural questions the memory answers are attached, whichever path
   ran. They are indexed for keyword (BM25) search only, never embedded, and are read only by
   natural-language recall.
10. If active (or low-salience), the connection engine queues the memory for link discovery at the
    next consolidation (`enqueueAndMaybeFlush`).

### What Gets Persisted

- Engram record (concept, content, confidence, salience, tags, stage, memory class, slot, questions, validity window)
- Salience features and reason codes (for auditability)
- Embedding vector (384 floats, computed before the write)
- FTS5 index entry (for BM25 search; questions in their own index)
- Entity-index rows (`entity_mentions`, `entity_aliases`)

### Requirements

- `agentId`, `concept`, and `content` are required
- `concept` should be 3-8 words (short label)
- `content` is the full detail (no length limit but practical limit ~10KB for FTS performance)

### Limits

- Default max active memories: 10,000 per agent
- Default max staging: 1,000 per agent
- Memories below salience 0.2 are stored as `low-salience` (confidence 0.25), not dropped

### Error States

- Missing required fields: Fastify returns 400 (schema validation)
- Database write failure: 500 error (rare, SQLite is robust)

### Side Effects

- Embedding generation (synchronous, before the write, ~50-100ms per memory)
- Connection discovery for active memories (queued for the next consolidation)
- FTS5 index update (synchronous, <1ms)

## Code References

- Write pipeline: `performWrite()` / `createNewEngram()` in `src/core/write-pipeline.ts`
- HTTP handler: `POST /memory/write` in `src/api/routes.ts`
- MCP tool: `memory_write` in `src/mcp.ts`
- Salience evaluation: `evaluateSalience()` in `src/core/salience.ts`
- Redaction: `redactFields()` in `src/core/redact.ts`
- Questions: `attachQuestions()` in `src/core/questions.ts`
- Engram creation: `createEngram()` in `src/storage/sqlite.ts`
- Embedding: `embed()` in `src/core/embeddings.ts`
- Connection engine: `enqueueAndMaybeFlush()` in `src/engine/connections.ts`
