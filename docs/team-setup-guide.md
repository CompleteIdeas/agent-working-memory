# AWM Setup Guide — Team Onboarding

## What is this?

Every time you start a new Claude Code conversation, Claude has zero memory of past work. You re-explain the same things, it forgets decisions it made an hour ago, and long conversations go circular as it loses earlier context.

AWM (AgentWorkingMemory) fixes that. It gives Claude persistent memory that works across every conversation and every project. When Claude learns something — a bug fix, an architecture decision, your preferences — it writes it to memory. Next conversation, it picks up where it left off.

**What it actually does:**

- **Remembers** decisions, bugs, patterns, and preferences across conversations
- **Forgets noise** — duplicate and low-value observations are filtered out automatically
- **Gets smarter over time** — novel information gets stored, frequently useful memories get stronger, unused ones fade
- **Auto-saves on context compaction** — when Claude's context window fills up, hooks auto-checkpoint your state
- **Auto-saves on session end** — when you close Claude Code, your working state is preserved
- **Manages tasks** — persistent task tracking that doesn't disappear when the conversation ends
- **Activity log** — see exactly what's happening in real time

Everything runs locally on your machine. No cloud, no API keys, no data leaves your computer. It's a single SQLite file.

> **Hosting AWM on a server instead of every laptop?**
> This guide covers per-user installs. For a shared deploy — Docker,
> Railway, Fly, Render, or systemd — see [`deployment.md`](deployment.md).
> It captures the gotchas (Railway `VOLUME` rejection, glibc vs musl,
> Node 20 EOL) so you don't have to rediscover them.

---

## Option A: Install with npm (recommended)

### Requirements

- **Node.js 22 LTS+** — check with `node --version` (Node 20 reached EOL 2026-04-30; AWM 0.8.6+ requires 22)
- **Claude Code** — the CLI tool from Anthropic

### Install (2 minutes)

Open a terminal and run:

```bash
npm install -g agent-working-memory
```

Then set it up globally (one brain across all your projects):

```bash
awm setup --global
```

That's it. This does four things:
1. Creates `~/.mcp.json` — tells Claude Code to load the AWM memory server
2. Creates `~/.claude/CLAUDE.md` — gives Claude instructions on when to use memory
3. Installs the hooks in `~/.claude/settings.json` (memory priming, auto-checkpoint, reminders — see below)
4. Installs the `awm-learn` skill in `~/.claude/skills/awm-learn/` (0.22.2) — `/awm-learn` learns a whole repo or folder into memory

**Restart Claude Code** after setup.

The first conversation will take minutes longer while it downloads three ML models (**~175 MB**: 134 MB embedder + 23 MB MiniLM reranker + 17 MB Ettin reranker, both int8). These are cached locally — only happens once.

---

## Option B: Install Node.js first, then AWM (PowerShell)

If you don't have Node.js or npm installed yet, install Node.js (which includes npm), then install AWM with npm.

### Step 1: Install Node.js

Open PowerShell as Administrator and run:

```powershell
# Using winget (built into Windows 11)
winget install OpenJS.NodeJS.LTS

# Then close and reopen PowerShell, verify:
node --version   # should show v22+ (Node 20 reached EOL 2026-04-30)
npm --version
```

If winget isn't available, download from https://nodejs.org (LTS version).

### Step 2: Install AWM

```powershell
npm install -g agent-working-memory
```

### Step 3: Run setup

```powershell
awm setup --global
```

### Step 4: Restart Claude Code

Close and reopen Claude Code. The memory tools will appear automatically.

---

## Option C: Clone from GitHub (no npm publish needed)

If npm is down or you want the latest code directly:

```powershell
# Clone the repo
git clone https://github.com/CompleteIdeas/agent-working-memory.git C:\tools\awm

# Install dependencies and build
cd C:\tools\awm
npm install
npm run build

# Run setup
node dist/cli.js setup --global
```

---

## Setting up the hooks

`awm setup --global` does this for you. Since 0.14.6 it installs **script files** rather than
inline `curl` commands, so there is nothing to hand-edit and no secret to paste:

