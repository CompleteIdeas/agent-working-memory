# Troubleshooting

## Server won't start

### "EADDRINUSE: address already in use"
Another process is using port 8400. Either stop it or use a different port:
```bash
AWM_PORT=8401 npx tsx src/index.ts
```

### "Cannot find module" errors
Run `npm install` to ensure all dependencies are installed.

### Models fail to download
The three ML models (~124MB total) download from Hugging Face on first run. If behind a proxy or firewall:
1. Check internet connectivity
2. Models cache in `~/.cache/huggingface/` — if corrupt, delete and restart
3. The server starts even if models fail (embedding, reranker, expansion degrade gracefully)

## Activation returns unexpected results

### All scores are the same (e.g., 0.800)
The cross-encoder reranker may be dominating scores. The blend is 40% composite + 60% reranker. If the reranker gives similar scores to all passages, results cluster. Check `phaseScores.composite` for the pre-reranker scores.

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
- Normal on AWM 0.7.14+: floor ~300ms, typical 400-700ms on 10K-engram corpora
- First recall after process start is slower (~2-3s) — that's the cold cost of loading 3 ML models (embedder, reranker, expander) and populating the slim cache. AWM warms the cache eagerly at startup; the first user-visible recall is fast in production.
- Disable model phases for speed: `"useReranker": false, "useExpansion": false` (~5-20ms recall, but degraded ranking)
- **If recall feels >1s warm on 0.7.14+**: one of the optimization paths may be silently disabled. Check the AWM coordinator process env for any of `AWM_DISABLE_POOL_FILTER`, `AWM_DISABLE_SLIM_CACHE`, `AWM_DISABLE_RERANK_SKIP`, `AWM_DISABLE_EXPANSION_CACHE` — none should be set to `1` in production.

### Recall returning slightly different top-K than expected
AWM 0.7.7+ uses a candidate pool filter, and 0.7.14+ truncates passages to 400 chars before reranking. Recall quality A/B verified 8/8 top-1 matches and 90-95% top-5 overlap on diverse queries — but you may see reorderings near the bottom of top-K. If you suspect a regression for a specific query class, A/B by setting one or more of the disable flags above and compare. File an issue with the query and the diff if you find a real recall miss.

### "Avg latency" stat looks high in `memory_stats`
The 24h `avg_latency_ms` reported by `memory_stats` is a simple mean across the full 24h activation_events window. If your AWM coordinator was running an older version yesterday and you upgraded today, the average is dragged up by the slower historical recalls. Wait 24h for the rolling window to flush, or query the recent subset directly:

```sql
SELECT AVG(latency_ms), COUNT(*) FROM activation_events
WHERE timestamp > datetime('now', '-1 hour');
```

## MCP issues

### Tools not appearing in Claude Code
1. Verify `.mcp.json` exists in the project root (not in `src/` or `docs/`)
2. Check the file is valid JSON: `cat .mcp.json | python -m json.tool`
3. The `command` must be `npx` and `args` must include `tsx` and the full path to `src/mcp.ts`
4. Restart Claude Code (MCP servers load on startup)
5. Run `npm run test:mcp` to verify the protocol works independently

### MCP server crashes on startup
- Check Node.js version: `node --version` (must be >= 20)
- Check `npx tsx` works: `npx tsx --version`
- Run manually to see errors: `npx tsx src/mcp.ts` (should print to stderr and wait)

### MCP works but memories aren't persisting
- Check `AWM_DB_PATH` in `.mcp.json` — it should point to an absolute path
- The default `memory.db` is created in the working directory, which may differ from what you expect
- Run `GET /health` on the HTTP server (port 8400) to verify the same DB is being used

## Database issues

### Database file is locked
Another process is using `memory.db`. SQLite supports only one writer at a time. Don't run both the HTTP server and MCP server pointing to the same DB file simultaneously (the MCP server has its own in-process store).

### Database appears corrupted
AWM uses WAL (Write-Ahead Logging) mode. If the process crashed:
1. Check for `memory.db-wal` and `memory.db-shm` files — these are normal WAL artifacts
2. SQLite should recover automatically on next open
3. As a last resort, copy the DB file and try opening the copy

### Database is too large
Run eviction to clean up: `POST /system/evict` with `{ "agentId": "your-agent" }`
Run edge decay to prune stale associations: `POST /system/decay`

## Test failures

### Unit tests timing out
Tests that call `activate()` load ML models on first run. The integration tests pass `useReranker: false, useExpansion: false` to avoid this. If you see 5000ms timeouts, ensure the test is disabling ML features.

### Self-test / workday / LOCOMO failing
These require a live server. Start it first: `npx tsx src/index.ts`

### LOCOMO dataset download fails
On Windows, SSL revocation checks can fail. The runner uses `--ssl-no-revoke` automatically. If the download still fails, manually download:
```bash
curl -L "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" \
  -o tests/locomo-eval/data/locomo10.json
```
