# Plan — close the correctable gaps, then give memories directive force

Two plans and one evaluation. **Plan A** fixes what is already known to be broken and does not
need a measurement slot to justify. **Plan B** is the procedural-memory / drift-protection idea
Robert raised on 2026-10-12. **Part 3** runs both through `first-class-delivery` and returns a
verdict per item rather than per plan, because the two plans do not share a risk profile.

**Provenance.** Numbers re-derived this session against the live store are *verified* and name
their query. Numbers carried from `eval-gap-2026-10-11.md`, `landscape-2026-10-10.md` or
`decision-gap-closure-2026-10-10.md` keep those documents' own labels and are cited, not restated
as new. Design claims about code are *observed* with a file:line. Everything about what a change
would *achieve* is *assumed* until an arm measures it, and is labeled.

**What this document does not do.** It does not reopen fade as a design, does not propose an LLM
anywhere, and does not re-litigate the hosted fork — all three were decided on 2026-10-12
(`d6d85d73`) and on 2026-07-30 (`4b6401e6`).

> **STATUS, 2026-10-12 (later the same day).** Robert approved the 365-day floor and the whole of
> Tier 0. All of it is built: **A-9 forward guard, A-1, A-3, A-4, A-5, A-6, A-7, A-8.** 839 tests
> passing, up from 810. One item changed verdict under measurement — **A-6's planned fix was
> rejected and replaced** (see its row). The A-9 backfill remains gated, and **Part 5 below answers
> the question Robert asked in its place**, which turned out to matter more than the backfill. The
> P-0 harness exists and has run; see Part 5.

---

## Part 1 — Plan A: the correctable gaps

Twelve gaps were examined and **one was withdrawn under checking**, leaving eleven: seven found
this session and appearing in no prior document, four carried from `eval-gap-2026-10-11.md` §8 with
its ranking intact. They separate by whether they need a measurement first, which is the only
sequencing question that matters.

**Four things moved during this document's own review, all recorded in place rather than quietly
deleted:** A-2 was a false bug and is withdrawn; A-6's headline statistic was survivorship bias and
is narrowed; **A-9's "one line in the archive loop" was wrong** and is replaced by a design decision
with a measured pool-size cost; and **P-0 gained a third arm** without which a positive result would
not have been interpretable. Three of the four made the plan *smaller or more cautious*, and the
fourth made the measurement that governs Plan B able to answer its own question. That is the method
this project claims, applied to a plan instead of to code.

### Tier 0 — correctness, no measurement needed, no slot contention

These are why this plan exists separately from the eval-gap doc's §10, which blocked *everything* on
Robert's sequencing call. None of these competes with M1 for a measurement slot, because none of
them is a measurement.

| # | Gap | Evidence | Fix |
|---|---|---|---|
| **A-1** | `CLAUDE.md` states canonical does not protect against fade. It does. | `FADE_PROTECTED_CLASSES = new Set(['canonical','structural'])` at `src/engine/consolidation.ts:114`, applied at `:550`. *Observed.* | **A proposed edit for Robert to apply, not an edit to make for him** — that file is hand-written and global. The accurate paragraph: canonical changes write-time gating (0.7 floor, never stages, `salience.ts:319`) **and** fade exemption, but **not** archiving (see A-9), so the argument against over-pinning is canonical-layer pollution, not fade. |
| ~~**A-2**~~ | ~~`discardRegret` has no agent filter~~ — **WITHDRAWN, false bug.** | `src/engine/eval.ts:40` fetches `await this.store.getEngramsByAgent(agentId, 'active')`, so the metric at `:95` was always agent-scoped. The absence of a filter in the `:95` expression was read as the absence of scoping anywhere, without checking where `activeEngrams` came from. The 23.9% figure came from **this session's own whole-store SQL**, which is a fact about that query, not about `eval.ts`. *Verified.* | None. The claim is retracted here, in `03837a6d` and in `d6d85d73`. |
| **A-3** | Every launcher defaults `AWM_DB_PATH` to the **live** store, and nothing refuses a write arriving from a test or bench context. | `scripts/build-plugin.mjs:77`, `build-mcpb.mjs:129` and `evict-stale.cjs:18` all default to `~/.awm/memory.db`; `bench-current.mjs:390` only *suggests* a scratch path in a log line. 4,745 fixture engrams across 51 unpinned UUID spaces were purged on 2026-10-11 (`03837a6d`). **But the newest fixture is dated 2026-06-17 — roughly four months with no recurrence — and `tests/realstore-eval/` reads `snapshot/store-backfilled.db`, not the live store.** So the current eval path is not the writer. *Verified.* | Keep as a guard, at lowered priority: abort when a test/bench context resolves `AWM_DB_PATH` to the configured live store. The hazard is the default, not a live offender. |
| **A-4** | No stage-transition timestamp, so lifecycle quality is not computable after the fact. | `eval-gap` §3.4 and §8.2. Six `updateStage` call sites: `consolidation.ts` 571, 625, 648, 652, 719, 795. | One additive column, one write per call site. **Cheapest item in either plan, and it gates the most valuable target (T4).** |
| **A-5** | A faded engram ranks first and answers nothing, and nothing in the payload says the body is partial. | `eval-gap` §8.1. Fade retains **7.1%** of answer-bearing identifiers while leaving findability intact — 37 of 38 faded engrams still surface by cue. | Add a `[faded]` marker to the recall payload. Converts a silent failure into a visible one, and is correct whatever is later decided about truncation's shape. |
| **A-6 — FIX REJECTED, REPLACED** | The planned fix was to widen `detectVerifiedFinding`'s operational-verb list. **Tested on the 496 real discards and rejected:** of 177 that failed only the verb gate while already carrying 2+ identifiers, every candidate token scored at or below the 38.1% base rate of later recall — `Verified` 33:97, `Run` 16:48, `Fixed` 11:27, `Sent` 10:13. The verb carries no signal, and fitting a list to that sample would have been fitting noise in the write path. What *does* discriminate is **caller-declared intent: `intent=decision` was recalled later at 77.3% (n=22) against the 38.1% base, +41pp** — and `intent` was assembled into a tag and read by nothing, while the redundant `decision_made` boolean was the only wired path. **Shipped:** the mapping now lives in `write-pipeline.ts` so both write surfaces inherit it. *Verified.* Original claim and evidence retained below. |
| ~~**A-6 (original)**~~ | The novelty channel sends recurring operational records to `discard`, at 0.25, when recurrence is evidence of importance. **Narrowed from an earlier, wrong version of this claim.** | The earlier figure — discards accessed at 72.2% against 56.4% for keeps — was **survivorship bias**: it was measured only over the 171 discards still `active`, which are exactly the ones reinforcement rescued. Across **all stages**, `work`+`personal`: kept **34.1%** (5,356/15,688), discarded **37.8%** (190/502). So the filter is not inverted; it shows **no measurable discrimination on access**, which is a weaker claim and the honest one. What survives is the class: a sprint-status record entered at 0.25 and now carries **870 accesses**, alongside a release note and a recurring support-sweep record. *Verified.* | Not the reinforce path — a write that matches an existing engram reinforces and never produces a discard, so these were discards in the `createNewEngram` fallthrough band. The right question is why `verifiedFindingFloor` (`salience.ts:208/221/334`, a 0.45 floor for action-verb-plus-two-identifiers records) does not already cover a dated, ticket-numbered support-sweep record. **Write-path change ⇒ it gets the revert-to-prove test, not a bare PASS.** |
| **A-9** | **Canonical is fade-protected but NOT archive-protected.** | `FADE_PROTECTED_CLASSES` is consulted in the fade loop (`consolidation.ts:550`) and **nowhere in the Phase 6 archive loop** (`:625`, `:648`, `:652` call `updateStage(id,'archived')` with no class check). *Observed.* Live consequence, `work`+`personal`: **4,360 canonical engrams archived against 2,058 active.** *Verified.* | **A design decision with a pool-size cost, not a one-line guard** — see **A-9 in detail** below, which corrects the first version of this item. A-1's doc fix still depends on it. |
| **A-7** | Nine real engrams are stranded in UUID fallback agent spaces, invisible to `work`/`personal` recall. | `c78411b6` (3), `5cd58e41` (2), `83f89f14` (2), `67080394` (1), `ddc81f6d` (1) — a task-context note and a build-health baseline from another project. *Verified.* | Re-point the nine to `work`. Data migration, not a feature. The identity-pinning defect itself is R17 and already shipped `memory_whoami`. |
| **A-8** | 571 orphaned `retrieval_feedback` rows and 3 orphaned `entity_mentions` point at engram ids that no longer exist. | Same counts in the pre-purge backup, so they predate this session's delete. *Verified.* | Clean them, and add the dependent-table delete to whatever path produced them. Inert today; they corrupt any join that assumes referential integrity. |

