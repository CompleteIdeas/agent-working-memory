# AWM Design Proposals — Consolidated (D1–D16)

**Date:** 2026-07-30 · **Supersedes:** the R1–R17 working list (crosswalk at bottom)
**Synthesis of:** the 2026-07-29 deep-dive eval (4 workstreams + live operator evidence) · the personal-space decision record (positioning 6/13, MWA patterns 6/15–6/29, entity-retrieval roadmap 6/16, coupling map 7/3) · 2024–2026 literature and frontier-lab practice.

**Framing (Robert):** AWM is a **memory space for an LLM, not containing an LLM** — a component within larger systems. It returns enough for the model to add to its context and get where it needs to go **without file seeking**. MWA is a proof of concept: it demonstrates *one* structure for implementing against AWM and serves as the reference consumer — a multi-tool usable different ways in different projects — but AWM's design must serve **all** consumers equally: Claude Code and Codex sessions directly, MWA, NovelForge, AgentSynapse, the USEA harness, and future embedders.

**Binding constraints:** local and stays local · really fast · multi-agent including multi-CLI on one store · deterministic engine (the three small ONNX models only) · salience-selectivity is the product, not a limitation.

---

## Layer A — Substrate integrity

**D1 — Serialized write service.** All writes to a store route through one owner process (the existing sidecar) as a queue: idempotency keys, interactive-priority lane, synchronous journal insert (null embedding) with async embed + backfill sweep, so a crash means delayed searchability, never loss. Fallback when the owner is absent: direct write under an OS-level lock with bounded busy-retry + jitter. Consolidation transactions chunked so the sleep cycle never holds the lock against a live writer. Reads stay in-process and untouched.
*Grounded in:* two live 120s MCP writes; no app-level mutex on the memory path; two concurrent Claude sessions + sidecar verifiably sharing one store; better-sqlite3 synchronous waits. Instrument lock-wait first (`AWM_PROFILE_WRITE` extension) to prove mechanism before building.

**D2 — Local security defaults.** Bind 127.0.0.1 unless `AWM_BIND` widens it; installer generates an API key; coordination session token mandatory (today it passes when absent); remove `.env.bak`. A laptop on hotel Wi-Fi is the deployment target — local-first raises the bar, it doesn't lower it.

**D3 — Instance identity (`whoami`).** `memory_whoami` MCP tool + `/whoami` route: instance name, mode (standalone / hive / hosted-connector), backend, store path, code provenance (repo + version), ports, **and the sibling agent spaces present in the store (names only)**. Installer stamps matching identity into generated CLAUDE.md/AGENTS.md. Kills two recurring failure classes observed this week: sessions confusing the hosted connector with the local instance, and an evaluation running blind to the project's own decision space because nothing said `agent=personal` existed.

**D4 — Config over code + truth-in-docs.** Salience feedback-name list and org tag patterns become config (installer seeds current values); `AWM_DISABLE_POOL_FILTER` implemented or deleted; default-OFF pipeline phases documented as such where operators read; version-narrative drift swept. The library becomes shippable to a second user without a code edit.

## Layer B — The memory spine (schema; from the MWA-originated roadmap, landing in the substrate so every consumer gets it)

**D5 — Provenance on every engram.** Writer agent, session id, origin class (`user-stated | tool-output | inference | recipe`), recipe/prompt hash where applicable. **Log-only** — zero ranking effect until D15's metrics prove a benefit. Cheap now at ~10K engrams; impossible to retrofit honestly later. Enables the audit question "which turn wrote this."

**D6 — Trust tier.** A spine field populated from origin class + writer, **observed before it ranks** (two-week log-only pattern, per how 0.9.0 was validated). Threat model per the coworker challenge: the realistic single-operator adversary is *buggy automation self-poisoning the store*, amplified by Hebbian access-strengthening — trust must therefore dampen amplification loops, not just block attackers.

