# Reference

## API Request/Response Reference

### POST /memory/write

**Request:**
```json
{
  "agentId": "string (required)",
  "concept": "string (required) — short label, 3-8 words",
  "content": "string (required) — full detail",
  "tags": ["string"] ,
  "eventType": "observation | decision | friction | surprise | causal",
  "surprise": 0.0-1.0,
  "decisionMade": true/false,
  "causalDepth": 0.0-1.0,
  "resolutionEffort": 0.0-1.0,
  "confidence": 0.0-1.0,
  "memory_class": "canonical | working | ephemeral | structural",
  "sequence": 5,                                            // 0.8 — optional story-time
  "embed": true,                                            // 0.8 — force embed for structural
  "references": [                                           // 0.8 — typed cross-record links
    { "type": "advances", "matchEngramId": "uuid" },
    { "type": "resolves", "matchConcept": "Promise X", "matchTags": ["topic=promise"] }
  ]
}
```

**Memory class semantics (0.8):**
- `canonical` — source-of-truth facts. Salience floor 0.7, surfaced via `/activate`.
- `working` (default) — observations, findings. Standard salience rules apply.
- `ephemeral` — temporary context. Stronger time decay.
- `structural` *(new in 0.8)* — system-written event-log records. Salience
  bypass like canonical, **excluded from `/activate` by default**, no temporal-
  adjacency edges, no embedding by default. Use for high-volume deterministic
  substrate (chapter analyses, promise advancements, motif phases).

**References (0.8):** When `matchConcept` is provided without `matchEngramId`,
AWM resolves it to the most-recent active engram at write time and stores
both — stable link survives concept renames. No match found → stores just
`matchConcept`, preserving the writer's intent.

**Response (201 if stored, 200 if discarded):**
```json
{
  "stored": true,
  "action": "create | reinforce | supersede",      // 0.7.17 — write-pipeline action
  "disposition": "active | staging | low-salience",
  "salience": 0.62,
  "reasonCodes": ["causal_insight", "event:causal", "class:structural", "disposition:active"],
  "engram": { ... }
}
```

### POST /memory/activate

**Request:**
```json
{
  "agentId": "string (required)",
  "context": "string (required) — what you're thinking about",
  "limit": 10,
  "minScore": 0.01,
  "includeStaging": false,
  "useReranker": true,
  "useExpansion": true,
  "abstentionThreshold": 0
}
```

**Response:**
```json
{
  "results": [{
    "engram": { "id": "...", "concept": "...", "content": "...", ... },
    "score": 0.82,
    "phaseScores": {
      "textMatch": 0.75,
      "vectorMatch": 0.68,
      "decayScore": 1.20,
      "hebbianBoost": 0.15,
      "graphBoost": 0.05,
      "confidenceGate": 0.80,
      "composite": 0.72,
      "rerankerScore": 0.88
    },
    "why": "composite=0.820 | text=0.75 | vector=0.68 | ...",
    "associations": [...]
  }]
}
```

### POST /memory/feedback

**Request:**
```json
{
  "engramId": "string (required)",
  "useful": true,
  "activationEventId": "string (optional)",
  "context": "string (optional)"
}
```

**Response:** `{ "recorded": true }`

### POST /memory/retract

**Request:**
```json
{
  "agentId": "string (required)",
  "targetEngramId": "string (required)",
  "reason": "string (required)",
  "counterContent": "string (optional) — correct information"
}
```

**Response:**
```json
{
  "retractedId": "...",
  "correctionId": "... (if counterContent provided)",
  "associatesAffected": 3
}
```

### POST /memory/search

**Request:**
```json
{
  "agentId": "string (required)",
  "text": "string (optional) — keyword search",
  "concept": "string (optional) — exact concept match",
  "tags": ["string"],                                       // legacy AND-filter
  "tagsAll": ["string"],                                    // 0.8 — explicit AND (alias for tags)
  "tagsAny": ["string"],                                    // 0.8 — OR (at least one)
  "tagsNone": ["string"],                                   // 0.8 — NOT (exclude all)
  "stage": "active | staging | fading | archived | consolidated",  // 0.8.2 — fading added
  "retracted": false,
  "limit": 20,
  "offset": 0,
  "sortBy": "createdAt | sequence | salience | confidence | lastAccessed",
  "sortOrder": "asc | desc"
}
```

