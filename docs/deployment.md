# Deploying AWM

AWM is a single Node.js process with a SQLite file. Local install via
`npm install -g agent-working-memory` covers most users — this doc is for
the case where you need AWM running on a server: as a shared backend for a
team of agents, as the memory tier for a hosted app, or simply because you
want it always-on rather than per-session.

Three patterns covered here, in order of complexity:

1. **Docker container** — base recipe; the foundation for the rest.
2. **Railway / Fly / Render** — managed platforms that consume the Docker image.
3. **Plain Linux server (systemd)** — when you want full control.

Plus a section on **backup, restore, and migration**: file-level copies for
whole stores, and the `awm export` / `awm import` / `awm merge` CLI commands for
moving one agent's memories between stores.

---

## 1. The Docker recipe (foundation)

The canonical Dockerfile lives at the top of the AWM repo. It's
multi-stage (build with full toolchain, ship with prod deps only). The
models are not baked into the image: about 175 MB downloads to the model
cache on first use, which is why the cache belongs on the persistent volume.

Key choices baked into the recipe, in case you adapt it:

| Choice | Why |
|---|---|
| `FROM node:22-bookworm-slim` (glibc) | `node:20-alpine` (musl) cannot load `onnxruntime-node` prebuilt native bindings — they're glibc-only. Bookworm-slim is the same size class with broad compat. Node 20 reached EOL on 2026-04-30; Node 22 is the current LTS line (until 2027-04-30). |
| No `VOLUME` directive | Railway's builder rejects Dockerfiles with `VOLUME`. Other orchestrators (k8s, compose) handle persistent mounts at their own layer, so the image-level directive is redundant. Mount `/data` from outside. |
| `apt-get install wget ca-certificates` | The HEALTHCHECK uses `wget --spider`. Bookworm-slim doesn't ship it. |
| `ARG BUILD_TIMESTAMP=unset` at the bottom | Cache-bust. Without it, two builds with bit-identical source can produce the same image digest, which some platforms register as "nothing to deploy." Pass `--build-arg BUILD_TIMESTAMP=$(date +%s)` per build. |
| `CMD ["sh", "-c", "echo banner && exec node dist/index.js"]` | `exec` keeps node as PID 1, so SIGTERM from the platform reaches `ConsolidationScheduler` for graceful shutdown. |
| Single `/data` mount; `HF_HOME=/data/models` | Platforms that allow only one volume per service can keep both the SQLite DB and the HuggingFace model cache on one disk. |

Local build + run:

```bash
docker build -t awm:dev .
docker run -d --name awm \
  -p 8400:8400 \
  -v awm-data:/data \
  -e AWM_AGENT_ID=my-agent \
  -e AWM_BIND=0.0.0.0 \
  -e AWM_API_KEY=<key> \
  awm:dev
curl http://localhost:8400/health
# {"status":"ok","timestamp":"…","version":"<installed version>","coordination":false,…}
```

PowerShell (Windows) — the same command with backtick line continuations:

```powershell
docker run -d --name awm `
  -p 8400:8400 `
  -v awm-data:/data `
  -e AWM_AGENT_ID=my-agent `
  -e AWM_BIND=0.0.0.0 `
  -e AWM_API_KEY=<key> `
  awm:dev
curl.exe http://localhost:8400/health
```

`AWM_BIND=0.0.0.0` is what makes the published port reachable. The server binds
`127.0.0.1` unless `AWM_BIND` says otherwise, and inside a container that is the
container's own loopback — so without it `-p 8400:8400` forwards to nothing and
`curl` from the host fails even though the container's own health check passes.
Binding beyond loopback with no `AWM_API_KEY` is refused at startup (the process
logs `AWM refusing to start` and exits); `AWM_ALLOW_INSECURE=1` overrides that on
a network you trust.

