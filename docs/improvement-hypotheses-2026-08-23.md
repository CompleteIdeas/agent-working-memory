# AWM improvement hypotheses — 2026-08-23

A review of AWM as a whole against current academic and industry practice, with a token-economics
lens. Each hypothesis is tied to something measurable in the repo, not general advice.

---

## 1. Where AWM stands

AWM's cognitive model is genuinely well-grounded — ACT-R decay (Anderson 1993), Hebbian edges
(Hebb 1949), Complementary Learning Systems (McClelland 1995), synaptic homeostasis
(Tononi & Cirelli 2003), adaptive forgetting (Anderson & Bjork 1994). The 2026 field has
converged on the **CoALA** taxonomy — episodic / semantic / procedural — and AWM already
implements all three. That is not a gap.

What has moved since AWM's architecture was set:

- **The field's centre of gravity shifted from retrieval-time to write-time.** The most-repeated
  2026 finding is that *"most systems are doing too much at retrieval time and not enough at
  storage time"* — organising, relating and compressing should happen **once at creation**, not
  on every inference call.
- **Graph-at-write, PageRank-at-query.** HippoRAG 2 extracts an entity graph offline and runs
  Personalized PageRank at query time for multi-hop. A-MEM builds a Zettelkasten-style link graph
  with periodic LLM-mediated consolidation.
- **Token budgets became the headline metric.** Current-generation systems report ~7,000 tokens
  per retrieval against 25,000–100,000+ for full-context, at >91% recall.

---

## 2. The token finding that should drive everything else

AWM's own measured numbers, from `docs/benchmarks.md`:

| Metric | Value |
|---|---|
| Token savings (synthetic) | 64.5% |
| Recall accuracy | **65%** |
| Efficiency | 2.8× |
| **Real sessions — file retrieval** | 5,777,217 tokens / 2,743 calls = **2,106 per call** |
| **Real sessions — AWM retrieval** | 591,366 tokens / 131 calls = **4,514 per call** |
| Aggregate cost ratio | **9.8 : 1 in AWM's favour** |

**AWM wins decisively in aggregate and loses per call — by 2.1×.** That is the whole story. AWM's
value today comes from *needing far fewer calls*, not from each call being cheap.

Two consequences that reframe the roadmap:

1. **Recall accuracy is the real token lever, not compression.** At 65% accuracy, roughly a third
   of every recall's tokens carry nothing the agent needed. Raising precision from 65% → 85% would
   improve useful-tokens-per-call by ~30% — more than any summarisation scheme, and without losing
   information.
2. **Per-call cost is the exposed flank.** If per-call cost fell to parity (~2,100) while call
   count stayed low, the aggregate ratio would roughly double.

**Recommended headline metric change:** report **useful tokens per recall** (accuracy × tokens
returned) rather than "% savings". Savings can be gamed by returning less; quality-per-token
cannot.

---

## 3. Hypotheses

### H1 — Move the expensive work to write time *(highest expected value)*

Today a recall runs query expansion (flan-t5-small) and cross-encoder reranking
(ms-marco-MiniLM-L-6-v2) **at query time** — measured ~0.9s warm per call, and the reason per-call
tokens are high. Both are per-query by nature, but much of what they compensate for is missing
write-time structure.

Precompute at write: entity extraction, cluster/topic assignment, and a canonical "claim" form of
the memory. Then recall becomes lookup + light rerank instead of expansion + full rerank.

*Predicted effect:* lower per-call latency and tokens; better precision because entities are
resolved once, carefully, instead of re-inferred per query.
*Measure with:* `test:tokens` and `test:perf` before/after; watch useful-tokens-per-call.

### H2 — Token-budgeted recall *(most directly responsive to the token brief)*

`memory_recall` takes `limit: N` — a **count**, which is token-blind. A 5-result recall can be
400 tokens or 4,000.

Add `max_tokens`. Pack results greedily by expected-value-per-token (score ÷ estimated tokens),
stopping at the budget. Return `tokens_returned` so the caller can see the spend.

This makes AWM *actively* token-aware rather than incidentally so, and it lets a harness say
"I have 800 tokens of context to spare" instead of guessing at a result count.

