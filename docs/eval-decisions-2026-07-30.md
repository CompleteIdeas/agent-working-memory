# AWM Improvement Plan — Per-Item Decisions (R1–R17)

**Date:** 2026-07-30 · **Method:** first-class-delivery Decision Process per item (options → cited cases → tradeoffs → coworker challenge → decision → risks)
**Coworker challenge:** gpt-5.3-codex, run on the three contested forks (write-serialization approach, engine-vs-harness intelligence, trust weighting). Adopted from it: self-poisoning-by-buggy-harness as the real single-operator threat model, Hebbian amplification loops, provenance-now-or-no-retrofit, and canonical "cognition recipes" to keep Claude/Codex harnesses consistent. Rejected: nothing material — its recommendations matched the evidence-forced leans; its additions hardened them.
**Binding constraints (Robert, 2026-07-30):** local and stays local · really fast · multi-agent including multi-CLI (Claude + Codex) · deterministic engine, no API-key LLM inside.

Verdict vocabulary: **BUILD NOW** (this/next week) · **BUILD NEXT** (after NOW lands) · **BUILD LATER** (quarter, gated) · **TABLE** (write-up only, owner decides) · **RESHAPED** (built, but not as originally proposed).

---

## R1 — Fix the 120s write stalls · **BUILD NOW**
**Pro:** Two live 120s MCP writes observed during the eval; owner attributes to SQLite multi-writer, and the evidence agrees — no app-level mutex on the memory path (write-mutex covers coordination routes only), better-sqlite3 waits synchronously on a held lock, consolidation holds long transactions, and two Claude sessions + sidecar were verifiably writing one store concurrently. This is the single worst violation of "really fast, local."
**Con:** A write-owner process adds a localhost hop (~1–3ms) to every write and is a crash point; over-engineering risk if the real cause turns out to be model cold-load.
**Decision (fork resolved with coworker):** (1) Instrument first — extend `AWM_PROFILE_WRITE` to log lock-wait vs embed vs SQL time per write; one day of normal multi-CLI use proves the mechanism. (2) Then: **owner-process write queue through the existing sidecar** (idempotency keys, priority lane for interactive writes) **plus consolidation transaction chunking** so no sleep cycle holds the lock for minutes. (3) **Fallback path:** when the sidecar is absent/crashed, processes degrade to direct writes under an OS-level lock file with bounded busy-retry + jitter — never lose the write, never wait unbounded. Reads stay in-process and untouched.
**Risk:** owner crash mid-queue → journal accepted writes synchronously (null-embedding insert, backfill sweep on restart — the 0.6.1 backfill machinery already exists), so the failure mode is delayed searchability, not loss.

## R2 — Instrument reality + pinned benchmark · **BUILD NOW**
**Pro:** 805ms observed vs 300ms claimed; two eval metrics stubbed to 0; the 0.7.13 lesson (an 8-query A/B blessed a five-week silent regression) shows unmeasured is unsafe. The 0.9.0 stage-attribution tracer already exists — this is mostly running it on the real 9.7K store and wiring the already-written scheduler introspection into `/health`.
**Con:** Benchmark time is real; benchmarks mislead (the Mem0/Zep war) — a bad harness is worse than none.
**Decision:** Tracer run on the live store + `/health` consolidation state (finishes P2) + implement `discardRegret`/`staleUsageCount` + fix restart-resetting session counters. Then one pinned LongMemEval run (separate eval DB — the prod-pollution lesson) with config, seeds, and a full-context baseline recorded. LoCoMo only as a secondary, clearly-labeled number.
**Risk:** none material; pure observability.

## R3 — Security defaults · **BUILD NOW** (hours)
**Pro:** HTTP open by default on 0.0.0.0; coordination token optional-when-absent; `.env.bak` in repo. Local-first makes this *worse*, not better — a laptop on hotel Wi-Fi is the deployment.
**Con:** Breaking change for any existing remote-hive install that relied on open binding.
**Decision:** Bind 127.0.0.1 by default (`AWM_BIND` to widen), installer generates an API key, coordination session token becomes mandatory, delete `.env.bak`. Migration note in CHANGELOG; adapters regenerate configs on next `awm setup`.
**Risk:** a forgotten remote consumer breaks loudly on upgrade — acceptable and desirable; the alternative is breaking silently to an attacker.