**Tag-operator composition (0.8):** `result = tagsAll ∧ (tagsAny[0] ∨ ...) ∧
¬(tagsNone[0] ∨ ...)`. Empty arrays skip the clause (vacuous truth). If both
`tags` and `tagsAll` are passed, both apply as intersection of intersections.

**Sort defaults:** When `sortBy` is unspecified, behavior is unchanged
(`lastAccessed DESC`). `sortBy: "sequence"` puts NULL last regardless of
direction.

**Response:** `{ "results": [...], "count": 5 }`

### POST /memory/supersede

Mark an old engram as superseded by a new one (the original wasn't wrong,
just outdated — confidence decays to 20%, BM25 retrieval filters it out).
Two body shapes are supported.

**Form A — by existing engram IDs** (pre-0.8 behavior, unchanged):
```json
{
  "oldEngramId": "uuid (required)",
  "newEngramId": "uuid (required)",
  "reason": "string (optional)"
}
```
**Response:** `{ "superseded": "...", "supersededBy": "...", "reason": "..." }`

**Form B — atomic write-and-supersede by concept match (0.8 — new):**
```json
{
  "agentId": "string (required)",
  "matchConcept": "string (required) — case-insensitive, trimmed",
  "matchTags": ["string"],                                  // optional narrowing
  "newEngram": {
    "concept": "string", "content": "string",
    "tags": ["string"], "memory_class": "structural",
    "sequence": 7, "eventType": "decision"
  },
  "reason": "string (optional)"
}
```
Single SQL transaction: find most-recent active match → write new → link
via causal association + 20% confidence decay + supersede. If no match
found: write new anyway, return `{ superseded: null }`.

**Response (201):**
```json
{
  "newEngram": { ... },
  "superseded": "old-uuid | null",
  "supersededBy": "new-uuid",
  "reason": "..."
}
```

Form discrimination: presence of `oldEngramId+newEngramId` → Form A;
presence of `agentId+matchConcept+newEngram` → Form B; both → 400.

### POST /memory/latest-by-tag *(new in 0.8)*

For each distinct value of `tagKey`, return the most recent active engram.
Used for "latest emotional state per character", "latest commit per branch",
"latest decision per topic".

**Request:**
```json
{
  "agentId": "string (required)",
  "tagKey": "string (required) — tag prefix, e.g. \"character=\"",
  "scopeTagsAll": ["topic=emotional-state"],                // optional narrowing
  "retracted": false,
  "sortBy": "createdAt | sequence",                         // default createdAt
  "limit": 100
}
```

With `sortBy: "sequence"`, engrams without a `sequence` value are excluded
(they have no story-time anchor).

**Response:** `{ "results": [Engram, ...], "count": N }`
— one engram per distinct `tagKey` value (the most recent).

### POST /memory/top-by *(new in 0.8)*

Filter by tag-set operators, sort by numeric value extracted from a tag
prefix, return top N. Missing/non-numeric values sort last.

**Request:**
```json
{
  "agentId": "string (required)",
  "sortField": "string (required) — tag prefix, e.g. \"weight=\"",
  "order": "asc | desc",                                    // default desc
  "filterTagsAll": ["topic=promise", "state=active"],
  "filterTagsAny": ["weight=8", "weight=9", "weight=10"],
  "filterTagsNone": ["kind=advancement"],
  "retracted": false,
  "limit": 40
}
```

**Response:** `{ "results": [Engram, ...], "count": N }`

### POST /memory/resolve *(new in 0.8)*

Compute the effective state of an engram from referenced events:
- `superseded` if `supersededBy` is set
- `resolved | subverted | abandoned` if a reference with that relation
  type points at this engram (latest by `createdAt` wins)
- `active` otherwise

**Request (two targeting modes):**
```json
{ "agentId": "string", "targetEngramId": "uuid" }
```
OR
```json
{
  "agentId": "string",
  "matchConcept": "Mara's deferred disclosure",
  "matchTags": ["topic=promise"]
}
```