#### A-9 in detail — why it is not one line

The first version of this item said "one line in the archive loop, the same shape as `7c25282`."
Reading the three call sites and querying the live store refuted that. All numbers here are
`work`+`personal`, `retracted=0`, re-derived 2026-10-12. *Verified.*

**1. All three archive branches fire on disuse, and two of them ignore every strength signal.**
`consolidation.ts:625` is `accessCount === 0 && cycleCount >= FORGET_CYCLE_THRESHOLD`; `:648` is
`accessCount === 0 && ageDays > FORGET_ARCHIVE_DAYS`; only `:652` consults
`effectiveArchiveDays`, the access-and-confidence-scaled clock. **2,891 of the 4,360 archived
canonical engrams (66%) have `accessCount = 0`**, so they were taken by the two branches that no
strength factor touches. Adding a class term to `effectiveArchiveDays` — the change that would fit
the existing model — would therefore have saved **none of that 66%**.

**2. A blanket class exemption contradicts the module's stated invariant and costs pool size.**
The archive block's own comment is "Rehearsal … extends protection but **NEVER** makes immortal,"
with a hard 12× cap at 360 days. `if (FADE_PROTECTED_CLASSES.has(class)) continue;` makes canonical
permanent. It also restores 3,928 engrams into a **5,314-engram active pool — a 74% increase** —
which runs straight into T6, the target that forbids trading more than 1 pp of T1 for latency.
`eval-gap` §3.2's own caveat applies in reverse here: the archived sample it measured at 4-in-25
pool entry had mean `accessCount` 0.3, so part of "archived is unreachable" is the lifecycle working
correctly, and a blanket restore would re-admit exactly those.

**3. 432 of the archived canonical engrams are superseded.** A restore that does not exclude them
re-admits 432 stale source-of-truth memories — which is Plan B's debate item 2 built in by the fix
meant to enable it. Any guard is **class AND not superseded**; any backfill excludes those 432.

**So A-9 splits into two decisions.** (a) *Forward guard:* which criterion replaces `accessCount`
for a fade-protected class — this is the real question, because a canonical memory's normal state
before it is needed is zero accesses. (b) *Backfill:* whether to restore the 3,928, which is a
pool-size change that owes a latency measurement. (a) is cheap and should proceed; (b) should not be
done blind.

**What this means for Plan B, and it is the sharpest finding in this document.** A rule that has not
come up yet has `accessCount = 0` *by construction*. That is precisely the population the two
unguarded branches archive. It is already visible in the store: of **1,758 archived `procedural`
engrams, 1,160 are zero-access**, against 922 procedural active. **65% of the memory type Plan B is
built on is already in the stage it cannot be recalled from** — not as a prediction, as a count.

### Tier 1 — the one measurement set that unlocks the claim Robert actually wants

`eval-gap` §7 specifies five arms and §6 six targets. **None of the arms exists**: the runner reads
only `REALSTORE_SNAPSHOT`, `FIXTURE`, `K`, `GRANULARITY`, `TRACE`, `LIMIT`, `OFFSET`, `NO_SHUFFLE`
and `NOW`, and calls `activate()` directly, with no channel-ablation switch anywhere. *Verified
there by grep.* They are unwritten, not blocked.

Build them in that document's order, which this plan does not change:

1. **A0 — BM25-only.** Supplies T1's denominator. §7 states nothing else on the list means anything
   without it, so it precedes M1 as well (see Part 4).
2. **A4 — lifecycle suppression off, matched sample.** The only way to resolve §3.2's confound, and
   it supplies T5. **Needs A-4 above first**, or T4 stays uncomputable.
3. **The 25 KB curated-index arm.** Not an ablation. Claude Code auto memory loads the first 200
   lines or 25 KB of `MEMORY.md` and drops the rest; that is the arm a user actually chooses
   between, and the comparison AWM can win on store size rather than on ranking.

Operational constraint from §7, which is also a correctness fix: precompute the candidate pool once
and replay it across arms. Running the pipeline five times is both the OOM risk
(`BENCH_MIN_HEADROOM_GB`, five runs already killed on this machine) and the only source of
between-arm variance — the exact failure that parked the Gauntlet. Assert identical pool membership
between arms before comparing any score.

### Tier 2 — gated, do not start

- **Span-preserving truncation** (§8.1). The lever is that a prefix is the wrong thing to keep: 79.0%
  of identifiers sit beyond char 400, and 75% retention needs `KEEP ≈ 1,500` against a 2,077-char
  median body — i.e. by not fading. This is **new code, not reuse**: `entity_mentions` holds ~12,550
  entities across ~3,920 engrams with **no offsets**. Scope the extractor before costing it.
- **Widen first-stage candidate generation** (§8.3). The binding constraint is BM25's inner top-50
  across the whole index, not a stage predicate. **Measure A4 before building this or the
  vector-channel tier.**
- **Drop the graph from the scoring path, keep the edges** (§8, demoted). 0% change to top-3 sets
  today, costs a traversal per recall. Safe simplification; no measurement owed, no urgency.
- **Temporal channel** (§3.5). Every cue phrasing scores *below* the no-cue baseline. A measurement
  question, not a build.

---

## Part 2 — Plan B: procedural memory with directive force

### The idea, in Robert's terms

