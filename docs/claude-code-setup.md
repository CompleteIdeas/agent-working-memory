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

- **Node.js 20+** — `node --version`
- **Claude Code** installed and working

### Install & configure

```bash
npm install -g agent-working-memory
awm setup --global
```

Restart Claude Code. Done — 13 memory tools appear automatically.

> First conversation takes ~30s while ML models download (~124MB). Cached after that.

### What `awm setup --global` creates

| File | Purpose |
|------|---------|
| `~/.mcp.json` | Tells Claude Code to load the AWM MCP server |
| `~/.claude/CLAUDE.md` | Memory workflow instructions (when to write, recall, checkpoint) |
| `~/.claude/settings.json` | Auto-checkpoint hooks (Stop, PreCompact, SessionEnd) |

### Verify

Start a new conversation:

> "What memory tools do you have?"

Claude should list: `memory_write`, `memory_recall`, `memory_restore`, `memory_feedback`, `memory_retract`, `memory_stats`, `memory_checkpoint`, `memory_task_add`, `memory_task_update`, `memory_task_list`, `memory_task_next`, `memory_task_begin`, `memory_task_end`.

---

## How AWM works with Claude Code

### Automatic behaviors (via hooks)

These happen without any action from you:

| Trigger | What happens |
|---------|-------------|
| **Session start** | Claude calls `memory_restore` — recovers execution state + recalls recent context |
| **Every response** | Stop hook reminds Claude to save important learnings |
| **Context compaction** | PreCompact hook auto-checkpoints state before context window shrinks |
| **Session end** | SessionEnd hook auto-checkpoints + triggers consolidation (sleep cycle) |
| **Every 15 min** | Silent auto-checkpoint while session is active |

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

---

## Best Practices

### 1. Let Claude learn naturally

Don't micromanage memory. Claude is prompted (via CLAUDE.md) to save important discoveries automatically. The salience filter discards noise — 77% of write attempts are filtered out as duplicates or low-value.

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

### 6. Start sessions with restore

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

Each project gets its own memory namespace. Same database file — isolation by agent ID. See [Separate Memory Pools](../README.md#separate-memory-pools).

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

```bash
# PowerShell
Get-Content (Join-Path (npm root -g) "agent-working-memory\data\awm.log") -Wait

# Git Bash
tail -f "$(npm root -g)/agent-working-memory/data/awm.log"
```

### Sidecar stats

```bash
curl http://127.0.0.1:8401/stats
# {"writes": 8, "recalls": 9, "hooks": 3, "total": 25}
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

```bash
# Find the database
npm root -g  # then navigate to agent-working-memory/data/

# Delete the database (all memories lost)
rm memory.db memory.db-shm memory.db-wal

# Or just reset one agent pool
sqlite3 memory.db "DELETE FROM engrams WHERE agent_id = 'claude-code'"
```

---

## Incognito Mode

For conversations where you don't want memory involved:

```bash
AWM_INCOGNITO=1 claude
```

All 13 tools are hidden. Claude operates without memory. Other MCP servers still work.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No memory tools in Claude | Restart Claude Code after `awm setup --global` |
| First conversation slow (~30s) | Normal — ML model download (one-time) |
| Claude not saving memories | Check Stop hook in `~/.claude/settings.json` |
| Hook errors in log | Verify `curl` is available; check secret matches `data/.awm-hook-secret` |
| `awm` command not found | Re-run `npm install -g agent-working-memory` |
| Memory seems stale | Say "Call memory_restore" or close/reopen session to trigger consolidation |
| Wrong memories surfacing | Use `memory_retract` to invalidate; give `memory_feedback(useful: false)` |

---

## Architecture Quick Reference

```
Claude Code ←stdio→ AWM MCP (13 tools)
                        ↓
                   AWM Engine
                   ├── Salience filter (write-time)
                   ├── 10-phase retrieval pipeline
                   ├── 7-phase consolidation (sleep)
                   └── Hebbian association graph
                        ↓
                   SQLite + FTS5
                   (single file: memory.db)

Hook Sidecar ←HTTP:8401→ Claude Code hooks
                          ├── Stop (memory reminder)
                          ├── PreCompact (auto-checkpoint)
                          └── SessionEnd (checkpoint + consolidate)
```

All local. No cloud. No API keys. One SQLite file holds everything.

---

## Appendix: Recommended DB Telemetry & Stats Columns

AWM's current schema tracks core memory operations but lacks system health telemetry that would help evaluate long-term performance, diagnose issues, and tune behavior. These recommendations add observability without changing existing tool behavior.

### A. Write Pipeline Telemetry

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

### B. Consolidation Telemetry

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
Avg recall latency: 180ms

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
