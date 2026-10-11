# Landscape scan — agent memory, October 2026

What the rest of the field is doing, who is doing what AWM does, and what is worth
taking. Written 2026-10-10 against AWM 0.16.1.

**Provenance.** Local numbers (npm counts, benchmark figures, code reads) were measured
or read directly and are marked *verified*. Claims from a paper's own text are *observed*.
Claims that reached me through a summarizer or a secondary write-up are *assumed* — there
are several, and they are labeled, because this document's whole value is that the
uncomfortable parts are not overstated.

---

## 1. Yes — AWM is harness memory, and the stack now has three named layers

Robert's framing was right, and the field has since settled into the shape it implies.
As of October 2026 "agent memory" means three different products at three different
layers, and conflating them is how comparisons go wrong.

**Layer 1 — the model/API layer.** Anthropic ships a first-party `memory` tool
(`memory_20250818`), available on all Claude 4 and later models. It is a directory of
files the model edits through six commands — `view`, `create`, `str_replace`, `insert`,
`delete`, `rename`. It is **client-executed**: the model requests an operation, your
application performs it against storage you own. The API injects its own system prompt
("ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE … ASSUME INTERRUPTION").
It pairs with context editing (client-side tool-result clearing) and compaction
(server-side summarization). *Observed, from the official docs.*

There is no ranking, no embedding, no recency model and no decay. The docs delegate
lifecycle to the implementer, under Security considerations: *"Periodically delete memory
files that haven't been accessed in a long time."* That sentence is AWM's job description,
written by the platform vendor as a footnote.

**Layer 2 — the harness layer.** This is where AWM lives, and the harness vendors have
now moved in:

- **Claude Code** ships `CLAUDE.md` plus **auto memory**, on by default in local
  sessions. Claude writes four kinds of note — `user`, `feedback`, `project`,
  `reference` — into `~/.claude/projects/<project>/memory/`, as a `MEMORY.md` index with
  one topic file per memory. **The first 200 lines of `MEMORY.md`, or the first 25 KB,
  whichever comes first, is loaded at the start of every conversation; anything past that
  is dropped.** Topic files are not loaded at startup — Claude reads them on demand with
  ordinary file tools. Machine-local; not shared across machines; not loaded into
  subagents except forks. Auditable and git-diffable via `/memory`. *Observed, official
  docs.*
- **Codex** ships `AGENTS.md` plus background session summaries written to
  `~/.codex/memories/`, machine-local and reportedly not available in all regions.
  *Assumed — vendor-adjacent write-up, not OpenAI's docs.*
- **Cursor** reportedly has no native equivalent. *Assumed, and from a competitor's blog;
  treat as unverified.*

**Layer 3 — the third-party memory service.** mem0, Supermemory, Zep/Graphiti, Letta,
Hindsight, Mastra's memory module, SuperLocalMemory, opencode-mem, agentmemory. Mostly
cloud or cloud-optional, mostly LLM-in-the-write-path, and increasingly sold as a
cross-harness installer rather than a library.

**Where this leaves AWM.** The honest positioning is not "memory for agents" — that is
now a checkbox the harness ships. It is: *what happens when the knowledge stops fitting
in 25 KB.* Claude Code's native auto memory loads an index capped at 25 KB and reads the
rest by filename. AWM's live store holds **29,853 engrams (11,262 retrievable)**, which
would cost **1,234,429 tokens** to carry whole — mean 110 tokens per engram — and it
answers at **93.0% success@1** on 300 identifier probes and **92.2%** on 450 topic probes,
p50 ~500 ms, returning a measured **+518 net tokens per recall on identifier queries**
(that figure is reported for the identifier set only — there is no published equivalent for
topic queries). *Verified, from `docs/benchmarks-current.md` at commit 2375582.*

That is the comparison that matters, and it is a scale argument, not a sophistication
argument. A 25 KB index does not need a cross-encoder. A 1.2M-token store does.

---

## 2. Who else is doing what we are doing

