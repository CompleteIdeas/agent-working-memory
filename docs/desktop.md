# AWM in Claude Desktop

Claude Desktop runs local MCP servers over stdio, so AWM works there natively — same engine,
same store, same nineteen tools you get in Claude Code.

## Install

**1. Install the package.** The extension ships the wiring, not the engine:

```bash
npm install -g agent-working-memory
```

Node 22+. Skipping this is the single most common way to end up with an extension that
installs cleanly and then does nothing — see [Why the bundle is small](#why-the-bundle-is-small).

**2. Install the extension.** Double-click `agent-working-memory-<version>.mcpb`, drag it onto
the Claude Desktop window, or go to **Settings → Extensions → Advanced settings → Install
Extension…**

Desktop will show you two settings before it finishes:

| Setting | Default | |
|---|---|---|
| **Memory database** | `${HOME}/.awm/memory.db` | Leave it to share one store with Claude Code |
| **Memory pool** | `work` | Which pool this reads and writes |

**3. Restart Desktop** and ask Claude what memory tools it has. You should get nineteen.

### Building the bundle yourself

There is no published release asset yet, so build it from the repo:

```bash
npm install -g @anthropic-ai/mcpb   # once
npm run build && npm run build:mcpb
npm run pack:mcpb                   # -> dist-mcpb/agent-working-memory-<version>.mcpb
```

---

## The store is shared, and that is the point

`AWM_DB_PATH` defaults to `~/.awm/memory.db` — the same file `awm setup --global` and the
Claude Code plugin use. A decision recorded while coding is recalled in Desktop, and a note
made in Desktop is there next time you open a terminal.

If you point Desktop at a different file you get a second, separate memory. That is a
legitimate choice — a personal store kept apart from work — but it is a choice, not a default.

## The memory pool

Claude Code derives the pool from the project directory: anything under `Personal-Projects/`
is `personal`, everything else is `work`. **Desktop has no project directory**, so there is
nothing to derive from, and the manifest exposes the pool as a setting instead. It defaults to
`work`.

Clearing the field is safe — the launcher drops empty settings rather than pinning an empty
agent, and the server falls back to its own default.

---

## Why the bundle is small

An `.mcpb` normally vendors every dependency so the install is genuinely one click. AWM does
not, and the reason is size:

| | |
|---|---|
| `onnxruntime-node` | **208 MB** — it carries darwin, linux *and* win32 binaries |
| `onnxruntime-web` | 91 MB |
| `@huggingface/transformers` | 47 MB |
| `better-sqlite3` | 12 MB, and it **compiles per platform** |
| Full `node_modules` | **~497 MB** |

A self-contained bundle would be roughly 350 MB, and because `better-sqlite3` is built rather
than shipped, it would have to be three separate bundles — one per platform — with a release
pipeline to produce them.

So this bundle is **4.6 KB**: a manifest and a launcher. The launcher finds an installed copy
of the package, checking an explicit `AWM_PACKAGE_ROOT`, then an AWM checkout, then a local
`node_modules`, then the global npm root, and finally falling back to `npx`.

The trade is one prerequisite instead of a 350 MB download, and it is stated in the
description Desktop shows at install time rather than discovered afterwards.

**If you want the fat bundle**, nothing here prevents it — it is a release-infrastructure job
(per-platform builds, `better-sqlite3` prebuilds, three artifacts per release), not a change
to how any of this works.

---

## Troubleshooting

**The extension installed but there are no memory tools.** The launcher could not find the
package. Install it globally and restart Desktop. The launcher writes the paths it tried to
stderr, which Desktop surfaces in the extension's logs.

**The first message hangs for a minute or two.** The `npx` fallback is downloading and
rebuilding `better-sqlite3`. Install the package globally and it stops happening.

**Tools work but recall returns nothing.** Check the Memory database setting — the usual cause
is Desktop pointing at a different file from the one holding your memories. `memory_whoami`
reports the store and agent the running process actually has, which is the fastest way to see
the mismatch.

**Both Claude Code and Desktop are running.** That is fine and expected. SQLite is in WAL
mode, which is multi-process safe, so several sessions can share one store. Each process
starts its own hook sidecar on the next free port from 8401.

---

## What Desktop does not get

Claude Code's hooks — checkpoint on compaction, prime on prompt, the session-end consolidation
pass. Desktop has no hook system, so memory there is **tool-driven only**: Claude writes and
recalls when it decides to, rather than being prompted by the session lifecycle.

In practice that means Desktop is good at recalling what the rest of your setup has already
written, and less reliable at capturing new knowledge on its own. If Desktop is your only
surface, expect to ask Claude to remember things explicitly.

## For maintainers

`mcpb/` is generated by `npm run build:mcpb` from `src/`, and `npm run check:release` blocks
if the committed output has drifted. It reuses `src/plugin/awm-mcp-launcher.cjs` — the same
launcher the Claude Code plugin ships — so the two surfaces cannot disagree about how to find
the server or which store to open.

`tests/plugin/mcpb-bundle.test.ts` covers what `mcpb validate` cannot: that `entry_point` names
a file that exists, that every `${user_config.*}` reference is a declared setting, that the
prerequisite appears in the text a user actually reads, and that the launcher survives the
empty strings Desktop sends for cleared settings.
