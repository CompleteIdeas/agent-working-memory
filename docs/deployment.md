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

Plus a section on **backup, restore, and migration** because the
[known-limitations](known-limitations.md) note about "no built-in export/import"
applies to library tooling, not to the file-level procedures that actually work.

---

## 1. The Docker recipe (foundation)

The canonical Dockerfile lives at the top of the AWM repo. It's
multi-stage (build with full toolchain, ship with prod deps only) and
sized at ~200 MB.

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
  awm:dev
curl http://localhost:8400/health
# {"status":"ok","version":"0.8.x","coordination":false}
```

Required ENV (no defaults you'd want to keep in prod):

| Variable | Recommended |
|---|---|
| `AWM_AGENT_ID` | A stable namespace string per logical agent |
| `AWM_API_KEY` | Bearer token for the HTTP API (set this!) |
| `AWM_HOOK_SECRET` | Bearer token for the hook sidecar |

Optional but useful:

| Variable | Why |
|---|---|
| `AWM_PORT=8400` | Pin the listen port so reverse proxies don't drift |
| `AWM_DB_PATH=/data/memory.db` | Explicit — survives docker rebuilds because the volume mount is `/data` |
| `HF_HOME=/data/models` | Keep model cache on the persistent volume so cold restarts don't re-download |

See [reference.md](reference.md#environment-variables) for the full env-var
list including the four diagnostic `AWM_DISABLE_*` flags (don't set these
in prod unless A/B testing a regression).

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

If you set `AWM_API_KEY`, every HTTP request needs
`Authorization: Bearer <key>`. The hook sidecar uses `AWM_HOOK_SECRET`
separately. Without these, anything on the same network can write to your
memory store.

---

## 5. Backup, restore, migration

The library has no built-in export tool, but the file-level procedures
below work and are what you'd reach for in production.

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
subset of an existing dev DB:

```python
import sqlite3, shutil
shutil.copy("dev-memory.db", "subset.db")
con = sqlite3.connect("subset.db")
con.execute("DELETE FROM engrams WHERE agent_id NOT IN ('my-real-agent','awm-meta')")
# Also clean orphaned rows in tables that have agent_id columns:
for t in ["activation_events", "conscious_state", "episodes", "staging_events"]:
    con.execute(f"DELETE FROM {t} WHERE agent_id NOT IN ('my-real-agent','awm-meta')")
con.commit()
con.execute("VACUUM")
con.close()
# subset.db is now ready to ship to prod.
```

The FTS5 indices, embeddings, and association tables are referenced by
engram ID and are cleaned automatically by the `DELETE … WHERE agent_id`
plus `VACUUM`.

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

---

## 7. Observability checklist

For production, you want at minimum:

| Signal | Where |
|---|---|
| Process up | HTTP `GET /health` returns 200 with `version` + `coordination` flag |
| Recall latency | `GET /agent/:id/metrics` → `avgLatencyMs`, `p95LatencyMs` (24h rolling window) |
| Storage growth | `GET /agent/:id/stats` → engram counts by stage; alarm on `staging` running unbounded |
| Build provenance | startup log line `AWM build <ref> @ <timestamp>` (set via `--build-arg`) |
| Activity stream | tail `data/awm.log` (writes, recalls, hook events) |
| Daily counts | `GET /stats` on the hook sidecar (port `AWM_HOOK_PORT`, default 8401) |

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
