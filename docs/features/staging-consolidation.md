# Feature: Staging Buffer & Consolidation

## Lifecycle Overview (v0.8.5)

```
write → [staging] ─resonate→ active ─stale→ fading ─age→ archived ─isolation→ deleted
              │
              └─no-resonance→ deleted
```

| Stage | When | Visible in recall? |
|---|---|---|
| `staging` | Salience 0.2–0.4 at write time | Only with `includeStaging: true` |
| `active` | Promoted from staging or written above salience floor | **Yes** (default) |
| `fading` (v0.8.5) | Stale active engram, content trimmed | **Yes** — still surfaces by concept + tags + embedding |
| `archived` | Never-retrieved, old; or no longer accessed | Only via `/memory/search` |
| `consolidated` | Synthesized cluster summary | Yes — surfaces as `synth=true` engrams |

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

### Content Fade Phase (v0.8.5)

A new consolidation phase (Phase 5.5, between homeostasis and forgetting)
that coarsens the *content* of stale-but-accessed engrams without removing
them. Models Paper 1 (PLOS Comp Biology on storage degradation): human
memory loses surface detail while retaining cue-association pathways.

Fade criteria (all must hold):

| Criterion | Default | Env knob |
|---|---|---|
| `accessCount >= 1` (engram was actually retrieved) | — | — |
| `daysSinceAccess > 45` | 45 | `AWM_FADE_DAYS_SINCE_ACCESS` |
| `content.length > 250` | 250 | `AWM_FADE_MIN_CONTENT_LEN` |
| `accessCount < 10` (not heavily used) | 10 | — |
| `memoryClass` not in `{canonical, structural}` | — | — |
| Not retracted | — | — |

When triggered, the engram's content is trimmed to 150 chars (`AWM_FADE_KEEP_CHARS`)
plus a `… [faded]` marker, and `stage` transitions to `'fading'`. **Concept,
tags, and embedding are preserved** — the faded engram still surfaces in BM25
recall (via concept + tags + truncated content) and in vector recall (the
embedding is unchanged). At most `AWM_FADE_MAX_PER_CYCLE` (25) engrams fade
per consolidation cycle.

Faded engrams can still be archived later via the standard forget path
(Phase 6). The lifecycle is: `active → fading → archived → deleted`.

### Monitoring

Check staging counts: `GET /agent/:id/stats`
Check staging metrics: `GET /agent/:id/metrics` (promoted, discarded counts)

## Code References

- Staging buffer: `src/engine/staging.ts`
- Sweep logic: `src/engine/staging.ts:15-40`
- Staging threshold: `src/core/salience.ts` (0.2-0.4 range)
- Start/stop: called from `src/index.ts` and `src/mcp.ts`
