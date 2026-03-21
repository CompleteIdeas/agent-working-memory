# AWM Quickstart — 5 Minute Setup

## What is AWM?

Claude Code is powerful, but it has no memory between conversations. Every new session starts from scratch — it forgets what it learned, what decisions were made, and what you've been working on.

**AgentWorkingMemory (AWM)** is a local memory server that plugs into Claude Code. It gives Claude the ability to:

- **Remember** across sessions — decisions, bug fixes, architecture patterns, your preferences
- **Filter out noise** — a novelty-based filter stores new information and discards duplicates
- **Auto-save state** — hooks automatically checkpoint your work when context compresses or the session ends
- **Recall on demand** — Claude retrieves relevant memories when starting a new topic or project

It runs entirely on your machine as a lightweight background process. No cloud services, no API keys, no data leaves your computer. One shared memory works across all your projects.

---

## What you need

- **Windows 10/11** (macOS/Linux also work)
- **Claude Code** installed and working
- **Node.js 20+** — check with `node --version`

Don't have Node.js? Open PowerShell and run:
```powershell
winget install OpenJS.NodeJS.LTS
```
Then close and reopen your terminal.

---

## Setup

Run these two commands from any folder:

```bash
npm install -g agent-working-memory
awm setup --global
```

Then restart Claude Code. That's it — Claude now has persistent memory.

> The `--global` flag writes config to your home directory, so it works regardless of which folder you're in.

---

## Verify hooks are installed

The `awm setup --global` command automatically installs three hooks in `~/.claude/settings.json`:

- **Stop** — reminds Claude to save important learnings after each response
- **PreCompact** — auto-saves state before context window compression
- **SessionEnd** — auto-saves state and runs consolidation when you close the session

Open `~/.claude/settings.json` and confirm you see a `hooks` section with `Stop`, `PreCompact`, and `SessionEnd` entries. If it's missing, run `awm setup --global` again — it's safe to re-run.

> **No manual editing needed.** The setup command handles everything. See [team-setup-guide.md](team-setup-guide.md) if you need to add hooks manually.

---

## Verify it works

Start a new Claude Code conversation and ask:

> "What memory tools do you have?"

Claude should list 13 memory tools including `memory_write`, `memory_recall`, `memory_restore`, etc.

> **First conversation will be ~30 seconds slower** while ML models download (~124MB). This only happens once.

---

## Watch it work (optional)

Open a second terminal to see memory activity in real time:

**PowerShell:**
```powershell
Get-Content (Join-Path (npm root -g) "agent-working-memory\data\awm.log") -Wait
```

**Git Bash:**
```bash
tail -f "$(npm root -g)/agent-working-memory/data/awm.log"
```

You'll see every write, recall, and checkpoint as it happens.

---

## What does Claude do differently now?

Nothing changes for you. Claude automatically:
- Restores context at the start of each conversation
- Writes important discoveries, decisions, and fixes to memory
- Recalls relevant memories when you switch topics
- Auto-saves state when the context window compresses or the session ends

You can also explicitly ask:
- *"Save this to memory"*
- *"What do you remember about [topic]?"*
- *"Call memory_stats"* — shows how many memories, writes this session, etc.

---

## Separate memory pools (optional)

By default, `awm setup --global` creates one shared memory pool across all projects. If you want **isolated memory per folder** (e.g., work projects vs personal projects), place a `.mcp.json` in each parent folder with a different `AWM_AGENT_ID`:

**`C:\Users\you\work\.mcp.json`** — work memories only:
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

**`C:\Users\you\personal\.mcp.json`** — personal memories only:
```json
{
  "mcpServers": {
    "agent-working-memory": {
      "command": "node",
      "args": ["C:/path/to/agent-working-memory/dist/mcp.js"],
      "env": {
        "AWM_DB_PATH": "C:/path/to/agent-working-memory/data/memory.db",
        "AWM_AGENT_ID": "personal",
        "AWM_HOOK_PORT": "8402",
        "AWM_HOOK_SECRET": "your-secret-here"
      }
    }
  }
}
```

Claude Code uses the closest `.mcp.json` ancestor, so any project under `work/` gets the "work" pool and any under `personal/` gets the "personal" pool. Same database file — isolation is by agent ID. Use different hook ports if you run two sessions simultaneously.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Claude doesn't mention memory tools | Restart Claude Code after setup |
| First conversation is slow | Normal — models downloading (once only) |
| Claude isn't saving much | Add the Stop hook above, or say "save what you learned" |
| `awm` command not found | Run `npm install -g agent-working-memory` again |
| Node.js not found | Install via `winget install OpenJS.NodeJS.LTS` |

For the full setup guide with advanced options, see [team-setup-guide.md](team-setup-guide.md).

---

*No Docker, no cloud, no API keys. Everything runs locally on your machine.*