As a session's context grows, directives stated once at the top lose force. Today the harness
decides when a rule is relevant, from the user's prompt, and you hope it gets it right. Plan B binds
governing rules to the *memories they govern*, so recalling the fact brings the rule with it —
recalling how to ride a bike should also bring traffic rules, hand positions, and what stop-and-go
means. He frames the value as **drift protection for long-running agents**, and that framing is what
makes it a product claim rather than a feature.

### Why it is worth building, with receipts

- **Published evidence that this is the highest-leverage memory type.** Memp (ACL 2026 Findings,
  arXiv 2508.06433) took ALFWorld from 39% to 87% with procedural memory, and found procedural
  memory *transfers from strong to weak models*. `cf271814` already lists procedural-memory
  distillation as one of AWM's biggest gaps. *Observed, via that review.*
- **The mechanism is already proven in this codebase.** The entity bridge (`8372e8ba`): recall,
  extract salient entities from the top-6 results, issue separate single-hop recalls, merge into the
  primed set. Measured sparse-cue 67→100%, multi-hop 0→67%, headline 70→81%, for +20% steps. Plan B
  is that shape with `governs=` in place of entities. *Verified there.*
- **Durability is NOT free, and this is the claim that moved twice.** First draft: free. Second:
  nearly free, one guard. Checked: **a real dependency with a pool-size cost.** Guidance stored
  `canonical` is fade-exempt by construction (`consolidation.ts:114`), so its body survives — but it
  is not archive-exempt, and the archive trigger is **zero accesses**, which is a not-yet-needed
  rule's normal state. Live count: **1,160 of 1,758 archived `procedural` engrams are zero-access**,
  against 922 procedural active. P-1 depends on **A-9**, and A-9 is a design decision — see
  **A-9 in detail**, which supersedes the "one line" framing. *Verified.*
- **Half the vocabulary exists.** The D14 recipe path emits `topic=skill` and `skill=<slug>` and
  forces `memory_class: canonical` (`src/mcp.ts`), and MWA's `saveSkill`/`listSkills` (`69417e54`)
  already stores skills as canonical engrams with concept `skill: <name>`.
- **It is not already scheduled.** S4 in `decision-gap-closure` is encryption at rest, not this. It
  is also absent from `landscape-2026-10-10.md`'s scan of the field — which is *not* evidence that
  nobody has built it. Letta's always-in-context memory blocks are adjacent and were not checked.
  *Assumed.*

### The design

**P-1. Guidance is an engram, not a new store.** `memory_class: canonical`, `memory_type:
procedural`, concept prefixed `rule:` (reusing the existing `skill:` convention). No schema change,
fade-exempt already, recallable through every existing channel.

**P-2. Binding runs both ways.** A content engram may carry `governs=<slug>`; a guidance engram
carries `applies-to=<topic>`. The reverse direction is what makes this tractable — without it every
content memory would have to be tagged by hand, which will not happen.

**P-3. Lookup is a separate keyed query, never a pool injection.** This is the load-bearing design
decision, and it is settled by evidence rather than preference. The AWM-*core* entity-aware fetch
failed precisely because injecting into the candidate pool lets the original query's scoring bury
the injected items; the harness-side *separate* high-precision recall succeeded (`8372e8ba`). So
after the primary recall returns, collect `governs=`/`applies-to=` keys from the top-k, issue one
batched lookup, and return the results as a **distinct payload section** — never merged into the
ranked list, never competing for rank.

**P-4. It can therefore live in AWM.** The failure mode that forced the entity bridge harness-side
was ranking contamination. A separate output section has no ranking to contaminate, so Robert's
"build it into AWM" is compatible with the evidence. Injection rides the existing recall-time
surfaces: the `UserPromptSubmit` prime hook and `memory_restore`.

**P-5. Hard sub-budget.** `max_tokens` already packs recall output by value-per-token. Guidance gets
its own ceiling inside it, so a rule block can never crowd out the facts that were asked for.

**P-6. No LLM.** Tag lookup plus formatting. Honors `src/adapters/common.ts:639`.

### P-0 — the measurement that must come first

The premise — that directives decay with context length — is currently a claim, including in this
document. Before any of P-1…P-6:

> Plant a directive. Grow context. Measure compliance at turn N.

**Three arms, not two. The middle one is what makes the result mean anything.**

| Arm | What it does | What it tests |
|---|---|---|
| **0 — stated once** | Directive in the system prompt at turn 0, never repeated | Does compliance actually decay? The premise itself |
| **1 — periodic restatement** | *All* directives re-injected every N turns, no binding, no tags | **Is repetition sufficient?** |
| **2 — bound guidance** | Only the rules bound to what was recalled, via P-1…P-6 | Is *selection* worth anything over repetition? |

Arm 1 is the control the first draft of this plan was missing, and omitting it would have been the
expensive mistake. Without it, a positive result cannot distinguish "rules bound to memories help"
from "rules repeated help" — and arm 1 is a loop in the prime hook, a fraction of Plan B's cost. **If
arm 1 ≈ arm 2, build arm 1 and stop.** Plan B is only justified by the gap between them, which is
where its real claim lives anyway: selection beats repetition once the rulebook is larger than the
budget, because repeating everything is what runs out of room.

*Two things that will corrupt this measurement if unhandled.* Claude Code **re-injects `CLAUDE.md`
on compaction** — it happened in this session — so arm 0 is not "stated once" across a compaction
boundary and the decay curve resets. Either run inside a single context window or log every
compaction point and treat each as a censoring event. And state the cost up front: arms × turns ×
trials of API tokens. It is eval spend, not runtime, but it is real and it is the reason to scope
turn count before building the harness.

This is still the arm that decides whether the feature is worth anything, **and it is the benchmark
AWM could own**: `landscape-2026-10-10.md` recommends benchmarking on the axis AWM is built to win,
no published suite measures directive adherence over a long run, and MemoryAgentBench has every
system at ≤28% on multi-hop conflict resolution. It is the one axis where the field is empty and
Robert's own experience is the evidence.

---

## Part 3 — `first-class-delivery` evaluation

### Triage gate — classified before planning any build

| Item | Class | Grounding |
|---|---|---|
| A-1 | **BUG** (docs) | Code contradicts the instruction file. `consolidation.ts:114`. |
| A-2 | **WITHDRAWN — not a bug** | `eval.ts:40` scopes by agent. The triage gate caught this, which is what it is for. |
| A-3 | **BUG**, lowered priority | The default path is the live store, but no recurrence in ~4 months and the current eval path reads a snapshot. A guard, not a fire. |
| A-4 | **BUG** (missing instrumentation) | T4 is specified and uncomputable. §3.4. |
| A-5 | **BUG** | Silent wrong answer. 7.1% retention with findability intact is the worst possible shape. |
| A-6 | **BUG**, narrowed | Not inverted — 37.8% against 34.1% across all stages is no discrimination, not reversal. The 870-access engram that entered at 0.25 is still a real defect. |
| A-9 | **BUG** | Measured: 4,358 canonical archived against 2,042 active, no class check in the archive loop. |
| A-7 | **EXISTING SCOPE** | Identity pinning is R17 and already shipped `memory_whoami`; these nine rows are leftover data, not a new feature. |
| A-8 | **BUG**, low priority | Referential integrity, inert today. |
| Tier 1 arms | **EXISTING SCOPE** — specified, unwritten | §7 specifies all five. Writing them is not new scope; it is the scope that was deferred. |
| Tier 2 | **NEW SCOPE — tabled** | Span truncation needs an offsets extractor that does not exist. Tabled per the skill, not started. |
| Plan B | **NEW SCOPE** | Correctly tabled for a spec. This document is that spec. |

