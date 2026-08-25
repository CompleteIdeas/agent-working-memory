# AWM Standalone — Full-Stack Deep-Dive Evaluation

**Date:** 2026-07-29 · **Version evaluated:** 0.11.0 · **Method:** first-class-delivery (Ground → Orient → Build → Verify → Challenge → Close)
**Evidence base:** 4 independent workstreams — (A) code-level architecture map, (B) full changelog/benchmark history ledger, (C) academic literature 2024–2026 (35 primary sources), (D) frontier-lab & vendor practice — plus AWM's own memory of prior evals and 6 live operator-experience findings recorded during this evaluation. All workstream reports stored in AWM (`topic=awm-eval-evidence`, `literature-review-memory-systems`, `competitive-landscape-agent-memory`).

---

## Executive summary

AWM's core bets are aging well: 2026 papers (SYNAPSE, HeLa-Mem) provide the **first external benchmark validation of AWM's exact mechanism stack** (Hebbian edges + spreading activation + ACT-R decay + hybrid lexical/vector scoring), the industry converged on sleep-style background consolidation (Letta sleep-time compute, OpenAI Dreaming), and MemoryAgentBench's finding that **plain BM25 beats every commercial memory vendor on retrieval** validates AWM's refusal to drop lexical search. Content fade with cue preservation remains genuinely unique.

But the evaluation found a significant gap between the system as *described* and the system as *shipped and operated*: the headline associative features are default-OFF, the ML models run on the main event loop (the worker-thread fix was reverted and is now dead code), live writes stalled for 120+ seconds twice on the day of this eval, recall averages 805ms on a 9.7K-engram store against a ~300ms claim, the salience filter silently discarded a well-formed finding, the staging tier appears inert in practice, and the HTTP surface is unauthenticated by default. **The highest-leverage work is not a new capability — it is closing the claim/reality gap, then adding the three capabilities the literature prices highest: write-trust, procedural distillation, and generative consolidation.**

---

## 1. Claimed vs observed (the integrity ledger)

| Claim (docs/changelog) | Observed reality | Evidence |
|---|---|---|
| "10-phase activation pipeline" incl. beam-search graph walk | Graph walk (`AWM_SPREAD`), query-bridge, entity-fetch are **default-OFF**; decay/Hebbian are sub-scores inside phase 3b | activation.ts:722, :672, :356 |
| Write path "<10ms" (0.8.5) | Two MCP writes **>120s** on 2026-07-29; pre-embed runs on the hot path, in-process | write-pipeline.ts:180-187; live harness backgrounding |
| Recall "~300ms floor" (0.7.14) / "~35-77ms" (0.9.0 bench) | **805.6ms average** on the production 9,731-engram store | memory_stats 2026-07-29 |
| "No-discard salience" (0.5.4) | Live write **discarded at 0.14**; staging tier holds **0** of 9,731 | live write 2026-07-29; memory_stats |
| `AWM_DISABLE_POOL_FILTER` documented escape hatch | **Not implemented** — no code reads it | adapters/common.ts:483; repo-wide grep |
| Worker-thread ML pool (May P1) | **Reverted; dead code** — `shouldUseInProcess()` hardcoded `true`; all 3 models on the event loop | ml-worker.ts:63-69 |
| DMN/status endpoint (May P2) | Introspection methods defined, **never wired to any route** | consolidation-scheduler.ts:139-144; /health has no consolidation state |
| Postgres backend "for the hive" (P4) | Coordination, backups, slim cache, integrity are **SQLite-only** — the hive can't run on the hive backend | index.ts:137-143 |
| letta-locomo: published peers 68-74% | AWM internal run **48.8%** non-adversarial (methodology uncontrolled — see §4 R2) | tests/letta-locomo/results.json |

Landed as designed: P0 sleep-only consolidation with quiescence gate; P3 `IEngramStore` extraction; PGlite cognitive-engine parity; content fade; adaptive granularity; confidence/abstention; 0.9.0 wide-rerank win (LoCoMo +3.0pp AND adversarial +1.5pp); unified R1/R2/R3 write pipeline; TOON compression.

## 2. What the record says worked / didn't (workstream B, compressed)

**Worked, measured, stuck:** CTE-prefilter BM25 (567×), pool pre-filter, slim cache (60×), batched cross-encoder (7×), write-path rewrite (as benched), merge-on-reinforce (accuracy over token savings), entity-bridge gating (Recall@5 0.46→0.980), session-ID prefix tags (3× LongMemEval), salience auto-promoters, 0.9.0 wide pool + abstention, harness-side multi-hop (2-hop 67→100% with AWM unchanged), 9.8:1 aggregate token advantage vs file-retrieval workflows.