Robert's premise was "fairly novel." The accurate version is narrower and more useful:
**the mechanisms have converged — independently, and recently. What has not converged is
the measurement.**

### SuperLocalMemory — the closest thing to AWM in existence

`github.com/qualixar/superlocalmemory`, by Varun Pratap Bhardwaj (Qualixar). Two arXiv
papers (V3.2 = 2603.14588, V3.3 = 2604.04514, submitted 6 Apr 2026). **AGPL-3.0**,
231 stars, 2,171 commits, Python 3.12+ with an npm wrapper.

Read the feature list next to AWM's:

| | SuperLocalMemory | AWM |
|---|---|---|
| Store | SQLite + **sqlite-vec** (canonical), optional CozoDB/LanceDB replicas | SQLite + FTS5 (or PGlite). **No sqlite-vec** — embeddings are BLOBs, `Buffer`→`Float32Array` per recall behind a slim cache, cosine in JS over the candidate pool |
| Channels | 7 ranked lists: semantic 1.2, BM25 (FTS5) 1.0, entity graph 1.0, temporal 1.0, spreading activation 1.0, consolidation gists 0.8, Hopfield associative 0.8 | semantic + dual BM25 as channels; entity bridge, graph walk and temporal enter as **boosts on scored candidates**, not as separate lists |
| Fusion | weighted RRF, k=15 | per-phase additive scoring with an agreement gate (Phase 8), no RRF |
| Reranker | ONNX cross-encoder, `ms-marco-MiniLM-L-6-v2` | ONNX cross-encoder, `Xenova/ms-marco-MiniLM-L-6-v2` — **the same model** |
| Forgetting | Ebbinghaus `R(m,t) = exp(−t/S(m))`, 5 **retention bands** keyed to R (Active > 0.8, Warm, Cold, Archive, Forgotten ≤ 0.05) | ACT-R decay, 5 **pipeline stages**: `staging \| active \| consolidated \| fading \| archived` |
| Local-only mode | "Mode A", zero-LLM, CPU-only | the whole product — `src/adapters/common.ts:637`, "AWM contains no LLM" |
| Distribution | MCP stdio/HTTP; `slm connect` configures 12 IDEs; plugins for Claude Code, Codex, Copilot, Antigravity, Hermes; adapters for LangGraph/LangChain/LlamaIndex/CrewAI/AutoGen/OpenAI Agents SDK | Claude Code plugin, `.mcpb` bundle, MCP |

The convergence is real but it is at the level of *which cognitive mechanisms to build*,
not implementation. **Identical reranker model, both on SQLite, both refusing an LLM in
the write path, both with a five-state lifecycle and both doing spreading activation —
arrived at separately.** The differences in that table are worth keeping straight,
because two of them matter:

- **Vector search.** SLM uses the sqlite-vec extension; AWM has no `vec0` table and
  scores cosine in JS over a pre-filtered candidate pool. At 11,262 retrievable engrams
  that is fine and the pool filter exists precisely for it — but it is a full-scan
  architecture with a cache in front, and it is the first thing to look at under
  "make it more scalable." *Verified: no `sqlite-vec`/`vec0` anywhere in `package.json`
  or `src/`.*
- **Temporal.** SLM treats temporal as a first-class channel at weight 1.0. AWM has
  temporal *signals* — `temporalWeight` (0.4 default), `temporalBoost`, temporal edges in
  the graph walk — and they currently **do not pay**: `benchmarks-current.md` records that
  every cue phrasing scores *below* the no-cue baseline, and `activation.ts:237` says the
  same from the real store. Nobody should read that row as parity. *Verified.*

*SLM column observed from the paper and repo page; AWM column verified by code read.*

Two mechanisms of theirs that AWM does not have are described in **§5** below. Note
carefully: they are **described in the paper**, and the paper itself says that in the
current release all embeddings are stored at float32 by default — so the precision
tiering is specified, not shipped. Treat both as ideas, not as competitor features.