**D7 — Namespaces as first-class.** Formalize what agent/workspace scoping already half-does: named spaces with declared purpose, sibling discovery (via D3), and a sanctioned owner cross-space read path (today's workaround `awm export --agent <id>` promoted to a real, read-only recall option for store owners). Most users run one space — this is owner tooling, defaults unchanged.

**D8 — Temporal validity + conflict surfacing.** `valid_from`/`valid_to` columns (Zep-style bi-temporality) and a phase-8c change: when a superseded engram would rank, return the chain ("superseded 6/12 by X") instead of silently down-ranking. Field-wide benchmark result: every published system ≤28% on conflict reasoning — AWM's supersede graph is uniquely positioned to make contradiction *visible* to the model, which is exactly the continuity job.

## Layer C — Retrieval (executes the 6/16 entity-centric roadmap, updated with 2026 literature)

**D9 — Entity inverted index + alias table.** `entity_mentions` + `entity_aliases` write-time bookkeeping; collapses "Atlas" / "the Atlas project" / "my main project" to one ID; formalizes the entity-bridge boost that already ships default-ON. Near-free; no LLM.

**D10 — Sparse attribute/triple layer.** High-value attributes as indexed rows (`entity, attribute, value, source_memory_id, confidence, ts`) beside canonical free text — "X's deadline" answered by SQL lookup with zero context bloat. Extraction path: spaCy SVO dependency parsing (94% of LLM-graph quality at ~1000× speed — no LLM in the engine, honoring the concept).

**D11 — Guarded spreading activation + lateral inhibition.** Execute the established re-test queue (spread+inject first, then expansion, then wider floors) under the 0.9.0 wide-pool baseline, judged by stage attribution — with two additions from research: the bounded-propagation precision guards already specified in the roadmap (edge rescale c=0.4, τ=0.5, ≤3 hops; 67% vs 45% MuSiQue with a small model) and SYNAPSE-style lateral inhibition (competing activations suppress each other — the published fix for the displacing-gold regression that parked `AWM_SPREAD`). Three-strikes rule stands: a third regression parks it permanently.

## Layer D — Lifecycle

**D12 — Discard audit + staging investigation.** Implement `discardRegret` for real; log every discard with score breakdown; make the discard response actionable ("low salience — retry canonical if this must survive"); investigate why staging holds 0 of 9,731 and where the 0.5.4 no-discard policy went. **No threshold retuning until two weeks of audit data** — salience tuning has a three-revert scar history. Selectivity is the product; silent false negatives are its one unacceptable failure mode.

**D13 — Cluster-digest API.** Consolidation already computes clusters (replay phase); expose them deterministically (members + stats + change markers). This is the substrate half of generative consolidation: any consumer can summarize a digest into first-class summary memories carrying provenance edges to members, superseded-not-edited when members change (the ACE context-collapse guard). The engine never generates; it makes generation *possible and safe*.

## Layer E — The intelligence interface (the substrate contract)

**D14 — The Recipe Contract.** Formalize the pattern MWA proved as a documented AWM contract any host can implement identically: intelligence runs **host-side in a separate focused call** (MWA #14's hard lesson: combined-JSON fails, cheap models omit fields), against a **versioned prompt + strict JSON schema shipped by AWM**, validated on write-back, stored as ordinary memories with D5 provenance (`origin=recipe`, recipe id + version). Ship the library in order: **skills/procedural distillation** (port MWA #14 — the largest measured effect in the literature: 39→87% task success), **consolidation digest summarization** (over D13), **temporal rewriting** (over D8) later. MWA is the reference implementation; Claude Code, Codex, NovelForge, and the USEA harness implement the same contract — that's what keeps a multi-CLI store coherent.

## Layer F — Measurement

**D15 — Continuity metrics as the yardstick.** Per the 6/13 positioning decision (final): AWM is measured on the job it does — **file-seek avoidance** (the 9.8:1 production number, tracked over time), **recall-payload sufficiency** (did the agent proceed without a follow-up search), **decision-recall precision** (does the load-bearing decision surface when its topic returns). Stage-attribution tracer runs against the real store become routine (they explain 805ms-vs-300ms and catch masked false negatives — proven method). External benchmarks (LongMemEval axes: knowledge-update, abstention) demoted to per-axis diagnostics, never the headline; LoCoMo-class comparisons are recorded as category errors.

## Layer G — Distribution

**D16 — Consumer API tiers.** Declare the stable public API vs the deep `dist/` internals that MWA vendors (treat those paths as a de-facto API with change notes — MWA is version-locked and drives AWM forward); document export/import (0.10.0) as the interchange format; keep adapters (claude-code / codex / cursor / http) at parity so every host gets D2/D3/D14 on `awm setup`. NovelForge (containerized service) and AgentSynapse (public API) stay tolerant by design.

---

## Sequencing

| Wave | Proposals | Character |
|---|---|---|
| 1 | D1 (instrument→build), D2, D3, D4 | substrate integrity — days each |
| 2 | D5, D8, D12, D15 (metrics wiring) | spine schema + honesty — the measurement base |
| 3 | D14 (skills recipe first), D9 | intelligence contract + cheapest retrieval win |
| 4 | D10, D11, D13, D6 (ranking, eval-gated) | retrieval depth + generative substrate |
| Deferred triggers | D7 full owner tooling (multi-space demand) · privacy/retention (first external user) · Postgres coordination port (a distributed team) · ML sidecar (revisit with D1 profiling; pairs with 768d re-embed) | |

## Crosswalk (R → D)

R1→D1 · R2→D15 (corrected) · R3→D2 · R4+R5→D4 · R6→D12 · R7→D5+D6 · R8→D14 · R9→D13+D14 · R10→D8(+D14 later) · R11→D11 · R12→ Glass Box over D5/D12 (consumer-side, MWA leads) · R13→deferred trigger · R14→deferred trigger · R15→deferred trigger · R16→standing test policy (applies to every D) · R17→D3.

**One-line thesis:** harden the substrate, add the spine, formalize the recipe contract, and measure continuity — so any host, from a bare Claude Code session to MWA to systems not yet built, gets the same fast, local, selective memory that lets the model build on its prior thinking instead of reinventing it.
