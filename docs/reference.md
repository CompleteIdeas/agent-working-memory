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
  "questions": ["string"],                                  // 0.22 — up to 5, keyword-indexed only
  "slot": "entity.attribute",                               // 0.22 — supersedes the slot's holder
  "supersedes_slot": true,                                  // 0.22 — false keeps a second fact
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

**Response — 201 when a new engram was stored (`action: create | supersede`), including a
low-salience write:**
```json
{
  "stored": true,
  "action": "create | supersede",                   // 0.7.17 — write-pipeline action
  "disposition": "active | staging | low-salience", // low-salience = stored active, tagged `low-salience`, confidence 0.25
  "salienceDisposition": "active | staging | discard", // the salience filter's raw decision
  "salience": 0.62,
  "reasonCodes": ["causal_insight", "event:causal", "class:structural", "disposition:active"],
  "engram": { ... },
  "supersedeOf": { "id": "uuid" },                  // action=supersede only
  "questions": { "kept": ["…"], "dropped": [{ "question": "…", "reason": "invalid | over-limit" }] }, // with `questions` (0.22)
  "slot": { "slot": "…", "replaced": { "id": "…", "concept": "…" } | null, "keptAsHistoryOf": "uuid | null" }, // with `slot` (0.22)
  "redaction": [ ... ]                              // only when redaction found something (0.21)
}
```

**Response — 200 when the write was merged into an existing memory (novelty match):**
```json
{
  "stored": false,
  "action": "reinforce",
  "disposition": "reinforced",
  "engram": { ... },                                // the memory that now holds the fact
  "reinforce": { "previousConfidence": 0.5, "newConfidence": 0.55, "previousAccessCount": 2 },
  "novelty": 0.12,
  "questions": { ... }, "slot": { ... }, "redaction": [ ... ],   // each only when present
  "aliases": { "entity": "…", "registered": ["…"], "replaced": [{ "alias": "…", "previous": "…" }] } // with `aliases` (0.22.3)
}
```