### H3 — Make abstention the default

`require_confidence` already exists but is opt-in. Given 65% accuracy, the default path returns
low-value results roughly a third of the time — and the agent pays tokens for them.

Flip it: a modest default threshold, with `require_confidence: 0` to opt out. An empty result is
*cheaper and more honest* than a wrong one, and it tells the agent to read the code instead.

### H4 — Multi-granularity summaries stored at write

`granularity: 'compact'` computes a 200-char query-aware snippet **at recall time**. Store three
lengths (~120 / ~400 / full) at write instead, and have recall select rather than compute.

Query-aware snippets are better than static ones, so the honest version is a hybrid: static
summaries as the cheap default, query-aware only when the caller asks. Directly implements the
"do it once at storage time" principle.

### H5 — Personalized PageRank over the existing Hebbian graph

AWM already has the substrate HippoRAG builds deliberately — a weighted associative graph, plus
the 0.12 entity inverted index. Today the graph is a secondary signal. Running PPR seeded from
query-matched entities would target **multi-hop** questions ("what did we decide about X, and what
broke because of it?"), which is exactly where flat similarity retrieval fails.

*Cheap experiment:* PPR behind a flag, evaluated on the existing multi-hop eval set.

### H6 — A fade/consolidation audit trail

The literature's specific criticism of A-MEM is that its link graph is rewritten with *"no replay
or audit trail across rewrites."* AWM's content fade and consolidation have the same shape: they
mutate the substrate without a ledger.

This session produced a concrete instance of why that matters — a memory saying *"HYPOTHESIS NOT
YET REPRODUCED"* outranked its own verified correction. A consolidation ledger (what faded, what
merged, what superseded what, and when) makes that debuggable rather than mysterious.

### H7 — Close the supersede loop automatically

Related, and cheaper: when a new memory is written whose concept matches an existing one and whose
content contradicts it, AWM should *propose* the supersede rather than relying on the agent to call
`memory_supersede`. Today the burden is on discipline, and discipline fails — which is precisely
how the stale hypothesis kept ranking first.

---

## 4. CLI / harness integration

The 2026 pattern is explicit: *"the framework owns the agent loop, the memory layer owns retention
and recall"* — the harness either builds memory in or exposes a clean integration point. AWM is
positioned correctly; the gaps are in **when** it gets invoked.

### I1 — Recall on context injection, not agent initiative

**This is the biggest integration win, and the repo already knows it.** AWM's own instructions say
the #1 failure mode is the agent not calling recall. Relying on the model to remember to remember
is the weak link — this session alone produced two live examples of investigating something AWM
already had.

The hook sidecar already exists (`src/hooks/`, PreCompact + SessionEnd). Extend it to
**PreToolUse / UserPromptSubmit**: run a cheap recall on the incoming prompt and inject only
high-confidence hits. Budget it hard (H2) so injection can never balloon context.

### I2 — Procedural memories as harness skills

Harnesses now have a skills concept (Claude Code skills, `AgentSkillsProvider` in Microsoft's
framework). AWM stores `procedural` memories and already emits "cognition recipes"
(`skill-derivation@1`). Exporting high-confidence procedural memories **as** harness skills would
put them in the agent's path without a tool call — and without spending recall tokens at all.

### I3 — Make the value visible per call

Return `tokens_returned` and an estimate of tokens displaced, so both the human and the harness can
see the trade. Today the 9.8:1 ratio is only visible in an offline benchmark. A harness that can
see cost can tune the budget; a human that can see it will trust it.

### I4 — Session-start warm pack

`onboard` seeds a cold store. The natural extension is a session-start pack: the N highest-value
canonical memories for the current project, injected once at ~500 tokens, replacing several ad-hoc
recalls at 4,514 each. Cheapest possible win on the per-call number.

---

## 5. Suggested order

| Priority | Item | Why |
|---|---|---|
| 1 | **H2** token-budgeted recall | Directly addresses the exposed flank; small, self-contained |
| 2 | **I1** recall on context injection | Fixes the #1 documented failure mode |
| 3 | **H3** abstention by default | One-line default change, immediate precision win |
| 4 | **I3** per-call token accounting | Cheap, and makes everything else measurable |
| 5 | **H1** write-time work | Highest ceiling, largest change |
| 6 | **H5** PPR multi-hop | Best differentiator; substrate already exists |
| 7 | **H6/H7** audit trail + auto-supersede | Correctness and trust |