### Decision Process — the two forks that actually change the shape

**Fork 1 — where guidance lookup lives: AWM core, or harness-side like the entity bridge?**

- *Option A, harness-side.* Cited precedent: the entity bridge shipped in MWA `src/agent.ts` and
  worked, +11pp headline. Cited counter-evidence: it only lives there because the AWM-core version
  failed, and the stated reason was pool-injection ranking contamination.
- *Option B, AWM core as a separate payload section.* The failure mode does not apply — there is no
  shared ranking to contaminate. And the requirement is explicitly "build into AWM," so every
  consumer (Claude Code, Codex, any MCP client) gets it rather than one harness.
- **Challenge run** via `advisor` rather than `/ask-coworker`, which is not available in this
  session. Points taken: guidance must be fade-exempt (resolved — it already is), a wrongly bound
  rule is worse than none, and the premise needs measuring before the build. Point rejected: that
  absence from the landscape scan licenses "nobody owns this" — restated as *assumed*, with Letta
  named as unchecked.
- **Decision: Option B.** AWM core, separate payload section, never merged into the ranked list.
- *Risk with no mitigation yet:* two directive sources — `CLAUDE.md` and bound guidance — can
  disagree, and the agent will arbitrate inconsistently. Partial mitigation is a stated precedence
  line in the payload; the real fix is out of scope here.

**Fork 2 — A0 or M1 first?**

- *Option A, M1 first* (its position in `decision-gap-closure`): it closes a transfer-risk hole in a
  prior rejection, and it is cheap.
- *Option B, A0 first*: §7 ranks A0 first of five and states nothing else on the list means anything
  without it. M1 measures whether a channel change helps; A0 establishes whether the channels pay
  for themselves at all. A +2pp embedding result against an unknown baseline is not interpretable.
- **Decision: A0 first, then M1.** This re-orders a published plan, so it is Robert's call to
  confirm — but the argument is the earlier document's own ranking, not a new preference.

### Five-perspective production-failure debate — Plan B

Each perspective names a trigger, a failure and an impact. Abstract worries were not counted.

1. **Requirements.** *Trigger:* a `governs=` binding on a broad topic such as `auth`. *Failure:*
   every auth recall drags in the whole auth rulebook. *Impact:* the payload doubles and the agent's
   context fills with rules it did not need — reproducing the dilution the feature exists to fix,
   now inside AWM. **Mitigated** by P-5's sub-budget plus a binding-specificity rule, and the
   landscape doc's standing warning: never add breadth in the final cut.
2. **Architecture.** *Trigger:* a rule changes and the old guidance engram is not retracted.
   *Failure:* it is canonical and therefore fade-exempt, so it is injected forever at full strength.
   *Impact:* **the agent now reliably follows a stale directive, which is worse than drift because
   it is confident.** The feature makes wrong rules as durable as right ones.

   *This is not hypothetical, and the vocabulary for the fix already exists.* `valid_to` is a
   `memory_write` parameter (`src/mcp.ts:284` → `validTo` at `:347`), it is returned on recall
   (`:1392`) and rendered as `[valid until …]` in two places (`core/format-recall.ts:22`,
   `hooks/prime.ts:89`), and **373 live engrams carry it**. `memory_type: 'procedural'` likewise
   already exists both as a write enum and as a recall *filter* (`mcp.ts:263`, `:418`, `:447`). So
   P-1's vocabulary is entirely existing fields. *Verified.*

   **But validity is deliberately a label, not a gate — and that was decided.** `6b6fb64b` records
   D8 (shipped 2026-07-30) choosing exactly this: `[valid until X]` plus `⚠ SUPERSEDED by <id> —
   treat as historical` **appended at MCP formatting instead of a silent down-rank**, with the
   Phase 8c supersession penalty left unchanged. Grepped confirmation: no backend filters on
   `valid_to` anywhere — `storage/sqlite.ts` touches it only at the migration (`:372`), the insert
   (`:441`) and the row mapping (`:1489`). Consequence today, live: **43 active engrams are past
   their own `valid_to` and still fully recallable**, including one at 402 accesses that expired
   2026-09-13. *Verified.*

   **For facts that decision is right. For directives it does not transfer** — "the agent will read
   the label and discount it" is the exact mechanism this feature exists to stop relying on.
   **P-8 — the guidance lookup filters strictly where ordinary recall labels.** Because P-3 is
   already a *separate keyed query*, the strict predicate (`valid_to` in the future or null, AND
   `superseded_by IS NULL`) lives there and nowhere near the ranked path, so D8 is not reopened for
   facts. `findActiveMatchByConcept` (`storage/sqlite.ts:1099-1110`) is the existing precedent for
   that predicate shape. Plus the rule's age in the payload. **Mitigated by design, unbuilt** — and
   a build prerequisite, not a nice-to-have.
3. **User.** *Trigger:* `CLAUDE.md` says one thing, a bound guidance engram says another. *Failure:*
   inconsistent arbitration between two directive sources. *Impact:* the agent appears to ignore
   instructions at random, the hardest class of bug to report. Compounded by Robert's `CLAUDE.md`
   AWM section being hand-written, so `awm setup` must not rewrite it. **Partially mitigated** by a
   precedence line.
4. **QA.** *Trigger:* a recall whose top-3 results each carry a different `governs=`. *Failure:*
   three extra lookups per recall. *Impact:* p50 recall latency, currently 474–500 ms, grows; the
   entity bridge's analogous cost was +20% steps. **Mitigated** by dedupe and a single batched query
   with a cap — but it must be measured against T6, which forbids trading more than 1 pp of T1 for
   latency.