**Response:**
```json
{
  "engram": { ... },
  "effectiveState": "active | resolved | subverted | abandoned | superseded",
  "resolvingEvents": [
    { "id": "uuid", "type": "resolves", "createdAt": "..." }
  ]
}
```

### GET /memory/sequence/:agentId/next *(new in 0.8)*

Race-free next-sequence allocator. Caller writes the engram with the
returned value in `sequence`. Atomic via `BEGIN IMMEDIATE`; concurrent
callers serialize without conflict. Doesn't reserve — caller is expected
to write between calls.

**Response:** `{ "agentId": "...", "next": 19 }`

### GET /memory/:id

**Response:** `{ "engram": {...}, "associations": [...] }`

### GET /agent/:id/stats

**Response:**
```json
{
  "agentId": "...",
  "engrams": { "active": 42, "staging": 3, "retracted": 1, "total": 46 },
  "associations": 128,
  "avgConfidence": 0.72
}
```

### GET /agent/:id/metrics

**Query:** `?window=24` (hours, default 24)

**Response:**
```json
{
  "metrics": {
    "activationCount": 150,
    "avgPrecisionAtK": 0.73,
    "avgLatencyMs": 45.2,
    "p95LatencyMs": 120.5,
    "totalEdges": 512,
    "edgeUtilityRate": 0.65,
    "activeEngramCount": 200,
    "stagingEngramCount": 15,
    "retractedCount": 3,
    "avgConfidence": 0.68,
    "retractionRate": 0.015
  }
}
```

### POST /system/evict

**Request:** `{ "agentId": "string" }`
**Response:** `{ "evicted": 5, "edgesPruned": 12 }`

### POST /system/decay

**Request:** `{ "agentId": "string", "halfLifeDays": 7 }`
**Response:** `{ "edgesDecayed": 23 }`

### POST /task/create

**Request:**
```json
{
  "agentId": "string (required)",
  "concept": "string (required) — short task title",
  "content": "string (required) — full task description",
  "tags": ["string"],
  "priority": "urgent | high | medium | low",
  "blockedBy": "string (optional) — ID of blocking task"
}
```

**Response:** Full engram object with `taskStatus`, `taskPriority`, `blockedBy` fields.

### POST /task/update

**Request:**
```json
{
  "taskId": "string (required)",
  "status": "open | in_progress | blocked | done",
  "priority": "urgent | high | medium | low",
  "blockedBy": "string | null"
}
```

**Response:** Updated engram object.

### GET /task/list/:agentId

**Query:** `?status=open&includeDone=true`

**Response:**
```json
{
  "tasks": [{ "id": "...", "concept": "...", "taskStatus": "open", "taskPriority": "high", ... }],
  "count": 3
}
```

Tasks ordered by priority (urgent first), then creation date.

### GET /task/next/:agentId

**Response:**
```json
{
  "task": { "id": "...", "concept": "...", "taskStatus": "open", "taskPriority": "urgent", ... }
}
```

Returns the single highest-priority non-blocked task. Prefers in_progress tasks (finish what you started).

### GET /health

**Response:** `{ "status": "ok", "timestamp": "2026-03-09T...", "version": "0.3.0" }`

---

## Hook Configuration