**Do H2 and I3 first regardless** — without per-call token accounting the rest can't be evaluated
honestly, and "% savings" is the wrong yardstick for a system whose real weakness is per-call cost.

---

## Sources

- [Memory in the Age of AI Agents: A Survey (paper list)](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents](https://arxiv.org/pdf/2502.06975)
- [Multi-Layered Memory Architectures for LLM Agents](https://arxiv.org/html/2603.29194v1)
- [Human-Inspired Memory Architecture for LLM Agents](https://arxiv.org/html/2605.08538)
- [Awesome-GraphMemory (graph-based agent memory survey)](https://github.com/DEEP-PolyU/Awesome-GraphMemory)
- [GAAMA: Graph Augmented Associative Memory for Agents](https://arxiv.org/pdf/2603.27910)
- [Selection Integrity for LLM Graph Memory](https://arxiv.org/pdf/2606.12290)
- [State of AI Agent Memory 2026 (Mem0)](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [The 2026 Token Optimization Playbook](https://mem0.ai/blog/the-2026-token-optimization-playbook-cut-ai-agent-memory-costs-3%E2%80%934x)
- [AI Agent Context Compression Strategies (Zylos)](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies/)
- [The Missing Layer in Every Agent Harness (Hindsight)](https://hindsight.vectorize.io/blog/2026/05/04/agent-harness-needs-memory)
- [Awesome Harness Engineering](https://github.com/ai-boost/awesome-harness-engineering)
- [Microsoft Agent Framework at BUILD 2026](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/)

---

## Addendum (same day) — H3 was wrong, and the measurement says something better

H3 above proposed making abstention the default, reasoning that at ~65% recall accuracy a third of
every recall's tokens are wasted. `tests/abstention-eval/runner.ts` sweeps the threshold against
ground truth (6 memories, 6 on-topic queries with a known correct answer, 6 off-topic queries where
silence is correct). The result contradicts the hypothesis:

| threshold | hit rate | answers an off-topic query | **net tokens saved** |
|---|---|---|---|
| 0 (today) | 100% | 67% | 9,280 |
| **0.05** | **100%** | **50%** | **9,351** |
| 0.15 | 83% | 17% | 8,343 |
| 0.20+ | 67% | 0% | **6,965** |

**Aggressive abstention destroys value.** At 0.20 the answers are perfectly clean — and 25% of the
token saving is gone. The reason is that my first metric ("efficiency" = useful ÷ (useful + wasted))
treats a miss as free. It isn't: when AWM abstains the agent goes and reads the codebase, which
AWM's own benchmark measures at ~2,106 tokens. Optimising purity drives the system toward muteness,
and muteness is expensive.

### The real finding: the correct threshold is inverted between PULL and PUSH

| | `memory_recall` (PULL) | prime hook (PUSH) |
|---|---|---|
| Who asked? | the agent did | nobody |
| Cost of a **miss** | **high** — agent falls back to reading files (~2,106 tok) | **zero** — nothing happens, the agent can still recall explicitly |
| Cost of a **wrong answer** | moderate — wasted tokens, agent moves on | **high** — noise injected into *every* prompt |
| Therefore | **light** threshold (0.05) | **aggressive** threshold (0.25) |

The asymmetry is exactly reversed, which is why one global default would be wrong either way. Both
are now set accordingly.

### What this changes about the roadmap

The bigger lesson is that **misses cost more than false answers**, so raising hit rate is worth
considerably more than filtering. That moves **H1 (write-time work)** and **H5 (PPR multi-hop)** up
the list and moves precision-filtering down. The headline metric should be **net tokens saved**, not
"% savings" and not "efficiency" — both of the latter can be improved by returning less, which is
the opposite of the goal.

**Caveat:** measured on a 6-memory store. Confidence is a distribution shape, so the absolute
numbers will not transfer to a 22k-engram store — the *shape* of the curve is the finding, and the
threshold should be re-swept against the real store before being trusted.
