# Using AWM at scale — recall quality, multi-hop, and large stores

A field guide for integrators. AWM is powerful but **opinionated**; using it well at scale means
working *with* its design, not expecting it to be something it isn't. This doc captures the
patterns that matter once your store is large and your queries get hard.

## 1. What AWM is — and what it is not

AWM is a **fast, local, precision-first cognitive memory** with built-in **abstention**. It is
*not* an exhaustive, network-backed, LLM-driven search engine.

- **Precision over recall by design.** AWM would rather return *nothing* than return facts you
  didn't ask for. On adversarial "is this even in memory?" queries it scores ~73% (correctly
  abstaining); on broad open-domain recall it scores lower **on purpose** — surfacing every
  loosely-related memory would poison the prompt.
- **Single-machine, in-process, fast.** Recall is tens-to-~150ms locally — no network round-trip.
- **Following a long conversation is the LLM's job, not AWM's.** AWM gives the model the *right
  small slice*; reasoning/chaining over it is the agent's responsibility.

**Implication:** don't benchmark AWM as if it were full-recall RAG (e.g. raw LoCoMo recall@k will
look modest — that's the precision/abstention tradeoff, not a bug). Benchmark it on *does the
agent get the answer it needs at low token cost without hallucinating*.

## 2. Write for recall (the highest-leverage thing you control)

Recall quality is mostly set at **write** time:
- **Lead with the fact**, not backstory. The first 1–2 sentences carry the most retrieval weight.
- **Include 2+ retrievable identifiers** — names, dates, file paths, IDs, the literal terms a
  future query will use. `AccountingService.closePeriod()` beats "the accounting code."
- **Pick a specific topic/concept**, not a generic bucket.
- **Reserve `canonical` for stable invariants** (decisions, requirements). Working class is the
  right default for observations.

### Updates: write a transition-with-reason (supersede as decision-history)
When a value changes, don't just write the new value — write the **transition and the why**:
> "Project Atlas due date moved from July 1 → August 15 because Q2 scope grew."
This single memory answers *what is it now* (ranks #1), *what was it before*, and *why it
changed* — and the stale standalone fades below it. Decision history is knowledge: it stops you
reverting to a known-bad choice and lets you mine "decided X → result → decided Y" patterns.

## 3. Recall tuning knobs

| Goal | Knob |
|---|---|
| Faster recall, no accuracy loss in most cases | rerank-only (skip query expansion); expansion ~doubles latency by inflating the rerank pool for little gain on most distributions |
| Don't act on low-confidence noise | `require_confidence` (opt-in abstention: 0.10 strict … 0.40 aggressive) |
| Scan fewer tokens across many results | `granularity: 'compact'` (query-aware snippets) |
| Cross-agent / cross-CLI shared recall | register agents into a shared **workspace** (recall then spans all agents in it) |
| Keep a flat token budget on long runs | rely on scoped recall + **consolidation**, not a growing transcript |

## 4. At scale (thousands of memories)

- **Run consolidation** (sleep cycles) regularly — it clusters, strengthens, decays noise, and
  creates syntheses. A store built from many short interactions never auto-consolidates; trigger
  it (e.g. a `consolidate` command on a cron). Consolidation has been measured to *improve*
  retrieval (removing redundant noise sharpens ranking).
- **Know the candidate-recall limit.** Recall is a funnel: BM25 + vector → candidate pool →
  rerank. At scale, a memory that's *semantically related but lexically different* from the query
  can fall **outside the candidate pool**, and **rerank cannot rescue what isn't in the pool**.
  This shows up as "the obviously-relevant memory wasn't returned." Mitigations: write for recall
  (§2, put the query's likely terms in the memory), and use the multi-hop pattern (§5) for
  bridged queries.
- **Bigger memory is not automatically better recall.** More memories = more competitors for the
  same keywords. Precision discipline (write well, consolidate, abstain) matters more than volume.

## 5. Multi-hop queries (validated pattern)

AWM reliably answers **single-hop** queries ("who is my scheduler?", "Atlas's codename?"). It does
**not** chain hops itself: a query like *"the codename of the project my scheduler owns"* needs
scheduler→person→project→codename, and the bridging facts are vocabulary-mismatched with the
query, so the answer often falls out of the candidate pool.

**Do the chaining in the harness, not by bending AWM's recall:**
1. Recall the query → get the bridging entity (e.g. "Atlas" / "Sarah Chen").
2. Issue a **follow-up single-hop recall on that entity** (AWM recalls "Atlas's codename = Magpie"
   precisely for "Atlas").
3. Repeat for additional hops; hand all the recalled facts to the LLM, which chains the answer
   (LLMs chain reliably when the facts are in context).

This keeps AWM **fast and precise** (each call is a clean single-hop) and puts the multi-hop
reasoning where it belongs — in the model. (Boosting bridged facts *inside* AWM recall was tried
and rejected: it trades away the precision that is AWM's whole point.)

**Validated:** on a controlled gauntlet (k=3) this harness pattern lifted 2-hop "sparse-cue"
67%→100%, 3-hop "multihop" 0%→67%, and overall memory-dependent accuracy 70%→81%, with no
regression elsewhere — entirely via follow-up single-hop recalls, AWM unchanged.

## 6. Quick reference — env knobs

| Env | Effect |
|---|---|
| `AWM_RECALL_EXPAND=1` | restore query-expansion-by-default (default is rerank-only) |
| `AWM_SIM_CANDIDATE_FLOOR_*` | vector candidate floor (lower = more recall, more noise/cost) |
| `AWM_DISABLE_RERANK_SKIP=1` | force the cross-encoder rerank even on clear-winner queries |
| `AWM_REINFORCE_MERGE_CONTENT=0` | disable content merge on reinforce |
| diagnostics | leave unset in production; flip only to A/B a suspected regression |

---

**The one-line philosophy:** AWM is the *precise, fast, durable* memory layer; the *judgment*
(what to chain, what to ignore, when to abstain) is the agent's. Build with that division and it
scales; fight it (expecting exhaustive recall or in-store multi-hop) and you'll be disappointed.