5. **Product.** *Trigger:* a poisoned, or merely wrong, engram is tagged as guidance. *Failure:* it
   is injected as a **rule**, not as a fact. *Impact:* this converts memory poisoning into prompt
   injection with elevated authority. MINJA (arXiv 2503.03704) reports >95% memory-injection success
   query-only, and `cf271814` already records that **AWM has no write-trust layer**.

   *Two mitigations that do not work.* Gating on `origin_class` fails because it is a
   caller-supplied optional parameter on `memory_write` — a poisoned tool output relayed by the
   agent can simply claim `user-stated`. And **the existing bearer token does not reach this**:
   `AWM_HOOK_SECRET` guards the sidecar's HTTP surface (`src/hooks/sidecar.ts:205-206`) and
   `AWM_API_KEY` the main server (`src/index.ts:134`), while `memory_write` over **MCP stdio has no
   auth layer at all** — it is a child process on pipes, and trust comes from the host having
   spawned it. Even on the HTTP path a token authenticates the *caller*, and the authenticated
   caller is the agent, which is precisely the component being manipulated. Authentication answers
   "who wrote this," not "should this carry authority." *Observed.*

   **P-7 — the mitigation that does work, and it is small.** Rules require a second secret that the
   agent does not hold: a `AWM_RULE_SECRET` (or an `awm rule add` CLI path) deliberately **absent
   from the `env` block of the MCP server in `.mcp.json`**, where `AWM_HOOK_SECRET` currently does
   live. A poisoned agent then cannot mint a rule at all, because it cannot present the credential
   — the security property comes from the secret being withheld, not from the check existing. It
   reuses the bearer pattern already in `src/index.ts:134` and the `OWNED_ENV_KEYS` convention at
   `common.ts:86`.

   **Why this is proportionate rather than annoying:** rules are rare and long-lived, facts are
   frequent and disposable. Human-in-the-loop on rule creation costs a handful of confirmations
   ever, while ordinary writes keep flowing with no change. With P-7 specified, debate item 5 moves
   from *unmitigated* to *mitigated-by-design, unbuilt*.

### Verdicts

| Scope | Verdict | Why |
|---|---|---|
| **Tier 0 (A-1, A-3 … A-8)** | **PASS to build**, with two conditions | Each item is a measured defect with a named fix and no measurement dependency. **A-6 is a write-path change and must be proven by reverting the fix and watching the suite go red**, the method that caught both halves of `2607e3c`. A-1 is Robert's file to edit. A-2 is withdrawn. |
| **A-9** | **PASS on the forward guard; BLOCK on the backfill** | Split out of Tier 0 after checking. The forward guard is a criterion decision and proceeds. Restoring the 3,928 already-archived canonical engrams grows the active pool 74% and owes a T6 latency measurement first, and must exclude the 432 superseded. See **A-9 in detail**. |
| **Tier 1 arms** | **PASS to build; Robert confirms the A0-before-M1 re-order** | Specified in §7; the only open question is slot order, which Fork 2 answers using that document's own ranking. |
| **Tier 2** | **BLOCK** | Span truncation needs an extractor that does not exist; pool widening needs A4 first. Tabled, not started. |
| **Plan B** | **REVISE before build — and P-0 may retire it** | The design is sound, the mechanism is proven, and both debate items that were open are now mitigated by design: **P-7** (a withheld rule-write credential) and **P-8** (strict validity filtering inside the P-3 lookup, which does not reopen D8 for facts). Every remaining objection is answered on paper. What is *not* answered is whether the premise holds, and **P-0 arm 1 can legitimately kill this feature** — if periodic restatement scores as well as bound guidance, the right build is the loop, not the binding. Prerequisites: **P-0** (three arms), **A-9 forward guard**, **P-7** and **P-8** built rather than specified. |

**Four things here change a previously published plan, and all four are Robert's to confirm:**

1. **A0 before M1** (Fork 2), argued from `eval-gap` §7's own ranking.
2. **A-4 proceeds without waiting for a slot.** §10 says §8.2 competes with M1, and §8.2 *is* A-4.
   The distinction this plan draws: A-4 is one additive column and six one-line writes — an
   instrumentation change with no runtime to contend for. What competes for a measurement slot is
   the **arm** that consumes it (A4, supplying T4/T5), not the column. If that distinction is
   rejected, A-4 goes back behind M1 and T4 stays uncomputable for another cycle.
3. **A narrow slice of write-trust becomes a prerequisite of Plan B** — **P-7**, from debate item 5.
   Guidance must not acquire directive authority before provenance can be trusted, and since
   `origin_class` is caller-set and the bearer token never reaches the stdio write path, that means
   a rule-write credential **withheld from the agent**. It sits beside S1 (write-time redaction),
   which is already scheduled and already carries a "must precede" constraint. P-7 is materially
   smaller than S1 and could land first.
4. **P-0 does not queue behind A0, M1 and A4.** The published slot constraint is a *recall-pipeline
   ablation* constraint — one candidate pool precomputed and replayed across arms, under
   `BENCH_MIN_HEADROOM_GB`, with five runs already OOM-killed on this machine. P-0 shares none of
   that: it is a long-context compliance harness with its own fixture, no pool replay, no ablation
   switch, and its cost is API tokens rather than local memory. Serializing it behind three arms
   buys nothing and risks the usual outcome — the fourth item in a queue never starts. It spends
   real money, which is the honest reason to confirm it rather than assume it.

---

## Part 4 — recommended sequence

Tier 0 is not in contention with anything and should simply proceed. The ordering question is only
about measurement slots and the existing `M1 → S1 → S2 → S3 → S4` queue.

Two tracks that do not contend, because one is bounded by local memory and the other by API spend:

```
TRACK 1 — correctness and the publishable number (local, OOM-bounded)
now        A-9 forward guard                     (criterion decision; zero-access is the trigger)
now        A-4 A-5 A-6 A-7 A-3 A-8               (correctness, no slot contention)
now        A-1                                   (proposed CLAUDE.md edit — Robert applies)
then       A0                                    (T1 denominator — §7 ranks it first of five)
then       M1                                    (interpretable only after A0)
then       A4 + 25 KB arm                        (T5, and the competitive comparison)
gated      A-9 backfill of the 3,928             (needs T6 latency first; excludes the 432 superseded)

TRACK 2 — the drift claim (API spend, no pool replay, runs in parallel)
now        P-0 arms 0 and 1                      (does compliance decay? is restatement enough?)
decision   if arm 1 ≈ arm 2's ceiling, ship the restatement loop and stop
then       P-7 + P-8                             (withheld rule credential; strict validity in the lookup)
then       P-1 … P-6                             (bind guidance — only if the arm-1/arm-2 gap pays)

parked     S1                                    (redaction; P-7 is smaller and does not wait on it)
parked     Tier 2, S2, S3, S4                    (unchanged)
```

**What would retire the misleading headline.** `eval-gap` §6 calls 93.0% success@1 the most
misleading figure AWM publishes — a ranking score with no baseline, measured on a population that
excludes the lifecycle, and 0 of 1,867 probes had a faded or archived gold. A0 plus A-4 plus A4 are
exactly what replaces it with normalized gain over BM25-only (T1) and sufficiency@3 stratified by
stage (T3). That is also the shortest path from "this works well for me" to a number that survives
outside contact.

---

## Part 5 — what the archived memories turned out to be, and the P-0 instrument

Added 2026-10-12, after Tier 0 shipped. Robert declined a blind backfill of the archived canonical
engrams and asked the better question instead: **are any of them relevant to what has actually been
searched?** Answering it found something larger than the backfill.

### The archived memories are not dormant — they are being retrieved right now

Two measurements against the live store, `work`+`personal`, `retracted=0`.

