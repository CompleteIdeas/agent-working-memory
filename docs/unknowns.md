# Open Questions

Reviewed against v0.22.4 (2026-11-15).

## Architecture

### Multi-agent shared memory
Memories are scoped by `agentId`. A shared view exists: recall with `workspace` (or `AWM_WORKSPACE`) searches every agent in that workspace (hive mode). Still open:
- How should conflicts between one agent's memory and another's be resolved when both surface in a workspace recall?

### Re-embedding on model change
The embedding model is configurable via `AWM_EMBED_MODEL`, but switching models invalidates existing vectors. Questions:
- Should re-embedding be automatic on model change?
- Should old embeddings be kept alongside new ones during migration?

## Tuning

### Salience thresholds for non-coding use cases
The salience filter is tuned for coding assistant memories (decisions, bugs, architecture). Conversational agents may need different thresholds.
- Event types and weights are currently fixed in `src/core/salience.ts`
- Future: per-agent configurable salience profiles

### Reranker blend ratio
The adaptive blend (30-70% reranker weight, based on BM25 signal strength) was tuned on workday/self-test evals. It now feeds only the pre-rerank score; the final order comes from the 0.21.1 blend (weight routed by query shape) plus the 0.22.4 first-place rule (`src/core/blend-rule.ts`). Whether those settings carry over to other domains is still open.

### Abstention threshold
`require_confidence` defaults to 0.05, a light gate; the store-calibrated gate (`AWM_ABSTAIN_GATE=calibrated`) is opt-in. Whether the calibrated gate should become the default, and how it should treat natural-language questions, is still open (see `docs/claims.md` §2).

## Deployment

### Rate limiting
No rate limiting on endpoints. Fine for single-user MCP, but shared deployments need per-agent limits.

### Backup/recovery
`awm export` and `awm import` exist (embeddings optional; re-embed after import when models differ), and the SQLite file can be copied. Scheduled or automatic backup is not built in.