**Where AWM is clearly ahead: the measurement.** Their headline is 70.4% on LoCoMo in
Mode A — scored on **2 of 10 conversations**, 304 QA pairs, by an LLM on a 1–5 Likert
scale with ≥4 counted correct. AWM **retired LoCoMo in 0.13.x** for reasons that apply
directly to that number: 115-character passages against a real store's ~2,000, one-shot
seeding so decay and Hebbian signals contribute nothing, and scoring that rewards
indiscriminate retention. Their own stated limitations include a **−14.9 pp single-hop
regression** caused by the 7-channel fusion, a forgetting study that is a **simulation of
170 facts over 30 days**, session continuity tested on **10 facts**, and a cold start
needing ~200 feedback signals before adaptive weights train. AGPL also means: read the
papers, take no code. AWM is Apache-2.0. *Verified locally; their figures observed from
the paper.*

### The academic twin — arXiv 2605.08538

*Human-Inspired Memory Architecture for LLM Agents*, 8 May 2026 (Kerestecioglu, Robsky,
Vasters, Sharma, Kesselman). Sleep-phase consolidation on a 6-hour schedule; interference
-based forgetting `I(t) = I₀e^(−λt)` weighted 0.6 retroactive / 0.4 proactive; **engram
maturation** with initially "silent" engrams on a sigmoid reaching threshold at one week;
**reconsolidation** with a 60-minute lability window on retrieval; entity knowledge graph;
hybrid multi-cue retrieval; six graceful-degradation fidelity levels.

They use the word *engram*. They built our architecture. Independently, five months ago.
Their results are in §3, and they are the most important thing in this document.

### Prior validation already in the store

`cf271814` records SYNAPSE (2601.02744) and HeLa-Mem (2604.16839) independently validating
spreading activation plus Hebbian retrieval on LoCoMo temporal/multi-hop. The survey
**2603.07670** (Pengfei Du, 8 Mar 2026) lists the field's open problems as *continual
consolidation, causally grounded retrieval, trustworthy reflection, learned forgetting*,
and multimodal embodied memory — four of five are AWM's subject matter.

### So what is actually novel

Not the cognitive machinery. Three things:

1. **Measurement on a real production store.** 29,853 engrams accumulated over months of
   genuine use, with a reproducible snapshot, version/commit stamping, and a page that is
   regenerated rather than hand-edited. Every competitor benchmarks on synthetic
   conversation corpora. This is not a small difference — see §3.
2. **The integrated task system.** `memory_task_*` makes commitments first-class
   engrams sharing the retrieval substrate. No other system in this scan has it.
3. **Hive / multi-agent shared store** with workspace scoping and real-time cross-agent
   recall.

---

## 3. The uncomfortable evidence, and what it actually licenses

Three independent 2026 results converge, and they need to be read precisely rather than
either dismissed or over-generalized.