**1. Half of recent queries had a better answer in the archive.** The store records real recall
queries in `activation_events` (19,570 of them). Taking the **600 most recent distinct queries**
(2026-10-09 to 2026-10-12) and scoring every non-superseded engram lexically against each:
**309 of 600 (51.5%)** had an archived canonical engram that outranked every engram recall could
reach, implicating **131 distinct archived engrams**. *Verified.* The strongest single candidate was
wanted by 113 of the 600 queries: `b3c28047` — *"Claude Code SessionStart hook auto-restores AWM at
session open"* — which already carries **91 accesses**.

Caveat, stated because it limits the claim: this is BM25 only, not the full pipeline, and
`eval-gap` §3.2 plus `0b80c261` establish that the lexical channel has **no stage predicate** — so
archived engrams do compete there. What they cannot do is get vector-channel support
(`searchByVector` unions `active`+`fading` only, `sqlite.ts:845-852`), which means they face the
2-of-3 agreement gate with one channel permanently unavailable.

**2. And here is the mechanism, which is not the archive criterion at all. There is no path from
`archived` back to `active`.** Every `updateStage(..., 'active')` in the codebase is either a
staging promotion (`staging.ts:63`, `consolidation.ts:839`) or a reinforcing *write* to a matching
concept (`write-pipeline.ts:334`). **Recall never un-archives anything.** *Observed.*

So an engram that is archived and then proves useful again stays archived permanently, accruing
accesses it will never be credited for:

| | count |
|---|---|
| archived engrams accessed in the **last 7 days** | **1,331** |
| … in the last 30 days | 3,749 |
| … in the last 90 days | 6,766 |
| archived canonical with 30+ accesses | 29 |
| archived canonical with 10–29 accesses | 79 |

Named examples, all archived, all accessed on 2026-10-12: a Freshdesk SOP at **327 accesses**, a
scale-mode **resume pointer** at 305, a project digest decision at 119. A resume pointer is the
exact kind of memory a long-running loop depends on, and it is in the stage that cannot support it.

### What this implies — and what it replaces

**Promote-on-access** is the fix the data points at: when recall returns an archived engram and
`touchEngram` (`sqlite.ts:756`) records the hit, move it back to `active`. It is self-correcting,
needs no backfill decision, and selects on proven usefulness rather than on a guess — the 3,928
non-superseded archived canonical engrams would no longer need a bulk restore, because the ones
that matter would restore themselves.

**It is NOT built, deliberately, and this is the same gate the backfill is behind.** The pool-size
cost is measurable right now and it is not small:

| promotion window | pool `active`+`fading` | change |
|---|---|---|
| accessed in last 7 days | 5,760 → 7,091 | **+23%** |
| last 30 days | 5,760 → 9,509 | +65% |
| last 90 days | 5,760 → 12,526 | +117% |

T6 forbids trading more than 1 pp of T1 for latency, and every recall scores against that pool.
Shipping an unmeasured +23% to +117% change to the active set hours after writing that the backfill
was gated for exactly this reason would be inconsistent. **The window is the tunable** — and it
turns a one-off bulk decision into a parameter, which is the better shape. It belongs immediately
after A0/A4 in Track 1, where the measurement that prices it already lives.

### The P-0 instrument, and two ways it lied before it worked

`tests/directive-drift/runner.ts` — three arms (stated-once / restate-all / oracle-bound), five
mechanically-checked per-turn obligations, one continuous context with no compaction, prompt caching
on the growing prefix, and a printed token bill. Two instrument failures are recorded in the file
itself because both produced confident numbers from nothing:

1. **Every reply was empty and the harness scored it.** With thinking enabled and a 300-token
   budget, the whole allowance went to a thinking block. The suffix rule scored 0%, and *brevity
   scored 100%*, because an empty reply is under 80 words. Fixed by disabling thinking, raising the
   budget, and making an empty reply a hard failure on every rule.
2. **Two rules could not be satisfied at all, so they could not decay.** "Exactly two paragraphs"
   scored 0% from turn 1 — it conflicts with the length cap, and the model obeyed the cap. Then the
   mandated `Next:` line pushed replies past 80 words and brevity fell to 33% from turn 1. A rule
   that is never met measures nothing, so one was replaced and the cap raised to 120.

The general lesson, which applies to the arms as much as to the rules: **a compliance harness must
be shown capable of measuring compliance before its decay curve means anything.** A floor effect
and a real decline look identical in a bucket average.

### P-0 result, run 1 — the premise did not reproduce, and the oracle arm came last

`claude-haiku-5-5`, 40 turns, 2 trials per arm, 240 calls, one continuous context, no compaction.
Final-turn context ≈ 26k tokens (≈650 tokens/turn). *Verified.*

**Compliance by turn bucket, all trials pooled:**

| arm | 1–10 | 11–20 | 21–30 | 31–40 | injection cost |
|---|---|---|---|---|---|
| A0 stated-once | 81% | 84% | **93%** | **93%** | 0 tokens |
| A1 restate-all | 86% | 93% | **98%** | **95%** | ~642 tokens/run |
| A2 bound-guidance (oracle) | 84% | 83% | **81%** | **83%** | ~1,817 tokens/run |

**Three findings, in order of how much they matter.**

**1. There is no decay here at all.** Four of the five obligations — the format suffix, the
confidence label, US spelling and the mandated `Next:` line — scored **100% in every bucket of
every arm**, first to last. Nothing drifted. The entire movement in the pooled row comes from the
one rule with headroom, `brevity`, and it moved **upward**: A0 20%→70%, A1 40%→80%. The model got
*better* at the directive set as the conversation grew, which is the opposite of the premise.

**2. The oracle arm was the worst arm, at three times the token cost of repetition.** A2 is the
*ceiling* for bound guidance — it is told which rule is at risk, so no retrieval system can select
better. It finished at 83% against A1's 95% and A0's 93%, having injected ~1,817 tokens per run
against A1's ~642. Its `brevity` went 30%→25%, the only rule anywhere that got worse. The likely
mechanism is the obvious one: a per-turn reminder about *one* rule spends context and draws
attention to that rule, and the other four were not in trouble to begin with. **On this evidence,
selection does not beat repetition, and repetition barely beats doing nothing.**

**3. The run does not reach the regime the premise is about, and that is the real limitation.**
26k tokens is short. Robert's experience of directives losing force is from sessions an order of
magnitude longer, past compaction. So the honest claim is narrow: **no measurable directive decay
up to ~26k tokens on a small model with five mechanical rules.** It is evidence against building
Plan B *now*, not proof that drift is imaginary.

**What this costs to extend, and why that is the next step rather than a build.** The whole run was
~2.0M cache-read tokens, 58k output, 3.7k uncached input — cents on Haiku. Four of the five rules
sitting at a 100% ceiling is exactly what a decay detector should look like: if the suffix rule
falls at turn 120, that is unambiguous. The parameters worth changing are **turns (150–200), model
(a confirmation run on a larger model), and rule count** — not the arms.

**Verdict update for Plan B: the gate is unmet.** The plan said P-0 arm 1 could retire the feature
if repetition matched bound guidance. It did better than match it. Plan B stays unbuilt, and the
next move on it is a longer P-0, not P-1.

### P-0 run 2 — extended to the long-context regime (2026-10-13)