Required ENV (no defaults you'd want to keep in prod):

| Variable | Recommended |
|---|---|
| `AWM_AGENT_ID` | A stable namespace string per logical agent |
| `AWM_BIND` | `0.0.0.0` in a container (or the interface your clients reach). The default, `127.0.0.1`, is unreachable from outside the container |
| `AWM_API_KEY` | Bearer token for the HTTP API. Required whenever `AWM_BIND` is not loopback — the server refuses to start without it |
| `AWM_HOOK_SECRET` | Bearer token for the hook sidecar |

Optional but useful:

| Variable | Why |
|---|---|
| `AWM_PORT=8400` | Pin the listen port so reverse proxies don't drift |
| `AWM_DB_PATH=/data/memory.db` | Explicit — survives docker rebuilds because the volume mount is `/data` |
| `HF_HOME=/data/models` | Keep model cache on the persistent volume so cold restarts don't re-download |

`HF_HOME` (and the AWM-specific `AWM_CACHE_DIR`, which takes precedence over it) is honored as of 0.13.1. If
you set this on an earlier version, upgrade — it was silently ignored before then and models were re-downloaded
on every cold start regardless.

See [reference.md](reference.md#recall-tuning-env-overrides) for the full env-var
list. The diagnostic `AWM_DISABLE_*` family is `POOL_FILTER`, `SLIM_CACHE`,
`EXPANSION_CACHE`, `ENTITY_BRIDGE` and `SCHEDULER` — five, not the four this line
claimed before 2026-10-09, when `AWM_DISABLE_RERANK_SKIP` left the list because
the branch it disabled was removed. Don't set any of them in production unless
you are A/B testing a suspected regression.

---

## 2. Railway

Railway works well for AWM because internal DNS lets you keep AWM
private — only your backend service needs to talk to it. The deploy is
`railway up` from the AWM-deploy directory.

### Service configuration

| Setting | Value |
|---|---|
| Source | Dockerfile (in the AWM repo) |
| Volume | mount **`/data`** (Railway allows one volume per service) |
| Public networking | **off** (internal-only) |
| Service domain | leave as `awm.railway.internal` |
| Environment variables | per the table above |

### Deploying

```bash
RAILWAY_API_TOKEN=<token> railway up --service awm --ci
```

Backend services talk to AWM via internal DNS:

```python
# in your backend
AWM_URL = os.environ["AWM_URL"]   # http://awm.railway.internal:8400
```

### When "Deploy failed" shows up with no detail

Railway's CLI gives you `Deploy failed` and nothing else. The real error
lives in the buildLogs, reachable via Railway's GraphQL API:

```bash
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query(\$id: String!) { buildLogs(deploymentId: \$id, limit: 200) { timestamp message severity } }\",\"variables\":{\"id\":\"<deployment-id>\"}}"
```

Get the deployment ID from `railway status --json` →
`.environments.edges[0].node.serviceInstances.edges[]
  .node.latestDeployment.id`. If `imageDigest` on that same node is
`None`, the build never produced an image — the failure is a parser-level
rejection (and `buildLogs` will say what).

### Common Railway failure modes (and the underlying cause)

| Symptom | Cause | Fix |
|---|---|---|
| `dockerfile invalid: docker VOLUME at Line N is not supported` | `VOLUME` directive in Dockerfile | Remove it; mount `/data` via the Railway UI volume config. |
| Container starts then `ERR_DLOPEN_FAILED` on `onnxruntime-node/binding.js` | Alpine base (musl libc) | Use `node:22-bookworm-slim` or newer glibc base. |
| Deploy ends in <5 s with `imageDigest: None` | Build never ran | Check `buildLogs` — usually a Dockerfile parser error. |
| Container exits with `MODULE_NOT_FOUND dist/index.js` | TypeScript build skipped | Confirm builder stage runs `npx tsc` and the runtime stage copies `dist/`. |
| Two successive deploys produce identical image digest, second one fails | Build cache deduped | Pass `--build-arg BUILD_TIMESTAMP=$(date +%s)`. |
| Service scales to zero after idle, then can't be reached | Serverless / sleep-when-idle setting | Either turn off sleep, or have a backend service ping `/health` on cold paths to wake it. |

---

## 3. Fly.io / Render

Both work with the same Dockerfile.

**Fly.io** — `fly launch` against the AWM repo, then in `fly.toml`:

```toml
[mounts]
  source = "awm_data"
  destination = "/data"

[[services]]
  protocol = "tcp"
  internal_port = 8400

[[services.tcp_checks]]
  interval = "15s"
  port = 8400

[env]
  AWM_DB_PATH = "/data/memory.db"
  HF_HOME = "/data/models"
```

Set secrets via `fly secrets set AWM_API_KEY=... AWM_HOOK_SECRET=...`.

**Render** — create a *Private Service* (not Web Service) pointing at the
Dockerfile, attach a *Persistent Disk* mounted at `/data`. Render auto-
provisions a `*.onrender.com` internal hostname your backend can reach.

---

## 4. Plain Linux (systemd)

For self-hosted boxes where you don't want Docker.

```ini
# /etc/systemd/system/awm.service
[Unit]
Description=AgentWorkingMemory
After=network.target

[Service]
Type=simple
User=awm
WorkingDirectory=/opt/awm
ExecStart=/usr/bin/node /opt/awm/dist/index.js
Restart=on-failure
RestartSec=5
Environment=AWM_DB_PATH=/var/lib/awm/memory.db
Environment=AWM_PORT=8400
Environment=AWM_API_KEY=...
Environment=HF_HOME=/var/lib/awm/models

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/awm awm
sudo mkdir -p /var/lib/awm/models && sudo chown -R awm:awm /var/lib/awm
# build AWM into /opt/awm/dist (npm ci + npx tsc)
sudo systemctl daemon-reload
sudo systemctl enable --now awm
sudo journalctl -u awm -f
```

If you set `AWM_API_KEY`, every HTTP request except `GET /health` needs
`Authorization: Bearer <key>`. The hook sidecar uses `AWM_HOOK_SECRET`
separately. The server binds `127.0.0.1` unless `AWM_BIND` is set, and a
non-loopback `AWM_BIND` with no `AWM_API_KEY` refuses to start, so an open
network listener takes an explicit `AWM_ALLOW_INSECURE=1`. (Before 2026-07-30
the server listened on all interfaces with no key required.)

---

## 5. Backup, restore, migration

Whole-store backup and restore are file-level procedures, below. To move one
agent's memories between stores, use the `awm export` / `awm import` / `awm merge`
commands (see *Subset migration*).

### Backup

AWM already does this on every server start (see startup log:
`Backup: /data/backups/memory-<ISO>.db`). Those are point-in-time copies
into the same volume, fine for "I want to roll back to last boot" but
insufficient for disaster recovery.

For offsite backups, snapshot the SQLite file with the [Online Backup
API](https://www.sqlite.org/backup.html) — `.backup` is safe to run on a
live database:

```bash
docker exec awm sh -c 'apt-get install -y sqlite3 2>/dev/null; \
  sqlite3 /data/memory.db ".backup /data/snapshot.db"'
docker cp awm:/data/snapshot.db ./memory-$(date +%F).db
```

For automated offsite snapshots, run this in a cron and ship the result
to S3 / R2 / B2 / wherever.

### Restore

Stop AWM, drop the file in place, start AWM:

```bash
docker stop awm
docker cp ./memory-2026-05-28.db awm:/data/memory.db
docker start awm
```

AWM's startup integrity check (`PRAGMA integrity_check`) runs
automatically — if the file is corrupt, AWM will try the most recent
internal backup from `/data/backups/` and exit non-zero so your
orchestrator restarts cleanly.

### Migration (between hosts or volumes)

Same as restore. SQLite is portable across OS and arch: copy the file,
mount it on the new host, restart.

For migrations across major schema changes (rare — most upgrades are
additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`), the
[CHANGELOG](../CHANGELOG.md) calls them out explicitly. Backup first.

### Subset migration (one agent_id from one DB to another)

Useful when you want to seed a fresh production AWM with a curated
subset of an existing dev DB. Export the agent you want, then import it
into the target store (the same commands work in PowerShell, bash and zsh):

```bash
awm export --db dev.db --agent my-real-agent --output my-real-agent.json
awm import my-real-agent.json --db prod.db --dedupe
```

`awm import` also takes `--remap-agent <id>` (load under a different agent id)
and `--dry-run`; `awm export --active-only` leaves archived memories out. To
combine whole stores, use
`awm merge --target <path> --source <path> [--source <path> …] [--dedupe] [--dry-run]`.
Take a backup of the target first.

---

## 6. Scaling considerations

AWM is a single-process system intentionally. It's not designed for
horizontal scaling — the cognitive model (Hebbian edges, slim cache,
consolidation) is built around a single shared store.

Practical scale limits as of 0.8.x:

| Dimension | Comfortable | Investigate at | Hard limit |
|---|---|---|---|
| Engrams per agent_id | up to ~10,000 | 10,000 (default `maxActiveEngrams` cap) | none — but recall latency grows ~linearly past 50k |
| Concurrent recall QPS | up to ~10 | 50 | better-sqlite3 is single-writer; the candidate-pool filter and slim cache keep reads parallel-safe |
| Memory database size | up to ~500 MB | 2 GB | none — but full integrity checks at startup get slow over 10 GB |

If you hit the active-engram cap, eviction kicks in automatically (lowest
utility = low confidence × low access). For finer control, you can also
call `POST /system/evict` manually with `{ "agentId": "..." }` to run
eviction on demand.

For larger memory stores or higher concurrency, the right move today is
**multiple AWM instances with different `AWM_AGENT_ID` values** —
isolated stores, federated by your application layer. The
`/coordination` endpoints (enabled via `AWM_COORDINATION=true`) are for
multi-agent task hand-off within a single store, not for sharding across
stores.


<a id="operating-modes-quality-first-and-latency-first"></a>

### Reranker precision: q8 (default) and fp32

Since 0.19 the cross-encoder runs **int8-quantized (`q8`) by default**.
`AWM_RERANKER_DTYPE=fp32` is the opt-in that restores the full-precision ranker
AWM shipped through 0.18. It is a single knob, deliberately.

| | q8 (default since 0.19) | fp32 (opt-in) |
|---|---|---|
| Setting | *nothing — this is the default* | `AWM_RERANKER_DTYPE=fp32` |
| Cross-encoder weights | int8-quantized | fp32 |
| ONNX file the dtype selects | 23 MB | 91 MB |
| Warm recall p50 (30k-memory store, v0.22.4) | 287–304 ms | slower: in the 2026-10-09 sweep q8 cut recall p50 by 26–33% (fp32 533 / 522 / 292 ms against q8 395 / 358 / 196 ms on the identifier, topic and public suites) |
| Correct abstention | unchanged on all three suites in that sweep | |
| `success@5` | unchanged on both private suites; +0.5pp on the public corpus, inside its 4pp seed-noise floor | |
| `success@1` | −0.2pp on one suite of three; unchanged on another | |
| Published numbers | figures from 0.19 on are measured at q8 | figures published before 0.19 stand at fp32 |

The accuracy rows compare q8 against fp32 on the 2026-10-09 pipeline; the full
tables are in [recall-latency.md](recall-latency.md). The ~175 MB first-run model
download is at the q8 default.

**Choose fp32 only when you need the pre-0.19 ranker exactly** — for instance to
compare against a result published before 0.19, or because you have measured
that q8 costs your corpus a query you care about. Otherwise q8 is the better
trade: the saving is large and the accuracy cost is a query or two in hundreds.

**`q8` does change ranking outcomes. It is not a transparent speedup.** On the
private snapshot the measured cost is one query in 450 on the topic suite; on the
identifier suite two golds move and cancel, so "no change" there is an aggregate
statement and not a per-query one. One property changes at q8: a pair's score
depends very slightly on the other pairs in its batch (measured max 0.00105 over
80 pairs, top-1 unchanged). For a given query and store the results are still
reproducible. **To validate on your own data** — the available path depends on
what you installed, because the harness is not in the published package:

- **Latency, on your own store, from any install.** Set `AWM_PROFILE_RECALL=1` for
  one stderr line per recall with the per-stage breakdown
  (`src/core/recall-telemetry.ts`, which does ship). Compare a run started at
  fp32 against one started at q8. This needs no fixture and is the check most
  people actually want.
- **Accuracy needs ground truth, so it needs a repo checkout.** Neither
  `scripts/` nor `tests/` is in the npm tarball. From a clone, the reproducible
  A/B is `npm run bench:public:build` followed by
  `npm run profile:recall -- --public --dtype fp32` against
  `npm run profile:recall -- --public --dtype q8`. Note that corpus has a measured
  **4pp seed-noise floor** on accuracy, so read it for the latency result and the
  shape, not for a precise accuracy delta.
- **Accuracy on *your* data is real work, not a one-liner.** Copy your database
  into `tests/realstore-eval/snapshot/`, derive unique-identifier hold-out ground
  truth with
  `REALSTORE_SNAPSHOT=<file> REALSTORE_AGENTS=<your agent id> node tests/realstore-eval/build-fixture.mjs`,
  then point `profile:recall` at it with `--snapshot` and `--fixture`. That is the
  same derivation AWM's own published fixtures use.


**Switching to fp32 needs a process restart, and here is how to confirm it
took.** `AWM_RERANKER_DTYPE` is read once when the reranker module is imported
(`src/core/reranker.ts`) and the loaded model is then cached for the life of the
process, so setting the variable against a *running* AWM does nothing at all. For
an MCP install this means restarting the Claude Code session or reconnecting with
`/mcp` — a connection that is already running keeps both the code and the model
it loaded at spawn time. Set the variable where the process is launched. For an MCP install that is the
`env` block of the AWM entry in your MCP config, which is also the one place it
survives re-running setup: `awm setup` layers your existing env *over* its
recommended defaults and force-sets only the keys it owns (`OWNED_ENV_KEYS` in
`src/adapters/common.ts` — db path, agent id, hook port, hook port range, hook secret,
client), so
a hand-set `AWM_RERANKER_DTYPE` is preserved. There is a test for precisely that
("re-run keeps the user's agent id, db path, port and every foreign env value",
`tests/adapters/claude-code-setup.test.ts`).

Then check the load lines, which name the precision in use. There is one per
reranker model as it loads — the MiniLM cross-encoder for keyword queries, and the
Ettin-17m reranker for natural-language questions (since 0.22):

```
Re-ranker model loaded in-process: Xenova/ms-marco-MiniLM-L-6-v2 (fp32)
```

In-process they go to stderr. With the shared model daemon on (`AWM_MODEL_DAEMON=1`)
the models load in the daemon, so the lines are in the daemon's log under
`~/.awm/run/` instead. If the MiniLM line still says `(q8)`, `AWM_RERANKER_DTYPE=fp32`
did not reach the process. `AWM_RERANKER_DTYPE` is also part of the configuration fingerprint
that `npm run profile:recall` prints as its `arm=` label, so a profiling run
reports which mode it measured rather than leaving two different arms to print the
same thing.

**One caveat on the latency figure.** The 26–33% difference above follows from the
cross-encoder being ~83% of warm recall on an 11,262-engram store. On a much
smaller store the other phases are a larger share of a smaller total, so the
proportional difference will be lower. Measure on your own corpus rather than
adopting the number.

**Why precision is one knob rather than a bundle.** The other latency levers were
measured and rejected, so do not stack them on top of `q8` expecting more:
cutting the rerank pool (`AWM_RERANK_POOL=16`) buys a similar saving for
**−4.0pp** `success@1` and **−3.4pp** `success@5` (measured 2026-10-08 on the pre-Rocchio-flip
pipeline and not re-run since, so treat the magnitude as indicative), and `q4` is dominated outright
— equal accuracy to fp32, only −3% latency, and a 6,080 ms cold start against
fp32's 1,591 ms. Full tables in [recall-latency.md](recall-latency.md).

*History:* through 0.18, fp32 was the default and q8 the opt-in "latency-first"
mode, on the reasoning that every published accuracy figure was measured at fp32
on a private corpus. 0.19 (2026-10-19) made q8 the default after the speed review;
an interleaved in-process comparison cut the cross-encoder's p50 by 35–45%, and
figures published since are measured at q8 (see [claims.md](claims.md)).

---

## 7. Observability checklist

For production, you want at minimum:

| Signal | Where |
|---|---|
| Process up | HTTP `GET /health` returns 200 with `version` + `coordination` flag |
| Recall latency | `GET /agent/:id/metrics` → `avgLatencyMs`, `p95LatencyMs` (24h rolling window) |
| Storage growth | `GET /agent/:id/stats` → engram counts by stage; alarm on `staging` running unbounded |
| Build provenance | startup log line `AWM build <ref> @ <timestamp>` (set via `--build-arg`) |
| Activity stream | tail `awm.log`, written next to the database (`/data/awm.log` with `AWM_DB_PATH=/data/memory.db`; `~/.awm/awm.log` for a local `awm setup` install) — writes, recalls, hook events |
| Daily counts | `GET /stats` on the hook sidecar, with `Authorization: Bearer <AWM_HOOK_SECRET>` (it is behind the sidecar's auth gate; only `/health` is open). The sidecar binds the first free port in `AWM_HOOK_PORT`..+`AWM_HOOK_PORT_RANGE` (default 8401–8410), so with several agents running check `/health` for the port each one actually took, or run `awm doctor` |

If you've got a Prometheus stack, scrape the coordination telemetry
counters at `GET /telemetry/channels` (these are enabled when
`AWM_COORDINATION=true`).

---

## Summary

Most AWM deploys are: build the Dockerfile, mount `/data`, set
`AWM_AGENT_ID` + `AWM_API_KEY`, point your backend at it. The non-obvious
gotchas — `VOLUME` rejection on Railway, glibc requirement, Node EOL —
are captured in the recipe above so you don't have to rediscover them.

If you hit a deploy failure not listed here, the diagnostic path is:

1. `railway status --json` (or equivalent) → grab the latest deployment ID
2. Check `imageDigest` — if `None`, the build never ran; if set, the runtime crashed
3. Pull buildLogs (or `railway logs --build`) for the parser error
4. Pull runtime logs (or `railway logs --service awm`) for the crash trace

Once you have the actual error, [troubleshooting.md](troubleshooting.md)
has remedies for the common runtime cases.
