# AWM — Claude Code plugin

Installs Agent Working Memory as a plugin: the MCP server, the session hooks, and the usage
guidance, all versioned together. This is the plugin equivalent of `awm setup --global`.

**This directory is generated.** `npm run build:plugin` emits it from the same modules the
installer uses, and `npm run check:release` fails if the committed output has drifted. Edit
`src/adapters/`, not these files.

## What it installs

| | |
|---|---|
| MCP server | 1 server, 19 memory tools, via `bin/awm-mcp-launcher.cjs` |
| Hooks | Stop, PreCompact, SessionEnd, UserPromptSubmit (prime), PostToolUse — hooks v0.14.6 |
| Skill | `awm-memory` — when to recall, when to write, how to tag |

## The store

The launcher defaults `AWM_DB_PATH` to `~/.awm/memory.db` — **the same file
`awm setup --global` uses** — so a plugin install shares memory with a CLI install rather
than quietly starting an empty one. Set `AWM_DB_PATH` yourself to override.

It prefers an installed copy of the package (global, or a local `node_modules`) and falls
back to `npx -p agent-working-memory@0.15.4`. The npx path rebuilds
`better-sqlite3` on a cold cache, which is slow enough to look like a hang, so a real
install is worth having:

```bash
npm install -g agent-working-memory
```

## Turning prime off

`UserPromptSubmit` primes relevant memory into context. To silence it without uninstalling,
create an empty `~/.claude/hooks/awm-prime.disabled`.