The `awm setup --global` command installs three Claude Code hooks into
`~/.claude/settings.json`. The block below is the exact shape they take —
use it if `awm setup` failed and you need to add them manually, or to
audit what was installed.

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsS -X POST -H \"Authorization: Bearer ${AWM_HOOK_SECRET}\" http://127.0.0.1:8401/hook/stop"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsS -X POST -H \"Authorization: Bearer ${AWM_HOOK_SECRET}\" http://127.0.0.1:8401/hook/pre-compact"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsS -X POST -H \"Authorization: Bearer ${AWM_HOOK_SECRET}\" http://127.0.0.1:8401/hook/session-end"
          }
        ]
      }
    ]
  }
}
```

**What each hook does:**

| Hook | When it fires | What the sidecar does |
|---|---|---|
| `Stop` | After every Claude response | Bumps the daily counter; nudges the agent to write/recall via system reminder. |
| `PreCompact` | Before context compaction | Auto-saves the current execution state to AWM so context survives the compress. |
| `SessionEnd` | When the conversation closes | Final auto-checkpoint + triggers a consolidation pass. |

**The hook sidecar:**

The sidecar is a separate HTTP server bundled with AWM, run automatically
when the MCP server starts. It listens on `AWM_HOOK_PORT` (default
`8401`) on `127.0.0.1` only. Authentication is via the `Authorization:
Bearer ${AWM_HOOK_SECRET}` header — set this env var to anything random
and the same value will be substituted into the hooks above by
`awm setup --global`.

**Port collisions:** If you run multiple AWM agents simultaneously (e.g.,
"work" and "personal" pools per the [Quickstart](quickstart.md#separate-memory-pools-optional)),
give each a different `AWM_HOOK_PORT` and update the URLs above
accordingly.

**Verifying the hooks installed correctly:**

```bash
# Show the installed hook config
cat ~/.claude/settings.json | python -m json.tool

# Confirm the sidecar is listening
curl -fsS -H "Authorization: Bearer $AWM_HOOK_SECRET" \
  http://127.0.0.1:8401/stats
# {"writes": N, "recalls": N, "hooks": N, "total": N}
```

If `curl` returns `401`, the secret is wrong. If `connection refused`,
the sidecar isn't running — restart Claude Code or check `awm serve`
output.

---

## Configuration Defaults

All values from `DEFAULT_AGENT_CONFIG` in `src/types/agent.ts`:

### Salience

| Setting | Default | Meaning |
|---------|---------|---------|
| `salienceThreshold` | `0.4` | Minimum score for active storage |
| `stagingThreshold` | `0.2` | Minimum score for staging (below = discard) |
| `stagingTtlMs` | `86,400,000` | 24 hours in staging before sweep |

### Capacity

| Setting | Default | Meaning |
|---------|---------|---------|
| `maxActiveEngrams` | `10,000` | Hard cap on active memories |
| `maxStagingEngrams` | `1,000` | Hard cap on staging buffer |
| `maxEdgesPerEngram` | `20` | Max associations per memory |

### Activation Pipeline

| Setting | Default | Meaning |
|---------|---------|---------|
| `activationLimit` | `10` | Default max results per query |
| `hebbianRate` | `0.25` | Association learning rate |
| `decayExponent` | `0.5` | ACT-R *d* parameter (higher = faster forgetting) |
| `edgeDecayHalfLifeDays` | `7` | Unused edges halve in weight every 7 days |

### Feedback

| Setting | Default | Meaning |
|---------|---------|---------|
| `feedbackPositiveBoost` | `0.05` | Confidence increase for "useful" |
| `feedbackNegativePenalty` | `0.1` | Confidence decrease for "not useful" |

### Connection Discovery

| Setting | Default | Meaning |
|---------|---------|---------|
| `connectionThreshold` | `0.7` | Min activation score to form a new edge |
| `connectionCheckIntervalMs` | `60,000` | Queue processing frequency |

### Recall tuning (env overrides)

Recall is a funnel: candidate generation → composite scoring → **rerank pool** → cross-encoder
rerank → abstention gate. A 2026-06 pipeline-attribution study (LoCoMo, N=616 answerable) found
~50% of answerable queries had gold that *cleared the candidate floor* but was squeezed out of the
rerank pool by the (decay-compressed) composite before the high-lift reranker saw it. Widening the
pool + scoping the abstention gate to the returned top-K lifted LoCoMo recall 22.7%→25.7% (every
category up) **and** adversarial precision 73.4%→74.9%, with no 4-suite/edge/workday regression and
recall ~35→77ms. These env vars expose the knobs; the **defaults are the validated values**.

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_RERANK_POOL` | `max(limit*4, 40)` | How many candidates reach the cross-encoder reranker. Wider = more retrievable gold reaches the reranker (recall ↑) at more (query,passage) pairs (latency ↑). |
| `AWM_TOPN_MULT` | `8` | Candidate breadth carried into graph-walk + rerank (`limit × this`). |
| `AWM_ABSTAIN_GATE_K` | `5` | Out-of-domain abstention judges the **post-rerank top-K** (not the whole wide pool), so widening for recall doesn't inflate the in-domain signal. `0` = legacy whole-pool behavior. |
| `AWM_SIM_FLOOR_TARGETED` | `0.50` | Raw-cosine floor below which vector match scores 0 (targeted/precise queries). |
| `AWM_SIM_FLOOR_EXPLORATORY` | `0.35` | Same, for exploratory-mode queries. |
| `AWM_SIM_CANDIDATE_FLOOR_TARGETED` | `0.40` | Min cosine for a vector hit to *enter* the candidate pool (targeted). |
| `AWM_SIM_CANDIDATE_FLOOR_EXPLORATORY` | `0.30` | Same, exploratory. |
| `AWM_RECALL_EXPAND` | `0` | `1` restores query-expansion-by-default (default is rerank-only). |

