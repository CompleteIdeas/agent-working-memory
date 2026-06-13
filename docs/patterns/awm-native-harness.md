# Pattern: The AWM-Native Agent Harness

> An agent harness that treats AWM as an **always-on cognitive substrate**, not a
> tool the model occasionally calls. The agent learns automatically as a
> byproduct of doing its work — which lets a **cheap model perform at a high
> level** and gets **cheaper and better over time** on the same workload.

This is a design pattern, not a library. The reference implementation is the
USEA "Gallop Support" agent (`AIAgentBuild/harness/`). This doc captures the
pattern so the next agent-shaped project starts from it instead of reinventing
it.

---

## The headline result

The pattern's whole reason to exist, measured on a real domain workload (USEA
member-support investigations, 15-task stress suite):

| Model | Substrate | Score | Cost/task |
|---|---|---|---|
| **gpt-5.4-mini + AWM** | primed | **14 / 15** | **$0.0069** |
| Claude Sonnet 4.6 (no substrate priming) | — | 7 / 15 | $0.277 (≈40×) |

A small, cheap model **out-performed a frontier model at ~1/40th the cost** —
because the hard-won domain knowledge (DB schemas, working SQL, business rules,
prior corrections) lives in the **substrate**, not the model's weights. The
model doesn't have to *know* the domain; it only has to *reason over facts that
are primed into its context for it.* That is the core trade the pattern makes:
**move capability from the model into the memory.**

---

## The core loop

Every task runs through four phases. The phases the model does NOT control are
what make it a substrate instead of a tool:

```
                    ┌─────────────────────────────────────────┐
   task ──▶  (1) PRIME ──▶ (2) ACT ──▶ (3) VERIFY ──▶ (4) LEARN ──▶ response
                 ▲                                         │
                 └───────────── AWM substrate ◀────────────┘
                       (recall feeds in / learning feeds back)
```

1. **PRIME (automatic, pre-model).** Before the model sees anything, the harness
   recalls relevant memories and injects them into the system prompt — verified
   facts, working query patterns, prior corrections — plus progressive-disclosure
   domain topic files. The model starts the task already knowing what was learned
   on every prior run. *The model never has to decide to remember.*

2. **ACT (cost-tiered).** The agent loop runs tools. A router picks a **cheap
   model for lookups** (`fetch` tier) and escalates to a **reasoning model only
   when needed** (`reason` tier), per iteration. Most iterations are cheap.

3. **VERIFY (mechanical gates).** Reversible-write tools require a read-back
   confirmation; responses are validated for substance (did it actually answer,
   with real data, not flail or punt). Failures loop back with a corrective
   prompt before finalizing.

4. **LEARN (automatic, post-model).** After the turn, with **zero model
   cooperation**, the harness:
   - sends **feedback** to AWM on which recalled memories the agent actually used
     (closes the validation-gated Hebbian loop → useful memories strengthen);
   - captures **discovered schemas** as canonical memories, with
     **supersede-on-correction** (a wrong column tried once becomes a corrected
     canonical fact — the agent stops repeating the mistake);
   - captures **working query patterns** (next similar task recalls the working
     SQL instead of re-deriving it);
   - **reflects** on gaps and user corrections, writing them as friction/surprise
     memories.

---

## Why it compounds (the flywheel)

A stateless tool-calling agent pays full price for every task forever. This
pattern doesn't:

- **Cost goes down with use.** Primed schemas + working queries mean fewer
  iterations and fewer wrong turns next time. Recall *replaces flailing* — the
  single biggest cost sink in domain agents (measured ≈9.8× cheaper than a
  Read/Grep/Glob-style rediscovery workflow). In-process memory (below) removes
  the network hop; compact-granularity recall trims ~70% of primed tokens.
- **Quality goes up with use.** Verified/canonical facts are surfaced first
  (class-bonus rerank); corrections supersede wrong facts so mistakes don't
  recur; the Hebbian loop promotes what proved useful.
