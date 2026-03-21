# Feature: Retract a Wrong Memory

## When You'd Use It

When you discover a stored memory contains incorrect information. Retraction marks it as wrong, optionally creates a correction, and reduces confidence in associated memories that may also be contaminated.

## How It Works

### Steps (Happy Path)

1. Call `POST /memory/retract` (or MCP `memory_retract`) with the wrong memory's ID and a reason
2. The original memory is marked as **retracted** (soft delete — preserved for audit)
3. If `counterContent` is provided, a new correction memory is created:
   - Concept: `correction:{original concept}`
   - Tags: `['correction', 'retraction']`
   - Salience: at least 0.6 (moderately important)
   - Confidence: 0.7 (trusted)
   - An **invalidation edge** links the correction to the retracted memory
4. **Confidence contamination**: all memories directly associated with the retracted one have their confidence reduced
   - Penalty: 0.1, scaled by association weight
   - Depth: 1 (direct neighbors only)
   - Invalidation edges are skipped (corrections aren't penalized)

### What Gets Persisted

- `retracted = true`, `retracted_at` timestamp on original
- `retracted_by` set to correction ID (if created)
- New correction engram (if counterContent provided)
- Invalidation association (bidirectional, weight 1.0)
- Updated confidence on associated memories

### Requirements

- `agentId`, `targetEngramId`, and `reason` are required
- The target engram must exist

### What Happens to Retracted Memories

- **Hidden from activation**: retracted memories are excluded from normal queries
- **Visible in search**: `POST /memory/search` with `"retracted": true`
- **Visible by ID**: `GET /memory/:id` still returns them
- **Not deleted**: preserved for audit trail and eval metrics

### Error States

- Target engram not found: retraction still runs (idempotent marking)
- No associations: just marks retracted, no contamination spread

## Code References

- HTTP handler: `src/api/routes.ts:164-180`
- MCP tool: `src/mcp.ts:204-235`
- Retraction engine: `src/engine/retraction.ts:12-50`
- Confidence propagation: `src/engine/retraction.ts:55-80`