#### Opt-in / experimental retrieval flags (default-off)

| Env var | Meaning | Status |
|---------|---------|--------|
| `AWM_QUERY_BRIDGE` | Query-named entities boost in-pool candidates tagged with them (relevance-modulated). Lifts **attribution** ("what does X think") strongly; small adversarial cost. | Validated, opt-in |
| `AWM_AUTOTAG` | Write-time `entity:`/`cat:` meta-tags (feeds the entity-bridge, BM25, and the D9 entity index). | Neutral on recall alone; **required to populate the entity index** for free-text writes; opt-in |
| `AWM_BROAD_EDGES` | Form entity-co-occurrence edges (not just high-cosine) at write time. | Enabler; opt-in |
| `AWM_ENTITY_INDEX_FETCH` | **D11 (2026-07-30):** query-named entities (proper nouns, bare numeric ids) resolve through the `entity_mentions`/`entity_aliases` inverted index; matched engrams get NO score boost but a **guaranteed cross-encoder audition** (exempt from the topN cut, minScore floor, rerank-pool slice, and rerank-skip). The alias table lets a query reach facts no lexical/vector channel can ("Starbox" → `horse:thunder`). Cap: `AWM_ENTITY_INDEX_CAP` (12). | Gauntlet-accepted (74%±5pp, best floor of 6 configs); opt-in pending k≥10 confirmation |
| `AWM_SPREAD` / `AWM_SPREAD_INJECT` | Iterative PPR/SYNAPSE-style spreading activation over the graph. | **Parked** — regressed recall (displaces gold); re-test staged behind `AWM_SPREAD_INHIBIT` |
| `AWM_SPREAD_INHIBIT` | **D11:** SYNAPSE-style divisive normalization inside spread iterations — competing receivers suppress each other (the published fix for the displacing-gold regression). `0` (default) = off; `0.3` = re-test value. | Staged for tracer-judged re-test |
| `AWM_RERANK2` / `AWM_RERANK2_K` | **Phase 9b (2026-08-24):** re-sort the returned window by `rerankerScore` alone, after the abstention gate. The shipped blend caps `rerankWeight` at 0.7, so `composite` (decay/Hebbian/salience) always keeps ≥30% of the vote on final order — and it disagrees with the cross-encoder about rank 1 on 38.6% of queries, where the cross-encoder is right 77% of the time. `K` default 10 (== return limit, so pure reordering; K>limit also changes membership). | **+9.7pp success@1** (LoCoMo paired, p<0.001); adversarial abstention provably and measurably unchanged (0 broken / 0 fixed) because it runs post-gate |
| `AWM_RERANK_WINDOW=query` / `AWM_RERANK_TRUNC` | **(2026-08-24):** spend the rerank passage budget on the window densest in query terms instead of the first N chars. Truncation exists because cross-encoders pad to the longest passage in a batch, but a PREFIX is the wrong budget: canonical memories are median 1,965 chars and 98.7% exceed 400, so the reranker could not see 78.8% of their vocabulary. | **Long-memory success@1 25% → 87.5%.** Answer at char 150 scores 0.986; at char 700 it scored 0.000 while BM25 barely moved. **Must ship WITH `AWM_RERANK2`** — rerank2 alone drops long-memory s@5 91.7%→25.0% |
| `AWM_RERANK_TAGS` / `AWM_RERANK_TAGS_LEN` | **(2026-08-24):** append topical (`topic=`/`proj=`) tag terms to the rerank passage. Tags are indexed by BM25 only — the embedding and the rerank passage are both built from `concept + content` — so 66.2% of topical tag vocabulary is invisible to two of three channels, including the one that decides final order. Default budget 80 chars. | **+7.4pp success@1** on category queries; adversarial unchanged; ~+5-8% recall latency. 160 chars was byte-identical to 80 |
| `AWM_RETRIEVAL_TEXT` | **(2026-08-24):** include tag terms in the text used for EMBEDDING (derived view; never mutates `content`). | **Rejected — +0.3pp.** The embedder sees the whole memory (~1,965 chars), where eight tag words barely perturb a 384-dim vector. Combined with `AWM_RERANK_TAGS` it adds exactly 0.0pp |
| `AWM_ALIASES` / `AWM_ALIAS_QUERY_CAP` | **(2026-08-24):** expand queries with project-dialect terms mined offline into `data/alias-map.json`. Alias terms reach the BM25 search string ONLY, never `queryTokens` — so an alias-only match arrives with near-zero textMatch and dies at the `minScore` gate. Aliases buy reach; original terms decide relevance. | **Rejected — −0.2pp.** Guardrails worked (adversarial held 90.0%), but PMI over 8-memory categories is too thin; ~half the mined dialect is coincidence |
| `AWM_TEMPORAL` / `AWM_TEMPORAL_BOOST` | **(2026-08-24):** parse temporal expressions ("last Friday", "in May 2026") out of the query, strip them from the lexical channel, and PREFER (never filter) candidates in the implied window. Requires an explicit cue — a BARE date is left alone, because memories carry dates as part of their subject. | **Strip works** (+3–8pp: telling AWM *when* previously COST 3–8pp). **Window preference +4.0pp, below its pre-registered 10pp bar.** Oracle ceiling is 96% vs 58.4% control — the gap needs candidate injection, not a bigger boost |
| `AWM_SNIPPET_WEIGHT=rarity\|anchor` | **(2026-08-24):** weight snippet-window selection by term rarity, or anchor the window on the rarest matched term. Affects `granularity: compact` only. | `anchor` lifts compact sufficiency 19.7%→35.0% (held out). Compact still delivers the answer only 35% of the time vs 100% for `full`, so it is not a route to defaulting compact |
| `AWM_EMBED_MODEL` / `AWM_EMBED_DIMS` | Swap the embedding model and dimension. Storage is dimension-agnostic; `normalize: true` keeps dot-product cosine valid for any model. | **bge-base 768d rejected — +0.7pp alone, −1.1pp combined.** ⚠️ `cosineSimilarity` returns **0** on dimension mismatch, so a partial re-embed silently zeroes the vector channel — migrate the whole corpus or not at all |

