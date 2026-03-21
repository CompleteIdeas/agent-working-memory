# Feature: Eviction & Association Decay

## When You'd Use It

Manually via `POST /system/evict` and `POST /system/decay`, or conceptually as part of system maintenance. Prevents unbounded memory growth and prunes stale associations.

## Eviction (Capacity Enforcement)

### How It Works

1. **Active memory budget**: if `activeCount > maxActiveEngrams` (default 10,000):
   - Query eviction candidates ranked by a weighted composite:
     - 30% salience + 30% confidence + 20% access frequency + 20% recency
     - Lowest-scoring memories evicted first
   - Evicted memories move to `stage: 'archived'` (soft removal)

2. **Staging budget**: if `stagingCount > maxStagingEngrams` (default 1,000):
   - Delete oldest expired staging memories

3. **Edge pruning**: for each memory with more than `maxEdgesPerEngram` (default 20) associations:
   - Remove weakest edges until under cap

### What Gets Changed
- Over-capacity active memories archived
- Over-capacity staging memories deleted
- Excess edges deleted (weakest first)

## Association Decay

### How It Works

Run periodically (e.g., daily) to weaken unused association edges:

1. Fetch all associations for the agent
2. Skip recently activated edges (< 0.5 days old)
3. Apply exponential decay: `weight *= 2^(-daysSinceActivation / halfLifeDays)`
4. Delete edges falling below 0.01 minimum useful weight
5. Update edges where weight changed by more than 0.001

### Default Half-Life: 7 Days

An association unused for 7 days loses half its weight. After ~50 days of disuse, it drops below the 0.01 threshold and is deleted.

### Configuration

| Setting | Default | Meaning |
|---------|---------|---------|
| `maxActiveEngrams` | 10,000 | Trigger eviction above this |
| `maxStagingEngrams` | 1,000 | Trigger staging cleanup above this |
| `maxEdgesPerEngram` | 20 | Max associations per memory |
| `edgeDecayHalfLifeDays` | 7 | Days for edge weight to halve |

## Code References

- Eviction engine: `src/engine/eviction.ts`
- Eviction candidates: `src/storage/sqlite.ts:270` — `getEvictionCandidates()`
- Decay formula: `src/core/hebbian.ts:25` — `decayAssociation()`
- HTTP endpoints: `src/api/routes.ts:264-274`
