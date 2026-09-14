# Agent Working Memory — Claude Desktop extension

**Generated.** `npm run build:mcpb` emits this from `src/`; `npm run check:release` fails if
the committed output has drifted. Edit the source, not these files.

## Build the installable bundle

```bash
npm install -g @anthropic-ai/mcpb   # once
npm run build && npm run build:mcpb
npm run pack:mcpb                   # -> dist-mcpb/agent-working-memory-<version>.mcpb
```

Install the result by double-clicking it, dragging it onto the Claude Desktop window, or
**Settings → Extensions → Advanced settings → Install Extension…**

## Why this bundle is small

MCPB normally vendors every dependency. For AWM that would be roughly 350 MB —
`onnxruntime-node` alone is 208 MB because it carries darwin, linux and win32 binaries — and
`better-sqlite3` compiles per platform, so it would have to be three separate bundles.

This ships the manifest and the launcher instead, and the launcher finds an installed
`agent-working-memory`. The trade is one prerequisite:

```bash
npm install -g agent-working-memory
```

That requirement is in the description the user reads at install time, rather than being
discovered afterwards as an extension that does nothing.

## The store

`AWM_DB_PATH` defaults to `${HOME}/.awm/memory.db` — the same file `awm setup --global` and
the Claude Code plugin use. Memory written in one surface is recalled in the other. Desktop
shows it as a configurable field at install time.

Desktop has no project directory, so the agent pool cannot be derived the way Claude Code
derives it. The manifest exposes it as a setting, defaulting to `work`.
