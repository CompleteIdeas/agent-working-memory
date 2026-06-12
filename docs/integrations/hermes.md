# Integration: Hermes Agent (Nous Research)

Use AWM as the persistent memory backend for [Hermes Agent](https://github.com/NousResearch/hermes-agent)
via the Model Context Protocol (MCP).

**No adapter code is required.** AWM already ships a stdio MCP server
(`dist/mcp.js`), and Hermes can launch any stdio MCP server. The entire
integration is: install AWM where Hermes can run it, then add one block to
Hermes' `config.yaml`. AWM's tools then appear to the agent as
`mcp_awm_memory_write`, `mcp_awm_memory_recall`, etc.

> Verified 2026-06-12 in Docker: a write in one session was recalled by a
> fresh session through AWM's cognitive recall, on both `claude-haiku-4-5`
> (Anthropic) and `gpt-5-4-mini` (Azure AI Foundry).

---

## TL;DR

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  awm:
    command: node
    args: ["/usr/local/lib/node_modules/agent-working-memory/dist/mcp.js"]
    env:
      AWM_AGENT_ID: hermes
      AWM_DB_PATH: /opt/data/awm/hermes.db      # put this on a persistent volume
      HF_HOME: /opt/data/.cache/huggingface     # persist the embedding model cache
    connect_timeout: 120
    timeout: 600        # first call downloads the embedding model — allow time
```

That's it. The path in `args` is wherever `npm i -g agent-working-memory`
placed the package (see below).

---

## Prerequisites

- A working Hermes install (CLI/Docker). Node 22 is bundled in the official
  Hermes Docker image, so AWM's stdio server runs inside it with no extra work.
- A model provider configured in Hermes (Anthropic, Azure, OpenRouter, local —
  AWM is model-agnostic; see [Model provider](#model-provider) for two worked
  examples).

---

## Step 1 — make AWM available to Hermes

AWM's MCP server is launched **by the Hermes process**, so the
`agent-working-memory` package must live in the same environment Hermes runs in.

### Docker (recommended)

Derive a thin image from the Hermes image and install AWM globally. The Hermes
image already has Node 22 and a C toolchain, so AWM's native dependency
(`better-sqlite3`) compiles cleanly:

```dockerfile
# Dockerfile.awm
FROM hermes-agent:local          # or your Hermes image tag

USER root
RUN npm install -g agent-working-memory@latest

# Persist the embedding-model cache in the data volume so it isn't
# re-downloaded on every container recreate.
ENV HF_HOME=/opt/data/.cache/huggingface
```

```bash
docker build -f Dockerfile.awm -t hermes-awm:local .
```

The global install path inside the image is
`/usr/local/lib/node_modules/agent-working-memory/dist/mcp.js` — that's what the
`args` in the config block point at.

### Local (non-Docker)

```bash
npm install -g agent-working-memory
node -e "console.log(require.resolve('agent-working-memory/dist/mcp.js'))"
```

Use the printed path as the `args` value in the config block.

---

## Step 2 — register AWM as an MCP server

Add the [`mcp_servers.awm`](#tldr) block to `~/.hermes/config.yaml` (inside the
Hermes data dir, e.g. `/opt/data/config.yaml` in Docker). Notes:

- **`AWM_DB_PATH`** must point at a persistent location (a mounted volume in
  Docker) so memories survive container/session recreation. Pre-create the
  parent directory — `better-sqlite3` will not create it.
- **`AWM_AGENT_ID`** namespaces the memories. Use a stable value per agent. Set
  it to a shared name (and `AWM_WORKSPACE`) if multiple agents should share a
  memory pool.
- **`timeout: 600`** — the *first* recall/write triggers a one-time embedding
  model download (~tens of MB) into `HF_HOME`. Subsequent calls are fast.

Hermes rewrites `config.yaml` to its full canonical form on first boot but
**preserves your `mcp_servers` block**.

---

## Step 3 — model provider

AWM does not care which model Hermes runs. Two worked examples:

### Anthropic (baked into the Hermes image)

```yaml
model:
  default: claude-haiku-4-5
  provider: anthropic            # needs ANTHROPIC_API_KEY in ~/.hermes/.env
```

### Azure AI Foundry — GPT-5.x (e.g. gpt-5-4-mini)

```yaml
model:
  default: gpt-5-4-mini                                        # the deployment name
  provider: azure-foundry
  base_url: https://<resource>.api.cognitive.microsoft.com/openai/v1
```

```bash
# ~/.hermes/.env
AZURE_FOUNDRY_API_KEY=<key>
AZURE_FOUNDRY_BASE_URL=https://<resource>.api.cognitive.microsoft.com/openai/v1
```

> ⚠️ **Azure GPT-5.x path gotcha.** GPT-5.x models on Azure use the *responses*
> API; Hermes auto-detects this and `POST`s to `{base_url}/responses`. The
> `base_url` **must end in `/openai/v1`** — with a bare host you get
> `POST .../responses` → **HTTP 404 "Resource not found"**. With `/openai/v1`
> you get the correct `POST .../openai/v1/responses` (the GA path; no
> `api-version` needed). If you hit a 404, read the request dump Hermes writes
> to `HERMES_HOME/sessions/request_dump_*.json` — it shows the exact URL it
> tried.

---

## Step 4 — verify

Write in one session, recall in a fresh one:

```bash
# Session 1 — write
docker run --rm -v /path/to/hermes-home:/opt/data hermes-awm:local \
  chat -q "Use mcp_awm_memory_write to save: my favorite database is PostgreSQL with pgBouncer. Report the engram id."

# Session 2 — fresh container, recall
docker run --rm -v /path/to/hermes-home:/opt/data hermes-awm:local \
  chat -q "Use mcp_awm_memory_recall to find my database preference. What is it?"
```

Expected: session 1 shows a `mcp_awm_memory_write` tool call returning an engram
UUID; session 2 (a fresh container — only the AWM DB persisted in the volume)
shows a `mcp_awm_memory_recall` call returning the stored fact.

---

## Tool names

MCP tools are namespaced `mcp_<server>_<tool>`. With `awm` as the server name:

| AWM tool | Hermes name |
|---|---|
| `memory_write` | `mcp_awm_memory_write` |
| `memory_recall` | `mcp_awm_memory_recall` |
| `memory_feedback` | `mcp_awm_memory_feedback` |
| `memory_task_begin` / `memory_task_end` | `mcp_awm_memory_task_begin` / `_end` |
| `compress_output` / `retrieve_original` | `mcp_awm_compress_output` / `_retrieve_original` |

All 16 AWM tools are exposed. Hermes also has its own lightweight memory
(`MEMORY.md` + FTS5 session search); AWM adds cognitive recall
(embeddings + BM25 + reranker + associative graph + decay) on top — leave both
on, or scope Hermes' built-in memory toolset off if you want AWM to be the sole
memory layer.

---

## Gotchas

- **Windows: clone Hermes with `git -c core.autocrlf=false clone …`.** Hermes'
  `.gitattributes` only pins `*.sh`/`Dockerfile` to LF, so with `autocrlf=true`
  the extensionless s6-overlay control files (`docker/s6-rc.d/*/type`, etc.) get
  CRLF and the container dies at boot with
  `s6-rc-compile: fatal: invalid .../type: must be oneshot, longrun, or bundle`.
- **First call is slow** — the embedding model downloads once into `HF_HOME`.
  Keep `HF_HOME` on the persistent volume so it's cached across runs.
- **`hermes mcp list`** may error `typer is required` — cosmetic, unrelated to
  runtime MCP. Verify with an actual `chat` instead.
- **`AWM_DB_PATH` parent dir** must exist before first run.

---

## Generic MCP hosts

Nothing here is Hermes-specific beyond the config syntax. Any MCP-capable host
(Claude Code, Cursor, etc.) launches AWM the same way — a stdio server:

```
command: node
args:    [<path>/agent-working-memory/dist/mcp.js]
env:     AWM_AGENT_ID, AWM_DB_PATH, HF_HOME, [AWM_WORKSPACE]
```

This is the same server Claude Code connects to; pointing two hosts at the same
`AWM_DB_PATH` (+ shared `AWM_AGENT_ID`/`AWM_WORKSPACE`) gives them a shared
cognitive memory.