| File | What it does |
|---|---|
| `~/.claude/hooks/awm-find-sidecar.cjs` | Works out which server this project talks to — reads the MCP config for the directory, probes the port range, picks the sidecar whose `/health` reports that agent |
| `~/.claude/hooks/awm-checkpoint.cjs` | Auto-saves on PreCompact and SessionEnd |
| `~/.claude/hooks/awm-used.cjs` | Stop (0.20) — reminds Claude to save what it learned, and credits the memories the reply actually used (implicit feedback) |
| `~/.claude/hooks/awm-prime.cjs` | Puts relevant memory into context when you send a prompt |
| `~/.claude/hooks/awm-db-mutation-reminder.cjs` | PostToolUse on Bash / PowerShell — reminds Claude that a data change is not done until it is written to memory |
| `~/.claude/hooks/awm-hooks.json` | A record of what setup installed |

**Check it worked:**

```bash
awm doctor claude-code
```

That probes the whole port range and reports each live sidecar as `port=agent@version pid`,
warns if none of them serves the agent this directory is configured for, and flags hooks left
over from before 0.14.6. It is more reliable than reading `settings.json` yourself.

**Things that used to be manual and are not any more:**

- *You do not paste a secret.* The bearer token lives in the MCP config and the hooks read it
  at run time. Rotating it no longer leaves the hooks silently failing. It is deliberately
  never written into `settings.json`.
- *You do not assign ports.* Running two projects at once — say `work` and `personal` — needs
  no configuration: the second server finds 8401 taken and walks to 8402, and each project's
  hooks find the sidecar for their own agent rather than whichever server started first.
- *Re-running setup is safe.* It upgrades rather than resets: your own hooks on those events
  survive, and any env value you have already set wins over the default.

If you are upgrading from a version before 0.14.6, re-run `awm setup --global` once. `awm doctor`
will tell you if the old inline-`curl` hooks are still in place.

**What the hooks do:**
- **Stop** — reminds Claude to save important learnings after each response, and credits the recalls the reply used (background, no delay)
- **PreCompact** — auto-saves state before Claude's context window gets compressed
- **SessionEnd** — auto-saves state when you close the session, and triggers consolidation
- **UserPromptSubmit** — primes relevant memory into context before Claude sees your prompt
- **PostToolUse (Bash / PowerShell)** — after a shell command, reminds Claude to record a data change in memory
- **Every 15 minutes** — a silent auto-checkpoint while the session is active

---


## How do I know it's working?

### 1. Ask Claude

Start a new conversation and ask:

> "What memory tools do you have?"

Claude should mention `memory_write`, `memory_recall`, `memory_restore`, `memory_task_begin`, `memory_task_end`, etc. — 22 tools total (18 `memory_*` + 2 onboarding + `compress_output` / `retrieve_original`).

### 2. Check the activity log

Open a second terminal and watch the log in real time:

The log is `awm.log`, next to the database — `~/.awm/awm.log` for a default install.

**PowerShell:**
```powershell
Get-Content "$HOME\.awm\awm.log" -Wait
```

**macOS / Linux / Git Bash:**
```bash
tail -f ~/.awm/awm.log
```

You'll see one line per event (`time | agent | event | detail`):
```
2026-11-15T14:30:00.000Z | work | startup | MCP server starting (backend: sqlite, db: C:/Users/you/.awm/memory.db, hooks: 8401)
2026-11-15T14:30:01.000Z | work | restore | idle=5min checkpoint=true recalled=3 lastWrite=JWT token rotation
2026-11-15T14:30:40.000Z | work | hook:prime | "how does the auth middleware work" (…) → 2/8 injected, ~210 tok
2026-11-15T14:31:00.000Z | work | recall | "auth middleware patterns" → 2 results
2026-11-15T14:32:00.000Z | work | write:active | "JWT token rotation" salience=0.52 novelty=1.0 id=…
2026-11-15T14:32:30.000Z | work | hook:used | 1 recalled memory credited from the reply
2026-11-15T14:45:00.000Z | work | hook:PreCompact | auto-checkpoint files=4 task="…"
```

If the log path is different on your machine, ask Claude to call `memory_stats` — it shows the log path.

### 3. Ask Claude for stats

> "Call memory_stats"

This shows active memory count, session writes/recalls, checkpoint status, and log path.

---

## What changes in my workflow?

**Nothing.** You use Claude Code exactly as before. The memory works automatically:

- Claude writes important discoveries to memory as it works
- At the start of new conversations, Claude restores previous context
- When switching topics, Claude recalls relevant past memories
- Hooks auto-save state on context compaction and session end

You don't need to tell Claude to "remember this" — but you can if you want to be explicit.

**Helpful prompts if Claude isn't saving enough:**
- "Save what you learned to memory"
- "What do you have in memory about [topic]?"
- "Call memory_stats to see what's stored"

---

## Separate memory pools

