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
4. **Confidence contamination (coherence-weighted)**: memories directly
   associated with the retracted one have their confidence reduced.
   - Base penalty: 0.1, scaled by association weight.
   - Depth: 1 (direct neighbors only).
   - Invalidation edges are skipped (corrections aren't penalized).
   - **As of v0.8.5**: the penalty is multiplied by `0.5 + cohesion`
     (range 0.5–1.5), where `cohesion = density × (0.5 + 0.5 × tagOverlap)`
     of the seed's neighborhood. Dense, topically-coherent clusters (a
     narrative) get heavier penalties — when the seed is wrong, the
     surrounding cluster is more likely to be wrong too. Hub structures
     (popular node with heterogeneous edges) get lighter penalties — a
     central node being wrong doesn't impeach its unrelated neighbors.
     Research grounding: Carrillo et al, "Continued Influence Effect"
     (ICCM 2025).
5. **Counter-narrative inheritance (v0.8.5)**: when `counterContent` is
   provided, the new correction engram inherits the original's
   `'connection'` edges (scaled by `0.7×`, capped at 10 inheritances).
   Edges of type `invalidation`, `causal`, or `temporal` are NOT inherited
   (they are correction-specific or directional). This implements the
   "counter-narrative replacement" mechanic from the CIE literature: the
   corrected fact takes over the structural role of the wrong fact in the
   graph rather than leaving the corrected fact disconnected.

### What Gets Persisted

- `retracted = true`, `retracted_at` timestamp on original
- `retracted_by` set to correction ID (if created)
- New correction engram (if counterContent provided)
- Invalidation association (bidirectional, weight 1.0)
- Inherited counter-narrative connection edges from original to correction
  (v0.8.5; up to 10, scaled 0.7×, only `'connection'` type)
- Updated confidence on associated memories (coherence-weighted; v0.8.5)

### Return Value (v0.8.5)

The retract function returns:

```ts
{
  retractedId: string;
  correctionId: string | null;   // null if no counterContent
  associatesAffected: number;
  cohesion: NeighborhoodCohesion;   // density, tagOverlap, score — for introspection
  narrativeEdgesInherited: number;   // 0 if no counterContent
}
```

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