**2026-07-30 flag ablation (MWA gauntlet, memory suite, k=3 each — see
`docs/gauntlet-baseline-2026-07-30.md`):** defaults 67%±18 · bridge/autotag/edges 59%±5 ·
expansion-only 63%±14 · all-four 74%±10 · entity-index config 74%±5. No single-factor cell
reproduced the combined wins; all CIs overlap at k=3 — no default flip without a k≥10 run.

### 0.11.x additions (Waves 1–3 + D11, 2026-07-30)

**Write-path telemetry (D1)** — always-on slow-write attribution:

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_SLOW_WRITE_MS` | `250` | Any write slower than this logs one stderr line with embed/novelty/persist phase times, event-loop lag, in-process consolidation state, `SQLITE_BUSY` flag, and embed-model cold-load ms. `0` disables. |

**Security defaults (D2):**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_BIND` | `127.0.0.1` | HTTP server bind address. Widening beyond loopback **without** `AWM_API_KEY` refuses to start (fail-closed). |
| `AWM_ALLOW_INSECURE` | unset | `1` overrides the fail-closed gate on trusted networks. |
| `AWM_COORD_REQUIRE_TOKENS` | unset | `1` makes coordination endpoints reject requests with an absent session token (closes the omit-the-header bypass). |

**Instance identity (D3):** `memory_whoami` MCP tool / `GET /whoami` — agent id, workspace,
mode, backend, store path, code provenance, ports, and sibling agent spaces in the store.
`GET /health` now also reports `consolidation.schedulerDisabled` / `cycleRunning` / active-cycle age (D15).