Nothing is discarded any more: a write the salience filter scores below `stagingThreshold` is
still stored (see [Salience Scoring Formula](#salience-scoring-formula)). The 201 reply does not
echo the `aliases` outcome (only the 200 reply and MCP `memory_write` do). `400` when `agentId`,
`concept` or `content` is missing. Code: `src/api/routes.ts` (`POST /memory/write`).

### POST /memory/write-batch

Bulk write for importers and benchmarks. **Bypasses the write pipeline**: no salience filter, no
novelty/reinforce merge, no slots or questions — every memory is created `active` at salience 0.5
and confidence 0.5, then the batch is embedded in one pass (redacted text, as stored).

**Request:**
```json
{
  "agentId": "string (required)",
  "sessionId": "string (optional) — tagged sid=<id> on every memory",
  "memories": [
    { "concept": "string", "content": "string", "tags": ["string"],
      "supersedes": "uuid (optional) — old engram is superseded, confidence 0.1, archived",
      "sessionId": "string (optional) — per-memory override" }
  ]
}
```

**Response (201):** `{ "stored": 2, "results": [{ "id": "…", "concept": "…", "disposition": "active" }, …] }`
— `400` when `agentId` or a non-empty `memories` array is missing.

### POST /memory/activate

**Request:**
```json
{
  "agentId": "string (required)",
  "context": "string (required) — what you're thinking about",
  "limit": 10,                    // default 10 (the MCP tool defaults to 3)
  "minScore": 0.01,
  "includeStaging": false,
  "useReranker": true,
  "useExpansion": false,          // default follows AWM_DEFAULT_EXPANSION (off since 0.22.1)
  "abstentionThreshold": 0,       // >0 = strict: 3 of 3 channels, legacy reranker threshold
  "requireConfidence": 0,         // >0 = withhold when recall confidence is below it
  "workspace": "string (optional) — recall across every agent in this workspace",
  "granularity": "full | compact | auto",  // default full
  "bm25Only": false               // accepted and passed through, but the 0.22.4 engine does not act on it
}
```

**Response:**
```json
{
  "confidence": 0.71,             // recall confidence, top level (0 when nothing returned)
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
    "associations": [...],
    "confidence": 0.71,           // same value on every result
    "activationEventId": "…",     // pass to /memory/feedback
    "conflictsWith": [{ "id": "…", "newer": true, "slot": "time | date | money | number | status" }], // when present
    "summary": "…",               // granularity compact/auto only
    "signal": { "band": "answer | low | withhold", "score": 0.4, "answerAt": 0.3, "withholdBelow": 0.1 }
                                  // only with AWM_ABSTAIN_GATE=calibrated
  }]
}
```

An empty `results` can mean nothing matched or that a gate withheld the answer; the MCP tool says
which (`RECALL ABSTAINED`), the HTTP route does not. Pipeline: [Activation Pipeline Phases](#activation-pipeline-phases).

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

### GET /memory/about *(0.22.3)*

Every memory indexed under one entity, oldest first (by `valid_from` when set, else write
time). Query: `agentId`, `entity` (a name, alias or key), optional `workspace`, `limit`
(default 50; the newest are kept), `includeSuperseded` (default true), `includeStaging`
(default false). Resolution: exact key → the agent's alias (then a shared one) → exact value
after `key:` → otherwise substring candidates. A name naming two entities is `ambiguous`.

```
GET /memory/about?agentId=maya&entity=jenna
→ { "status": "found", "entity": "contact:events@harborhotel.example", "matchedBy": "alias",
    "matchedTerm": "jenna", "candidates": [], "aliases": ["jenna", "jenna park"], "total": 4,
    "omitted": 0, "memories": [{ "id": "…", "concept": "Deposit invoice 1043", "date": "2026-10-28T00:00:00.000Z",
    "superseded": false, … }, …] }
GET /memory/about?agentId=maya&entity=Jenna%20Park
→ { "status": "ambiguous", "candidates": ["contact:jenna park", "person:jenna park"], "memories": [], … }
```

### POST /memory/alias, DELETE /memory/alias, GET /memory/aliases *(0.22.3)*

`POST { agentId, alias, entity }` registers `alias → entity` for that agent and returns
`{ alias, entity, previous }` (`previous` is the entity it pointed at before, else null).
`entity` must be `key:value` (`person:…`, `contact:…`, `org:…`, `event:…`, `entity:…`).
`DELETE { agentId, alias }` → `{ removed }`. `GET /memory/aliases?agentId=…[&entity=…]` lists
the agent's aliases plus shared ones. `POST /memory/write` also accepts `aliases: string[]`
(and `aliasFor` when the write names more than one person/contact/org/event/entity tag).

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

### POST /agent/register

**Request:** `{ "name": "string" }`
**Response (201):** `{ "id": "<new uuid>", "name": "…", "config": { …DEFAULT_AGENT_CONFIG } }` —
mints an id and echoes the default config. Nothing is persisted; any string works as an
`agentId` without registering.

### POST /system/evict

**Request:** `{ "agentId": "string" }`
**Response:** `{ "evicted": 5, "edgesPruned": 12 }`

### POST /system/decay

**Request:** `{ "agentId": "string", "halfLifeDays": 7 }`
**Response:** `{ "edgesDecayed": 23 }`

### POST /system/consolidate

Runs a full consolidation ("sleep") cycle for one agent now, synchronously — the same pass the
scheduler runs at `AWM_CONSOLIDATION_CRON` or on quiescence, and it works with the scheduler
disabled.

**Request:** `{ "agentId": "string" }`
**Response:** the cycle's counters — `{ clustersFound, edgesStrengthened, edgesCreated,
bridgesCreated, edgesDecayed, edgesPruned, edgesNormalized, memoriesForgotten, memoriesArchived,
memoriesFaded, redundancyPruned, confidenceAdjusted, stagingPromoted, stagingDiscarded,
engramsProcessed, synthesesCreated }` (`ConsolidationResult`, `src/engine/consolidation.ts`).

### POST /system/time-warp *(test utility)*

Shifts one agent's engram `created_at` / `last_accessed` and its associations' `created_at` /
`last_activated` back by `days`, so decay and lifecycle tests can age a store without waiting. It
is always registered, it rewrites real data, and it cannot be undone: never call it against a
store you care about.

**Request:** `{ "agentId": "string", "days": 30 }`
**Response:** `{ "shifted": 120, "days": 30 }` (`shifted` = engram rows + association rows changed)

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
With none: `{ "task": null, "message": "No actionable tasks" }`.

### POST /memory/checkpoint

Saves the agent's explicit execution state (what `memory_checkpoint` does over MCP).

**Request:**
```json
{
  "agentId": "string (required)",
  "currentTask": "string (required)",
  "decisions": ["string"], "activeFiles": ["string"], "nextSteps": ["string"],
  "relatedMemoryIds": ["uuid"], "notes": "string", "episodeId": "string | null"
}
```
**Response:** `{ "saved": true, "agentId": "…" }`

### GET /memory/restore/:agentId

Returns the last checkpoint plus context to resume from: a recall (limit 5, minScore 0.05)
against the last recall context, or else the checkpoint's `currentTask`. Idle for more than
5 minutes also starts a mini-consolidation in the background.

**Response:**
```json
{
  "executionState": { "currentTask": "…", "decisions": [], ... } ,
  "checkpointAt": "ISO datetime | null",
  "recalledMemories": [{ "id": "…", "concept": "…", "content": "…", "score": 0.8 }],
  "lastWrite": { "id": "…", "concept": "…", "content": "…" },
  "idleMs": 420000,
  "miniConsolidationTriggered": true
}
```

### GET /memory/export

**Query:** `?agentId=<id>` (optional; all agents when absent) `&all=true` (include retracted and
non-active memories; default active, unretracted only).
**Response:** `{ exported_at, agent_id, include_all, engrams_count, associations_count, engrams,
associations }` — engram rows in `created_at` order, with only the associations whose both ends are
exported. Engram rows carry the core columns (no embeddings, no 0.8+ columns). **SQLite only**:
`501` on PGlite/Postgres; use the `awm` CLI export there.

### GET /whoami

**Query:** `?agent=<id>` (default `AWM_AGENT_ID`, else `default`).
**Response:** instance identity — agent id, workspace, mode, backend, store path, code provenance,
ports and sibling agent spaces in the store (`src/core/whoami.ts`; the same report as MCP
`memory_whoami`, with `surface: "http"`).

### GET /health

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-11-15T…",
  "version": "0.22.4",
  "coordination": false,
  "recall": { "fingerprint": "…", "flags": { "AWM_RERANK_TAGS": "1", ... } },  // flags = recall env vars that are set
  "store": { "live": true },
  "consolidation": { "schedulerDisabled": false, "cycleRunning": false, "activeCycle": { ... } },
  "models": { "enabled": true, "mode": "daemon", "fingerprint": "…", "daemonPid": 1234, "requests": 10,
              "queueTimeouts": 0, "fallbacks": 0, "lastFallbackReason": null, "lastFallbackAt": null },
  "embeddingIntegrity": { "status": "degraded", "dimensionMismatches": 3, "expectedDimensions": 384, "sample": { ... } }
}
```
`recall.fingerprint` / `flags` are the server's active recall configuration, so a benchmark can
assert it measured the config it set. `consolidation.activeCycle` appears only while a cycle runs;
`models` only when the model daemon is enabled; `embeddingIntegrity` only when stored vectors have
the wrong dimension. With `AWM_COORDINATION` on (SQLite), also `agents_alive`, `pending_tasks`,
`active_locks`.

### Coverage

The 32 routes in `src/api/routes.ts` are all documented above (32 of 32). The coordination
routes (`src/coordination/routes.ts`, registered only with `AWM_COORDINATION=true`) are not
covered by this page.

---

## Hook Configuration

`awm setup --global` installs **five** hook groups into `~/.claude/settings.json`,
and since 0.14.6 they are **shipped script files**, not inline `curl`. The block
below is the shape the installer writes — use it to audit what was installed.
`<hooks>` stands for `~/.claude/hooks/` (or the plugin's own hooks directory).

```jsonc
{
  "hooks": {
    "Stop":             [{ "matcher": "",                "hooks": [{ "type": "command", "command": "node \"<hooks>/awm-used.cjs\"",                  "timeout": 6, "async": true }] }],
    "PreCompact":       [{ "matcher": "",                "hooks": [{ "type": "command", "command": "node \"<hooks>/awm-checkpoint.cjs\"",            "timeout": 10 }] }],
    "SessionEnd":       [{ "matcher": "",                "hooks": [{ "type": "command", "command": "node \"<hooks>/awm-checkpoint.cjs\"",            "timeout": 8  }] }],
    "UserPromptSubmit": [{ "matcher": "",                "hooks": [{ "type": "command", "command": "node \"<hooks>/awm-prime.cjs\"",                 "timeout": 6  }] }],
    "PostToolUse":      [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node \"<hooks>/awm-db-mutation-reminder.cjs\"",  "timeout": 10 }] }]
  }
}
```

**What each hook does:**

| Hook | When it fires | What happens |
|---|---|---|
| `Stop` | After every Claude response | **(0.20)** `awm-used.cjs` prints the write / recall / switch-tasks reminder and POSTs the transcript path to `/hooks/used`; the sidecar reads the turn's reply and tool calls and credits the recalled memories they drew on (implicit feedback). Before 0.20 this was a local `echo` with no network call. |
| `PreCompact` | Before context compaction | `awm-checkpoint.cjs` POSTs to the sidecar's `/hooks/checkpoint`, saving execution state so it survives the compress. |
| `SessionEnd` | When the conversation closes | The same checkpoint script; the sidecar also triggers a consolidation pass. |
| `UserPromptSubmit` | Every prompt you send | `awm-prime.cjs` POSTs to `/hooks/prime` and injects relevant memories *before* Claude sees the prompt. Omit it with `awm setup --no-prime`. |
| `PostToolUse` | After `Bash`/`PowerShell` calls | A reminder that a production data change is not complete until it is `memory_write`n. |

> **Corrected 2026-10-09 — the sidecar has no `/hook/*` routes and never did.**
> It serves exactly six: `GET /health`, `GET /stats`, `POST /memory/activate`,
> `POST /hooks/prime`, `POST /hooks/checkpoint` and (since 0.20) `POST /hooks/used`
> (`src/hooks/sidecar.ts`).
> Until this revision, this page offered hand-written `curl` to `/hook/stop`,
> `/hook/pre-compact` and `/hook/session-end` "if `awm setup` failed and you
> need to add them manually" — three paths that do not exist. Because Claude Code
> hooks fail open and `curl -fsS` is silent, anyone who copied that block got
> three hooks POSTing to 404s with no error. It also described `Stop` as doing
> sidecar work, and hardcoded port 8401 when the port is discovered across
> `[AWM_HOOK_PORT, +AWM_HOOK_PORT_RANGE)`. Prefer `awm setup`; verify with
> `awm doctor claude-code`.

**The hook sidecar:**

The sidecar is a separate HTTP server bundled with AWM, run automatically
when the MCP server starts, on `127.0.0.1` only. Since 0.14.2 it binds the
**first free port** in `[AWM_HOOK_PORT, AWM_HOOK_PORT + AWM_HOOK_PORT_RANGE)`
— default `8401` with a range of `10`, so `8401..8410`. Authentication is via the `Authorization:
Bearer ${AWM_HOOK_SECRET}` header — set this env var to anything random and
`awm setup --global` stores it in the MCP config. Since 0.14.6 the hook scripts
**read it from there at run time** rather than having it baked into
`settings.json`, so rotating the secret does not leave them silently 401-ing.

**Port collisions are handled for you (0.14.2).** Running several AWM agents at
once (e.g. "work" and "personal" pools per the
[Quickstart](quickstart.md#separate-memory-pools-optional)) needs no manual port
assignment: the second server finds 8401 taken and walks to 8402. `/health`
reports the port it actually bound and the agent it serves, and the shipped hook
scripts probe the range and pick the sidecar matching the session's own agent —
so a hook never talks to whichever server happened to grab 8401 first.

| Variable | Default | What it does |
|---|---|---|
| `AWM_HOOK_PORT` | `8401` | First port the sidecar tries |
| `AWM_HOOK_PORT_RANGE` | `10` | How many ports to walk upward before giving up. `awm setup --hook-port-range N` writes it |
| `AWM_HOOK_SECRET` | generated | Bearer token. Stored in the MCP config and read by the hooks at run time, never written into `settings.json` |
| `AWM_PRIME_QUERY_CHARS` | `400` | The prime hook recalls with at most this many characters of the prompt (`0` = the whole prompt). A longer prompt loses its machine lines (logs, code, JSON, diffs, stack frames), task-notification envelopes and boilerplate, keeps up to two error lines, and is cut to the head and tail of its prose. Recall only: the agent still sees the whole prompt. A shorter prompt is used as typed. `src/hooks/prime-query.ts` |
| `AWM_HOOK_DEBUG` | unset | *(diagnostic)* Any value makes the shipped hook scripts append one JSON line per hook run to `~/.claude/hooks/awm-hooks.log` |
| `AWM_SETUP_HOME` | `$HOME` | Overrides the home directory for `awm setup` / `awm doctor`, so an upgrade can be rehearsed against a scratch tree |

The shipped hook scripts carry a version stamp (`AWM_HOOKS_VERSION`, currently
`0.20.0`, `src/adapters/hook-scripts.ts`); `awm doctor` compares it against what is installed and tells you when a
re-run of `awm setup` would change something.

**Verifying the hooks installed correctly:**

```bash
# Show the installed hook config
cat ~/.claude/settings.json | python -m json.tool

# Confirm the sidecar is listening — prefer `awm doctor`, which probes the whole
# range, reports `port=agent@version pid` for each live sidecar, and warns when
# none of them serves the agent this directory is configured for.
awm doctor claude-code

# Or by hand, remembering the port may have walked past 8401:
curl -fsS -H "Authorization: Bearer $AWM_HOOK_SECRET" \
  http://127.0.0.1:8401/stats
# {"writes": N, "recalls": N, "hooks": N, "total": N}
```

If `curl` returns `401`, the secret is wrong. If `connection refused`,
the sidecar isn't running. Restart Claude Code, or run `awm doctor claude-code`,
which probes the port range and reports which sidecars are live. Note that
`awm serve` starts the **HTTP API only** and no sidecar — the sidecar is started
by the MCP process — so its output will not tell you anything about this.

---

## Configuration Defaults

All values from `DEFAULT_AGENT_CONFIG` in `src/types/agent.ts`. Two consolidation
keys live there too and are not repeated in the sections below:
`consolidationIntervalMs` (`300_000` — how often to look for merge candidates) and
`consolidationSimilarity` (`0.85` — the threshold above which similar engrams merge).

### Salience

| Setting | Default | Meaning |
|---------|---------|---------|
| `salienceThreshold` | `0.4` | Minimum score for active storage |
| `stagingThreshold` | `0.2` | Minimum score for staging. Below it the salience filter says `discard`, but the write pipeline still stores the memory **active**, tagged `low-salience`, at confidence 0.25 |
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

Recall is a funnel: candidate generation → composite scoring → fused shortlist → **rerank pool**
→ cross-encoder rerank → agreement gate → blend and first-place rule (0.21.1 / 0.22.4) → optional
calibrated gate; phase by phase in [Activation Pipeline Phases](#activation-pipeline-phases). A 2026-06 pipeline-attribution study (LoCoMo, N=616 answerable) found
~50% of answerable queries had gold that *cleared the candidate floor* but was squeezed out of the
rerank pool by the (decay-compressed) composite before the high-lift reranker saw it. Widening the
pool + scoping the abstention gate to the returned top-K lifted LoCoMo recall 22.7%→25.7% (every
category up) **and** adversarial precision 73.4%→74.9%, with no 4-suite/edge/workday regression and
recall ~35→77ms. These env vars expose the knobs; the **defaults are the validated values**.

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_RERANK_POOL` | `max(limit*4, 32)` | How many candidates reach the cross-encoder reranker — 32 at the MCP default k=3 (`src/engine/activation.ts`). Wider = more retrievable gold reaches the reranker (recall ↑) at more (query,passage) pairs (latency ↑). Before this cut, the shortlist carried into graph walk and rerank is `max(limit × AWM_TOPN_MULT, pool)`, chosen by reciprocal-rank fusion of the BM25, vector and composite ranks (0.21.1; `AWM_PRESELECT=composite` restores the composite-only cut). *History: documented as `max(limit*4, 40)` from 0.9.0; until 0.21.1 the topN cut held it to 24 at k=3.* |
| `AWM_RERANKER_DTYPE` | `q8` | Cross-encoder weight precision: `q8` (**default since 0.19**) or `fp32` (the 0.18 default; every number published before 0.19 was measured at fp32). The cross-encoder is ~83% of warm recall latency, so this is the largest single latency lever in the system — `q8` cuts total recall p50 **26–33%** and the ONNX file it loads from 91 MB to 23 MB. **It changes ranking outcomes**: measured cost is one query in 450 on the topic suite. Correct abstention is unmoved on all three suites; `success@5` is unmoved on both private suites and moves **+0.5pp** on the public corpus, within that corpus's 4pp seed-noise floor. Every published number is measured at `fp32`. `q4` is dominated — equal accuracy, only −3% latency, 6,080 ms cold start. **Read once at module import and the model is then cached, so it needs a process restart** — not a live env change; confirm via the `Re-ranker model loaded in-process: … (q8)` stderr line. See [deployment.md → Operating modes](deployment.md#operating-modes-quality-first-and-latency-first). |
| `AWM_RERANK_QUERY_TOKENS` | `128` | A longer query reaches the cross-encoder as its first and last halves (`0` = uncut). Without it, transformers.js truncates a too-long pair from the **end**, which is the passage. A ~510-token query (a prompt carrying a paste) left every passage empty and every score equal. Measured on 100 fixture queries wrapped in a ~600-token paste: success@1 3% → 49% (question before the paste), 7% → 26% (question after it); short queries unchanged. It also bounds memory, below. |
| `AWM_RERANK_BATCH` / `AWM_EMBED_BATCH` | `8` / `8` | Pairs per cross-encoder pass, texts per embedder pass (`0` = all at once). onnxruntime-node's CPU arena keeps the largest tensor a model has ever run for the life of the process, and attention is quadratic in padded length. Measured: an MCP process went 3,964 MB → 1,173 MB on the same workload with all three caps on. Results are unchanged (scores and vectors match to 1e-5). |
| `AWM_MODEL_DAEMON` | on for `awm mcp` and `awm serve`; off for library use | **On by default since 0.19 for the two server entry points** (`0` disables): the first recall of every session after the first drops from ~4 s to the warm ~0.6 s. For embedded callers, `1` sends embed, rerank and expand to one shared per-user model process instead of loading the three models in every AWM process. Four sessions recalling at once: 4,825 MB → 1,730 MB in total, at the same speed (12.3 → 11.6 min of wall time for the same work). The daemon is started by the first AWM process that needs it, is keyed by a fingerprint of the inference config (two versions or configs get two daemons), authenticates both ways with a token in `~/.awm/run`, and exits when no AWM process has been connected for `AWM_MODEL_DAEMON_IDLE_MS`. If it cannot be reached, inference runs in-process as before and is probed again in the background (60 s, doubling to 15 min); `memory_whoami` and `GET /health` report the mode, the daemon pid and each fallback with its reason. Results are identical to in-process. `src/core/model-daemon.ts` |
| `AWM_SQLITE_CACHE_MB` / `AWM_SQLITE_MMAP_MB` | `64` / `256` | **(0.19)** SQLite page cache and mmap size for the store connection. The store had run on SQLite's 2 MB default cache against a ~270 MB file, so the BM25 and association-stats phases paid page faults: 42 / 14 ms at p50 but 156 / 167 ms at p95 (2026-10-19 profile). No effect on results; `0` restores the SQLite default. |
| `AWM_PRIME_CACHE_MS` | `60000` | **(0.19)** The prime hook serves its last injection again for the same shaped question (same agent, same thresholds) within this window instead of running the ~600 ms recall on every prompt. Priming is advisory context nobody asked for, so a repeat within a minute costs nothing in accuracy. `0` disables. |
| `AWM_SESSION_ID` / `AWM_SESSION_TTL_DAYS` | process id / `7` | **(0.20)** The MCP process's session: every write carries it as `writer_session`; it adopts Claude Code's own session id from the first hook that carries one unless `AWM_SESSION_ID` pins it. `memory_write(scope: "session")` notes are active whatever their salience, ephemeral, never merged into durable memories, and archived after the TTL. `memory_recall(scope: "session")` / `session_first`; `memory_restore` prefers this session's checkpoint. |
| *(Stop hook, 0.20)* | on | `awm-used.cjs` posts the transcript path to `/hooks/used` after every turn; the sidecar credits the recalls whose identifiers appear in the reply or its tool calls (`src/core/implicit-feedback.ts`). Before this the live store had 12 feedback rows against 23,653 recalls. Positives only; `memory_feedback` remains the way to say a recall was not useful. |
| `AWM_MODEL_DAEMON_IDLE_MS` | `300000` | The daemon exits this long after its last client disconnects (`0` = never). |
| `AWM_MODEL_DAEMON_START_MS` | `20000` | How long an AWM process waits for a daemon to start before running in-process. A daemon that exits with an error ends the wait at once. |
| `AWM_MODEL_DAEMON_TIMEOUT_MS` / `AWM_MODEL_DAEMON_QUEUE_MS` | `120000` / `600000` | Each step of a started request (one chunk, for an embed) must finish within the first (a stuck daemon). A request may wait in the daemon's queue for the second, including between chunks (a busy daemon is not a failure); a request that gives up is dropped by the daemon. |
| `AWM_MODEL_DAEMON_STUCK_MS` | `AWM_MODEL_DAEMON_TIMEOUT_MS` | A daemon whose current step has run this long (at least 10 min for a warm, which may download the models) is wedged and exits, so the next AWM process starts a fresh one. The default matches the client's step timeout, so a client that gave up is never left reconnecting to a daemon still stuck on that step. `0` = never. |
| `AWM_RUN_DIR` | `~/.awm/run` | The daemon's token, lockfile and log (and its socket, off Windows). A separate run dir is a separate daemon. It must be private, or the daemon is not used: off Windows, owned by you and not writable by others; on Windows, inside your user profile. |
| `AWM_TOPN_MULT` | `8` | Candidate breadth carried into graph-walk + rerank (`limit × this`, never below the floor below). |
| `AWM_TOPN_MIN` | `AWM_RERANK_POOL`, else `max(limit*4, 32)` | **(0.21.1)** Floor on that shortlist, so it is never shorter than the rerank pool. |
| `AWM_PRESELECT` | fused | **(0.21.1)** The shortlist is cut by reciprocal-rank fusion (k=60) of the composite, BM25 and vector ranks. `composite` restores the composite-only cut. Measured: gold reaching the cross-encoder 71% → 90% on natural-language questions, identifier top-1 91.6 → 93.7. |
| `AWM_ABSTAIN_GATE_K` | `5` | Out-of-domain abstention judges the **post-rerank top-K** (not the whole wide pool), so widening for recall doesn't inflate the in-domain signal. `0` = legacy whole-pool behavior. |
| `AWM_SIM_FLOOR_TARGETED` | `0.50` | Raw-cosine floor below which vector match scores 0 (targeted/precise queries). |
| `AWM_SIM_FLOOR_EXPLORATORY` | `0.35` | Same, for exploratory-mode queries. |
| `AWM_SIM_CANDIDATE_FLOOR_TARGETED` | `0.40` | Min cosine for a vector hit to *enter* the candidate pool (targeted). |
| `AWM_SIM_CANDIDATE_FLOOR_EXPLORATORY` | `0.30` | Same, exploratory. |
| `AWM_DEFAULT_EXPANSION` | `0` | `1` turns phase-0 query expansion on by default and warms the expander at startup. Since 0.22.1 every path follows it: MCP `memory_recall` no longer defaults `use_expansion` to `true`, and `memory_task_begin`, the restore path and the HTTP context route no longer force it. Measured 2026-11-02 on the three realstore suites: identical top-1 with it on (52.6 / 96.0 / 93.8), ~150-220 ms slower per short query. *(This row named `AWM_RECALL_EXPAND` until 2026-10-09 — a variable nothing in `src/` has ever read.)* |
| `AWM_DATABASE_URL` | `postgres://localhost:5432/awm` (used only with `AWM_STORE_BACKEND=postgres`) | Connection string for the networked **Postgres** backend. The only way to point AWM at a Postgres server (`src/storage/factory.ts`); undocumented until 2026-10-09. |
| `AWM_DISABLE_ENTITY_BRIDGE` | unset | Skips the default-ON phase-3.7 entity-bridge boost. **Footgun:** the code tests presence, not value, so `=0` *also* disables it. Unset the variable to re-enable. |
| `AWM_RERANK2` / `AWM_RERANK2_K` | on / `10` | **Default ON since 2026-10-19** (`AWM_RERANK2=0` disables; `src/core/rerank2.ts`). Phase 9b, after the abstention gate. Since 0.21.1, when every candidate has a reranker score, the final order comes from the [blend](#activation-pipeline-phases) (and, since 0.22.4, the first-place rule), not from rerank2's plain re-sort; the re-sort by `rerankerScore` alone (with the stale penalty) applies only when some candidate has no reranker score or `AWM_BLEND=off`. `AWM_RERANK2=0` turns off the blend and the rule too, leaving the phase-9 score order. `K` (10, == return limit) is the re-sorted window. *History (2026-08-24): the re-sort measured **+9.7pp success@1** (LoCoMo paired, p<0.001) with adversarial abstention unchanged (0 broken / 0 fixed), because the pre-rerank2 blend capped `rerankWeight` at 0.7 and the composite disagreed with the cross-encoder about rank 1 on 38.6% of queries, where the cross-encoder was right 77% of the time.* |
| `AWM_RERANK_WINDOW` / `AWM_RERANK_TRUNC` | `query` / `400` | **Default ON since 2026-10-19** (`prefix` restores the prefix passage). Spend the rerank passage budget (`TRUNC` chars) on the window densest in query terms instead of the first N chars. Truncation exists because cross-encoders pad to the longest passage in a batch, but a PREFIX is the wrong budget: canonical memories are median 1,965 chars and 98.7% exceed 400, so the reranker could not see 78.8% of their vocabulary. Measured: long-memory success@1 25% → 87.5%; answer at char 150 scores 0.986, at char 700 it scored 0.000 while BM25 barely moved. Shipped with `AWM_RERANK2` — rerank2 alone dropped long-memory s@5 91.7%→25.0%. |
| `AWM_RERANK_TAGS` / `AWM_RERANK_TAGS_LEN` | on / `80` | **Default ON since 2026-10-19** (`AWM_RERANK_TAGS=0` disables). Append topical (`topic=`/`proj=`) tag terms, up to `LEN` chars, to the rerank passage. Tags are indexed by BM25 only — the embedding and the rerank passage are both built from `concept + content` — so 66.2% of topical tag vocabulary was invisible to two of three channels. Measured: **+7.4pp success@1** on category queries; adversarial unchanged; ~+5-8% recall latency; 160 chars was byte-identical to 80. |

#### Opt-in / experimental retrieval flags (default-off)

| Env var | Meaning | Status |
|---------|---------|--------|
| `AWM_QUERY_BRIDGE` | Query-named entities boost in-pool candidates tagged with them (relevance-modulated). Lifts **attribution** ("what does X think") strongly; small adversarial cost. | Validated, opt-in |
| `AWM_QUERY_BRIDGE_WEIGHT` / `AWM_QUERY_BRIDGE_CAP` / `AWM_QUERY_BRIDGE_FLOOR` | Tuning for `AWM_QUERY_BRIDGE` (phase 3.75): boost = `min(matches × WEIGHT × textMatch, CAP)`, applied only to candidates with `textMatch ≥ FLOOR`. Defaults `0.4` / `0.4` / `0.1`. | Experiment knobs |
| `AWM_AUTOTAG` | Write-time `entity:`/`cat:` meta-tags (feeds the entity-bridge, BM25, and the D9 entity index). | Neutral on recall alone; **required to populate the entity index** for free-text writes; opt-in |
| `AWM_BROAD_EDGES` | Form entity-co-occurrence edges (not just high-cosine) at write time. | Enabler; opt-in |
| `AWM_BROAD_EDGES_MAX` | Max entity-co-occurrence edges per engram with `AWM_BROAD_EDGES=1` (on top of semantic edges). Default `6`. | Experiment knob |
| `AWM_ENTITY_ALIAS_MATCH` | **(0.22.3):** lowercase names in ordinary questions. Lowercase 1–3 word phrases from the question are matched EXACTLY (no substring) against the agent's aliases and the values of name-like entity keys (`person`, `contact`, `org`, `event`, `entity`, `horse`, `member`), and the matched entities go through the same guaranteed-audition path as `AWM_ENTITY_INDEX_FETCH` (no boost, same cap). Works with or without that flag. | Off by default. Measured 2026-11-13: alone it changed nothing on `tests/entity-eval` (the cross-encoder reads only the passage, so it cannot link "jenna" to a memory that says "the events manager"); 0 of 52 matched entities wrong, look-alike sender never matched. Real-store bench unchanged (it fired on 25 of 1,316 identifier and 2 of 450 category probes; the store has no aliases) |
| `AWM_ENTITY_ALIAS_PASSAGE` | **(0.22.3), with `AWM_ENTITY_ALIAS_MATCH`:** appends the question phrase that named a memory's entity to that memory's rerank passage (`[about jenna]`), so the cross-encoder can see the link. Still no score boost. | Off by default. `tests/entity-eval` (68 memories, 56 questions): broad questions that name only the entity, success@5 68.8 → 100, success@1 31.3 → 68.8; specific questions success@1 87.5 → 92.5, success@5 100 → 100. Real-store bench: identifier, category and temporal unchanged; recall p90 +7% identifier, −5% category |
| `AWM_ENTITY_INDEX_FETCH` | **D11 (2026-07-30):** query-named entities (proper nouns, bare numeric ids) resolve through the `entity_mentions`/`entity_aliases` inverted index; matched engrams get NO score boost but a **guaranteed cross-encoder audition** (exempt from the topN cut, minScore floor and rerank-pool slice; the fourth exemption, from the clear-winner rerank skip, became moot when that branch was removed on 2026-10-09). The alias table lets a query reach facts no lexical/vector channel can ("Starbox" → `horse:thunder`). Cap: `AWM_ENTITY_INDEX_CAP` (12). | Gauntlet-accepted (74%±5pp, best floor of 6 configs); opt-in pending k≥10 confirmation |
| `AWM_ENTITY_FETCH` / `AWM_ENTITY_FETCH_SEEDS` / `AWM_ENTITY_FETCH_CAP` | **(2026-06):** from the top `SEEDS` (5) candidates, take capitalised words not in the query, run one BM25 pass on them and add up to `CAP` (30) hits to the pool. Recall-only, no boost. The predecessor of `AWM_ENTITY_INDEX_FETCH`. | **Insufficient at scale** — injected gold entered the pool but was cut before the reranker scored it. Kept opt-in for experiments |
| `AWM_FEEDBACK_BM25` | **(2026-10-09):** Rocchio pseudo-relevance feedback (phase 3.5) — take the top 3 scored results, harvest five novel content tokens, re-search BM25 with the query plus those terms. Shipped ON since 0.5.x; flipped to opt-in the first time anyone measured it. The terms are the first five in DOCUMENT ORDER rather than the top five by weight, which is a plausible reason it underperforms — a weighted selection is a different experiment. | **Rejected as a default — 6.7–7.0% of every recall for nothing measurable.** 3 gold ranks move in 950 queries across three suites, two of them the WRONG way. On the public corpus — the only suite with real recall headroom (s@5 61.5%) — it is inert PER QUERY: 0 of 200 differ in rank, top-1 or score, with an ON-vs-ON determinism check also at 0 |
| `AWM_SPREAD` / `AWM_SPREAD_INJECT` | Iterative PPR/SYNAPSE-style spreading activation over the graph. | **PARKED PERMANENTLY (2026-08-26).** Re-test ran: best-guarded arm fixes **0** queries and breaks 4; injection tested separately and also fixed 0. Superseded for its goal by `AWM_RERANK_TAGS` (+7.4pp). Reopen only if D9/D10 broad entity edges ship. Code kept, default-OFF |
| `AWM_SPREAD_INHIBIT` | **D11:** SYNAPSE-style divisive normalization inside spread iterations — competing receivers suppress each other (the published fix for the displacing-gold regression). `0` (default) = off; `0.3` = re-test value. | **Re-test complete — mechanism WORKS** (λ=0.3 repaired nearly all of unguarded spread's damage: single-hop 46.4→49.6, multi-hop 27.5→30.2) but still lands below baseline. Parked with `AWM_SPREAD` |
| `AWM_SPREAD_ITERS` / `AWM_SPREAD_DAMPING` / `AWM_SPREAD_BUDGET` / `AWM_SPREAD_BOOST` | Spread tuning: iterations `3`, damping `0.5`, node budget `64`, boost scale `0.4` (per-node cap 0.15, total 0.25, fixed). | Parked with `AWM_SPREAD` |
| `AWM_SPREAD_INJECT_MIN` / `AWM_SPREAD_INJECT_CAP` / `AWM_SPREAD_INJECT_SCALE` | Injection tuning with `AWM_SPREAD_INJECT=1`: activation threshold `0.08`, at most `8` injected, scale `1.0`. `AWM_SPREAD_DEBUG=1` prints one `[spread]` stderr line per recall. | Parked with `AWM_SPREAD` |
| `AWM_RETRIEVAL_TEXT` | **(2026-08-24):** include tag terms in the text used for EMBEDDING (derived view; never mutates `content`). | **Rejected — +0.3pp.** The embedder sees the whole memory (~1,965 chars), where eight tag words barely perturb a 384-dim vector. Combined with `AWM_RERANK_TAGS` it adds exactly 0.0pp |
| `AWM_ALIASES` / `AWM_ALIAS_QUERY_CAP` | **(2026-08-24):** expand queries with project-dialect terms mined offline into `data/alias-map.json`. Alias terms reach the BM25 search string ONLY, never `queryTokens` — so an alias-only match arrives with near-zero textMatch and dies at the `minScore` gate. Aliases buy reach; original terms decide relevance. | **Rejected — −0.2pp.** Guardrails worked (adversarial held 90.0%), but PMI over 8-memory categories is too thin; ~half the mined dialect is coincidence |
| `AWM_ALIAS_MAP` | Path to the mined alias map read by `AWM_ALIASES`. Default `data/alias-map.json` in the package; a missing file is not an error. | Rejected with `AWM_ALIASES` |
| `AWM_TEMPORAL` / `AWM_TEMPORAL_BOOST` | **(2026-08-24):** parse temporal expressions ("last Friday", "in May 2026") out of the query, strip them from the lexical channel, and PREFER (never filter) candidates in the implied window. Requires an explicit cue — a BARE date is left alone, because memories carry dates as part of their subject. | **Strip works** (+3–8pp: telling AWM *when* previously COST 3–8pp). **Window preference +4.0pp, below its pre-registered 10pp bar.** Oracle ceiling is 96% vs 58.4% control — the gap needs candidate injection, not a bigger boost |
| `AWM_SNIPPET_WEIGHT=rarity\|anchor` | **(2026-08-24):** weight snippet-window selection by term rarity, or anchor the window on the rarest matched term. Affects `granularity: compact` only. | `anchor` lifts compact sufficiency 19.7%→35.0% (held out). Compact still delivers the answer only 35% of the time vs 100% for `full`, so it is not a route to defaulting compact |
| `AWM_EMBED_MODEL` / `AWM_EMBED_DIMS` | Swap the embedding model and dimension. Storage is dimension-agnostic; `normalize: true` keeps dot-product cosine valid for any model. | **bge-base 768d rejected — +0.7pp alone, −1.1pp combined.** ⚠️ `cosineSimilarity` returns **0** on dimension mismatch, so a partial re-embed silently zeroes the vector channel — migrate the whole corpus or not at all |
| `AWM_EMBED_POOLING` | `mean` (or `cls`) pooling for the embedder (default model `Xenova/bge-small-en-v1.5`, 384d). Changing it changes every vector: re-embed the corpus. | Shipped default `mean`; change only with `AWM_EMBED_MODEL` |
| `AWM_EXPANDER_MODEL` / `AWM_EXPANDER_DTYPE` | Query-expansion model (`Xenova/flan-t5-small`) and its precision (`fp32`); used only when expansion is on. | Measurement knobs (0.22.1) |

**2026-07-30 flag ablation (MWA gauntlet, memory suite, k=3 each — see
`docs/archive/gauntlet-baseline-2026-07-30.md`):** defaults 67%±18 · bridge/autotag/edges 59%±5 ·
expansion-only 63%±14 · all-four 74%±10 · entity-index config 74%±5. No single-factor cell
reproduced the combined wins; all CIs overlap at k=3 — no default flip without a k≥10 run.

### 0.22.0 additions (questions, the natural-language re-ranker, slots, 2026-11-01)

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | The main cross-encoder: keyword-shaped queries, and every query when the natural model is off or fails to load. Loaded at `AWM_RERANKER_DTYPE` (`q8`); a model without that quantized ONNX file fails to load and recall runs without a reranker (reported once on stderr). Process restart to change. |
| `AWM_RERANKER_MODEL_NATURAL` | `cross-encoder/ettin-reranker-17m-v1` | Cross-encoder for natural-language questions (as judged by `src/core/query-shape.ts`); keyword lookups keep `AWM_RERANKER_MODEL`. Loads the int8 file the repository ships for this CPU (`model_quint8_avx2` on x64, `model_qint8_arm64` on ARM), else fp32. `off`, or the main model's own id, uses one model for every query. A natural model that fails to load falls back to the main one, reported once. **Larger Ettin models, measured 2026-11-02** (store with questions, natural-language top-1 / recall p50): 17m 52.6% / ~340 ms; `ettin-reranker-32m-v1` 54.1% / ~730 ms; `ettin-reranker-68m-v1` 58.2% / ~1.6-1.9 s. Topic accuracy is unchanged by all three (96.0%). 68m is the one real gain, at five times the time; cutting its pool (`AWM_RERANK_POOL=16`) loses the gain (53.1%). Opt in where a slow recall is acceptable; refit a calibrated gate after switching. |
| `AWM_BLEND_NATURAL_RANK` | `0.7` | Weight of the natural model's **rank** in the pool when it is blended with the fused BM25 + vector order. Its scores saturate near 1, so its rank is used, not its score. |
| `AWM_BLEND` / `AWM_BLEND_KEYWORD` | `0.85` / `0.95` | (0.21.1) Cross-encoder weight in the final blend for natural questions scored by the main model, and for keyword lookups. `AWM_BLEND=off` sorts by the cross-encoder alone, as before 0.21.1. |
| `AWM_BLEND_QUESTIONS` | `0.5` | Blend weight for a natural question scored by the main model when at least half the candidate pool carries questions. |
| `AWM_BLEND_MODE` | score | `rank` forces the rank blend for every query (experiments). |
| `AWM_BLEND_RECENCY` | `0` | *(experiment)* Adds `w ×` the candidate's creation-time rank in the pool (newest 1, oldest 0) to the blend key, favouring the newer of otherwise similar candidates. Not a default. |
| `AWM_BLEND_SURE` | on | (0.22.4) First place is chosen by a rule; places 2+ keep the blend's order. When the cross-encoder is sure (its top-two margin in logit space is at least the threshold below), its #1 goes first; otherwise a keyword query re-blends for first place with the vector rank counting a quarter; otherwise the blend's #1 stays. `off` restores 0.22.3 exactly. Code: `src/core/blend-rule.ts`. |
| `AWM_BLEND_SURE_KEYWORD` / `AWM_BLEND_SURE_NATURAL` | `1` / `1.5` | (0.22.4) Logit margin between the cross-encoder's top two that counts as sure, for keyword and natural queries. Its sigmoid scores saturate near 1: 0.99 against 0.95 is a margin of 1.7. |
| `AWM_BLEND_VEC_KEYWORD` | `0.25` | (0.22.4) Weight of the vector rank when a keyword query re-blends for first place. On near-template corpora the blend's wrong first places were mostly the vector channel's #1. `1` turns the re-blend into a no-op. |
| `AWM_BLEND_AGREE_RANK` | `1` | (0.22.4) A candidate both channels rank this high or better (0-based, so `1` = top two) keeps the full vector weight in that re-blend. |
| `AWM_GATE_FEATURES` | `1` | `2` selects the eight-signal gate feature set (measured, not better: `docs/abstention-signals-2026-10-30.md` §14). |

**`memory_write` / `POST /memory/write` fields:**

| Field | Meaning |
|---|---|
| `questions` | Up to 5 natural questions the memory answers. Trimmed, 8–300 characters, de-duplicated, redacted like content, merged onto the memory that ends up holding the fact. Indexed for keyword search only, and searched only by natural-language questions: SQLite keeps a second FTS index (`engrams_qfts`), Postgres/PGlite a second tsvector (`fts_q`). Never embedded, never shown to the cross-encoder. The reply reports `questions: { kept, dropped }`. |
| `slot` | Entity + attribute, e.g. `rosterkeep.deploy-command` (normalised: trimmed, lower-case). A write to a slot supersedes its current holder for the same agent and memory class; an older fact (earlier `valid_from`) is stored as history; a less-trusted write cannot retire a more-trusted holder. The reply reports `slot: { slot, replaced, keptAsHistoryOf }`. |
| `supersedes_slot` (`supersedesSlot`) | `false` keeps a deliberate second fact in the slot instead of superseding. |

**Capability hand-off (MCP).** `memory_restore` takes `capabilities` (e.g. `["questions"]`). With
`questions` declared, `memory_restore` and `memory_task_end` replies carry a `questions@1` job: up
to 5 of the agent's current memories with no questions. The host answers with
**`memory_set_questions`** `{ items: [{ id, questions }] }` (at most 20 items; another agent's ids
are refused) and the reply reports coverage. Library hosts use `getEngramsMissingQuestions(agentId,
limit, { excludeTags })`, `questionCoverage(agentId, { excludeTags })`, `attachQuestions()` (writes
through the redacting store whatever store it is given) and `renderQuestionJob()` from
`src/core/question-handoff.ts`.

**Calibration with questions.** When at least a quarter of an agent's memories carry questions, `awm calibrate` also fits a natural-question model: positives are a memory's own stored question with that memory as the answer; nulls are another memory's question recalled with that memory excluded, and questions other agents of the store have stored.

**Gate models** record the re-rankers they were fitted on (`rerankers`); a model fitted on other
re-rankers stands aside, reported once per agent, until `awm calibrate` refits it.

### 0.21.0 additions (redaction, the vault, calibrated abstention, 2026-10-29)

Write-time redaction is **on by default**. The vault and the calibrated gate are **opt-in**.
Full write-ups: [`redaction.md`](redaction.md), [`vault.md`](vault.md),
[`abstention.md`](abstention.md).

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_REDACT` | `mask` | Secret tier (provider keys with a known shape, PEM keys, JWTs, connection-URL passwords, `Bearer` tokens, labelled values) plus US SSNs and payment cards. `mask` replaces them before the write is stored, indexed, embedded or logged; `report` only says what it found; `off` disables. |
| `AWM_REDACT_PII` | `report` | Email addresses and phone numbers. Reported, not masked, by default, because in a personal or team store the contact is often the point of the memory. `mask` or `off`. Names are not detected. |
| `AWM_VAULT` | off | `on` seals secrets instead of masking them: the value is encrypted (AES-256-GCM) in `vault.db`, the memory keeps a handle `[VAULT:type …last4 #id]`, and a value once sealed is recognised and replaced wherever it appears again. |
| `AWM_VAULT_PATH` | beside the store | Path to `vault.db`. It is a separate file, so exporting or sharing `memory.db` never carries a secret. |
| `AWM_VAULT_KEY_STORE` | `keyring` | Where the vault key lives: the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service). `file` forces the weaker `vault.key` fallback beside the vault, which is used automatically where no credential store exists. |
| `AWM_ABSTAIN_GATE` | off | `calibrated` turns on the store-calibrated abstention gate. Each recall lands in one of three bands: answer; ⚠ LOW SIGNAL (answered, flagged); withhold (reported as `RECALL ABSTAINED — this store most likely does not hold this`, never a silent empty result). `require_confidence: 0` on `memory_recall` opens it for one call. With the reranker disabled the gate stands aside. |
| `AWM_ABSTAIN_RECALIBRATE_DAYS` | `7` | After a full consolidation, the gate's model is refitted when it is missing, older than this, or the store has grown by 20%. The model is saved per agent in `abstention-model.json` beside the store. |

Measured with the calibrated gate on the real 29,853-memory snapshot
(`tests/realstore-eval/gate-eval.ts`, v0.22.4): it withholds 50 of 73 never-stored facts, withholds
1 of 718 correct answers (flags 6), and of 200 absent questions asked in familiar vocabulary
withholds 95 and flags 19. On natural-language questions, once memories carry questions, it
withholds 3 of 103 correct answers. One store; see [`abstention.md`](abstention.md).

**Responses.** `POST /memory/write` (and `memory_write`) carries a `redaction` field naming what
was masked. With the gate on, each `/memory/activate` result carries `signal`
(`band: answer | low | withhold`, `score`, `answerAt`, `withholdBelow`).

**Commands:**

| Command | What it does |
|---------|-------------|
| `awm calibrate [--agent <id>]` | Fit the abstention gate now (92–118 s per agent on the real snapshot) instead of waiting for the next consolidation. Read-only on memories; writes only `abstention-model.json`. |
| `awm vault list` | What is sealed, with use counts and allowed commands. Never the values. |
| `awm vault run <id> [--env NAME] -- <cmd>` | Run `<cmd>` with the value in `$NAME` (default `AWM_SECRET`). Allowed command prefixes only; a command that chains or redirects (`;`, `&&`, `\|`, `>`, backticks, `$(`) is never allowed by prefix. The value is replaced by its handle in the command's output. |
| `awm vault allow <id> "<prefix>"` / `disallow` | Add or remove a command prefix `run` may use the value for. Allowing an interpreter or network tool prints a warning. |
| `awm vault reveal <id>` | Print a value. Interactive terminal only, and asks you to type the id. There is no MCP tool that returns a value. |
| `awm vault forget <id>` | Delete a sealed value. Memories keep the dead handle. |
| `awm vault status` | Where the vault and its key live. |
| `awm vault migrate [--apply] [--db <memory.db>]` | Seal the secrets already in a store. Without `--apply`, a dry run. `--apply` backs up `memory.db` first (the backup holds every secret in plaintext; delete it once the store checks out), sweeps every text column and `awm.log`, then optimizes the index and vacuums. SQLite stores only. Stop AWM sessions first. |
| `npx tsx scripts/redact-scan.ts [db] [--samples N]` | Repository script, not a CLI command. Scans a store read-only and prints per-rule counts of what redaction would mask. |

### 0.18.0 additions (lifecycle correctness, 2026-10-12)

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_PROTECTED_ARCHIVE_DAYS` | `365` | Archive floor for fade-protected classes (`canonical`, `structural`) in the disuse archive; superseded engrams get none, and a value that is not a non-negative number falls back to 365. The archive phase measures disuse as `accessCount === 0`, which is wrong for a source-of-truth class: a decision nobody has needed **yet** has zero recalls by construction. Measured before this existed: 4,360 canonical engrams archived against 2,058 active, 2,891 of them zero-access. A longer clock, not an exemption — the class is still archived past the floor, and the module's "never immortal" invariant holds. Fade-protected engrams are additionally never **deleted**, which is the one irreversible step in the cycle. |
| `AWM_ALLOW_LIVE_STORE` | unset | `1` permits a test or benchmark process (`VITEST`, or `AWM_BENCH=1`) to open the live store, `~/.awm/memory.db` or `~/.awm/memory-pglite`. Otherwise store creation refuses, and `npm run bench` refuses a server whose `/health` reports `store.live`. Every launcher defaults `AWM_DB_PATH` to the live store, and 4,745 benchmark fixture engrams were purged from it on 2026-10-11 — nine real memories sat among them. |

Also in this group, no env var: `GET /health` reports `store.live` (boolean, same purpose as
`recall.fingerprint` — a writing benchmark can refuse the wrong store loudly); engrams carry
`stage_changed_at` (nullable, no backfill — null means never transitioned, so readers fall back
to `created_at`); recall output labels a trimmed body `[faded]` in the header rather than only
via the marker at the end of the content; `deleteEngram` clears `retrieval_feedback`,
`entity_mentions` and `staging_events` atomically (571 and 3 orphans respectively were
found in the live store); and a declared `intent: 'decision'` on `memory_write` now reaches the
salience filter instead of only becoming a tag.

### 0.20.1 additions (consolidation calibration, 2026-10-24)

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_REDUNDANCY_THRESHOLD` | `0.90` | Cosine above which consolidation Phase 6.5 archives a low-confidence (< 0.6), rarely-accessed (< 3) engram as a duplicate of an active neighbour. Was 0.75, calibrated for MiniLM-L6; the store embeds with bge-small-en-v1.5, where UNRELATED active pairs reach p99 0.757 and same-fact pairs sit at p10 0.789 / p50 0.889, so a cycle straight after a batch write archived 25 distinct minute-old memories. 0.90 catches near-verbatim repeats only; paraphrases are the writer's `supersede` decision. Candidates must also be older than `FORGET_GRACE_DAYS` (7), and `canonical` / `structural` engrams are never pruned here. |
| `AWM_CONFIDENCE_GATE_K` | `1` | The composite recall score is multiplied by `1 - k(1 - confidence)`. k=1 is the historical behaviour (score x confidence); k=0 removes confidence from ranking. Confidence is mostly a write-kind prior (decision 0.65, observation 0.45), so at k=1 a principle outscores a number-bearing fact of equal relevance by 1.44x. Measured on the MWA pilot stores and the 400-probe public benchmark: a trade on the former, identical on the latter — so the default stays. |

Also in this group, no env var: a `supersedes` write (and `correction: true`) floors the new
engram's confidence at the replaced memory's, applied after the caller's value or the write-kind
prior is resolved; and `embedding_model` is stamped on every vector written (see the schema
below) — `EngramCreate.embeddingModel` carries an importing store's model through `awm import`.

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
(comma lists) drive the user-feedback auto-promotion regex — content starting with a
configured name plus a feedback verb is promoted to `canonical`.

**`AWM_FEEDBACK_NAMES` ships EMPTY, which turns the detector off (2026-10-11).** It
previously defaulted to a list of 22 real first names — one deployment's staff list,
published in the npm tarball because `src/` is in `package.json` `files`. An operator who
wants the promotion must now set the variable; with no names configured,
`detectUserFeedback()` returns `false` for everything and an explicit
`memory_class: 'canonical'` is the way to pin a stakeholder decision.

Set it in the **MCP server's `env` block**, not a `.env` file: the `.env` loaders in
`cli.ts` and `mcp.ts` resolve against `process.cwd()`, which an MCP server launched by a
host does not control.

**Memory spine (D5/D8):** writes accept `origin_class`
(`user-stated | tool-output | inference | recipe`), `writer_session`, `recipe_id`,
`valid_from`, `valid_to`. Provenance fields are recorded on every backend and **not used in
ranking**. Temporal validity **is** (0.18.0): a memory past its `valid_to`, or before its
`valid_from`, takes the same 0.15 penalty as a superseded one in Phase 8c, and rerank2's
re-sort honours that penalty (`src/core/validity.ts`, `src/core/rerank2.ts`). Recall output
shows `[written YYYY-MM-DD]` on every line, `[valid until …]` while the window holds, and
`⚠ EXPIRED <date>` / `[not yet valid — from <date>]` / `⚠ SUPERSEDED by <id>` otherwise; two
returned memories that disagree on a time, date, amount, number or status get
`⚠ POSSIBLE CONFLICT with <id> … (this one is newer|older)` and the reply names the newest
(`src/core/conflicts.ts`; `ActivationResult.conflictsWith`); every reply ends with
`[confidence: …]`; and when the question asks for a kind of value no returned memory holds,
one line says so (`src/core/asked-value.ts`).

**Correcting a fact (0.18.0):** `memory_write` with `correction: true` supersedes the closest
active memory in content (novelty match score ≥ 0.6, a superseded match followed to its
superseder, never another agent's), stores the correction active at no less than that
memory's confidence, and reports `correctionOf` (null when nothing was close enough). It never
reinforce-merges. **Trust (0.18.0):** a write carrying a `trust=<tier>` tag lower than the
memory it matched — or explicitly `trust=untrusted` — never merges into, revives, supersedes
or corrects that memory; it is stored as its own engram and the result carries `trustBlocked`
(`src/core/trust.ts`). Untagged writes and memories are unaffected.

**Cognition recipes (D14):** AWM never calls a hosted model (any model it embeds must not slow recall) — `src/recipes/` ships versioned prompt+contract
pairs (`skill-derivation@1`, `friction-lesson@1`) the HOST agent runs as a separate focused pass;
`memory_task_end` responses carry the invitations, and `memory_write` validates recipe-attributed
write-backs (unknown recipe ids and malformed shapes rejected with the contract echoed).

**Entity index (D9):** `entity_mentions(entity, engram_id, agent_id)` +
`entity_aliases(alias, entity)` tables on all three backends, populated at write time from
structured sources only (prefix tags like `person=`/`ticket=`, auto-tagger `entity:` tags),
normalized `key:value` lowercase. Store API: `recordEntityMentions()`, `getEngramIdsByEntity()`
(alias-resolving), `searchEntities()` (mentions ∪ aliases). Retrieval uses it only behind
`AWM_ENTITY_INDEX_FETCH` (see the flag table above).

### Other environment variables

Every remaining `AWM_*` variable read in `src/`, with its default and effect. Rows marked
*diagnostic* or *experiment* are for measurement; leave them unset in production.

**Server basics:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_PORT` | `8400` | HTTP API port (`awm serve --port` sets it). |
| `AWM_DB_PATH` | `memory.db` (SQLite) / `memory-pglite` (PGlite), relative to the working directory | The store: a file for SQLite, a directory for PGlite. Every launcher (`awm setup`, the Claude Code plugin, the Desktop bundle) sets it to `~/.awm/memory.db`; the shipped hook scripts read it too. |
| `AWM_AGENT_ID` | `WORKER_NAME`, else derived from the project directory (`CLAUDE_PROJECT_DIR` or cwd) | The MCP server's agent pool. Also the default agent of HTTP `GET /whoami`. |
| `AWM_API_KEY` | unset | When set, the HTTP API requires `Authorization: Bearer <key>`. Required to bind beyond loopback (`AWM_BIND`). |
| `AWM_WORKSPACE` | unset | Default `workspace` for MCP recall (hive mode: recall across every agent in the workspace); reported by `memory_whoami`. |
| `AWM_STORE_BACKEND` | auto-detect | `sqlite` \| `pglite` \| `postgres`. Unset: inferred from `AWM_DB_PATH` (directory → PGlite, file or new path → SQLite), else `memory-pglite/` or `memory.db` in the working directory, else SQLite. An unknown value falls back to SQLite with a warning. `src/storage/factory.ts` |
| `AWM_COORDINATION` | off | `true` or `1` turns on the multi-agent coordination layer: 13 `coord_*` MCP tools, the coordination HTTP routes, and agent/task/lock counts in `GET /health`. |
| `AWM_PLUGINS` | unset | Comma-separated module paths or package names loaded as coordination plugins (only with `AWM_COORDINATION`). |
| `AWM_CACHE_DIR` | `HF_HOME`, else `<package>/data/models` | Where the embedding, re-ranker and expansion models are downloaded and cached. |
| `AWM_INCOGNITO` | off | `1` or `true`: the MCP server registers no tools, opens no store and starts no sidecar; nothing is recorded. |
| `AWM_CLIENT` | set by the launcher | Which application runs the server (`claude-code`, `claude-desktop`, …). Every new memory is tagged `client=<value>` unless the caller's tags already carry a `client=`. |
| `AWM_NO_EAGER_WARM` | off | `1` stops the MCP server warming the models and slim cache at startup, so the first recall pays the load instead. |

**Ranking and recall confidence:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_CONF_SHARPNESS_W` / `AWM_CONF_CLIFF_W` / `AWM_CONF_FLOOR_W` | `0.4` / `0.3` / `0.3` | Weights of the recall-confidence signal (`src/engine/confidence.ts`): sharpness = top1 / mean(top5), cliff = (top1 − top10) / top1, floor = top1's absolute score. Confidence drives `requireConfidence` and `granularity: auto`. |
| `AWM_RERANK2_TIE_EPS` | `0` | *(experiment)* Within this reranker-score margin, rerank2's re-sort lets the blended score decide. Measured at 0.03: identifier s@1 93.0% → 78.7%, so it stays off. |

**Write and lifecycle:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_WRITE_PIPELINE` | on | `off` reverts to legacy create-only writes: every write creates a new engram, no reinforce-merge. |
| `AWM_NOVELTY_EMBED` | on | `0` drops the cosine channel from write-time novelty (BM25 only) and writes without a pre-computed embedding; the async embed fills it later. Faster writes, less consistent novelty across backends. |
| `AWM_REINFORCE_MERGE_CONTENT` | on | `0` stops a reinforcing write from merging its new content into the matched memory (only confidence and access count move, as before 0.8.5). |
| `AWM_REINFORCE_MAX_CONTENT_LEN` | `1500` | Max characters a memory's content may grow to by reinforce-merging; the oldest merged text is dropped first. |
| `AWM_CONNECTION_COLD_START_THRESHOLD` | `10` | Below this many active engrams, connection discovery may run inline on write so a new store gets a graph before its first consolidation; above it, discovery waits for consolidation. |
| `AWM_CONSOLIDATION_CRON` | `0 3 * * *` | When the scheduler runs the nightly consolidation cycle (local time). The other trigger is quiescence: every active agent idle for 30 minutes. |
| `AWM_DISABLE_SCHEDULER` | off | `1` or `true` disables both scheduler triggers. `POST /system/consolidate` still works. |
| `AWM_FADE_DAYS_SINCE_ACCESS` | `45` | Content fade: a memory accessed at least once but not for this many days is a fade candidate. |
| `AWM_FADE_MIN_CONTENT_LEN` | `250` | Only content longer than this fades. |
| `AWM_FADE_KEEP_CHARS` | `150` | A faded body is trimmed to this many characters and marked `[faded]`; concept, tags and embedding are kept. |
| `AWM_FADE_MAX_PER_CYCLE` | `25` | Most memories faded per consolidation cycle. |

**Recall output and diagnostics:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_GRANULARITY_COMPACT_LEN` | `200` | Snippet length for `granularity: compact` (and the lower results under `auto`). |
| `AWM_GRANULARITY_FULL_LEN` | `1000` | Summary length of the top result under `granularity: auto` when confidence clears the threshold below. |
| `AWM_GRANULARITY_AUTO_THRESHOLD` | `0.4` | Recall confidence at which `auto` gives the top result the long summary. |
| `AWM_DISABLE_POOL_FILTER` | off | *(diagnostic)* `1` scores every active candidate: no vector top-K cut (`max(50, limit×5)`), no candidate cosine floor. |
| `AWM_DISABLE_EXPANSION_CACHE` | off | *(diagnostic)* `1` disables query expansion's skip heuristic and LRU cache, so every expanded recall runs the expander. |
| `AWM_DISABLE_SLIM_CACHE` | off | *(diagnostic)* `1` disables SQLite's in-memory slim cache (id, concept, embedding) and fetches per recall. |
| `AWM_PROFILE_RECALL` / `AWM_PROFILE_RECALL_OUT` | off / unset | *(diagnostic)* `1` prints one per-phase timing line per recall to stderr; `_OUT=<path.jsonl>` appends one JSON object per recall. |
| `AWM_PROFILE_WRITE` | off | *(diagnostic)* `1` logs per-phase write timings to stderr for every write (`AWM_SLOW_WRITE_MS` logs only slow ones). |

**Backends:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_PG_POOL_MAX` | `10` | Connection-pool size for the Postgres backend. |
| `AWM_IVFFLAT_PROBES` | `5` | pgvector ivfflat probes per vector query (PGlite and Postgres). Higher = more accurate, slower. |
| `AWM_PGLITE_BM25_M` | `1` | Multiplier on PGlite/Postgres `ts_rank_cd` to calibrate it against SQLite FTS5 BM25. `1` = passthrough. |
| `AWM_SUPPRESS_BACKEND_WARNINGS` | off | `1` silences the warning printed when `AWM_STORE_BACKEND` names a backend with no data while the other backend's store exists. |

**Calibration experiments:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `AWM_CALIBRATE_RANDOM` | `50` | *(experiment)* Random-vocabulary null probes in `awm calibrate`. |
| `AWM_CALIBRATE_HELDOUT` | `0` | *(experiment)* Held-out keyword nulls in `awm calibrate`: a positive's own query, recalled as if its memory were never stored. |

Not listed: `AWM_ML_INPROCESS` and `AWM_ML_SIDECAR_URL` appear only in code comments (in-process
inference is the default; nothing reads either), and `AWM_GEN_BEGIN`/`AWM_GEN_END`,
`AWM_INSTRUCTION_CONTENT`, `AWM_PACKAGE_ROOT`, `AWM_MODEL_DAEMON_FINGERPRINT` are internal
constants or launcher plumbing, not settings.

---

## Salience Scoring Formula

`evaluateSalience()` in `src/core/salience.ts`. It runs only on a write the pipeline did not
merge into an existing memory (a close novelty match reinforces that memory instead; see
`POST /memory/write`).

**Score:**
```
score = min(1, 0.15·surprise + 0.15·decisionMade + 0.15·causalDepth
             + 0.10·resolutionEffort + 0.45·novelty + typeBonus)
```
`novelty` is 1 for nothing similar, 0 for a near-duplicate, computed at write time from BM25 and
(unless `AWM_NOVELTY_EMBED=0`) cosine against existing memories; 0.8 when the caller does not
compute it. Novelty is the largest weight: a fresh plain observation scores ~0.45 and is stored
active on novelty alone.

**Event type bonuses (`typeBonus`):**
- `observation`: +0.0
- `decision`: +0.15
- `friction`: +0.20
- `causal`: +0.20
- `surprise`: +0.25
- `user_feedback`: +0.30

**Weak-signal gate.** For `friction`, `causal`, and `decision` without `decisionMade` (that is,
everything except `user_feedback`, `surprise` and a decision with `decisionMade`), when
`surprise + causalDepth + resolutionEffort + (decisionMade ? 0.5 : 0) < 0.5` the type bonus is
cut to a quarter (`event:{type}:attenuated`) and the novelty term is capped at 0.30
(`novelty:capped`), so a labelled event with no signals behind it does not clear the active
threshold on novelty alone. Plain observations are never capped.

**Automatic detection (before scoring):**
- **User feedback** — content starting with a name from `AWM_FEEDBACK_NAMES` plus a feedback
  verb becomes `user_feedback` (+0.30) and class `canonical` (`auto:user_feedback`). Off unless
  `AWM_FEEDBACK_NAMES` is set (it ships empty).
- **Verified operational record** — an action verb (Submitted, Deployed, Migrated, …) plus two
  or more ISO dates or concrete identifiers: an `observation` becomes `decision` (+0.15) and a
  working-class write gets a **0.45 floor** (`auto:verified_finding`). Not promoted to canonical.
- **Trivial routine operation** — ≤150 characters with a routine verb (completed, saved,
  synced, pinged, …) and noun (file, log, job, sync, batch, …) that is not a verified record:
  score capped at 0.1 (`auto:trivial_operation`), so it lands as `discard` (stored low-salience)
  unless the class floor applies.

**Memory-class overrides:** `canonical` and `structural` get a **0.7 floor** and are always
stored active; `ephemeral` gets no floor.

**Disposition:**
- `canonical` / `structural` → `active`
- score ≥ 0.4 (`salienceThreshold`) → `active`
- score ≥ 0.2 (`stagingThreshold`) → `staging` (confidence 0.40, 24 h TTL, then the sweep)
- score < 0.2 → the filter says `discard`, but the write pipeline **still stores the memory
  active**, tagged `low-salience`, at confidence 0.25. HTTP reports `disposition: "low-salience"`
  with `salienceDisposition: "discard"` (`src/core/write-pipeline.ts` `createNewEngram`).

**Reason codes (audit trail):**
- `high_surprise` — surprise > 0.5
- `decision_point` — decision was made
- `causal_insight` — causalDepth > 0.5
- `high_effort_resolution` — resolutionEffort > 0.5
- `novel_information` / `redundant_information` — novelty > 0.7 / < 0.3
- `event:{type}` (`:attenuated` when the weak-signal gate fired), `novelty:capped`
- `auto:user_feedback` / `auto:verified_finding` / `auto:trivial_operation`
- `class:canonical` / `class:structural` / `class:ephemeral`
- `disposition:{active|staging|discard}` — the filter's decision

---

## Activation Pipeline Phases

Phase numbers match the comments in `src/engine/activation.ts` (its header lists them), in the
order the code runs. "Mode" is the query classification: `targeted` (identifiers, short
queries), `exploratory` (question words, long or vague queries) or `balanced`.

| Phase | Stage | Range | Description |
|-------|-------|-------|-------------|
| -1 | Coreference | - | A query with pronouns gets recent entities appended (conditional). |
| 0 | Query expansion | - | flan-t5-small adds related terms to the BM25 search string. **Off by default since 0.22.1** (`AWM_DEFAULT_EXPANSION`, per-call `useExpansion`). |
| 1 | Query embedding | - | `Xenova/bge-small-en-v1.5`, 384d (`AWM_EMBED_MODEL`). |
| 2 | BM25 retrieval | 0-1 | Two FTS5 passes (keyword-stripped query; expanded/alias query), `limit×3` each, best score per memory, normalised `\|rank\| / (1 + \|rank\|)`. Natural-language queries also search the stored questions (`engrams_qfts`). |
| 3a | Vector retrieval + candidates | - | Native vector top-K `max(50, limit×5)` per agent; a hit enters the pool above the candidate floor (0.40 targeted / 0.30 otherwise). Candidates = BM25 ∪ vector. Opt-in entity-index injection splices in here (`AWM_ENTITY_INDEX_FETCH`, `AWM_ENTITY_ALIAS_MATCH`). |
| 3b | Keyword match | 0-1 | `min(max(bm25, jaccard) + conceptBonus, 1)`; Jaccard is stopword-filtered, 0.6 concept + 0.4 content; concept bonus = concept-term overlap × 0.3. |
| 3b | Vector match | 0-1 | `min(1, (raw − floor) / (0.95 − floor))` above the floor, else 0; floor 0.50 targeted / 0.35 otherwise (`AWM_SIM_FLOOR_*`). |
| 3b | Text match | 0-1 | Both > 0: `0.5·max + 0.3·min + 0.2·keyword·vector`; otherwise `max(keyword, vector)`. |
| 3b | ACT-R decay | real | `ln(n+1) − d·ln(age/(n+1))`; `d` = mode base (0.6 / 0.5 / 0.3) less up to 0.2 for confidence and 0.1 for access count, floor 0.2. |
| 3b | Hebbian / centrality / feedback | 0-0.5 / 0-0.1 / 0-0.15 | Mean association weight (cap 0.5); log-scaled weighted degree; bonus for confidence above 0.55. |
| 3b | Composite | 0-1+ | `(wText·text + wTemp·temporalNorm·gate + (centrality + feedback)·gate) × confidenceGate`; `gate` = text when > 0.1, else 0; `temporalNorm = min(softplus(decay + hebbian), 3)/3`; `wText/wTemp` 0.75/0.25 targeted, 0.6/0.4 balanced, 0.4/0.6 exploratory; `confidenceGate = 1 − k(1 − confidence)` (`AWM_CONFIDENCE_GATE_K`, 1). |
| 3.5 | Rocchio feedback | - | **Off** since 2026-10-09 (`AWM_FEEDBACK_BM25=1`). |
| 3.7 | Entity bridge | - | Boosts candidates sharing entity tags with the strongest anchors. **On** (`AWM_DISABLE_ENTITY_BRIDGE` disables). |
| 3.75 | Query bridge | 0-0.4 | **Off** (`AWM_QUERY_BRIDGE=1`). |
| 6 (cut) | Shortlist | - | **Runs before the graph walk.** Reciprocal-rank fusion (k=60) of the composite, BM25 and vector ranks, cut at `max(limit × AWM_TOPN_MULT, AWM_TOPN_MIN)` — `max(limit×8, max(limit×4, 32))` (0.21.1; `AWM_PRESELECT=composite` cuts by composite alone). |
| 4/5 | Graph walk | 0-0.25 | Within the shortlist: four sub-graphs (semantic 0.40, temporal 0.20, causal 0.25 and doubled, entity 0.15), depth 2, hop penalty 0.2 / 0.3 / 0.4 by mode, ≤0.15 per step, ≤0.25 per memory. `AWM_SPREAD=1` swaps in spreading activation (parked). |
| 6 | Rerank pool | - | Drop below `minScore` (0.01), sort by score, keep `AWM_RERANK_POOL` = `max(limit×4, 32)`; injected entity candidates always stay. |
| 7 | Cross-encoder | 0-1 | Every pool candidate is scored. Keyword-shaped queries: `Xenova/ms-marco-MiniLM-L-6-v2` at q8 (`AWM_RERANKER_MODEL`); natural-language questions: `cross-encoder/ettin-reranker-17m-v1` (`AWM_RERANKER_MODEL_NATURAL`), routed by `src/core/query-shape.ts`. `score = (1 − w)·composite + w·rerankerScore` with adaptive `w = 0.3 + 0.4·(1 − max textMatch in the pool)`, so 0.3–0.7. |
| 8 | Agreement gate | - | Pool ≥ 3 only, judged on the post-rerank top 5 (`AWM_ABSTAIN_GATE_K`). Channels: BM25 > 0.3, vector > 0.05, reranker > 0.25. **Default:** returns nothing only when fewer than 2 of 3 agree **and** the best raw cosine is below the floor (0.50 / 0.35); if fewer than 2 agree or the reranker's top-two margin is < 0.05, every score is ×0.4. **With `abstentionThreshold` > 0:** 3 of 3 required, the ×0.4 case abstains instead, and the legacy check abstains when the top reranker score is below the threshold (or < 0.5 with variance < 0.01). |
| 8c | Stale penalty | ×0.15 | Superseded memories and memories outside `valid_from`/`valid_to`. |
| 9 | Final sort + confidence | 0-1 | Sort by score; recall confidence from the top 10 (`AWM_CONF_*`); `requireConfidence` withholds below it. |
| 9b | Blend (0.21.1) | 0-1 | When rerank2 is on and every candidate has a reranker score: `a·rr + (1 − a)·fused`, × stale penalty, where `fused` is the candidate's rank-normalised BM25 + vector RRF position in the pool. `a` = 0.95 keyword (`AWM_BLEND_KEYWORD`); natural with the Ettin model 0.7 and `rr` is its **rank**, not its score (`AWM_BLEND_NATURAL_RANK`); natural with the main model 0.5 when at least half the pool has questions (`AWM_BLEND_QUESTIONS`), else 0.85 (`AWM_BLEND`). Otherwise rerank2's re-sort by reranker score. |
| 9b | First-place rule (0.22.4) | - | `src/core/blend-rule.ts`: the cross-encoder's #1 when it is sure (top-two logit margin ≥ 1 keyword / 1.5 natural); else, for keyword queries, the #1 of the same blend with the vector rank weighted 0.25 (full weight for a candidate both channels rank top two); else the blend's #1. Places 2+ keep the blend's order. `AWM_BLEND_SURE=off` restores 0.22.3. |
| - | Calibrated gate | - | Opt-in (`AWM_ABSTAIN_GATE=calibrated`). Reads the **blend's** order, not the rule's: answer / ⚠ low signal / withhold. Skipped when the cross-encoder did not run. |
| - | Limit | - | The first `limit` results; `granularity` summaries; conflict marks. |

---

## Engram Stages (State Machine)

```
write ──> [Novelty match?] ── close match ──> REINFORCE the existing memory (no new engram)
              |
              └── new ──> [Salience Filter]
                              |
                              ├── score >= 0.4 ──> ACTIVE ──> [Fade] ──> FADING ──> [Eviction] ──> ARCHIVED
                              |                       |
                              |                       └── [Retraction] ──> RETRACTED
                              |
                              ├── score >= 0.2 ──> STAGING ──> [Sweep: resonant?]
                              |                                    |
                              |                                    ├── yes ──> ACTIVE
                              |                                    └── no  ──> DELETED
                              |
                              └── score < 0.2 ──> ACTIVE, tagged `low-salience`, confidence 0.25
```

Canonical and structural writes always go ACTIVE. *Corrected 2026-11-15: this diagram showed a
sub-0.2 write as "DISCARDED (not stored)". The write pipeline keeps it, low-weighted
(`src/core/write-pipeline.ts` `createNewEngram`), so nothing an agent wrote is lost silently.*

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
| memory_class | TEXT | `canonical` / `working` (default) / `ephemeral` / `structural` |
| superseded_by | TEXT | Engram that replaced this one (NULL while current); recall ×0.15 when set |
| supersedes | TEXT | Engram this one replaced |
| embedding_model | TEXT | Model the vector came from, stamped on every write since 0.20.1 (cosine thresholds are calibrated per model); NULL without an embedding |
| memory_type | TEXT | `episodic` / `semantic` / `procedural` / `unclassified` (default) |
| sequence | INTEGER | Optional story-time order (0.8); NULL when unset |
| references_json | TEXT | Typed cross-record links (0.8), JSON |
| stage_changed_at | TEXT | ISO datetime of the last stage transition (0.18.0); NULL = never transitioned, readers fall back to `created_at` |
| origin_class | TEXT | Memory spine (D5, 2026-07-30): `user-stated` / `tool-output` / `inference` / `recipe` — log-only |
| writer_session | TEXT | Session id that wrote this engram (D5) |
| recipe_id | TEXT | Cognition recipe that produced it, e.g. `skill-derivation@1` (D14) |
| valid_from | TEXT | Bi-temporal validity start (D8) |
| valid_to | TEXT | Bi-temporal validity end — shown as `[valid until …]` in recall; past it, the memory is down-ranked like a superseded one and shown as `⚠ EXPIRED` (D8, enforced since 0.18.0) |
| questions | TEXT | JSON array of up to 5 natural questions the memory answers (0.22); keyword-indexed only |
| slot | TEXT | Entity + attribute this memory holds (0.22); indexed, see `memory_write` `slot` |

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
| entity | TEXT | Normalized `key:value` (e.g. `person:avery`, `ticket:10002`) — PK with engram_id |
| engram_id | TEXT | Engram mentioning the entity |
| agent_id | TEXT | Agent scope (indexed with entity) |

Populated best-effort on every write from structured sources only (prefix tags,
auto-tagger `entity:` tags), including a write merged into an existing memory (its tags are
indexed onto that memory, since 0.22.3). Read by `memory_about` / `GET /memory/about`, and by
recall behind `AWM_ENTITY_INDEX_FETCH` and `AWM_ENTITY_ALIAS_MATCH`.

### entity_aliases (D9; per-agent since 0.22.3)
| Column | Type | Notes |
|--------|------|-------|
| agent_id | TEXT | Owning agent; `''` = shared (rows written before the migration). PK with alias |
| alias | TEXT | Alternate name, normalized lowercase |
| entity | TEXT | Target entity key in entity_mentions |

An agent's own alias wins over a shared one. The migration from the global D9 table is
idempotent on all three backends.

### engrams_fts (FTS5 virtual table)
Full-text search index on concept, content, tags. Auto-synced via triggers.

### engrams_qfts (FTS5 virtual table, 0.22)
The same plus `questions`. Only natural-language recall searches it, so identifier and topic
lookups keep the three-column statistics they were measured on. Built once on first open.

### activation_events
Logs every retrieval query: context, result count, top score, latency.

### staging_events
Logs consolidation decisions: promoted, discarded, expired.

### retrieval_feedback
Ground truth: engram ID, useful (boolean), context.
