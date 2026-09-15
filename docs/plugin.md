# AWM as a Claude Code plugin

Two commands instead of a setup step. **Install the package first** — it carries the
plugin with it, so nothing here needs GitHub:

```bash
npm install -g agent-working-memory
awm plugin                  # prints the two lines below, with the real path on YOUR machine
```

```
/plugin marketplace add <the path awm plugin printed>
/plugin install awm@agent-working-memory
```

`awm plugin` exists because that path differs per machine and per OS. On Windows it is
typically `C:\Users\<you>\AppData\Roaming\npm\node_modules\agent-working-memory`,
which is not something anyone should be expected to type from memory.

<details>
<summary>Installing from GitHub instead</summary>

If you have a checkout, or would rather track the repository than the npm release:

```
/plugin marketplace add CompleteIdeas/agent-working-memory
/plugin install awm@agent-working-memory
```

That route needs GitHub access. The npm route above does not.
</details>

Restart Claude Code. You get the 19 memory tools, the session hooks, and the usage guidance —
the same things `awm setup --global` installs, but as one versioned artifact that updates
with two commands instead of by re-running a script.

---

## Install it properly

**The plugin does not bring the engine with it.** It ships the wiring — manifest, hooks,
guidance, and a launcher — and expects to find the package. Install that first:

```bash
npm install -g agent-working-memory
```

Without it the launcher falls back to `npx`, which works but rebuilds `better-sqlite3` on a
cold cache. That takes minutes and looks exactly like a hang, so it is worth the one command.

Requires **Node.js 22+**.

### Check it worked

```bash
awm doctor claude-code
```

That probes the hook port range and reports each live sidecar as `port=agent@version pid`. In
a session, ask Claude what memory tools it has — you should get 19, and `memory_whoami` will
tell you which store and agent the running process actually has.

---

## What gets installed

| | |
|---|---|
| **MCP server** | 19 memory tools, started through `bin/awm-mcp-launcher.cjs` |
| **`Stop` hook** | Reminds Claude to write what it learned |
| **`PreCompact` hook** | Checkpoints state before the context window is compressed |
| **`SessionEnd` hook** | Final checkpoint, and triggers consolidation |
| **`UserPromptSubmit` hook** | **Prime** — puts relevant memory into context before Claude sees your prompt |
| **`PostToolUse` hook** | Reminds you that a production data change is not done until it is written to memory |
| **`awm-memory` skill** | When to recall, when to write, how to tag so it can be found again |

---

## The store, and why this matters

The launcher defaults `AWM_DB_PATH` to **`~/.awm/memory.db`** — the same file
`awm setup --global` writes. That is deliberate: a plugin that opened its own database would
look like it worked while quietly giving you a second, empty memory. Everything you had
written would appear to be gone.

So a plugin install and a CLI install share one store. Point somewhere else by setting
`AWM_DB_PATH` yourself.

**Which agent you get.** With `AWM_AGENT_ID` unset, the server derives the pool from the
directory: anything under `Personal-Projects/` is `personal`, everything else is `work`. Two
sessions in different projects therefore get different pools from the same install, and the
hooks find the sidecar serving *their* agent rather than whichever process started first.

---

## Upgrading — it is not automatic

**A marketplace installed from a local directory never refreshes on its own.** Measured on a
real machine: two GitHub-sourced marketplaces both refreshed within the same second (a
scheduled refresh), while two directory-sourced ones had moved only when somebody ran the
command — one of them last touched **167 days** earlier.

Since the npm install route registers a *directory* marketplace, upgrading AWM is two steps,
and `npm update` alone is not enough:

```bash
npm install -g agent-working-memory@latest     # 1. new code
```

```
/plugin marketplace update agent-working-memory   # 2. re-read the manifest
/plugin install awm@agent-working-memory          #    (or /plugin update awm@…)
```

Then restart Claude Code. Skipping step 2 leaves the old hooks and skill in
`~/.claude/plugins/cache/` while the MCP server may already be running new code — which is
confusing precisely because it half-works.

`memory_whoami` reports the version the server is actually running, which is the fastest way
to tell what you have.

## Where this plugin works

| Surface | Works? | |
|---|---|---|
| **Claude Code** | **Yes** | Everything: 19 tools, all five hooks, the skill |
| **Claude Cowork** | **No — do not install it there** | The skill loads and hooks run, but the memory tools do not |
| **Claude Desktop** | Not yet | Needs an `.mcpb` bundle; Desktop does support local stdio MCP, so this is a packaging job rather than a limitation |

### Why not Cowork

Cowork supports plugins, and it supports skills, slash commands, sub-agents and hooks. What
it does not support is a **local stdio MCP server**, which is exactly what AWM is. Anthropic's
documentation is explicit: *"In Cowork, connectors reach external services through Anthropic's
cloud, not through your local network,"* and a custom connector *"must point to a server that's
reachable over the public internet from Anthropic's IP ranges."*

So installing this plugin in Cowork produces the worst kind of failure — one that looks like
success. The plugin appears installed, the `awm-memory` skill loads and tells Claude to call
`memory_recall`, and the tools are not there. The hooks would run but POST to `127.0.0.1:8401`,
which in Cowork is not your machine, so they find no sidecar and fail open: silent, exit 0.

