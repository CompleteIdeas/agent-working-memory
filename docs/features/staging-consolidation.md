# Feature: Staging Buffer & Consolidation

## When It Activates

Automatically, in the background. Memories with salience between 0.2 and 0.4 are placed in **staging** — a buffer for uncertain observations. Every 60 seconds, the staging buffer sweeps for expired entries.

## How It Works

### Memory Enters Staging
When a write scores between 0.2-0.4 salience, the memory is stored with `stage: 'staging'` and a TTL of 24 hours.

### Consolidation Sweep (every 60s)
1. Find all staging memories past their TTL (24 hours old)
2. For each expired memory, test **resonance**: run an activation query against active memories
3. If the activation returns results above `minScore: 0.3` — the memory **resonates** with existing knowledge:
   - Promote to `stage: 'active'`
   - Log staging event as "promoted"
4. If no resonance — the memory is noise:
   - Hard-delete the memory
   - Log staging event as "discarded"

### Why This Exists

Not every observation deserves immediate storage. The staging buffer implements a form of **hippocampal consolidation** — uncertain memories get a chance to prove themselves through resonance with existing knowledge. If new evidence arrives within 24 hours that relates to the staged memory, it gets promoted. Otherwise, it's forgotten.

### Configuration

| Setting | Default | Meaning |
|---------|---------|---------|
| `stagingTtlMs` | 86,400,000 | 24 hours before sweep eligibility |
| Sweep interval | 60,000ms | How often to check for expired staging |
| Resonance threshold | 0.3 | Min activation score to promote |
| `maxStagingEngrams` | 1,000 | Capacity cap (excess deleted oldest-first) |

### Accessing Staging Memories

Staging memories are excluded from activation by default. To include them:
- HTTP: `"includeStaging": true` in activate request
- MCP: `include_staging: true` in memory_recall

### Monitoring

Check staging counts: `GET /agent/:id/stats`
Check staging metrics: `GET /agent/:id/metrics` (promoted, discarded counts)

## Code References

- Staging buffer: `src/engine/staging.ts`
- Sweep logic: `src/engine/staging.ts:15-40`
- Staging threshold: `src/core/salience.ts` (0.2-0.4 range)
- Start/stop: called from `src/index.ts` and `src/mcp.ts`