## R4 — Truth-in-docs sweep · **BUILD NOW** (hours)
**Pro:** `AWM_DISABLE_POOL_FILTER` is advertised and reads nothing; the pipeline header says 10 phases while three are default-OFF; version narrative says 0.8.x/2.0 in a 0.11.0 repo. Docs that lie cost diagnosis time — this eval spent real effort reconciling them.
**Con:** None beyond churn.
**Decision:** Implement the pool-filter flag (the filter exists; the bypass doesn't) or delete the doc line; annotate default-OFF phases in the header and adapter template; sweep stale version references.

## R5 — De-USEA the salience detectors · **BUILD NOW** (small)
**Pro:** Staff names and org ID patterns hardcoded in salience.ts:36-67 couple a general-purpose library to one org; staffing changes currently require a code edit.
**Con:** Config indirection for something only one deployment uses today.
**Decision:** `AWM_FEEDBACK_NAMES` + configurable tag-pattern list, installer seeds Robert's current values so behavior is unchanged for him. The library becomes shippable.

## R6 — Salience/staging honesty · **BUILD NOW (investigate), tune later**
**Pro:** Live false-negative discard (dense finding at 0.14) + staging holding 0 of 9,731 + the 0.5.4 "no-discard" policy contradicted in practice. The filter is AWM's signature feature and its failure mode is silent data loss.
**Con:** Salience retuning has a scar history (three reverted tuning attempts in the ledger) — blind threshold changes are how regressions happen.
**Decision:** Investigation + observability only, no retuning yet: trace why the disposition skipped staging, add a discard-audit log (feeds `discardRegret`), make the discard response actionable ("low salience — retry canonical if this must survive"). Threshold decisions wait for two weeks of discard-audit data.

## R7 — Provenance + trust · **BUILD NEXT (log-only); ranking LATER, eval-gated**
**Pro:** The field's #1 2026 security topic; and per the coworker, the *single-operator* version of the threat is self-poisoning by buggy automation — which Robert's fleet has already produced (this month's unrecorded-mutation incident was benign self-poisoning by omission). Provenance fields are cheap now at 9.7K engrams and impossible to retrofit honestly later. Provenance also feeds R17, R8's recipes, and the audit surface.
**Con:** Trust-in-ranking risks down-ranking legitimate tool-derived memories (most of the store IS tool output) and suppressing novel-but-correct outliers; Hebbian access-strengthening can amplify whatever ranking favors.
**Decision:** Schema + write-path provenance now (writing agent, session, origin class: user-stated / tool-output / inference / harness-recipe, prompt-hash where applicable) — **log-only, zero ranking effect**. Trust as a ranking factor ships only after an eval set demonstrates benefit, and then log-only-observed for two weeks first (the 0.9.0 validation pattern).

## R8 — Procedural memory distillation · **BUILD NEXT, harness-side via cognition recipes**
**Pro:** Largest measured effect in the literature (Memp: ALFWorld 39.3→87.1; AWM-the-acronym-collision paper: +51% relative). AWM already captures trajectories (task_begin/end, checkpoints). Precedent: multi-hop was deliberately solved harness-side and won (2-hop 67→100% with the engine unchanged).
**Con (fork 2, resolved):** engine-side needs an LLM — breaks the deterministic/no-API-key principle (flan-t5-small demonstrably can't do it); harness-side risks Claude and Codex distilling inconsistently.
**Decision:** **Harness-side.** AWM ships a canonical **cognition recipe**: a distillation prompt + strict JSON output schema + validator + a `procedure` write path with provenance (`origin=harness-recipe`, recipe version, prompt hash). `memory_task_end` returns the recipe invitation; the host agent does the thinking; results land as ordinary procedural memories, superseded on update. Engine stays deterministic.
**Risk:** recipe drift across harnesses → recipes are versioned artifacts in the repo, validated on write; malformed distillations rejected at the schema gate.

## R9 — Generative consolidation (reflection + summary nodes + query anticipation) · **BUILD LATER, harness-side, same recipe pattern**
**Pro:** GraphRAG 72-83% win rates on sensemaking; Generative Agents' ablation; Letta's 5× sleep-time result; known-limitations.md admits summaries are concatenations.
**Con:** ACE's "context collapse" — iterative rewriting erodes detail; engine-side needs an LLM (same fork as R8); harness idle-time isn't guaranteed.
**Decision:** Engine adds one deterministic primitive: a **cluster-digest API** (consolidation already computes clusters in Phase 1 — expose members + stats). A consolidation recipe lets the host agent write summary nodes as first-class memories with provenance edges to members, superseded-not-edited when members change (delta discipline per ACE). Query-anticipation deferred until digest+summary prove out. After R8 proves the recipe pattern.

## R10 — Temporal model · **SPLIT: fields + chain-surfacing BUILD NEXT; rewriting LATER**
**Pro:** Field-wide ≤28% on conflict reasoning (MemoryAgentBench) — AWM's supersede graph is uniquely positioned; Zep's bi-temporality and OpenAI's temporal rewriting (41.5→82.8) are the two published wins.
**Con:** Rewriting is generative (fork 2 again); validity fields without consumers are dead schema.
**Decision:** **Now-half (deterministic):** `valid_from`/`valid_to` columns + recall-time supersede-chain surfacing (when a superseded memory would rank, return "superseded 6/12 by X" instead of silently down-ranking — one change in phase 8c, immediately useful to every agent). **Later-half:** temporal rewriting as a consolidation recipe (harness-side), after R8/R9.

## R11 — Lateral inhibition, then re-test `AWM_SPREAD` · **BUILD LATER, tracer-gated**
**Pro:** The parked headline feature regressed by displacing gold; SYNAPSE published lateral inhibition as the fix for exactly that interference mechanism; success would earn the bio stack default-ON.
**Con:** Spreading activation has regressed **twice** in AWM's history; research risk is real; zero user-visible value if it fails again.
**Decision:** Gated research item: only after R2's tracer baseline exists, implemented behind the existing `AWM_SPREAD` flag, judged by the 0.9.0 method (stage attribution + adversarial suite, not end-score A/B). Time-boxed; a third regression parks it permanently without regret.

## R12 — Memory summary/audit surface · **BUILD LATER (thin first cut)**
**Pro:** All three frontier labs shipped one; doubles as the review UI for R7 provenance and R6 discard audits.
**Con:** Single operator with CLI fluency; a web UI is scope.
**Decision:** Thin: `awm review` CLI generating a static HTML digest (what I know / recent writes / discards / supersede chains / provenance). No server UI until multi-user exists.

## R13 — Privacy retention windows / PII flagging · **TABLE**
**Pro:** Industry table stakes for multi-user; Gemini's 72h pattern is clean.
**Con:** Single-operator local store; incognito + ephemeral class already exist; YAGNI until AWM is shipped to other users.
**Decision:** Tabled with this write-up. Trigger: the first non-Robert operator or any hosted deployment. (Spec: per-class TTL + write-time PII flag + no-persist session mode.)

## R14 — ML sidecar process · **BUILD LATER (converges with R1's owner)**
**Pro:** worker_threads proven impossible; in-process models block the event loop and pin ~920MB per consumer process; prerequisite for the 768d embedding upgrade; dispatch abstraction already shaped for it.
**Con:** IPC complexity, another process to manage; R1's fixes may reduce urgency.
**Decision:** Deliberately after R1 — the write-owner sidecar from R1 is the natural future home for ML offload (one process owns writes AND models; consumers go thin). Revisit with R1's profiling data; pair with the 768d re-embed migration when done.

## R15 — Postgres hive completion · **RESHAPED → TABLE the port; document the design**
**Pro (original):** coordination is SQLite-only, so the "hive backend" can't run the hive.
**Con:** Violates the sharpened constraint — local-first is the product; a Postgres coordination port (~1500 LOC) solves a problem Robert doesn't have; the local multi-process story (R1) is the actual gap.
**Decision:** Document SQLite-only coordination as the intended design; keep the Postgres cognitive backend experimental for genuinely distributed teams; the port is tabled until such a team exists. R1 is the budget's better use.

## R16 — Test the core + decompose monoliths · **BUILD NOW (policy), incremental**
**Pro:** activation.ts (68KB, the product's heart) has no dedicated unit tests; default-OFF phases untested in enabled state; 102KB/72KB files resist review.
**Con:** Big-bang decomposition is regression risk for zero feature value.
**Decision:** Policy, not project: every R-item touching a monolith adds focused tests first and extracts only what it touches. One dedicated activation suite (pipeline-order, phase-toggle, abstention paths) lands with R2 since the tracer work reads that file anyway.

## R17 — `whoami` identity surface · **BUILD NOW** (small)
**Pro:** Robert: Claude "regularly confuses" the hosted connector vs the local instance; this eval reproduced the class (submodule copy on 8401 vs docs saying 8400, misread as an outage). One recurring misdiagnosis category, killed by one tool.
**Con:** None real.
**Decision:** `memory_whoami` MCP tool + `/whoami` route: instance name, mode (standalone/hive/hosted-connector), backend, store path, code provenance (repo path + version), ports; installer stamps matching identity into generated CLAUDE.md; session-start hook surfaces it.

---

## Sequence

| Wave | Items | Shape |
|---|---|---|
| **Week 1** | R1 (instrument→fix), R2, R17, plus R3/R4/R5 (hours each) | close the claim/reality gap |
| **Next** | R6 audit data, R7 log-only provenance, R10 fields + chain-surfacing, R8 first cognition recipe | provenance + the biggest lit win |
| **Quarter** | R9, R10 rewriting recipe, R11 (tracer-gated), R12 thin, R14 (with R1 data) | generative layer + research |
| **Tabled** | R13 (trigger: first external user), R15 Postgres port (trigger: distributed team) | written up, owner decides |

**Standing architectural rule established by these decisions:** the engine stays deterministic and local; anything requiring real intelligence ships as a versioned, schema-validated **cognition recipe** executed by the host agent, written back as ordinary memories with provenance. That one rule resolves R8, R9, and R10's rewriting half consistently, keeps Claude and Codex interchangeable, and honors "local and stays local."

---

## Reconciliation with the personal memory space (added 2026-07-30)

This evaluation ran as agent=`work` and could not see the `personal` agent space where AWM's design record actually lives (surfaced via `awm export --agent personal`: 1,188 memories, 183 AWM-related, 113 canonical/decision). Reconciliation against that record:

**Already decided there — this doc now defers to those decisions:**
- **Positioning (2026-06-13, canonical, Robert's words):** AWM is a *decision/direction continuity layer*, NOT total-recall; "LoCoMo is a category error"; salience-gating IS the product; pitch = "lightweight, fast, embeddable decision-and-direction memory so your LLM builds on its prior thinking instead of reinventing it." Robert's restatement 2026-07-30: the memory space returns enough for the LLM to add to context and get where it needs to go **without file seeking**. → **R2 is corrected:** the headline metric is *continuity/production* — file-seek-avoidance (the 9.8:1 measurement), recall-payload sufficiency, decision-recall precision. External conversational benchmarks are at most per-axis diagnostics, never the yardstick. The "48.8 vs Letta 74" item in the eval report is reclassified from *gap* to *category error*.
- **Harness-side intelligence is not a proposal — it is shipped.** MWA #14 (2026-06-15): skills as canonical AWM memories (`topic=skill`), auto-derived in a **separate focused brain call** (the combined-JSON attempt failed — cheap models omit the skill field), gated, live-verified, dup-skills reinforce. "PATTERN CONFIRMED (again): harness-owned beats model-elective." → **R8 becomes a port/generalization of MWA's skill pattern into the standalone recipe format**, not a fresh design. The "cognition recipe" rule in this doc is a convergent re-derivation of MWA's architecture — alignment, not invention.
- **R7/R12 are MWA's "memory spine" roadmap** (2026-06-29 vision, Robert: "a substrate for model thinking… like a train of thought"): provenance + trust-tier + namespace + action-as-engram on every memory, with Glass Box (= R12), Trust-Provenance (= R7), Context-Namespaces, Explain-Approve-Undo, Honest Agent, Earned-Determinism. Execute R7/R12 as that roadmap (plan: MWA `scratchpad/harness-research-gaps.md`), with the substrate pieces (provenance columns, trust field) landing in AWM-standalone so all consumers get them.
- **Retrieval research roadmap exists (2026-06-16):** entity inverted index + alias table, sparse attribute/triple layer, **bounded spreading activation with precision guards** (edge rescale c=0.4, τ=0.5, ≤3 hops — arXiv 2512.15922, 67% vs 45% MuSiQue), spaCy SVO triples (94% of LLM-graph quality, no LLM). → **R11 merges into this**: SYNAPSE's lateral inhibition is a *complement* to the bounded-spread guards, and the personal space's masked-false-negative analysis (0.7.16 wider pool was a good lever killed by a confounded revert) already established both the stage-attribution method and a re-test queue (spread+inject first). R11 = execute that queue with inhibition added, under the 0.9.0 wide-pool baseline.
- **Consumer coupling map (2026-07-03):** MWA vendors AWM 0.10.0 and consumes **deep dist internals** (storage/engine/core paths) — MWA is effectively driving AWM's version. → Every R-item touching `dist/` paths must treat MWA as a de-facto API consumer; NovelForge (containerized 0.8.6) and AgentSynapse (workspace 0.9.0 public API) are tolerant.

**Genuinely new from this evaluation (not previously in either space):** R1 write-stall diagnosis and owner-queue fix, R3 security defaults, R4 truth-in-docs, R5 de-USEA config, R6 discard-audit, R17 whoami, and the 2026 literature deltas (lateral inhibition, MemoryAgentBench's BM25 finding, the poisoning-defense paper, ACE context-collapse).

**Process lesson (feeds R17):** an agent evaluated a project while blind to the project's own decision space because agent scoping worked as designed and nothing told it a sibling space existed. `whoami` should list sibling agent spaces present in the store (names only), and owner-operated setups need a sanctioned cross-space read path (`awm export --agent <id>` worked but is manual). Most users run one space; this is an owner-tooling concern, not a default behavior change.