Robert asked to extend. Run 1's ceiling was the problem, not its arms: **it never reached the
regime the premise is about.** Three instrument changes, then the same three arms.

**1. Each turn is now the size of a real agent turn.** Run 1 grew at a measured **405 tokens/turn**,
so 40 turns reached only ~26k and even 150 turns would have reached ~61k. A real agent turn carries
a file excerpt or a tool result, so `CONTEXT_PAD` now emits a git log, an 18-line source excerpt and
four log lines — **~975 tokens/turn measured**. At 130 turns that is a **peak context of ~127k**,
which is the order of magnitude Robert's drift reports come from, and it gets there with 130 calls
instead of 310.

**2. First-failure turn per rule, per trial.** A bucket average smears the moment a rule breaks,
and four of the five obligations sit at a 100% ceiling — which makes them *good* detectors, but only
if the report says *when* the ceiling cracked. "suffix first failed at turn 118, 9 times total" is
the claim a decay argument actually rests on; "93% in bucket 4" is not.

**3. Task pool widened from 12 to 28.** Twelve questions cycling eleven times would let the model
settle into a rhythm, which would suppress whatever drift exists — a confound that looks exactly
like a negative result.

Also added: a context-size trace per arm, and a graceful stop at `CONTEXT_ABORT_TOKENS` (150k) so a
run ends with partial data rather than an API error.

