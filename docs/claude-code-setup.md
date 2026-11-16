# AWM for Claude Code — Standalone Setup & Best Practices

> For teams or multi-agent setups with AgentSynapse, see [team-setup-guide.md](team-setup-guide.md).
> This guide covers AWM as a standalone memory layer for individual Claude Code users.

---

## What this guide covers

1. Installing AWM without any orchestration layer
2. Configuring CLAUDE.md for effective memory usage
3. Best practices for getting the most out of AWM
4. Tuning for different workflow types
5. Monitoring and maintaining memory health

---

## Installation

### Prerequisites

- **Node.js 22 LTS+** — `node --version` (Node 20 reached EOL 2026-04-30; AWM 0.8.6+ requires 22)
- **Claude Code** installed and working

### Install & configure

```bash
npm install -g agent-working-memory
awm setup --global
```

Restart Claude Code. Done — 22 tools appear automatically (18 `memory_*` tools + 2 onboarding: `onboard_scan`, `onboard_questions` + 2 output-compression: `compress_output`, `retrieve_original`).

> First install downloads the ML models — **~175 MB total**: 134 MB bge-small embedder + 23 MB ms-marco reranker (int8) + 17 MB Ettin reranker (int8). The 377 MB flan-t5-small expander downloads only if expansion is turned on. Nothing is bundled in the package; this is a one-time fetch into `AWM_CACHE_DIR` > `HF_HOME` > `<packageRoot>/data/models`, and it is cached after that. As of 0.12.2, a Claude Code MCP session also **eager-warms** those models at startup (fire-and-forget), so the old "first recall in a session is slow" penalty is absorbed into session start instead of your first message — no action needed; disable with `AWM_NO_EAGER_WARM=1` if you'd rather defer the cost.

> **There is a plugin now.** `/plugin marketplace add CompleteIdeas/agent-working-memory`
> then `/plugin install awm@agent-working-memory` wires the same MCP server, hooks and
> guidance without a setup step. To upgrade, refresh the marketplace first
> (`/plugin marketplace update agent-working-memory`), then `/plugin update`. It never edits
> `settings.json` or your `CLAUDE.md`. Both share `~/.awm/memory.db`, so it is a preference
> rather than a fork — see [`plugin.md`](plugin.md). This guide covers the CLI install.

### What `awm setup --global` creates

