# Known Limitations

What AWM does not do well, stated plainly. Each item says how it was established and,
where one exists, the workaround. Last verified against the live store and current source
on 2026-09-11 (v0.14.5).

> This page was substantially out of date before that revision — it still cited a retired
> benchmark, a "~300 memories" test ceiling, and features that had since shipped. Items
> that are no longer true are listed at the bottom so they are not re-reported.

## Retrieval

### The link graph rarely changes a result
AWM maintains a graph of associations between memories (co-recall edges, similarity
bridges, causal links). Measured on the frozen eval snapshot, 120 queries with the graph
enabled and disabled: the graph contributes a score to **85%** of top-3 results and changes
the top-3 set in **0%** of them. The cross-encoder reranker makes the final ordering, and a
graph boost capped at 0.25 never overturns it. The graph is retained for the state it
accumulates — supersede chains, causal links, co-recall history — not for today's ranking.
- **Evidence:** `tests/realstore-eval/graph-contribution-probe.ts`, 2026-09-11.
- **Also:** 77% of edges are near-zero-weight "bridge" edges anchored on auto-generated
  synthesis nodes that have essentially never been recalled. A cleanup is planned; it
  changes no recall output.

### Multi-hop reasoning is the agent's job, not the store's
Questions that need two memories chained together ("who owns the table that the failing
report reads?") are answered by the *agent* making two recalls, not by AWM traversing.
The end-to-end gauntlet's `multihop` probe has passed inconsistently at every k tested,
and the passes that do occur are single-recall ranking wins rather than chaining.
- **Evidence:** `docs/benchmarks.md` → Memory Gauntlet. The recommended pattern is in
  the agent guidance: one hop per call.

### A memory that never names its subject cannot be found by it
Retrieval works on the text that was written. On the live store, 66% of the topical terms
a memory is *tagged* with never appear in its body. Tags are now fed to the reranker to
close part of that gap, but a write that omits the identifier it will later be asked about
is unreachable by that identifier.
- **Evidence:** `docs/archive/retrievability-final-2026-08-24.md`.
- **Workaround:** the writing guidance — lead with the fact, name the file/table/ticket in
  the body, not only in tags.

### The remaining misses on the real-store benchmark are genuine
At 92.7% first-result accuracy on the identifier fixture, the 10 remaining misses (of 300)
are real ranking failures, not fixture noise: 5 never enter the candidate pool, 2 reach it
with the identifier outside the 400-character window the reranker reads. Maximum headroom
from here is about 7 points.
- **Evidence:** `tests/realstore-eval/miss-stage-probe.ts`, 2026-09-11.

## Learning

### The feedback loop has almost no signal yet
`memory_feedback` is the mechanism by which recall results teach the system. In practice
agents call it about once per 170 recalls, and until v0.14.3 every feedback row was
unlinked from the recall it judged (872 of 872). The join is fixed; the volume is not.
Hebbian edge strengthening is validation-gated — it waits for feedback — so it has been
mostly idle.
- **Evidence:** live-store audit, 2026-09-11. A harness-side transfer detector that would
  supply feedback automatically is designed but not yet deployed.

### Consolidation summaries are concatenations
The maintenance pass clusters similar memories and can create summary nodes, but the
summary is assembled from key terms, not written by a language model. Those nodes are
low-value and a cleanup is planned.
- **Code:** `src/engine/consolidation.ts`, Phase 2.5.

### The salience filter is tuned for engineering work
Event-type weights favour decisions, root causes, and resolved friction. Conversational or
personal-life content scores low and tends to land in staging or low-salience. This is by
design for the coding-assistant use case; it is a poor fit for a general chat memory.
- **Code:** `src/core/salience.ts`.

## Operation

### Invocation depends on the harness, not on AWM
AWM cannot recall on the agent's behalf; something has to call it. In Claude Code that is
either the model choosing to, or a hook that primes each prompt. Measured on real sessions
before the prime hook was enabled, the model recalled *before* searching the filesystem in
only 2–15% of turns unless the user mentioned memory explicitly. The hook exists and is
now on; its effect is being measured.
- **Evidence:** `C:\Users\robert\project\testing\awm-influence\FINDINGS.md`, section 11.

### A running MCP connection never reloads code
The AWM process a Claude Code session spawns keeps whatever code it loaded at start.
Upgrading the package on disk changes nothing in a live session; only a new session (or a
process restart) picks up the new version. `memory_whoami` reports the *running* version.

### Cold start is a few seconds
The first recall in a fresh process pays for loading the embedding and reranker models
(~1.2 s) and warming an in-memory index over the store (~0.5 s at 30k memories). After
that, warm recall is ~0.5 s median. Concurrent sessions each pay their own cold start.
- **Evidence:** `AWM-ColdLoad-Measurements-2026-08-21.md`; benchmark p50 528–543 ms.

### One writer at a time on SQLite, but that is handled
SQLite allows one writer; AWM uses WAL mode so multiple Claude Code sessions can read and
write the same store concurrently and safely. Running the *standalone HTTP server* and an
MCP session against the same file is supported for the same reason. The PGlite backend, by
contrast, is single-process — two processes on one PGlite directory will abort the second.

### Agent isolation is by convention on the HTTP API
Memories are scoped by `agentId`, and MCP sessions cannot cross that boundary except via
an explicit `workspace` recall. The local HTTP API enforces the same scoping but has no
per-caller authentication when bound to loopback; binding beyond loopback requires
`AWM_API_KEY` and the server refuses to start without it. The hook sidecar uses a bearer
token.
- **Code:** `src/index.ts` (bind guard), `src/hooks/sidecar.ts`.

## Data

### Embedding model is fixed per store
Memories are embedded with bge-small-en-v1.5 (384 dimensions). Changing models means
re-embedding everything; `tests/realstore-eval/reembed-model.ts` does it, but it is a
migration, not a toggle. A larger model (bge-base, 768d) was measured and rejected —
+0.7 points alone, −1.1 combined.

### Schema migrations are additive, not versioned
Upgrades apply `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` at startup. Every release to
date has opened older databases cleanly. There is no down-migration.

## Measurement

### The benchmark has been wrong three times this month
Each time the *instrument* misdescribed the shipped system, and each time the true number
was better than published: the runner defaulted to k=7 while the product shipped k=3; the
decay clock ran on the wall clock so a frozen snapshot aged daily; the runner queried every
gold as the `work` agent while up to a third belonged to `personal`. All three are fixed
and documented in place in `docs/benchmarks.md`. The lesson is recorded as a rule: a
benchmark figure is not believed until it has been checked against its fixture's own
metadata.

### Some eval metrics are placeholders
`staleUsageCount` in `EvalEngine` always returns 0. `discardRegret` is now computed
(low-salience memories that were later accessed) but on a definition that undercounts.

---

## No longer true — removed from this page 2026-09-11

These appeared in earlier versions and were still being quoted. Each is now false:

| former claim | reality |
|---|---|
| "No cross-agent memory" | `workspace` recall exists (`AWM_WORKSPACE`; `getWorkspaceAgentIds`). |
| "Tested with up to ~300 memories" | Live store 31,470 engrams; eval snapshot 29,809; benchmarks run against the latter. |
| "First query 3–10 s, then 200–300 ms" | Cold ~3.3 s spawn-to-first-recall; warm p50 ~530 ms (rerank flags on). |
| "Multi-hop 15.4% on LOCOMO" | LoCoMo retired in 0.13.x; see gauntlet `multihop` above. |
| "No export/import API" | `awm export` / `awm import` CLI, with `--dedupe`. |
| "No authentication" | Sidecar bearer auth; HTTP API refuses non-loopback bind without `AWM_API_KEY`. |
| "Running HTTP and MCP on one DB causes locking" | WAL mode; concurrent sessions are the normal deployment. |
| "`discardRegret` always 0" | Computed since D12 (2026-07-30). |
