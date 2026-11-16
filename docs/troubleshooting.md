# Troubleshooting

## Server won't start

### "EADDRINUSE: address already in use"
Another process is using port 8400. Either stop it or use a different port — but **not
8401**: that is the hook sidecar's default, and the sidecar walks upward from it through
`AWM_HOOK_PORT_RANGE` (default 8401–8410), so putting the API there creates a fresh clash.
Pick something outside that window:
```bash
awm serve --port 8500          # macOS / Linux / PowerShell alike
AWM_PORT=8500 awm serve        # macOS / Linux, via the environment
```
```powershell
$env:AWM_PORT = '8500'; awm serve   # PowerShell, via the environment
```
`awm serve` opens `./memory.db` in the current directory unless `AWM_DB_PATH` is set — point it at
`~/.awm/memory.db` if you want the store `awm setup` uses. In a source checkout, `npx tsx src/index.ts` is
the equivalent.

### "Cannot find module" errors
Run `npm install` to ensure all dependencies are installed.

### Models fail to download
The ML models (**~175 MB** total: 134 MB embedder + 23 MB MiniLM reranker + 17 MB Ettin reranker, both int8; the 377 MB expander only when expansion is on) download from Hugging Face on first run. If behind a proxy or firewall:
1. Check internet connectivity
2. Models cache in the first of `AWM_CACHE_DIR`, `HF_HOME`, or `<package root>/data/models` (the `data/models` folder inside the installed `agent-working-memory` package — `src/core/model-cache.ts`) — if corrupt, delete that folder and restart
3. The server starts even if models fail (embedding, reranker, expansion degrade gracefully)

## Activation returns unexpected results