- **It learns by working.** No separate training step, no human curation in the
  hot path. Using the agent *is* how it improves.

Net: **on a fixed workload the same agent gets cheaper *and* better over time.**
That is the asset — and it's why a cheap model suffices.

---

## Anatomy (components of the reference implementation)

| Component | Role | Reference file |
|---|---|---|
| **Proactive recall** | recall at session start → injected into system prompt (not a tool call) | `orchestration/agent-loop.ts` (step 2) |
| **Context primer** | progressive-disclosure topic files + relevant past findings as "Pre-loaded Context" | `memory/context-primer.ts` |
| **Cost-tiering router** | per-iteration `fetch` vs `reason` model selection; intent classification | `adapters/model-router.ts` |
| **In-process AWM (EmbeddedAWM)** | AWM engines (Activation, Connection, Consolidation, Scheduler, Retraction) run in-process on a local SQLite DB — no HTTP hop; direct `validationGate.resolveFeedback` + `ConnectionEngine.enqueue` + class-bonus rerank | `memory/embedded-awm.ts` |
| **Automatic learning pipeline** | post-turn feedback, schema capture (supersede-on-correction), query-pattern capture, reflection | `orchestration/agent-loop.ts` (steps 6b, 8, 8b, 9) |
| **Verify gates** | read-back on writes, response substance validation, double-completion | `orchestration/agent-loop.ts` (`validateResult`) |
| **Compaction → AWM** | long-context summaries flow back through the substrate | `orchestration/compaction.ts` |

> **Two integration depths.** EmbeddedAWM (in-process engines) is the deepest:
> it can call `resolveFeedback`/`enqueue`/class-bonus directly. The HTTP/MCP
> client is a shallower option (recall/write/feedback over the wire) for agents
> that can't embed. **The automatic learning loop requires at least the
> recall→feedback wiring to be owned by the harness — it cannot be left to the
> model to invoke.** This is precisely why a generic MCP-tool host (where AWM is
> a tool the model *chooses* to call) cannot reproduce the pattern: the priming
> and feedback steps stop being automatic.

---

## Tooling: graduated freedom behind a hard perimeter

The agent should have **more freedom to act** — but freedom is earned by
containment, not granted blindly. Two layers:

### Layer 0 — the network perimeter (what earns the freedom)

The reference deployment is **network-isolated**: reachable only over a private
VPN / Tailscale, **no public ingress**, web UI reached via Tailscale from
anywhere. There is no inbound attack surface and no path for an external party
to reach or exfiltrate the agent. **Because the perimeter is tight, the agent
can safely be granted more internal action freedom** than an internet-exposed
agent ever should. The perimeter is the precondition for the permissions below.

> Corollary: do **not** add external messaging gateways (Slack/Telegram/email
> inbound, public webhooks) to an agent whose safety model depends on network
> isolation. That would punch a hole in Layer 0. Keep the control surface on the
> VPN; use the Tailscale web UI.

### Layer 1 — tool capability tiers

Classify **every** tool into a tier; the tier sets the guard, not the tool's
convenience:

| Tier | Examples | Guard |
|---|---|---|
| **READ** (safe) | db query, file read, web fetch, recall | Auto. No gate. Run concurrently. |
| **REVERSIBLE-WRITE** | scoped DB update, file write | Auto **but** mandatory **read-back verify** + audit. |
| **EGRESS** (leaves the system) | **email send**, outbound HTTP POST | Auto **but** behind an **EgressGuard**: recipient/host **allowlist** + **rate limit** + full **audit to AWM** + kill-switch env var. |
| **IRREVERSIBLE / DESTRUCTIVE** | unscoped DB write, `run_script` with side effects, deletes | **Snapshot/transaction first** (make it reversible) **or** explicit confirm token / dry-run-then-apply. |

### Better protection ideas (so more freedom stays safe)