| File | Purpose |
|------|---------|
| `~/.mcp.json` | Tells Claude Code to load the AWM MCP server |
| `~/.claude/CLAUDE.md` | Memory workflow instructions (when to write, recall, checkpoint) |
| `~/.claude/settings.json` | Wires the hooks below on Stop, PreCompact, SessionEnd, UserPromptSubmit and PostToolUse. Since 0.14.6 these reference **shipped script files**, not inline `curl` — see [reference.md → Hook Configuration](reference.md#hook-configuration) |
| `~/.claude/hooks/awm-find-sidecar.cjs` | Resolves which sidecar to talk to: reads the MCP config governing the session's cwd, probes the port range, and picks the one whose `/health` reports that agent |
| `~/.claude/hooks/awm-checkpoint.cjs` | Checkpoint on PreCompact / SessionEnd; forwards the whole hook payload. Since 0.20 the Stop hook is `awm-used.cjs` (below); before that it was a local `echo` with no network call. |
| `~/.claude/hooks/awm-prime.cjs` | `UserPromptSubmit` — primes relevant memory into context. `--no-prime` skips it; an empty `~/.claude/hooks/awm-prime.disabled` turns it off without uninstalling |
| `~/.claude/hooks/awm-used.cjs` | `Stop` (0.20) — prints the write / recall reminder and posts the transcript path to `/hooks/used`, so the recalls the reply drew on are credited without a `memory_feedback` call |
| `~/.claude/hooks/awm-hooks.json` | Records what setup installed, so the hooks can find the server even with no project config |
| `~/.claude/skills/awm-learn/` | The `awm-learn` skill (0.22.2): `/awm-learn` learns a whole repo or folder into memory. Upgraded on each run, unless you edited it (a `.awm-skill.json` record tells the two apart); `--no-instructions` skips it. A project setup puts it in `.claude/skills/` |

The bearer secret lives in the MCP config and is read at run time, so regenerating it does
not leave the hooks silently 401-ing. It is deliberately **not** written into
`settings.json`. Every hook fails open: no output, exit 0.

Re-running `awm setup` upgrades rather than resets — your own hooks on those events survive,
and any env value you have already set wins over the default.

### Upgrading

```bash
npm install -g agent-working-memory@latest
awm setup --global        # refreshes hooks, guidance and the awm-learn skill; keeps your db, agent id and env
```

Then start a new Claude Code session — a running MCP connection keeps the code it loaded. Two things to know:

- **Models re-download after an upgrade unless you move the cache.** With neither `AWM_CACHE_DIR` nor `HF_HOME`
  set, models cache in `<packageRoot>/data/models`, inside the installed package, and `npm install -g` replaces
  that folder — so each upgrade fetches the ~175 MB again. `awm setup` does not set a cache directory. To keep
  the models across upgrades, add `"AWM_CACHE_DIR": "<home>/.awm/models"` (an absolute path) to the `env` block
  of the AWM entry in `~/.mcp.json`; setup preserves env values it does not own.
- **With the calibrated gate on (`AWM_ABSTAIN_GATE=calibrated`), run `awm calibrate` after upgrading**, so the
  gate's floor is refitted to the new release's ranker.

### Verify

Start a new conversation:

> "What memory tools do you have?"

Claude should list: `memory_write`, `memory_recall`, `memory_feedback`, `memory_retract`, `memory_supersede`, `memory_stats`, `memory_whoami`, `memory_checkpoint`, `memory_restore`, `memory_task_add`, `memory_task_update`, `memory_task_list`, `memory_task_next`, `memory_task_begin`, `memory_task_end`, `memory_about`, `memory_alias`, `memory_set_questions`, `compress_output`, `retrieve_original`, `onboard_scan`, `onboard_questions` — 22 in all.

---

## How AWM works with Claude Code

### Automatic behaviors (via hooks)

These happen without any action from you:

| Trigger | What happens |
|---------|-------------|
| **Every response** | Stop hook (`awm-used.cjs`, 0.20) reminds Claude to save important learnings and credits the recalls the reply used (implicit feedback, no `memory_feedback` call needed) |
| **Context compaction** | PreCompact hook auto-checkpoints state before context window shrinks |
| **Session end** | SessionEnd hook auto-checkpoints + triggers consolidation (sleep cycle) |
| **Every prompt you send** | UserPromptSubmit hook primes relevant memory into context before Claude sees the prompt (0.14.6). Prompts under 15 characters make no network call |
| **Every 15 min** | Silent auto-checkpoint while session is active |
| **After a Bash / PowerShell call** | PostToolUse hook (`awm-db-mutation-reminder.cjs`) reminds Claude that a data change is not done until it is written to memory |

Session start is not a hook: the CLAUDE.md guidance that `awm setup` installs tells Claude to call
`memory_restore` first, which recovers execution state and recent context.

### Agent-directed behaviors (Claude decides)

Claude uses these tools based on what's happening in the conversation:

| Situation | Tool | Example |
|-----------|------|---------|
| Discovered a root cause | `memory_write` | "The build fails because esbuild strips type-only imports" |
| Made an architecture decision | `memory_write` | "Decided to use Zustand over Redux for state management" |
| Starting a new task | `memory_task_begin` | Auto-checkpoints, recalls relevant context |
| Finished a task | `memory_task_end` | Writes summary, checkpoints |
| Switching topics | `memory_recall` | "What do we know about the auth system?" |
| After failed attempt | `memory_recall` | Checks if prior knowledge exists for the problem |
| Recalled memory was helpful | `memory_feedback` | Marks as useful → boosts confidence |
| Recalled memory was wrong | `memory_retract` | Invalidates it → penalties propagate |
| Unsure which AWM instance/store you're talking to | `memory_whoami` | Reports agent id, workspace, mode, backend, store path, ports, sibling agent spaces |
| Finished a task, and it earned a reusable pattern or a standing lesson | `memory_task_end` | May invite a **cognition recipe** (`skill-derivation@1`, `friction-lesson@1`) — a guided pass that turns the task into a standardized, validated write-back |

---

## Recall tuning

Default `memory_recall` is tuned for the common case. Three parameters change the cost/quality tradeoff when the default doesn't fit:

| Param | Values | Use when |
|-------|--------|----------|
| `granularity` | `full` (default) / `compact` / `auto` | `compact` puts a short query-aware summary on every result — cheaper to scan when you expect 5+ hits. `auto` gives the top result a longer summary only when it's a clear winner. |
| `require_confidence` | `0.05` (default, always on) / `0` (off) / higher | Score-shape abstention — recall returns nothing (`RECALL ABSTAINED`) instead of low-confidence noise. The 0.05 default is light: on a real store it withheld none of 73 questions about never-stored facts, so an answer is not proof the fact exists. Raising it judges the *shape* of the scores and silences correct answers along with absent ones — 0.20+ cut net token savings ~25% in tests — so leave it alone for ordinary recall (the prime hook uses 0.10; see [abstention.md](abstention.md)). With the calibrated gate on, `0` opens that gate for one call. |
| `workspace` | a workspace name | Hive-mode recall across every agent in that workspace, not just this one. Use when another agent may hold canonical knowledge you need. |

### Server-side switches (opt-in)

Two behaviours are set in the AWM server's environment, the `env` block of the MCP config, not
per call. Restart Claude Code after changing either.

```json
"env": {
  "AWM_VAULT": "on",
  "AWM_ABSTAIN_GATE": "calibrated"
}
```

- **`AWM_ABSTAIN_GATE=calibrated`**: the store learns its own noise floor (`awm calibrate`, or
  the next consolidation), and each recall is answered, answered with a `⚠ LOW SIGNAL` flag, or
  withheld as `RECALL ABSTAINED — this store most likely does not hold this`. Measured on one real
  store (v0.22.4): it withheld 50 of 73 never-stored facts and 1 of 718 correct answers to
  keyword-shaped questions, and 3 of 103 correct answers to natural-language ones — but it still
  answers 88 of 97 natural-language questions whose fact was deleted.
  See [abstention.md](abstention.md). **After upgrading AWM, run `awm calibrate`** (with the gate on):
  a new release can change the ranker's scores — 0.22 added a second reranker — and the fitted
  floor is only refitted automatically when it is old or the store has grown by a fifth.
- **`AWM_VAULT=on`**: secrets are sealed in `vault.db` instead of masked, and the memory keeps a
  handle the agent can use through `awm vault run`. See [vault.md](vault.md).

Write-time redaction of secrets is already on by default (`AWM_REDACT`, `AWM_REDACT_PII`); see
[redaction.md](redaction.md).

---

## Best Practices

### 1. Let Claude learn naturally

Don't micromanage memory. Claude is prompted (via CLAUDE.md) to save important discoveries automatically. The salience filter discards noise — in one synthetic A/B, 77% of write attempts were filtered out as duplicates or low-value (a single test, not a live-store rate).

**Good:** Work normally. Claude saves what matters.
**Bad:** "Save everything we discussed to memory" — floods memory with noise.

### 2. Use explicit prompts when it matters

For things Claude should definitely remember:

- *"Remember: we decided to use PostgreSQL connection pooling with pgBouncer"*
- *"Save this to memory: the USEF API rate limit is 100 requests/minute"*
- *"This is important: never use STRING_AGG on SQL Server 2016"*

### 3. Ask Claude what it remembers

When starting work on a topic Claude has seen before:

- *"What do you remember about the payment system?"*
- *"Recall any past decisions about the database schema"*
- *"Check memory for anything related to the entry validation flow"*

### 4. Use task management for multi-step work

```
"Create a task: Migrate auth from session-based to JWT"
"What's my next task?"
"Mark the JWT migration as complete"
```

Tasks persist across conversations. `memory_task_begin` auto-checkpoints and recalls relevant context. `memory_task_end` writes a summary.

### 5. Give feedback

When Claude recalls something useful, say so: *"That memory was helpful"* → triggers `memory_feedback(useful: true)` → boosts confidence.

When it recalls something wrong: *"That's outdated"* → triggers `memory_retract` → invalidates with propagating penalties.

Since 0.12.1, every `memory_recall` result line carries `[id: <engram-id>]` — that's the id `memory_supersede` and `memory_feedback` need, so a recalled-but-not-yet-corrected memory can be fixed without a separate lookup step.

### 6. Mark memories that must survive or expire

Most memories should stay at the default (`memory_class: working`) and let the salience filter and consolidation manage their lifecycle. Two cases are worth being explicit about:

- **Decisions and standing facts** — pass `memory_class: "canonical"` on `memory_write`. Canonical memories get a 0.7 salience floor and are never silently staged. Don't overuse it; it's for things that should survive indefinitely, not for every finding.
- **Facts with a shelf life** (a deploy state, "waiting on X's reply", a ticket status) — pass `valid_to` (an ISO date) on `memory_write`. The memory expires instead of relying on you to remember it's stale, and recall renders `[valid until …]` on results that carry it.

`origin_class` (`user-stated` / `tool-output` / `inference` / `recipe`) records provenance — where the knowledge came from — and is worth setting on writes where that distinction matters later.

### 7. Start sessions with restore

The CLAUDE.md installed by `awm setup` instructs Claude to call `memory_restore` at session start. If Claude seems to have forgotten context, say:

> "Call memory_restore"

This recovers the last checkpoint + recalls relevant recent memories.

---

## Tuning for Different Workflows

### Solo developer (one project)

Default setup works perfectly. All memories go to one pool, Claude gets smarter about your project over time.

### Solo developer (multiple projects)

Use separate memory pools to prevent cross-project contamination:

```
~/work/project-a/.mcp.json  →  AWM_AGENT_ID: "project-a"
~/work/project-b/.mcp.json  →  AWM_AGENT_ID: "project-b"
```

Each project gets its own memory namespace. Same database file — isolation by agent ID. The namespace comes from `AWM_AGENT_ID` — see [reference.md](reference.md).

### Long research/exploration sessions

For sessions where Claude explores broadly before narrowing:

- Let Claude write freely during exploration
- At the end, say: *"Summarize what we learned and save the key findings to memory"*
- The consolidation cycle (triggered at session end) will strengthen useful clusters and fade noise

### Short focused tasks

For quick bug fixes or reviews:

- `memory_restore` at start gives you context
- Fix the issue
- `memory_task_end` captures what was done
- Consolidation handles the rest

---

## CLAUDE.md Configuration

The `awm setup --global` command installs a CLAUDE.md that teaches Claude when to use memory. You can customize it by editing `~/.claude/CLAUDE.md`.

### Key sections to customize

**Project-specific context** — Add your project's key facts:
```markdown
## Project Context
- This is a Next.js 14 app with PostgreSQL
- We use Zustand for state management
- API follows REST conventions with /api/v1/ prefix
```

**Memory priorities** — Tell Claude what's worth remembering:
```markdown
## What to save to memory
- Architecture decisions and rationale
- Bug root causes (not the fix itself — that's in the code)
- External API behaviors and limitations discovered
- Your coding preferences (naming, patterns, style)
```

**What NOT to save:**
```markdown
## What NOT to save
- Code snippets (they're in the repo)
- Git history (use git log)
- Things already in documentation
- Temporary debugging state
```

---

## Monitoring Memory Health

### Quick check

Ask Claude: *"Call memory_stats"*

Returns:
- Active memory count
- Session writes and recalls
- Consolidation timestamps
- Log file path

### Activity log

Watch in real-time:

The log is `awm.log`, written next to the database — `~/.awm/awm.log` for a default `awm setup` install.

```powershell
# PowerShell
Get-Content "$HOME\.awm\awm.log" -Wait
```

```bash
# macOS / Linux / Git Bash
tail -f ~/.awm/awm.log
```

### Sidecar stats

`/stats` is behind the sidecar's bearer auth. The secret is `AWM_HOOK_SECRET` in the AWM entry's `env`
block of `~/.mcp.json` (`.claude/mcp.json` for a project install). The sidecar takes the first free port from 8401 (up to 8410), so if several sessions
are running, `awm doctor claude-code` shows which port serves this directory's agent.

```bash
# macOS / Linux / Git Bash
curl -H "Authorization: Bearer <AWM_HOOK_SECRET>" http://127.0.0.1:8401/stats
# {"date":"2026-11-15","agentId":"work","writes":8,"recalls":9,"restores":1,"hooks":3,"checkpoints":4,"total":25}
```

```powershell
# PowerShell
curl.exe -H "Authorization: Bearer <AWM_HOOK_SECRET>" http://127.0.0.1:8401/stats
```

### Signs of healthy memory

- **Writes per session:** 3-15 (too few = Claude isn't saving; too many = noise)
- **Recalls per session:** 2-8 (too few = Claude isn't using memory; too many = over-reliance)
- **Confidence distribution:** Most memories between 0.3-0.8 (healthy range)
- **Staging buffer:** < 20 entries (consolidation is working)

### Signs of unhealthy memory

| Symptom | Cause | Fix |
|---------|-------|-----|
| Zero writes per session | Stop hook not firing | Re-run `awm setup --global`, restart Claude Code |
| 50+ writes per session | Claude treating memory as a log | Add to CLAUDE.md: "Only save novel, non-obvious information" |
| Recalls return irrelevant results | Too much noise in active memories | Let consolidation run (close session), or manually retract bad memories |
| Staging buffer > 50 | Consolidation not running | Close and reopen session (triggers SessionEnd consolidation) |
| Confidence all at 0.5 | No feedback given | Start marking recalled memories as useful/not-useful |

### Reset memory

If memory becomes corrupted or you want a fresh start:

The database is `~/.awm/memory.db` (the path in `AWM_DB_PATH` of your MCP config; `memory_whoami` prints it).
Close every Claude Code session first, then delete it together with its WAL files (all memories lost):

```bash
# macOS / Linux / Git Bash
rm ~/.awm/memory.db ~/.awm/memory.db-wal ~/.awm/memory.db-shm
```

```powershell
# PowerShell
Remove-Item "$HOME\.awm\memory.db", "$HOME\.awm\memory.db-wal", "$HOME\.awm\memory.db-shm" -ErrorAction SilentlyContinue
```

To reset only one agent pool, don't delete rows by hand — memories have rows in several tables, and a
`DELETE FROM engrams` leaves the rest behind. Either point that project at a fresh pool (a new `AWM_AGENT_ID`
in its MCP config; the old pool stays untouched), or rebuild the store from the pools you want to keep:

```bash
awm export --db ~/.awm/memory.db --agent work --output work.json   # once per pool you keep
awm import work.json --db ~/.awm/memory-new.db --dedupe
# then point AWM_DB_PATH at memory-new.db (or swap the files with every session closed)
```

`awm setup --global` names the default pool `work`; a project install uses the project folder's name.
In PowerShell, write `~/.awm/...` as `$HOME/.awm/...`.

---

## Incognito Mode

For conversations where you don't want memory involved:

```bash
# macOS / Linux / Git Bash
AWM_INCOGNITO=1 claude
```

```powershell
# PowerShell (set for this one launch, cleared again when claude exits)
$env:AWM_INCOGNITO = '1'; claude; Remove-Item Env:AWM_INCOGNITO
```

Zero memory tools are registered — Claude can't see or call any of them, not even a reduced set. Other MCP servers still work.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No memory tools in Claude | Restart Claude Code after `awm setup --global` |
| First conversation slow (minutes, once) | Normal — the one-time ~175 MB ML model download. Subsequent sessions load from cache in ~1.5 s |
| Claude not saving memories | Check Stop hook in `~/.claude/settings.json` |
| Hook errors in log | Run `awm doctor claude-code` — it probes the port range and reports which sidecars are live and whether one serves this directory's agent. The hooks read the secret from the MCP config at run time, so there is no separate secret file to compare |
| `awm` command not found | Re-run `npm install -g agent-working-memory` |
| Memory seems stale | Say "Call memory_restore" or close/reopen session to trigger consolidation |
| Wrong memories surfacing | Use `memory_retract` to invalidate; give `memory_feedback(useful: false)` |

---

## Architecture Quick Reference

```
Claude Code ←stdio→ AWM MCP (22 tools)
                        ↓
                   AWM Engine
                   ├── Salience filter (write-time)
                   ├── 10-phase retrieval pipeline
                   ├── 7-phase consolidation (sleep)
                   └── Hebbian association graph
                        ↓
                   SQLite + FTS5
                   (single file: memory.db)

Hook Sidecar ←HTTP:8401+→ Claude Code hooks
   (binds the first free port    ├── Stop (reminder + implicit feedback — 0.20)
    in AWM_HOOK_PORT ..          ├── PreCompact (auto-checkpoint)
    +AWM_HOOK_PORT_RANGE,        ├── SessionEnd (checkpoint + consolidate)
    default 8401..8410,          ├── UserPromptSubmit (prime — 0.14.6)
    so a second project          └── PostToolUse Bash|PowerShell (DB-mutation
    walks to 8402)                   reminder; local, no sidecar call)
                          └── POST /memory/activate (0.12.2 — warm recall for e.g. a
                              UserPromptSubmit hook; warm recall p50 ~0.3 s on a 30k store,
                              no standing server needed, runs in the sidecar's own
                              process/model lifecycle)
```

All local. No cloud. No API keys. One SQLite file holds everything.

---

## Appendix: DB Telemetry & Stats Columns

**Status as of 0.12.2:** this section originally proposed A and B below as future work (written 2026-06-10, against the ~0.7.x schema). **A shipped in 0.12.0** as write-path telemetry (D1); **B shipped partially** — D1 also logs when a consolidation cycle exceeds 5s, but not the before/after counts or edge stats the proposal below describes. See the [0.12.0 CHANGELOG entry](../CHANGELOG.md) for the actual shape, which is a slow-write stderr log gated by `AWM_SLOW_WRITE_MS`, not a `write_events` table. C–F remain open proposals, not yet implemented.

### A. Write Pipeline Telemetry — ✅ shipped 0.12.0 (D1), different shape than proposed below

**Problem:** No visibility into why memories are discarded, what salience scores look like over time, or how the filter is performing.

**Recommended: `write_events` table**

```sql
CREATE TABLE IF NOT EXISTS write_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  concept TEXT NOT NULL,
  disposition TEXT NOT NULL,        -- 'active', 'staging', 'discard'
  salience_score REAL NOT NULL,
  reason_codes TEXT NOT NULL DEFAULT '[]',
  event_type TEXT,                  -- 'observation', 'decision', 'friction', 'surprise', 'causal'
  content_length INTEGER NOT NULL,  -- character count of content
  duplicate_of TEXT,                -- engram_id if discarded as duplicate
  latency_ms REAL NOT NULL          -- time to process write
);

CREATE INDEX idx_write_events_agent ON write_events(agent_id, timestamp);
CREATE INDEX idx_write_events_disposition ON write_events(agent_id, disposition);
```

**What this enables:**
- Salience score distribution over time (are scores drifting?)
- Discard rate by event_type (which types get filtered most?)
- Duplicate detection rate (is noise increasing?)
- Write latency trends

### B. Consolidation Telemetry — 🟡 partially shipped (duration only)

**Problem:** Consolidation (the "sleep cycle") runs silently. No way to know if it's helping, how long it takes, or what it changed.

**Recommended: `consolidation_events` table**

```sql
CREATE TABLE IF NOT EXISTS consolidation_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,                -- 'full', 'mini'
  duration_ms REAL NOT NULL,
  memories_before INTEGER NOT NULL,
  memories_after INTEGER NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0,    -- staging → active
  demoted INTEGER NOT NULL DEFAULT 0,     -- active → staging
  pruned INTEGER NOT NULL DEFAULT 0,      -- removed entirely
  edges_created INTEGER NOT NULL DEFAULT 0,
  edges_strengthened INTEGER NOT NULL DEFAULT 0,
  edges_pruned INTEGER NOT NULL DEFAULT 0,
  episodes_created INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_consolidation_agent ON consolidation_events(agent_id, timestamp);
```

**What this enables:**
- Consolidation frequency and duration trends
- Prune rate (is memory growing unbounded?)
- Edge creation vs pruning ratio (is the graph healthy?)
- Promotion rate (are staging memories getting used?)

### C. Retrieval Quality Telemetry

**Problem:** `activation_events` tracks what was returned but not retrieval quality over time.

**Recommended additions to existing `activation_events` table:**

```sql
ALTER TABLE activation_events ADD COLUMN pipeline_stages TEXT;  -- JSON: per-stage timing
ALTER TABLE activation_events ADD COLUMN candidate_count INTEGER;  -- before filtering
ALTER TABLE activation_events ADD COLUMN reranker_used INTEGER DEFAULT 1;
ALTER TABLE activation_events ADD COLUMN expansion_used INTEGER DEFAULT 1;
ALTER TABLE activation_events ADD COLUMN abstained INTEGER DEFAULT 0;  -- returned empty
ALTER TABLE activation_events ADD COLUMN context_length INTEGER;  -- chars in query
```

**What this enables:**
- Per-stage latency breakdown (BM25 vs vector vs reranker)
- Selectivity ratio (candidates → results)
- Abstention rate (how often is recall empty?)
- Query length impact on recall quality

### D. Feedback Loop Telemetry

**Problem:** `retrieval_feedback` exists but doesn't track trends or connect to write quality.

**Recommended additions to existing `retrieval_feedback` table:**

```sql
ALTER TABLE retrieval_feedback ADD COLUMN memory_age_hours REAL;  -- age of the recalled memory
ALTER TABLE retrieval_feedback ADD COLUMN recall_rank INTEGER;     -- position in results (1 = top)
ALTER TABLE retrieval_feedback ADD COLUMN memory_access_count INTEGER;  -- how often this memory has been recalled
```

**What this enables:**
- Memory age vs usefulness (do old memories stay relevant?)
- Rank accuracy (are top results actually the most useful?)
- Diminishing returns (does a memory get less useful with repeated recall?)

### E. Session-Level Aggregates

**Problem:** No way to see session-level patterns without querying raw events.

**Recommended: `session_stats` table**

```sql
CREATE TABLE IF NOT EXISTS session_stats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_start TEXT NOT NULL,
  session_end TEXT,
  duration_minutes REAL,
  writes_total INTEGER NOT NULL DEFAULT 0,
  writes_stored INTEGER NOT NULL DEFAULT 0,
  writes_discarded INTEGER NOT NULL DEFAULT 0,
  recalls_total INTEGER NOT NULL DEFAULT 0,
  recalls_empty INTEGER NOT NULL DEFAULT 0,       -- recalls that returned nothing
  feedback_useful INTEGER NOT NULL DEFAULT 0,
  feedback_not_useful INTEGER NOT NULL DEFAULT 0,
  retractions INTEGER NOT NULL DEFAULT 0,
  checkpoints INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0,          -- context compaction events
  tasks_started INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  consolidation_ran INTEGER NOT NULL DEFAULT 0     -- did consolidation run this session?
);

CREATE INDEX idx_session_stats_agent ON session_stats(agent_id, session_start);
```

**What this enables:**
- Session quality scoring (writes:recalls ratio, feedback rate)
- Compaction frequency (how often does context fill up?)
- Task completion rate per session
- Trend analysis across sessions (is memory getting more useful over time?)

### F. Enhanced `memory_stats` Output

With the tables above, `memory_stats` could return richer health metrics:

```
Agent: claude-code
Active memories: 142
Staging: 8
Retracted: 12

--- Pipeline Health ---
Write accept rate (7d): 23% (healthy: 15-40%)
Avg salience (active): 0.61
Recall precision (7d): 78% useful (from feedback)
Abstention rate (7d): 5%
Avg recall latency: 400ms (warm), ~3s on first recall after process start (model load + cache warm)

--- Consolidation ---
Last run: 2h ago
Last 7d: 4 full, 12 mini
Avg memories pruned/cycle: 3.2
Edge utility: 67%

--- Session ---
This session: 8 writes (5 stored), 6 recalls, 2 feedback
```

### Implementation Priority

| Priority | Table | Effort | Impact |
|----------|-------|--------|--------|
| **P1** | `write_events` | Low | High — most requested visibility gap |
| **P1** | `consolidation_events` | Low | High — consolidation is a black box today |
| **P2** | `activation_events` additions | Low | Medium — helps debug recall quality |
| **P2** | `session_stats` | Medium | High — enables trend analysis |
| **P3** | `retrieval_feedback` additions | Low | Medium — enables feedback loop tuning |
| **P3** | Enhanced `memory_stats` | Medium | High — user-facing improvement |

All tables are append-only event logs — no impact on existing read/write paths. Can be added incrementally via SQLite migrations.