### All scores are the same (e.g., 0.800)
The cross-encoder reranker may be dominating scores. Three stages combine it with the first-stage score: (1) an adaptive blend whose reranker weight runs from 0.3 to 0.7 — lower when keyword (BM25) match is strong, higher when it is weak; (2) since 0.21.1, a second ordering of the pool that blends the cross-encoder with the BM25+vector fused rank, weighted by query shape (0.95 for keyword lookups; 0.5–0.85 for natural-language questions, and the natural-language reranker's rank at 0.7 since 0.22); (3) since 0.22.4, first place is picked by a rule — the cross-encoder's #1 when it is sure (clear top-two margin), otherwise the blend's #1 (`src/core/blend-rule.ts`; `AWM_BLEND_SURE=off` restores 0.22.3). If the reranker gives similar scores to all passages, results cluster. Check `phaseScores.composite` for the pre-reranker scores and `phaseScores.rerankerScore` for the cross-encoder's.

### Wrong memories ranking highly
Check the `phaseScores` breakdown:
- **High `hebbianBoost`** — reduce by running edge decay: `POST /system/decay`
- **High `graphBoost`** — memories connected to popular nodes get boosted. Cap is 0.2 per engram.
- **High `textMatch` but irrelevant** — common words matching. Try more specific queries.

### Relevant memories not appearing
- Check if they're in staging: `POST /memory/search` with `"stage": "staging"`
- Try `"includeStaging": true` in the activate request
- Verify the memory exists: `GET /memory/:id`
- Check if retracted: the engram's `retracted` field

### Very slow activation queries
- Normal on v0.22.4: warm recall p50 287–304 ms on a 30k-memory store, p90 under 0.4 s
- First recall after process start is slower (~2-3s) — that's the cold cost of loading the ML models (embedder and rerankers) and populating the slim cache. AWM warms the cache eagerly at startup; the first user-visible recall is fast in production.
- Disable model phases for speed: `"useReranker": false` (~5-20ms recall, but degraded ranking). Query expansion is already off by default since 0.22.1.
- **The fast reranker is already the default.** The cross-encoder has run int8-quantized (`q8`) since 0.19, which cut recall p50 26–33% against fp32. If `AWM_RERANKER_DTYPE=fp32` is set in the server's environment, that is the slower opt-in — see [deployment.md → Reranker precision](deployment.md#reranker-precision-q8-default-and-fp32).
- **If recall feels >1s warm on 0.7.14+**: one of the optimization paths may be silently disabled. Check the AWM coordinator process env for any of `AWM_DISABLE_POOL_FILTER`, `AWM_DISABLE_SLIM_CACHE`, `AWM_DISABLE_EXPANSION_CACHE` — none should be set to `1` in production. (`AWM_DISABLE_RERANK_SKIP` was also on this list until 2026-10-09; the branch it disabled has been removed, so the variable is now accepted and ignored.)

### Recall returning slightly different top-K than expected
AWM 0.7.7+ uses a candidate pool filter, and 0.7.14+ truncates passages to 400 chars before reranking. Recall quality A/B verified 8/8 top-1 matches and 90-95% top-5 overlap on diverse queries — but you may see reorderings near the bottom of top-K. If you suspect a regression for a specific query class, A/B by setting one or more of the disable flags above and compare. File an issue with the query and the diff if you find a real recall miss.

### Recall latency looks high in `memory_stats`
`memory_stats` reports `Recall latency (24h): p50 … p90 …` — medians, not a mean (the mean was dropped because cold model loads and stalls dragged it far above typical). Both still cover the full 24h `activation_events` window, so if your AWM process was running an older version yesterday and you upgraded today, the slower historical recalls still count. Wait 24h for the rolling window to flush, or query the recent subset directly:

```sql
SELECT AVG(latency_ms), COUNT(*) FROM activation_events
WHERE timestamp > datetime('now', '-1 hour');
```

## MCP issues

### Tools not appearing in Claude Code
1. Verify the MCP config exists where `awm setup` writes it: `~/.mcp.json` for a global install (`awm setup --global`), or `.claude/mcp.json` in the project for a per-project install
2. Check the file is valid JSON: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <path-to-file>` (works in any shell; prints nothing when valid)
3. For an installed package the `command` is `node` and `args` is the full path to `dist/mcp.js` (run `awm setup claude-code --global` to write it correctly). `npx tsx src/mcp.ts` applies only in a source checkout.
4. Restart Claude Code (MCP servers load on startup)
5. Run `npm run test:mcp` to verify the protocol works independently

### MCP server crashes on startup
- Check Node.js version: `node --version` (must be >= 22)
- Check `npx tsx` works: `npx tsx --version`
- Run manually to see errors: `node <path>/dist/mcp.js` (should print to stderr and wait). In a source checkout: `npx tsx src/mcp.ts`

### MCP works but memories aren't persisting
- Check `AWM_DB_PATH` in the MCP config (`~/.mcp.json` or `.claude/mcp.json`) — it should point to an absolute path (`awm setup` writes `~/.awm/memory.db`)
- Without `AWM_DB_PATH`, `memory.db` is created in the working directory, which may differ from what you expect
- Call the `memory_whoami` tool: it prints the store path, agent id and backend the running MCP server actually uses (an MCP-only install has no HTTP server to query)

## Database issues

### Database file is locked
With the default SQLite backend, several processes can share one `memory.db` — WAL mode makes it multi-process safe, which is how several Claude Code sessions (and an HTTP server alongside them) use the same store. SQLite still allows one writer at a time, so a lock error under heavy concurrent writes is transient; it is persistent only if a process is holding a long transaction or the file sits on a network drive (WAL needs a local filesystem). The PGlite backend is different: it is **single-process only** — a second process opening the same `memory-pglite/` directory aborts — so with PGlite, run exactly one AWM process per store.

### Database appears corrupted
AWM uses WAL (Write-Ahead Logging) mode. If the process crashed:
1. Check for `memory.db-wal` and `memory.db-shm` files — these are normal WAL artifacts
2. SQLite should recover automatically on next open
3. As a last resort, copy the DB file and try opening the copy

### Database is too large
Run eviction to clean up: `POST /system/evict` with `{ "agentId": "your-agent" }`
Run edge decay to prune stale associations: `POST /system/decay`

## Deployment issues

For production deploys (Docker, Railway, Fly, Render, systemd), the
canonical recipes and recovery procedures are in
[`deployment.md`](deployment.md). The most common failures and where
they're addressed:

| Symptom | Likely cause | See |
|---|---|---|
| Railway "Deploy failed" with no detail | `VOLUME` directive in Dockerfile | [deployment.md → Railway](deployment.md#2-railway) |
| `ERR_DLOPEN_FAILED` on `onnxruntime-node/binding.js` | Alpine base (musl libc); needs glibc | [deployment.md § 1](deployment.md#1-the-docker-recipe-foundation) |
| Container exits with `MODULE_NOT_FOUND dist/index.js` | TypeScript build skipped or `dist/` not copied | confirm builder stage runs `npx tsc` |
| Two deploys produce identical image digest, platform reports "nothing new" | Build cache deduped | pass `--build-arg BUILD_TIMESTAMP=$(date +%s)` |
| `Deployment is not restartable` (Railway CLI) | Latest deploy in FAILED state | `railway redeploy --service <name>` or push a new build |
| AWM container starts (health check passes) but isn't reachable from the host or sibling services | Server bound to loopback — it binds `127.0.0.1` unless `AWM_BIND` is set | set `AWM_BIND=0.0.0.0` **and** `AWM_API_KEY` (a non-loopback bind without a key refuses to start) — [deployment.md § 1](deployment.md#1-the-docker-recipe-foundation) |
| AWM container starts but isn't reachable from sibling services | Internal-DNS hostname mismatch | check `RAILWAY_PRIVATE_DOMAIN` env var matches the URL your backend uses |
| Backup/restore between hosts | SQLite Online Backup API | [deployment.md → Backup, restore, migration](deployment.md#5-backup-restore-migration) |

If Railway specifically tells you nothing useful, the buildLogs are
behind the GraphQL API — pull them via
`POST https://backboard.railway.com/graphql/v2` with
`{ query: "{ buildLogs(deploymentId: <id>, limit: 200) { ... } }" }`. The
deployment ID comes from `railway status --json`.

## Test failures

### Unit tests timing out
Tests that call `activate()` load ML models on first run. The integration tests pass `useReranker: false, useExpansion: false` to avoid this. If you see 5000ms timeouts, ensure the test is disabling ML features.

### Self-test / workday / LOCOMO failing
These require a live server. Start it first: `npx tsx src/index.ts` (source checkout) or `awm serve`

### LOCOMO dataset download fails
On Windows, SSL revocation checks can fail. The runner uses `--ssl-no-revoke` automatically. If the download still fails, manually download:
```bash
curl -L "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" \
  -o tests/locomo-eval/data/locomo10.json
```