**Configurable salience feedback detection (D4):** `AWM_FEEDBACK_NAMES` / `AWM_FEEDBACK_VERBS`
(comma lists) replace the hardcoded staff-name regex used for user-feedback auto-promotion.

**Memory spine (D5/D8, log-only):** writes accept `origin_class`
(`user-stated | tool-output | inference | recipe`), `writer_session`, `recipe_id`,
`valid_from`, `valid_to`. Recorded on every backend; **never used in ranking** until an eval
proves benefit (D6). Recall output flags superseded-but-still-ranking memories
(`⚠ SUPERSEDED by <id>`) and shows `[valid until …]`.

**Cognition recipes (D14):** AWM contains no LLM — `src/recipes/` ships versioned prompt+contract
pairs (`skill-derivation@1`, `friction-lesson@1`) the HOST agent runs as a separate focused pass;
`memory_task_end` responses carry the invitations, and `memory_write` validates recipe-attributed
write-backs (unknown recipe ids and malformed shapes rejected with the contract echoed).

**Entity index (D9):** `entity_mentions(entity, engram_id, agent_id)` +
`entity_aliases(alias, entity)` tables on all three backends, populated at write time from
structured sources only (prefix tags like `person=`/`ticket=`, auto-tagger `entity:` tags),
normalized `key:value` lowercase. Store API: `recordEntityMentions()`, `getEngramIdsByEntity()`
(alias-resolving), `searchEntities()` (mentions ∪ aliases). Retrieval uses it only behind
`AWM_ENTITY_INDEX_FETCH` (see the flag table above).

---

## Salience Scoring Formula

**Weights:**
- Surprise: 30%
- Decision made: 25%
- Causal depth: 25%
- Resolution effort: 20%

**Event type bonuses:**
- `observation`: +0.0
- `decision`: +0.15
- `friction`: +0.20
- `causal`: +0.20
- `surprise`: +0.25

**Disposition thresholds:**
- Score >= 0.4 -> `active`
- Score >= 0.2 -> `staging`
- Score < 0.2 -> `discard`

**Reason codes (audit trail):**
- `high_surprise` — surprise > 0.5
- `decision_point` — decision was made
- `causal_insight` — causalDepth > 0.5
- `high_effort_resolution` — resolutionEffort > 0.5
- `event:{type}` — event type used
- `disposition:{result}` — final placement

---

## Activation Pipeline Phases

| Phase | Signal | Weight | Description |
|-------|--------|--------|-------------|
| 0 | Query Expansion | - | Adds synonyms via flan-t5-small (optional) |
| 1 | Vector Embedding | - | Embeds query with MiniLM (384d) |
| 2 | BM25 Retrieval | - | FTS5 full-text search + all active pool |
| 3a | BM25 Score | 0-1 | Normalized FTS5 rank: `\|rank\| / (1 + \|rank\|)` |
| 3b | Jaccard Score | 0-1 | Stopword-filtered word overlap (60% concept, 40% content) |
| 3c | Concept Bonus | 0-0.3 | Exact concept term overlap |
| 3d | Vector Similarity | 0-1 | Cosine similarity mapped 0.2-0.6 -> 0-1 |
| 3e | Text Match | 0-1 | `max(keyword, vector)` |
| 4 | ACT-R Decay | real | `ln(n+1) - d * ln(age / (n+1))` |
| 5 | Hebbian Boost | 0-0.5 | Average association weight, capped |
| 6 | Composite | 0-1 | `(0.6 * text + 0.4 * temporal * relevanceGate) * confidence` |
| 7 | Graph Walk | 0-0.2 | BFS depth 2, hop penalty 0.3, per-engram cap 0.2 |
| 8 | Reranker | 0-1 | Cross-encoder blend: `0.4 * composite + 0.6 * rerankerScore` |
| 9 | Abstention | - | If top reranker score < threshold, return empty |

---