**arXiv 2605.08538 — the architecture nearest AWM's, measured honestly.** Against a raw
retrieval baseline of 78.4% on LongMemEval S-tier (50 sessions), *every* configuration
trailed: dedup-only 76.8% (−1.6), dedup + reconsolidation 75.8%, dedup + hybrid graph
74.8% — all with overlapping confidence intervals. Then it falls off a cliff:
adaptive-10K **57.0% (−21.4 pp, CI outside the baseline's)**, aggressive consolidation
**48.4% (−30.0 pp)**. M-tier (475 sessions): 70.1% vs 71.2% at a 200K-token budget, then
65.6% at 115K, 49.2% at 50K, **38.8% at 25K**. Where consolidation *did* win was a real
operational corpus — the VSCode issue tracker, 13,127 issues and 120K events: 97.2%
retention precision at 58% store reduction, against 75.4% for keep-everything.

Their conclusions, in their words: **"consolidation should deduplicate, not summarize"**,
because *"merging turns into cluster summaries destroys the specific details needed for
factual question answering."* Reconsolidation: *"marginal impact."* Maturation: **not
tested at all** — every experiment ran at uniform activation A = 1.0. And on the
benchmark itself: LongMemEval is *"an adversarial case for our design"*, the near-parity
result is best read as *"a non-destruction bound"*, and they *"expect the gap to invert"*
in operational settings with repeated, related queries — which they did not test.
*Observed, from the paper's own text.*

**CL-Bench — arXiv 2606.05661**, 4 Jun 2026, UC Berkeley / Snorkel AI / UW–Madison. Six
expert-validated domains with learnable structure. Headline finding: agents overfit to
immediate observations or fail to reuse knowledge, and dedicated memory systems do not fix
it — *naive in-context learning outperforms systems dedicated to memory management*. Its
metric is the part worth stealing: **normalized gain, which subtracts each system's own
stateless baseline.** *Observed for the finding; venue is disputed between NeurIPS 2026
and ICML 2026 listings, and leaderboard specifics were secondhand so they are omitted.*

**MemoryAgentBench** (already in the store, `cf271814`): BM25 RAG 60.5% beats Mem0 32.6%,
Zep 37.5%, Cognee 28.3% on accurate retrieval.

### What this licenses, and what it does not

It does **not** license "the cognitive stack doesn't work." All three measure regimes
where the history either fits in context or is benchmark-shaped: 50–475 synthetic
sessions, one-shot seeding, no months-long accretion, no decay signal with anything to
act on. AWM's regime — 11,262 retrievable engrams accreted over months, 1.2M tokens that
*cannot* fit in any context window — is precisely the regime none of them tested, and
precisely the one 2605.08538's authors said they expect would invert the result.

What it does license is this: **AWM cannot claim an accuracy win from its machinery, and
should stop expecting one.** Where the evidence points is that this class of system earns
its keep on store size, token cost, and the operating curve — which is exactly what AWM's
`+518 net tokens per recall` and `max_tokens` budget packing already measure, and exactly
where the VSCode-corpus result (+21.8 pp on a real issue tracker) came from.

It also licenses one hard conclusion about the bench suite — see §4.

---

## 4. The one measurement that should come next

**AWM has no published no-memory or BM25-only baseline on the real store.** Checked:
`docs/benchmarks-current.md` reports success@1, success@5, MRR, abstention and latency for
two probe sets, but no stateless arm. The suite that would provide it — the **Memory
Gauntlet end-to-end ablation** — is listed under *Not regenerated by this run*: it lives
in the memory-working-agent repo, costs real API spend per arm, and *"every probe flips
between identical runs. Making the probes deterministic is the prerequisite."*
*Verified.*

This matters more than any other item in this document. The Codex design review in
`7857c5b8` asked for exactly these arms — BM25, hybrid, time-weighted RAG, and
long-context-no-memory — and said that without them the comparison is incomplete. Three
independent 2026 papers have now published results in that shape, one of them on nearly
AWM's own architecture. **Until AWM runs the same arms, it cannot answer the field's
central published finding, and every retrieval number it publishes is unanswerable in the
only terms the field now uses.**

The recommendation: make the Gauntlet probes deterministic, then publish AWM's retrieval
score **as normalized gain over its own stateless baseline**, CL-Bench style. This is the
one experiment no competitor in this scan can run, because none of them has a real
production store to run it on. It converts AWM's genuine advantage — months of real
accretion — from an anecdote into the measurement that settles the question.

---

## 5. Worth taking, ranked

Ideas only. SuperLocalMemory is AGPL-3.0 and AWM is Apache-2.0: read the papers, write
our own code.

1. **Trust-weighted decay.** SLM's `λ_eff = λ · (1 + κ(1−τ))` with κ = 2.0, so a
   zero-trust source decays ~3× faster. AWM already carries `origin_class`
   (`user-stated` / `tool-output` / `inference` / `recipe`) — and it is **log-only**.
   Wiring it into the decay rate is close to free and closes the write-trust gap AWM's own
   literature review named, where MINJA (2503.03704) reports >95% memory-injection success
   query-only. Highest value-to-effort in this list.
2. **Normalized gain over our own stateless baseline** (CL-Bench). The credibility move,
   and the prerequisite is §4 anyway.
3. **Benchmarks built on the axis AWM is designed to win.** **AgentMemoryBench** (ICLR
   2026) standardizes five modes including *forgetting* and *knowledge-conflict
   resolution*; **Memora** (ACL 2026 Findings) targets consolidation and frequent
   knowledge updates over weeks-to-months conversations. Selective forgetting is the one
   axis where AWM is architecturally built to compete and nobody is currently winning —
   MemoryAgentBench has every system at ≤28% on multi-hop conflict resolution. *Assumed:
   both via summaries; read the papers before committing.*
4. **Memory parameterization** (SLM contribution C4): consolidated memories become
   natural-language soft prompts injected at session start, with **no retrieval step**.
   This is a no-LLM answer to AWM's S3 gap ("the agent never called `memory_write`/
   `memory_recall`") that sidesteps the extractor-noise risk the gap-closure record
   flagged, because the content is already-consolidated gists rather than fresh
   extractions. Pairs with AWM's existing prime hook, which is the recall half of the same
   idea.
5. **Precision-tiered embeddings as an alternative to truncating text.** SLM specifies
   32-bit active → 8-bit warm → 4-bit cold → 2-bit archive via random orthogonal rotation
   plus Lloyd–Max scalar quantization, shrinking the *vector* while leaving the *body*
   intact. AWM does the opposite: fade truncates the body and leaves the embedding at full
   precision. AWM already has q8 cross-encoder experience (`d509f3f0`), so the machinery
   is familiar. **Caveat that matters: their paper says the current release stores all
   embeddings at float32 by default, so this is an unshipped specification, not a proven
   feature. Their own limitation note says 2-bit "degrades significantly."**
6. **Cheap fusion experiments.** Weighted RRF with **k = 15** rather than the standard 60;
   and intersecting the entity and temporal channels *before* fusion on multi-hop queries.
   Both are one-afternoon ablations against the existing bench.
7. **Cross-harness distribution.** Hindsight installs into ten coding agents with one
   command; `slm connect` configures twelve IDEs. AWM is Claude-Code-shaped. This is the
   same conclusion the gap-closure record reached by a different route — adoption follows
   what a user can see and how little they must do.
8. **AWM as a backend for Anthropic's `memory_20250818` tool.** The tool is
   client-executed with a pluggable handler, and the SDKs ship an abstract base
   (`BetaAbstractMemoryTool`, `betaMemoryTool`) precisely so the store can be swapped.
   Distribution through the platform's own protocol. **The mismatch is real and should be
   scoped before anyone commits: the tool addresses memory by file path, and engrams have
   no paths.** A path-shaped façade over engrams is a design question, not a wiring job.

---

## 6. What the fade evidence does and does not say

This needs stating carefully, because fade is a documented design decision, not an
oversight: it is the Paper 1 storage-degradation mechanism, the lifecycle is `active →
fading → archived → deleted`, only ever applied to engrams accessed at least once, and the
global instructions say write-and-forget is safe *because* the system compresses what goes
unused.

2605.08538 measured **merging memories into cluster summaries**, found it cost up to
30 pp, and concluded consolidation should deduplicate rather than summarize. Those are
three distinct operations and AWM should be scored against them separately:

- **Dedup — AWM already does this, and it is the mechanism that won.** Merge-on-reinforce
  (`src/core/write-pipeline.ts:445`) matches a duplicate write to the existing engram,
  appends the new content, re-embeds the merged body, and drops oldest on overflow past
  1,500 chars. That is deduplication-with-accumulation, which is precisely the mechanism
  2605.08538 found drove its real-corpus gains. *Verified by code read.*
- **Summarize into cluster gists — AWM does not do this.** Good; it is the measured
  −30 pp.
- **Truncate un-recalled bodies to 150 chars — AWM does do this, and it is neither of the
  above.** No external result in this scan measures it. What exists is the local evidence
  gathered earlier today: 19 task bodies destroyed, `blocked` tasks hit at 29% against
  1.2% for `open`, 18 of 19 unrecoverable.

So the paper is **supporting external evidence for the guard already shipped** — the
general principle that destroying specifics to save space costs more than it saves — and
it is **not** grounds to reopen fade as a whole. The open question it does raise is narrow
and worth one measurement rather than an argument: *does fade's 150-char truncation pay
for itself in recall terms at all, given the body is 110 tokens on average and the store
costs 1.2M tokens whole?* That is a bench question, and §4's baseline work would answer it
as a side effect. Item 5 above is the alternative design if the answer is no.

---

## 7. Adoption, plainly

Last-month npm downloads, measured 2026-10-10:

| Package | Downloads |
|---|---|
| `@mastra/memory` | 4,363,526 |
| `mem0ai` | 667,617 |
| `supermemory` | 510,440 |
| `opencode-mem` | 13,437 |
| `agent-working-memory` | **1,533** |

*Verified via the npm registry API.* Caveats that matter: Mastra's count rides on
framework installs rather than deliberate memory adoption; mem0's real volume is mostly
PyPI, so 667K understates it; and AWM's own production use runs from a dev checkout, so
1,533 understates AWM — but not by a factor that changes the picture.

The `opencode-mem` ratio is **8.8×**, which reproduces the **8.6×** recorded in
`docs/decision-gap-closure-2026-10-10.md` from a different measurement — a useful
consistency check on both.

Funding context, for category temperature: mem0 raised $24M (seed + Series A, Oct 2025);
Letta a $10M seed. No 2026 rounds and no acquisitions surfaced in this scan. *Assumed —
search summaries only, and the search explicitly failed to find 2026 deal data.*

---

## 8. What not to do

- **Do not chase LoCoMo or LongMemEval headline numbers.** AWM retired LoCoMo in 0.13.x on
  stated grounds that remain correct, and 2605.08538's authors call LongMemEval adversarial
  to this whole class of design. Competing there means competing on corpora that structurally
  cannot reward decay, Hebbian edges or consolidation.
- **Do not add a fourth, fifth and sixth retrieval channel.** SLM took a measured
  −14.9 pp on single-hop from exactly that, and AWM's own entity-centric roadmap
  (`0c782c92`) already concluded: *"Never add breadth in the final cut."*
- **Do not put an LLM in the write path.** It remains a deliberate non-goal
  (`src/adapters/common.ts:637`), it is what makes Mode-A-style local operation possible,
  and the one system that matches AWM's design most closely made the same choice
  independently.
- **Do not claim the cognitive machinery beats plain retrieval on accuracy.** Nobody has
  shown it, the nearest architecture to AWM's measured that it does not on the available
  benchmarks, and AWM has no stateless baseline of its own to argue with yet. The defensible
  claims are store size, token cost, and the operating curve.

---

## Sources

Primary, read directly: [Anthropic memory tool
docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) ·
[Claude Code memory docs](https://code.claude.com/docs/en/memory) ·
[arXiv 2604.04514](https://arxiv.org/abs/2604.04514) (SuperLocalMemory V3.3) ·
[arXiv 2605.08538](https://arxiv.org/html/2605.08538v1) (Human-Inspired Memory
Architecture) · [github.com/qualixar/superlocalmemory](https://github.com/qualixar/superlocalmemory)

Secondary / via summary: [arXiv 2606.05661](https://www.emergentmind.com/papers/2606.05661)
(CL-Bench) · [arXiv 2603.07670](https://arxiv.org/abs/2603.07670) (survey) ·
[AgentMemoryBench, ICLR 2026](https://iclr.cc/virtual/2026/10012519) ·
[Hindsight, arXiv 2512.12818](https://arxiv.org/html/2512.12818v1) ·
[CL-Bench ICML listing](https://icml.cc/virtual/2026/75698) ·
[mem0 funding](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps)

Internal: `docs/benchmarks-current.md` (v0.16.0, commit 2375582) ·
`docs/decision-gap-closure-2026-10-10.md` · engrams `cf271814` (literature review),
`0c782c92` (entity-centric roadmap), `7857c5b8` (Codex benchmark review),
`14c48a66` (opencode-mem retrieval), `86359827` (2026-06 harness scan)