By default, `awm setup --global` creates a single shared memory pool (one `AWM_AGENT_ID` for everything). This is fine for most users — all your projects share the same brain.

But if you work across different contexts (e.g., client work vs personal projects) and want **isolated memory**, you can create separate pools by placing `.mcp.json` files in parent folders with different agent IDs.

### How it works

Every memory in AWM is namespaced by `AWM_AGENT_ID`. Different IDs = completely separate pools. Same database file, zero cross-contamination.

Claude Code walks up the directory tree to find the nearest `.mcp.json`. The closest one wins:

```
~/.mcp.json                    ← global fallback (agentId: "work" — what `awm setup --global` writes)
C:\Users\you\work\.mcp.json   ← work projects (agentId: "work")
C:\Users\you\personal\.mcp.json ← personal projects (agentId: "personal")
```

Opening Claude Code in `work/ProjectA/` → uses "work" pool. Opening in `personal/SideProject/` → uses "personal" pool.

### Setup

1. Create a `.mcp.json` in each parent folder. Copy from your `~/.mcp.json` and change:
   - `AWM_AGENT_ID` — unique name for this pool (e.g., `"work"`, `"personal"`, `"client-x"`)

   Leave `AWM_HOOK_PORT` as it is: since 0.14.2 each server walks to the next free port on its own, and
   the hooks find the sidecar for their own agent (see *Setting up the hooks* above).

Example for `C:\Users\you\work\.mcp.json`:
```json
{
  "mcpServers": {
    "agent-working-memory": {
      "command": "node",
      "args": ["C:/path/to/agent-working-memory/dist/mcp.js"],
      "env": {
        "AWM_DB_PATH": "C:/Users/you/.awm/memory.db",
        "AWM_AGENT_ID": "work",
        "AWM_HOOK_PORT": "8401",
        "AWM_HOOK_SECRET": "your-secret-here"
      }
    }
  }
}
```

2. Optionally keep `~/.mcp.json` as a fallback for folders not under any parent config.

3. Restart Claude Code in each folder.

### Per-project isolation

You can go even more granular — put a `.mcp.json` inside a specific project folder with its own agent ID. That project gets its own private memory pool while sibling projects share the parent pool.

### Verifying isolation

In each folder, ask Claude: *"Call memory_stats"* — it will show the agent ID and memory count for that pool.

---

## Where does the data live?

| File | Purpose |
|------|---------|
| `~/.mcp.json` | MCP server config (tells Claude Code to load AWM) |
| `~/.claude/CLAUDE.md` | Memory workflow instructions for Claude |
| `~/.claude/settings.json` | Hooks config (auto-checkpoint, reminders) |
| `~/.awm/memory.db` | SQLite database (all memories) — NEVER inside the package |
| `~/.awm/awm.log` | Activity log (writes, recalls, checkpoints) |
| `~/.claude/hooks/awm-*.cjs` | The shipped hook scripts `awm setup` installs |
| `~/.claude/hooks/awm-hooks.json` | Record of what setup installed, used by the hooks to find the server |

To start fresh, delete `~/.awm/memory.db` and Claude starts with a blank slate.

---

## Troubleshooting

**Claude doesn't mention memory tools:**
- Make sure you restarted Claude Code after running `awm setup --global`
- Check that `~/.mcp.json` exists and contains an `agent-working-memory` entry
- Run `awm setup --global` again — safe to re-run

**First conversation is slow:**
- Normal — ML models are downloading (**~175 MB**). Only happens once.

**Not seeing writes in the log:**
- The Stop hook reminder helps but Claude may still skip writes
- Explicitly ask: "Save what you learned about [topic] to memory"
- Check `memory_stats` to see session write count

**Hook errors:**
- The hooks are Node scripts (since 0.14.6), so they need only `node` on your PATH: `node --version` (22 or newer)
- Run `awm doctor claude-code` — it checks the live sidecars, the installed hook versions, and whether one serves this directory's agent. The secret is read from the MCP config at run time, so there is nothing to compare by hand
- Test the sidecar: `curl http://127.0.0.1:8401/health` (PowerShell: `curl.exe http://127.0.0.1:8401/health`). If several sessions are running, the sidecar may be on 8402–8410 — `awm doctor claude-code` lists them

**Want to see what Claude remembers:**
- Ask: "What do you have in memory about [topic]?"
- Or: "Call memory_recall with query [topic]"

---

## Questions?

Ask your team lead — or ask Claude. It probably remembers.