## Engram Stages (State Machine)

```
write ──> [Salience Filter]
              |
              ├── score >= 0.4 ──> ACTIVE ──> [Eviction] ──> ARCHIVED
              |                       |
              |                       └── [Retraction] ──> RETRACTED
              |
              ├── score >= 0.2 ──> STAGING ──> [Sweep: resonant?]
              |                                    |
              |                                    ├── yes ──> ACTIVE
              |                                    └── no  ──> DELETED
              |
              └── score < 0.2 ──> DISCARDED (not stored)
```

---

## Hebbian Learning

**Strengthening** (on co-activation):
```
log_new = log(weight) + signal * log(1 + rate)
weight = min(exp(log_new), 5.0)     // MAX_WEIGHT cap
```
Default rate: 0.25, default signal: 1.0

**Decay** (periodic):
```
weight = max(weight * 2^(-days / halfLife), 0.001)   // MIN_WEIGHT floor
```
Default half-life: 7 days

**Co-activation window:** 5 seconds (buffer size: 50 entries)

---

## Database Schema

### engrams
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| agent_id | TEXT | Agent isolation |
| concept | TEXT | Short label |
| content | TEXT | Full detail |
| embedding | BLOB | Float32Array (384 * 4 bytes) |
| confidence | REAL | 0-1, updated by feedback |
| salience | REAL | 0-1, set at write time |
| access_count | INTEGER | Incremented on activation |
| last_accessed | TEXT | ISO datetime |
| created_at | TEXT | ISO datetime |
| salience_features | TEXT | JSON |
| reason_codes | TEXT | JSON array |
| stage | TEXT | staging / active / fading (v0.8.5) / consolidated / archived |
| ttl | INTEGER | Milliseconds (staging only) |
| retracted | INTEGER | 0 or 1 |
| retracted_by | TEXT | FK to correction engram |
| retracted_at | TEXT | ISO datetime |
| tags | TEXT | JSON array |
| episode_id | TEXT | FK to episodes |
| task_status | TEXT | open/in_progress/blocked/done (null if not a task) |
| task_priority | TEXT | urgent/high/medium/low (null if not a task) |
| blocked_by | TEXT | FK to blocking task engram |
| origin_class | TEXT | Memory spine (D5, 2026-07-30): `user-stated` / `tool-output` / `inference` / `recipe` — log-only |
| writer_session | TEXT | Session id that wrote this engram (D5) |
| recipe_id | TEXT | Cognition recipe that produced it, e.g. `skill-derivation@1` (D14) |
| valid_from | TEXT | Bi-temporal validity start (D8) |
| valid_to | TEXT | Bi-temporal validity end — shown as `[valid until …]` in recall (D8) |

### associations
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| from_engram_id | TEXT FK | |
| to_engram_id | TEXT FK | |
| weight | REAL | 0-5, learnable |
| confidence | REAL | 0-1 |
| type | TEXT | hebbian/connection/invalidation |
| activation_count | INTEGER | Times used in retrieval |
| created_at | TEXT | ISO datetime |
| last_activated | TEXT | ISO datetime |

### entity_mentions (D9, 2026-07-30)
| Column | Type | Notes |
|--------|------|-------|
| entity | TEXT | Normalized `key:value` (e.g. `person:seetha`, `ticket:18999`) — PK with engram_id |
| engram_id | TEXT | Engram mentioning the entity |
| agent_id | TEXT | Agent scope (indexed with entity) |

Populated best-effort on every write from structured sources only (prefix tags,
auto-tagger `entity:` tags). Retrieval reads it only behind `AWM_ENTITY_INDEX_FETCH`.

### entity_aliases (D9)
| Column | Type | Notes |
|--------|------|-------|
| alias | TEXT PK | Alternate name, normalized lowercase |
| entity | TEXT | Target entity in entity_mentions |

### engrams_fts (FTS5 virtual table)
Full-text search index on concept, content, tags. Auto-synced via triggers.

### activation_events
Logs every retrieval query: context, result count, top score, latency.

### staging_events
Logs consolidation decisions: promoted, discarded, expired.

### retrieval_feedback
Ground truth: engram ID, useful (boolean), context.