Making AWM work in Cowork is not a packaging change. It would need a StreamableHTTP or SSE
transport (AWM is stdio-only), OAuth, and a server reachable from Anthropic's IP ranges — which
means the store leaves your machine. That contradicts the thing the product is for, so it is a
product decision, not a build step.

## Plugin or `awm setup`?

Both produce a working install. They differ in what they touch:

| | Plugin | `awm setup --global` |
|---|---|---|
| Install | Two slash commands | `npm i -g` then `awm setup --global` |
| Upgrade | `/plugin marketplace update agent-working-memory` **then** `/plugin update awm@agent-working-memory` | Re-run `awm setup --global` |
| `~/.claude/settings.json` | **Never touched** | AWM-owned hook groups rewritten |
| `~/.claude/CLAUDE.md` | **Never touched** — guidance is a skill | AWM section upserted |
| Guidance | Loaded on demand, versioned with the plugin | Always in context |
| Per-project MCP config | Not written | `.mcp.json` per project if you want it |

The settings.json row is the real argument. `awm setup` has to decide which hook groups it
owns before replacing them, and during the 0.14.6 rehearsal that ownership check matched too
broadly and deleted two hand-written hooks it had never installed. A plugin cannot make that
class of mistake, because Claude Code owns the wiring and AWM only declares it.

The guidance row cuts the other way. A skill is loaded when it looks relevant; the CLAUDE.md
section is simply always there. If you want the memory rules in front of the model on every
single turn regardless, `awm setup` is still the way to get that.

**Running both is fine** — they point at the same store. You will get two MCP servers
registered, which is wasted memory and a second sidecar on the next port. Pick one.

---

## Configuration

The manifest ships the three recommended retrieval flags on by default:

```
AWM_RERANK2=1  AWM_RERANK_WINDOW=query  AWM_RERANK_TAGS=1
```

Anything else goes in the environment Claude Code launches with:

| Variable | Default | What it does |
|---|---|---|
| `AWM_DB_PATH` | `~/.awm/memory.db` | The store. Set it for a separate pool |
| `AWM_AGENT_ID` | derived from the directory | Pins the pool instead of deriving it |
| `AWM_HOOK_PORT` | `8401` | First sidecar port tried |
| `AWM_HOOK_PORT_RANGE` | `10` | How far to walk upward when busy |
| `AWM_PACKAGE_ROOT` | — | Force a specific AWM checkout, ahead of every other lookup |

Full list with measured effects: [`reference.md`](reference.md).

### Turning prime off

`UserPromptSubmit` primes memory into context on every prompt over 15 characters. To silence
it without uninstalling, create an empty file:

```bash
touch ~/.claude/hooks/awm-prime.disabled
```

---

## Troubleshooting

**No memory tools after installing.** The launcher could not find the package. It prints the
paths it tried to stderr. Fix with `npm install -g agent-working-memory`, then restart.

**The first prompt hangs for minutes.** The `npx` fallback is rebuilding `better-sqlite3`.
Install the package globally and it will not happen again.

**Tools appear but recall is empty.** Check which store you actually opened —
`memory_whoami` reports the real path and agent of the running process. The usual cause is an
`AWM_DB_PATH` set somewhere in the environment, pointing the plugin at a different file from
the one your memories are in.

**Hooks do nothing.** Run `awm doctor claude-code`. Every hook fails open by design — no
output, exit 0 — so a missing sidecar is silent rather than noisy. Set `AWM_HOOK_DEBUG=1` and
they will log to `~/.claude/hooks/awm-hooks.log`.

**A name collision with another `awm` plugin.** Plugin names are qualified by marketplace, so
this one is always `awm@agent-working-memory`. If you also have AgentSynapse's `awm@agentsynapse`
installed, note that it is a different plugin — a multi-agent push channel that ships no
memory tools.

### Uninstall

```
/plugin uninstall awm@agent-working-memory
```

Your store is not touched. `~/.awm/memory.db` stays exactly where it is.

---

## For maintainers: `plugin/` is generated

Do not edit anything under `plugin/`. It is emitted by:

```bash
npm run build && npm run build:plugin
```

from the same modules `awm setup` uses — `HOOK_SCRIPTS` and `AWM_HOOKS_VERSION` from
`src/adapters/hook-scripts.ts`, `DB_MUTATION_HOOK_SCRIPT` from `src/adapters/claude-code.ts`,
`AWM_INSTRUCTION_CONTENT` and `RECOMMENDED_ENV` from `src/adapters/common.ts`.

That is the whole point. 0.14.6 exists because the same facts lived in two places and only
one got updated; a hand-maintained plugin directory would be a third copy of the hook wiring,
drifting on the same schedule. `npm run check:release` runs the generator with `--check` and
**blocks the release** if the committed output differs.

The one file that is not a template is `src/plugin/awm-mcp-launcher.cjs` — real code, kept in
a real file so it is syntax-checked and tested, copied into the bundle with only the version
substituted.

`tests/plugin/plugin-install.test.ts` walks the install path the way Claude Code does:
resolves the marketplace entry, expands `${CLAUDE_PLUGIN_ROOT}`, checks every referenced file
exists and parses, asserts the shipped hooks are byte-identical to `HOOK_SCRIPTS`, then starts
the MCP server over stdio and requires all 19 tools back. It uses a scratch database on
purpose — the launcher's job is to default to the user's real store, so a test that forgot to
override that would write into production memory.
