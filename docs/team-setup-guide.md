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

---

## Option A: Install with npm (recommended)

### Requirements

- **Node.js 20+** — check with `node --version`
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

That's it. This does three things:
1. Creates `~/.mcp.json` — tells Claude Code to load the AWM memory server
2. Creates `~/.claude/CLAUDE.md` — gives Claude instructions on when to use memory
3. Installs auto-checkpoint hooks in `~/.claude/settings.json`

**Restart Claude Code** after setup.

The first conversation will take ~30 seconds longer while it downloads three small ML models (~124MB). These are cached locally — only happens once.

---

## Option B: Install without npm (PowerShell)

If you don't have Node.js or npm installed, you can set everything up manually.

### Step 1: Install Node.js

Open PowerShell as Administrator and run:

```powershell
# Using winget (built into Windows 11)
winget install OpenJS.NodeJS.LTS

# Then close and reopen PowerShell, verify:
node --version   # should show v20+ or v22+
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

## Setting up the hooks (important)

AWM includes hooks that auto-save your state. After running `awm setup --global`, check that your hooks are installed:

Open `~/.claude/settings.json` and verify it contains a `hooks` section. If it doesn't, add it manually:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"MEMORY REMINDER: Before you finish this response, consider: Did you learn anything worth saving? Call memory_write for important discoveries, decisions, or outcomes. If you completed a task, call memory_task_end with a summary.\"",
            "timeout": 5,
            "async": true
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
            "command": "curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint -H \"Content-Type: application/json\" -H \"Authorization: Bearer YOUR_SECRET_HERE\" -d \"{\\\"hook_event_name\\\":\\\"PreCompact\\\"}\" --max-time 5",
            "timeout": 10
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
            "command": "curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint -H \"Content-Type: application/json\" -H \"Authorization: Bearer YOUR_SECRET_HERE\" -d \"{\\\"hook_event_name\\\":\\\"SessionEnd\\\"}\" --max-time 5",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `YOUR_SECRET_HERE` with the secret from `awm setup` output, or find it at:
- npm install: check inside the AWM package `data/.awm-hook-secret`
- Git clone: `C:\tools\awm\data\.awm-hook-secret`

**What the hooks do:**
- **Stop** — reminds Claude to save important learnings after each response (runs in background, no delay)
- **PreCompact** — auto-saves state before Claude's context window gets compressed
- **SessionEnd** — auto-saves state when you close the session

---

## How do I know it's working?

### 1. Ask Claude

Start a new conversation and ask:

> "What memory tools do you have?"

Claude should mention `memory_write`, `memory_recall`, `memory_restore`, `memory_task_begin`, `memory_task_end`, etc. — 13 tools total.

### 2. Check the activity log

Open a second terminal and watch the log in real time:

**PowerShell:**
```powershell
Get-Content "$(npm root -g)\agent-working-memory\data\awm.log" -Wait
```

**Bash/Git Bash:**
```bash
tail -f "$(npm root -g)/agent-working-memory/data/awm.log"
```

You'll see one line per event:
```
2026-03-10T14:30:00Z | claude | startup     | MCP server starting...
2026-03-10T14:30:01Z | claude | restore     | idle=5min checkpoint=true recalled=3
2026-03-10T14:31:00Z | claude | recall      | "auth middleware patterns" → 2 results
2026-03-10T14:32:00Z | claude | write:active| "JWT token rotation" salience=0.52 novelty=1.0
2026-03-10T14:45:00Z | claude | hook:PreCompact | auto-checkpoint files=4
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
~/.mcp.json                    ← global fallback (agentId: "claude")
C:\Users\you\work\.mcp.json   ← work projects (agentId: "work")
C:\Users\you\personal\.mcp.json ← personal projects (agentId: "personal")
```

Opening Claude Code in `work/ProjectA/` → uses "work" pool. Opening in `personal/SideProject/` → uses "personal" pool.

### Setup

1. Create a `.mcp.json` in each parent folder. Copy from your `~/.mcp.json` and change:
   - `AWM_AGENT_ID` — unique name for this pool (e.g., `"work"`, `"personal"`, `"client-x"`)
   - `AWM_HOOK_PORT` — different port per pool if you run multiple sessions at once (e.g., `8401`, `8402`)

Example for `C:\Users\you\work\.mcp.json`:
```json
{
  "mcpServers": {
    "agent-working-memory": {
      "command": "node",
      "args": ["C:/path/to/agent-working-memory/dist/mcp.js"],
      "env": {
        "AWM_DB_PATH": "C:/path/to/agent-working-memory/data/memory.db",
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
| `data/memory.db` | SQLite database (all memories) |
| `data/awm.log` | Activity log (writes, recalls, checkpoints) |
| `data/.awm-hook-secret` | Auth token for hook sidecar |

To start fresh, delete `data/memory.db` and Claude starts with a blank slate.

---

## Troubleshooting

**Claude doesn't mention memory tools:**
- Make sure you restarted Claude Code after running `awm setup --global`
- Check that `~/.mcp.json` exists and contains an `agent-working-memory` entry
- Run `awm setup --global` again — safe to re-run

**First conversation is slow:**
- Normal — ML models are downloading (~124MB). Only happens once.

**Not seeing writes in the log:**
- The Stop hook reminder helps but Claude may still skip writes
- Explicitly ask: "Save what you learned about [topic] to memory"
- Check `memory_stats` to see session write count

**Hook errors:**
- Verify curl is available: `curl --version` (comes with Windows 11)
- Check the secret matches: compare `~/.claude/settings.json` hooks with `data/.awm-hook-secret`
- Test the sidecar: `curl http://127.0.0.1:8401/health`

**Want to see what Claude remembers:**
- Ask: "What do you have in memory about [topic]?"
- Or: "Call memory_recall with query [topic]"

---

## Questions?

Ask your team lead — or ask Claude. It probably remembers.