**One portability bug worth recording, because it would have failed the whole confirmation run.**
`thinking: {type:'disabled'}` is **not portable across models**: `claude-sonnet-5-5` rejects it
("send `thinking: {type:'between_tools'}` instead") and `claude-opus-5-5` rejects it ("use
`thinking.type.adaptive`"). Hardcoding one model's value is a run that dies on call 1 of a
40-minute job. It is now selected per model, overridable with `THINKING_TYPE`.

**Run 2 configuration:** `claude-haiku-5-5` 130 turns × 2 trials × 3 arms, plus a
`claude-sonnet-5-5` confirmation at 130 turns × 1 trial × 3 arms. 1,170 calls. Opus was
deliberately NOT run — at roughly five times Sonnet's rate it is a materially larger spend than
this question has earned so far, and it is the one model Robert's own drift experience actually
comes from, so it is the right thing to price separately rather than to slip in.

### P-0 run 2 result — the premise is retired; the feature is not

Six runs, 1,170 calls, peak context **132k–145k tokens** on every arm. `claude-haiku-5-5`
130 turns × 2 trials; `claude-sonnet-5-5` 130 turns × 1 trial. *Verified.*

**Compliance, first half of the conversation vs second half:**

| arm | haiku 1st→2nd half | sonnet 1st→2nd half | injected per run |
|---|---|---|---|
| A0 stated-once | 81.7% → 84.4% (**+2.7pp**) | 93.6% → 93.8% (+0.2pp) | 0 tokens |
| A1 restate-all | 79.7% → 79.6% (−0.2pp) | 97.6% → 96.8% (−0.8pp) | ~2,087 |
| A2 bound-guidance | 78.7% → 78.9% (+0.2pp) | **100.0% → 100.0%** (0.0pp) | ~5,780 |

**1. There is no drift. On either model, in any arm, at 133k+ tokens.** Every bucket row is flat
across all thirteen buckets. On Sonnet, three of the five obligations — the format suffix, the
confidence label and the mandated `Next:` line — **never failed once in 130 consecutive turns in any
arm**, with the rules stated once at turn 0 and the conversation grown to 133k. The premise this
feature was argued from does not reproduce.

Where failures do occur they arrive **early, not late**: Sonnet A0's only failing rule is `brevity`,
first failing at **turn 6**; Haiku's `suffix` first fails at turn 13 and 27. That is a capability
limit, not decay. A decay story requires failures to cluster late, and they do not.

**2. But A2 found something real, and it is not what the plan claimed.** On Sonnet the three arms are
monotonic — **93.7% → 97.2% → 100.0%** — and A2 was *perfect*: zero violations across five rules and
130 turns. That is a clean effect, and it is **uniform over the conversation rather than growing with
length**. So targeted guidance injection is **compliance reinforcement for rules the model finds
hard**, not drift protection. It fixed the one genuinely hard rule (`brevity`: 35 failures under A0,
15 under A1, **0 under A2**) at every context length equally.

That reframes the product claim rather than killing it. "Drift protection for long-running agents"
is not supported. "Binding a rule to the memory it governs raises compliance on the rules a model
otherwise gets wrong, at a measured token cost" is — on a strong model.

**3. The effect inverts on the weak model, which contradicts one of Plan B's own citations.** On
Haiku the order reverses: A2 (78.8%) < A1 (79.7%) < A0 (83.0%). Targeted injection actively *hurt*
the weaker model. Plan B's receipts cite Memp (arXiv 2508.06433) for procedural memory transferring
**strong→weak**; in this setting it helped only the strong model. That citation should be narrowed
to the setting Memp measured, not carried as general support.

**4. The honest limit, and it is the one that matters most. Every rule tested is
SELF-REINFORCING.** The suffix, the confidence prefix and the `Next:` line all appear in *every
prior assistant turn*, so "continue what I have been doing" satisfies them — the conversation is its
own reminder. That scaffolding is the most likely reason they never decay, and it means this run
cannot speak to the directives Robert actually watches slip: **occasion-triggered** ones. *Recall
before asserting a fact. Don't relitigate a decided question. Write the system beside the date.*
Those fire rarely, have no pattern in prior turns to copy, and require recognizing an occasion —
which is precisely what a memory-bound rule would supply.

**So P-0 run 2 retires the stated premise and does not retire the feature.** The next measurement is
not longer — length is now ruled out to 133k — it is a different *class* of directive: rules that
apply on 10–20% of turns, scored on whether they fire when the occasion arises. If bound guidance
beats restatement there, Plan B has its claim, measured, on the axis the field leaves empty. If it
does not, the feature is finished and that is a cheap answer.

**Cost of run 2:** 79.4M cache-read tokens, 310k output, 4.7k uncached input — roughly $15–20,
dominated by cache reads. Opus was not run; at ~5× Sonnet it is the one remaining model worth
pricing separately, and it is the model Robert's own experience comes from.

### P-0 run 3 — 200 turns, and a correction to run 2's positive finding

Robert asked to extend to 150–200 turns. Run 2 had already ruled out length to 133k, so run 3 held
context near that ceiling (`PAD_CHARS=1200`) and moved **turn count** instead — 130 → 200. Run 2
confounded the two variables; separating them is what this run adds. Four runs,
`claude-sonnet-5-5` A0/A1/A2 and `claude-haiku-5-5` A0, 1 trial each. *Verified.*

| arm | model | turns | peak context | failures |
|---|---|---|---|---|
| A0 stated-once | sonnet | 200 | 156,824 | **0 — all five rules, 875 checks** |
| A1 restate-all | sonnet | 200 | 164,203 | 8 (brevity only, from turn 8) |
| A2 bound-guidance | sonnet | 200 | 166,444 | **0**, for ~8,897 injected tokens |
| A0 stated-once | haiku | 197¹ | 170,176 | suffix/confidence/next-step **0 in 197**; brevity 171 |

¹ stopped by `CONTEXT_ABORT_TOKENS` at turn 197, which is the guard working.

**1. The drift premise is finished.** A directive set **stated once at turn 0 and never repeated**
was followed **perfectly at turn 200**, in a 157k-token context, on every one of its five rules.
Haiku's bucket row is flat across all twenty buckets (81% → 83%) over 197 turns and 170k. Neither
turn count nor token distance degrades compliance for this class of directive. That is as clean a
negative as this question can get.

**2. Run 2's positive finding does not survive, and it was an artifact of my own instrument.**
Run 2 reported a monotonic 93.7% → 97.2% → **100.0%** on Sonnet and called bound guidance a real
effect. Run 3 changed exactly one parameter — pad size — and the ordering collapsed: **A0 and A2
both perfect, A1 slightly worse.** The mechanism is now clear and it is mechanical. The only rule in
this harness with any variance is `brevity`, and what drives it is **how much text sits in the
window** — a bigger pad, or a bigger injected reminder, produces longer replies and trips the cap.
In run 2 the 2,000-char pad made `brevity` hard, so A2's targeted reminder appeared to fix
something; with a 1,200-char pad A0 passes it 200/200 and there is nothing left to fix. **A2 spent
~8,897 tokens to match what A0 achieved for free.** An effect that reverses sign when an instrument
parameter changes is an artifact. The run-2 claim is withdrawn.

**3. What the three runs jointly establish.** Across ~2,500 calls, two models, three arms, 26k →
170k of context and 40 → 200 turns: **self-reinforcing directives do not decay, and injecting them
again — wholesale or selectively — buys nothing.** The honest reason is now visible in the data: the
suffix, the confidence prefix and the `Next:` line appear in *every prior assistant turn*, so the
conversation is its own reminder. There is no headroom for a memory system to add, because the
transcript already does the job for free.

**4. Which makes the occasion-triggered class the whole remaining question, not a footnote.** The
directives Robert actually watches slip have no scaffolding in prior turns — *recall before
asserting a fact, don't relitigate a decided question, write the system beside the date.* They fire
on 10–20% of turns and require recognising an occasion. Everything measured so far says the
self-reinforcing class is a solved problem that needs no help; if bound guidance has a claim, that
is the only place left for it to be true. The next run should score **whether a rule fires when its
occasion arises**, not whether a format holds.

**Cost:** run 3 was 65.4M cache-read, 189k output, 3.2k uncached input (~$15); the three runs
together are ~$35. Opus remains unrun.

---

## Part 6 — P-0b: occasion-triggered directives (partial, 2026-10-13)

Robert's read of runs 1–3 — *"that qualifies the harness more than it qualifies the model"* — is
correct and is the reason this harness exists. Every rule in `runner.ts` is **self-reinforcing**:
the format suffix, the `[confidence:]` prefix and the `Next:` line appear in every prior assistant
turn, so compliance at turn 200 is inferable from turns 1..199 without remembering the instruction.
An instrument whose targets carry their own reminders cannot detect forgetting. It proved a
tautology.

`tests/directive-drift/occasion.ts` removes the scaffolding. Three rules, each modelled on a real
standing instruction in Robert's `CLAUDE.md`, each firing on a minority of turns on an occasion the
model must *recognise*, with nothing in the transcript signalling that this turn is one of them:
**R1 supersede** (context restates an earlier fact with a different value → `[supersedes T<n>]`),
**R2 date-binds** (a date appears → `[binds: LEGACY]` for 2026, `[binds: HUB]` for 2027),
**R3 need-data** (asked for a figure the context lacks → `[need data]`, do not estimate).

Two design changes make this able to return a positive *or* a negative, which run 3 could not:

- **A2 is no longer an oracle.** Telling it which rule is at risk would be circular — knowing the
  occasion is present *is* the detection being measured. A2 now gets the rule bound to the turn's
  **topic**, on every turn of that topic, trigger present or not. That is the honest analogue of
  AWM: recall surfaces the topic's memories, they carry `governs=`, the rule rides along.
- **Both halves of the confusion matrix are scored.** *Recall* = fired when the occasion was
  present. *False-fire* = fired when it was not. That gives A2 a way to lose.

### Result (INCOMPLETE — all three runs died on API credit exhaustion)

`claude-sonnet-5-5`, 180 turns planned, 89 occasions planted, 1 trial per arm. A0 and A1 reached
turn 140; A2 reached turn 120. Cumulative figures, so the comparison below is taken at **turn 120**,
the last point all three arms share. *Verified, but single-trial and truncated.*

| arm | recall @120 | false-fire @120 | reached |
|---|---|---|---|
| A0 stated-once | 84% | **24%** | turn 140 |
| A1 restate-all | 84% | **24%** | turn 140 |
| A2 bound-guidance | 84% | **0%** | turn 120 |

**1. Occasion-triggered rules DO decay, and this is the first time any P-0 harness has shown it.**
Cumulative recall falls 100% (turn 20) → 91% (40) → 86% (60) → 84% (140). Because the figure is
cumulative, the implied rate over the later occasions is ≈81%. **This is the drift Robert reported,
and runs 1–3 could not see it** — not because it was absent, but because every rule they tested was
propped up by the transcript.

**2. No arm prevents it.** A0, A1 and A2 sit at *identical* 84% recall. Restating every rule every
10 turns does nothing; injecting the governing rule on every topic turn does nothing. Whatever
causes an occasion to be missed, having the rule nearer to hand does not fix it.

**3. But bound guidance eliminated false firing — 24% → 0%, at equal recall.** This is the first
positive signal for the feature in the entire investigation, and it is **the opposite of what I
predicted**: I expected per-turn injection to make the model flag non-contradictions more often.
The plausible mechanism is that each rule's text states *both* halves ("if X do Y; if not X, do not
include it"), so re-reading it reinforces the **boundary**, not just the trigger. A1 restates the
same text, so the difference is **adjacency**: A2's reminder sits in the same turn as the decision,
A1's is up to 10 turns stale.

**What this would mean if it replicates.** The product claim is neither "drift protection" (dead —
no arm prevents the decay) nor "better compliance" (dead — recall is identical). It is narrower and
more defensible: **binding a rule to the memory it governs suppresses spurious firing of
occasion-triggered rules.** For a rule like *supersede the stale fact* or *don't relitigate a
decided question*, a false fire is not harmless noise — it is the agent contradicting a correct
memory or reopening a settled decision. That is a real cost and AWM would be removing it.

**Status: PROVISIONAL, do not act on it.** One trial per arm, truncated runs, a single model, and
the headline rests on a 0-vs-24% contrast at one shared turn. It needs replication to completion,
two trials, and a second model before it is worth anything. The next run is **not** a new design —
it is this exact run, finished.

### Why it stopped, which is a billing fact and not a measurement one

All three arms died within seconds of each other on the API's credit-balance error: the
account's balance had reached zero, and P-0 runs 1–3 plus this partial run are the likely
cause. No further API runs should be started until the budget is refilled.
