# Open Questions

## Architecture

### Multi-agent shared memory
Memories are isolated by `agentId`. No shared knowledge base exists across agents. Questions:
- Should there be a shared pool accessible by all agents in a project?
- How would conflicts between agent-specific and shared memories be resolved?

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
The adaptive blend (30-70% based on BM25 signal strength) was tuned on workday/self-test evals. May need adjustment for other domains.

### Abstention threshold
Currently defaults to 0 (no abstention). The right threshold depends on use case — coding assistants benefit from lower thresholds than conversational agents.

## Deployment

### Rate limiting
No rate limiting on endpoints. Fine for single-user MCP, but shared deployments need per-agent limits.

### Backup/recovery
No built-in export/import. SQLite file can be copied manually. A proper backup mechanism would be useful for production.