These are the guards that let you *widen* autonomy without widening risk:

1. **Egress allowlist + rate limit + audit (the email case).** Let the agent
   email **directly** (drop the DB-mediated round-trip) — but wrap the send tool
   in an `EgressGuard`: an allowlist of recipient domains/addresses, a per-hour
   and per-day cap, a pinned `From`, and an **audit memory written to AWM for
   every send** (so there's a reviewable trail). Direct egress = more freedom;
   the guard = the safety that replaces the DB gate. A single
   `EMAIL_EGRESS_DISABLED=1` kill-switch beats redeploying when something
   misfires (cf. the runaway-email-loop incident — the fix there was exactly a
   gate + suppression + cap).
2. **Reversibility-first.** Prefer reversible actions; for irreversible ones,
   snapshot/transaction *before* acting so a bad call is `undo`-able, not a
   post-mortem. Read-back verify every write (the reference agent already does
   this for DB writes).
3. **Per-tool budgets & loop guardrails.** Cap calls-per-tool-per-run and writes
   per run; trip a circuit breaker on repeated identical failures or
   no-progress loops. (Stops a stuck agent from amplifying a mistake.)
4. **Audit trail as operational memory.** Every EGRESS and IRREVERSIBLE action
   writes an audit record to AWM (action, args digest, result, timestamp). The
   substrate doubles as the action log — queryable, and it feeds future recall
   ("last time we emailed this member, here's what happened").
5. **Dry-run mode on dangerous tools.** `run_script`/bulk writes support a
   `dryRun` that returns the plan without executing; the agent (or a human)
   confirms before the real run.
6. **Capability scoping at the tool, not the prompt.** Enforce allowlists,
   caps, and confirms **in the tool implementation**, not via instructions in
   the system prompt. Prompt-level rules are advisory; a model can ignore them.
   Tool-level guards are mechanical and can't be argued past.

> Design intent: the perimeter (Layer 0) makes the blast radius small; the tiers
> + guards (Layer 1) make each action *individually* safe and auditable.
> Together they let the agent act more autonomously than a typical assistant
> while staying inside hard, mechanical limits.

---

## When NOT to use this pattern

- **Stateless / one-shot tasks** with no recurring domain — there's no substrate
  to accumulate, so the loop is overhead.
- **You only have a generic MCP-tool host** (e.g. a vendor agent CLI where memory
  is a tool the model calls). You can get *recall-as-a-tool* there, but **not**
  the automatic prime+feedback+learn loop — that requires the harness to own the
  recall and feedback steps. Don't expect the flywheel from tool-calling alone.
- **Premature generalization.** Don't extract this into a shared framework on
  spec. Build it once (done — USEA), then generalize **only when a second
  concrete consumer pulls on it**, and clean the heuristic debt before lifting it
  (so you generalize the pattern, not the warts).

---

## Reuse checklist (for the next AWM-native agent)

1. **Embed AWM** (in-process `EmbeddedAWM` if possible; HTTP/MCP client if not).
   Own the recall and feedback wiring in the harness — never leave it to the model.
2. **Prime before the model runs** — recall + domain topic files into the system
   prompt; use compact granularity to keep token cost low.
3. **Cost-tier the loop** — cheap model for lookups, escalate only when needed.
4. **Wire the post-turn learning pipeline** — feedback on used memories, capture
   verified facts canonically with supersede-on-correction, capture working
   patterns, reflect on gaps.
5. **Add verify gates** — read-back on writes, substance validation.
6. **Set the perimeter, then tier the tools** — network-isolate; classify every
   tool; put allowlists/caps/audit/kill-switches in the tool code.
7. **Plug in the domain** — domain tools + topic/context files are the only
   project-specific parts. Everything above is the reusable harness.

---

*Reference implementation: USEA "Gallop Support" agent (`AIAgentBuild/harness/`),
running gpt-5.4-mini + EmbeddedAWM, network-isolated on Tailscale.*