**Didn't work (reverted/abandoned):** worker-thread ML (onnxruntime V8 handles), mode-aware retriever (-8.1pp adversarial), novelty-gated reinforce (collapsed 419 turns→7 engrams), MIN and cosine-primary novelty combines, `AWM_SPREAD` in-engine spreading (displaced gold — parked), PGlite BM25 M-sweep (one knob serves novelty AND ranking), in-store multi-hop boosting ("trades away the precision that is AWM's whole point").

**Method culture:** consistently strong — every optimization env-gated, regressions measured and reverted in-release, stage-attribution tracing (0.9.0) replacing end-score A/B. The 0.7.13→0.9.0 rerank-pool reversal is the cautionary tale: an 8-query A/B blessed a change that silently squeezed out ~50% of retrievable answers for five weeks.

## 3. External validation (workstreams C+D, compressed)

**Bets validated by 2024–2026 evidence:** sleep consolidation (Letta sleep-time compute ~5× test-time reduction; OpenAI Dreaming recall 41.5→82.8%); ACT-R decay + Hebbian spreading (SYNAPSE arXiv:2601.02744, HeLa-Mem arXiv:2604.16839 — published wins on temporal/multi-hop, the field's weakest categories); hybrid BM25+vector (MemoryAgentBench arXiv:2507.05257: BM25 RAG 60.5% vs Mem0 32.6 / Zep 37.5); abstention gate (a measured LongMemEval failure axis most systems lack); supersede-not-delete (≈ Zep bi-temporal edge invalidation); shared hive store (Letta shared blocks; arXiv:2604.03295 — small teams + good memory beat big teams); engram-granular deltas (ACE arXiv:2510.04618 names "context collapse" as the failure of holistic-rewrite memories).

**Unique to AWM, nobody publishes equivalents:** salience-gated writes with staging, feedback-trained activation, content fade with preserved cue pathways.

**Benchmark reality check:** LoCoMo is discredited (fits in a context window; the Mem0-vs-Zep number war ended with both corrected downward — 84%→58.44, and Mem0's Zep score up to 75.14 when configured fairly). LongMemEval (arXiv:2410.10813) is the credible target. Any published number needs pinned config, multiple seeds, and a full-context baseline.

## 4. Ranked improvement plan

### Tier 0 — Close the claim/reality gap (days each; prerequisites for measuring anything else)

- **R1. Diagnose and fix the write stalls.** Hypothesis chain, in order of likelihood: in-process ML cold-load on first MCP write (three ONNX models, no eager warm on the MCP boot path — the 0.7.14 eager cache warm exists for recall), event-loop blocking during embed, and cross-process `SQLITE_BUSY` (MCP + HTTP + sidecar share one DB with **no app-level mutex on the memory path** — write-mutex covers coordination routes only). Fix set: eager model warm at MCP startup, write-behind acknowledgment (accept + queue embed; the pre-embed is only needed for cosine novelty, which has a BM25-only fallback), single-writer serialization or busy-retry with jitter. *Evidence: live 120s×2; ml-worker.ts:63-69; write-pipeline.ts:180-187.*
- **R2. Instrument reality.** Run the 0.9.0 stage-attribution tracer against the live 9.7K store to explain 805ms vs 300ms; wire the already-written scheduler introspection into `/health` (finishes P2); fix session counters that reset on process restart; implement the two stubbed eval metrics (`discardRegret`, `staleUsageCount` — always 0 today). Then re-run letta-locomo/LongMemEval with pinned methodology. *You cannot rank capability work until the platform reports its own behavior truthfully.*
- **R3. Security defaults.** Bind 127.0.0.1 unless configured; generate an API key on install instead of open-by-default; make the coordination session token mandatory (today `sessionTokenOk()` passes when no token exists); remove `.env.bak` from the repo. *Table stakes per every 2026 industry source.*
- **R4. Truth-in-docs sweep.** Implement or delete `AWM_DISABLE_POOL_FILTER`; document the default-OFF phases honestly (an operator reading the header believes spreading activation is on); fix the 0.8.x/2.0 version narrative drift.
- **R5. De-couple the library from USEA.** The staff-name regex and org ID patterns in salience.ts:36-67 become config (`AWM_FEEDBACK_NAMES`, tag-pattern config). A general-purpose memory system should not require a code edit when Robert's staffing changes.
- **R6. Salience/staging honesty.** Investigate why staging holds 0 of 9,731 and why a dense finding scored 0.14 and was discarded (the 0.5.4 "no-discard" policy evidently regressed or was superseded); make the discard response actionable ("low salience — retry with memory_class=canonical if this must survive"); add a discard-audit log so false negatives are measurable (this is what `discardRegret` was designed for).

### Tier 1 — Highest-leverage capabilities (weeks; ranked by measured effect × strategic fit)

- **R7. Write-trust and provenance.** Provenance fields on every write (writing agent, session, tool-origin: user-stated vs tool-output vs inference), a trust factor in the composite-scoring phase (the published defense — trust-weighted retrieval with temporal decay, arXiv:2601.05504 — drops into phase 3b naturally), and an audit query ("which turn wrote this engram"). *The field's #1 2026 security topic: MINJA achieves >95% injection query-only; one poisoned write persists forever where prompt injection must recur. A multi-writer hive ingesting tool outputs is exactly the exposed topology.*
- **R8. Procedural memory distillation.** A consolidation phase that distills completed task trajectories (task_begin/end + checkpoints already capture them) into step-level procedures with Build/Retrieve/Update semantics and execution-outcome feedback. *Largest measured effect in the literature: Memp ALFWorld 39.3→87.1%; Agent Workflow Memory +51.1% relative on WebArena; transfers from strong to weak models.*
- **R9. Generative consolidation.** Upgrade consolidation from compression to generation: (a) reflection-style inferential memories over clusters (Generative Agents), (b) retrievable summary nodes per cluster — a RAPTOR/GraphRAG-lite over the clustering that Phase 1 replay already computes (GraphRAG: 72-83% win rates on sensemaking, 9-43× fewer tokens), (c) query-anticipating sleep compute (Letta: ~5× test-time reduction). Consolidation summaries today are concatenations — known-limitations.md admits it.
- **R10. Temporal model.** `valid_from`/`valid_to` on engrams (Zep bi-temporality), a temporal-rewriting pass during consolidation (future-tense facts become past-tense after the date — OpenAI Dreaming's mechanism, their eval 41.5→82.8%), and recall-time conflict surfacing: when a superseded memory would rank, return the chain ("X, superseded 6/12 by Y") instead of only down-ranking. *MemoryAgentBench FactConsolidation: every published system ≤28% on conflict reasoning — an open differentiator AWM's supersede graph is uniquely positioned to win.*

### Tier 2 — Differentiators and platform (when Tier 0/1 land)

- **R11. Lateral inhibition, then re-test `AWM_SPREAD`.** The parked spreading-activation feature regressed by *displacing gold* — and SYNAPSE (arXiv:2601.02744) published the fix for exactly that failure: competing activations suppress each other (lateral inhibition) to filter interference. Implement inhibition, re-run the 0.9.0 tracer, and the headline bio feature may finally earn default-ON.
- **R12. Memory summary/audit surface.** A "what I know" page per agent/workspace (all three frontier labs shipped one) — doubles as the trust/PII review UI for R7.
- **R13. Privacy controls.** Per-class retention windows (Gemini's 72h pattern), a no-persist session mode beyond incognito, PII flagging at write time. Required before any multi-user exposure.
- **R14. ML sidecar process.** The dispatch abstraction is already shaped for it; worker_threads is proven impossible, so child-process/HTTP sidecar is the path — unblocks the event loop (R1's root cause), enables the deferred 768d embedding upgrade with a re-embed migration, and removes the 920MB resident from every consumer process.
- **R15. Hive backend completion or de-scope.** Either port coordination to Postgres (~1500 LOC estimated in the parity doc) so the hive runs on the hive backend, or explicitly document SQLite-only coordination as the design.
- **R16. Test the core.** activation.ts (68KB) has no dedicated unit tests; the default-OFF phases are untested in their enabled state; decompose the 102KB/72KB/68KB monoliths as tests land.

## 5. Challenge (5-perspective production-failure debate)

- **Requirements:** "The ask was improvement via outside research — Tier 0 is mostly engineering hygiene." *Resolved:* the live store produced a 120s write and a discarded finding **during the eval itself**; no literature-derived capability survives contact with a platform that stalls and silently drops memories. Tier 0 is what makes Tier 1 measurable.
- **Architecture:** "R9 summary nodes could recreate the 'context collapse' ACE warns about — summaries drifting from sources." *Mitigation:* summary nodes must carry provenance edges to member engrams and be superseded (never edited in place) when members change; itemized deltas stay the write primitive.
- **User (operator):** "R7 trust weighting could down-rank legitimate tool-derived findings — most of Robert's memories ARE tool outputs." *Mitigation:* trust as a small additive factor with per-source floors, shipped default-observing (log-only) for two weeks before it affects ranking, exactly how 0.9.0 changes were validated.
- **QA:** "Concrete break: R1's write-behind means a crash between accept and embed loses the memory." *Mitigation:* journal the accepted write synchronously (cheap SQLite insert without embedding — the schema already allows null embeddings with backfill, per 0.6.1's batch backfill), embed async; on restart, backfill sweeps nulls. Failure mode becomes delayed searchability, not loss.
- **Product:** "Sixteen items is a backlog, not a plan; what's the sequence?" *Resolved:* R1+R2 first (one focused week, mostly existing instrumentation), R3-R6 opportunistic alongside; then R7 and R8 in either order; R9-R10 next quarter; Tier 2 gated on measured Tier 1 wins via the R2 benchmark harness.

**Method note:** `/full-audit` (a code-change PASS gate) was not applicable — no production code was modified; workstream A's senior-review sweep served as the audit layer. `/ask-coworker` was not invoked: the ranking is evidence-forced (Tier 0 items are measurement prerequisites, and Tier 1 order follows published effect sizes), not a genuine fork between defensible options — the four independent workstreams provided the adversarial perspectives.

## 6. Verdict

**PASS as an evaluation** (requirements met, claims verified against code/store/literature, challenge run). The system itself: **REVISE** — the architecture is validated externally, the method culture is genuinely strong, and the gaps are concrete, cheap to close relative to their leverage, and now fully enumerated with evidence.

*Workstream artifacts: AWM engrams under `topic=awm-eval-evidence` (6 memories), `literature-review-memory-systems` (34f7227a), `competitive-landscape-agent-memory` (8390b24e); scratchpad `awm-eval/workstream-B-history-ledger.md`, `workstream-CD-research-summary.md`; full agent transcripts in session task outputs.*

---

## 7. Post-review addendum — owner design constraints (2026-07-30, Robert)

Robert's review of this evaluation established three constraints that rerank the plan:

**(a) Local-first is the product.** "The key to AWM is that it's local and it stays local… run local on your machine and be really fast and be able to support multiple agents," including multi-CLI setups (Claude Code + Codex sharing one store). Consequence: **R15 is reframed** — the answer to multi-writer contention is not a hosted Postgres migration; it is making local multi-process SQLite excellent. Postgres hive remains an option for genuinely distributed teams, not the fix for local problems.

**(b) The write stalls are most likely SQLite multi-writer contention (owner hypothesis, now primary for R1).** The evidence assembled here supports it over the cold-load hypothesis: the memory write path has no app-level mutex (write-mutex covers coordination routes only); `better-sqlite3` calls are synchronous, so a held lock means the caller *waits*, not fails; consolidation is a long single-process transaction whose 30-minute quiescence gate can fire mid-session during long non-AWM stretches; and during this eval **two Claude Code sessions were live concurrently, each with its own MCP process writing the same `agent=work` store** — plus the sidecar. R1's fix set is accordingly reordered: (1) cross-process single-writer serialization for the memory path (a write queue through one owner process — the sidecar is the natural owner — or an OS-level lock with bounded busy-retry + jitter), (2) consolidation yield/chunking so the sleep cycle never holds the lock for minutes against a live writer, (3) eager model warm and write-behind as secondary. Instrument first: log lock-wait time per write (`AWM_PROFILE_WRITE` extension) to prove the mechanism before fixing it.

**(c) Deployment-shape confusion is a first-class defect, not operator error (new item R17).** There are two shapes — the hosted/hive multi-agent connector and the local standalone instance — "and Claude regularly confuses the two when I'm running in just a standard version of AWM." This eval reproduced the confusion class: the live server was the AgentSynapse submodule copy on sidecar 8401 while docs say HTTP 8400, and ":8400 unreachable" was initially misread as an outage. **R17: an identity/topology surface** — every MCP/HTTP response header (or a `memory_whoami` tool + `/whoami` route) reports instance name, mode (standalone/hive/hosted), backend, store path, code provenance (repo + version), and ports; the installer writes matching identity into the generated CLAUDE.md sections so agents can verify they are talking to the instance they think they are. Cheap, and it converts a recurring class of misdiagnosis into a one-call check. Belongs in Tier 0.
