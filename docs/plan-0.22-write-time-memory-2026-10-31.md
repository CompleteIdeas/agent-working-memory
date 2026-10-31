# Plan: AWM 0.22 — memory that does its work when it is written

*Design record, 2026-10-31. Status: proposed, for Robert's review. Builds on the measurements in
[abstention-signals-2026-10-30.md](abstention-signals-2026-10-30.md) (the findings ledger) and the
0.21.1 ranking work in the CHANGELOG. Every decision below names the measurement behind it.*

## 1. Why a big update

Two days of measurement on the frozen real store (29,853 memories; agents `work` 7,458 and
`personal` 1,215 retrievable) answered three questions about AWM.

**Is AWM's ranking better than plain search?** No. On a store holding only current memories,
plain BM25 + vector fusion matches it on natural-language questions (45.4% first-result). What
AWM adds is knowing what is current: plain search over the raw store, superseded memories still in
it, falls to 32–36% and puts a superseded memory first about a third of the time.

**Where is natural-language recall lost?** In the vocabulary gap between how people ask and how
agents write. Every query-time lever converged on the same ceiling: a better reranker (Ettin, 3×
slower), a bigger embedder (EmbeddingGemma: NL +3.6 vector-only but keyword −2.6 to −4.7, and 30 minutes to embed 8,673 memories), question rewriting by a small
LLM (worse), title and sentence vectors (worse on natural questions), more gate signals (+0.003).
The one change that broke through was at write time: three natural questions saved with each memory
and indexed for keyword search lifted natural-language retrieval by 6.2 points on a fair sample
with nothing lost elsewhere.

**Why does the abstention gate fail on natural questions?** Not for lack of signals. The signals
can separate an answerable natural question from a never-stored one at 0.997 AUC when trained on
representative questions; the shipped gate reaches 0.80 because it is calibrated only on
keyword-shaped synthetic probes. And the deleted-fact case (familiar topic, answer gone) stays at
0.82–0.83 whatever the signals.

The direction is consistent: **the intelligence belongs at write time, the ranking core should be
the parts that measured as useful, and the lifecycle should be structural rather than depend on the
agent remembering to call a tool.** That is this plan.

## 2. Where we are (baseline for every target below)

Real-store snapshot, k = 3, first result correct, interleaved latency on the same machine.

| | 0.21.0 (shipped) | 0.21.1 (local, ready) | 0.22 target |
|---|---|---|---|
| natural-language (194) | 41.2% | 45.4% | **≥ 50%** |
| topic (450) | 92.7% | 96.0% | ≥ 96.0% |
| identifier (1,316) | 91.6% | 93.3% | ≥ 93.3% |
| recall latency, median | baseline | ≈ +21% | ≤ 0.21.1 |
| gate: NL correct answers withheld | 18 / 80 | 21 / 88 | **≤ 9 / 88** |
| gate: never-stored withheld (73) | 65 | 65 | ≥ 63 |
| gate: NL deleted withheld (97) | 69 | 60 | ≥ 60 (≥ 75 if the answer check ships, §4.6b) |
| stale memory ranked first | not measured | not measured | measured, ≤ 1% |

The natural-language target is set from the sample result (+6.2) applied to 0.21.1's 45.4, rounded
down. It is a target, not a forecast: the end-to-end run on the full store has not happened yet
(§8, step 0).

## 3. Principles (each from a measurement)

1. **Write time is where the leverage is.** Questions in the keyword index: NL +6.2, topic +1.7,
   identifier ±0 (ledger §9).
2. **Three nearly independent channels, fused cheaply.** Spearman between cross-encoder, BM25 and
   vector scores: −0.01 to 0.31. Every free gain of 0.21.1 came from fusing them better (ledger §2;
   CHANGELOG 0.21.1).
3. **Lifecycle is the product, so make it structural.** The lead over a plain vector database is
   currency; today it depends on the agent calling `memory_supersede` or `correction: true`.
4. **Keep absolute signals for decisions, relative ones for ranking.** Per-query normalisation hid
   the best NL abstention signal (raw BM25, 0.757 vs the cross-encoder's 0.746; ledger §2).
5. **A self-calibrating model is only as good as its practice questions,** positive and negative
   (ledger §4, §8).
6. **Every stage observable, every claim generated.** Today's worst bugs were one stage silently
   capping or masking another: a "40-candidate pool" that was 24, a skip bound stale for months, a
   gate figure that was zero by construction.

## 4. The design

### 4.1 Write contract

`memory_write` gains two optional fields; nothing existing changes meaning.

| Field | Meaning | Who fills it |
|---|---|---|
| `questions: string[]` (≤ 5) | natural questions this memory answers | the writing agent; else the enrichment queue |
| `slot: string` | the entity + attribute this memory states, e.g. `rosterkeep.deploy-command`, `robert.flight-time` | the writing agent; else inferred (§4.3) |

The installed guidance (`src/adapters/common.ts`, CLAUDE.md templates) asks agents for both, with
examples, the same way it asks for `topic` and `intent` today.

### 4.2 Index

| Index | Holds | Evidence |
|---|---|---|
| FTS5 / tsvector | concept, content, tags, **questions** (new column) | questions belong in BM25, not the vector: vector+questions cost topic −9.6 |
| vector | one per whole note (unchanged) | whole note beat title and sentence pieces on NL: 42.8 vs 18.6 / 38.7 |
| entity index | exact IDs and names (exists, off by default) | identifier lookups; "unknown entity" for never-stored |
| slot table (new) | slot → current memory id, version history | §4.3 |

Schema migration: `engrams.questions TEXT` (JSON array), FTS rebuilt with the new column,
`slots(slot, agent_id, current_id, updated_at)` and `engrams.slot`. Postgres and PGlite get the same
columns; tsvector includes questions.

### 4.3 Slots: supersession without a tool call

**An explicit slot supersedes; an inferred one only suggests.** (Decision 2, §7.)

A write that names a slot supersedes the active memory holding that slot, subject to four guards:

1. **Scope.** The slot key is namespaced by workspace, agent and memory class. Two producers
   writing `deploy-command` in different workspaces, or a working note against a canonical fact,
   never touch each other.
2. **Order.** It supersedes only if it is newer: a later `valid_from` when either memory has one,
   otherwise a later write time. An older write arriving late (retries, clock skew, out-of-order MCP
   delivery) is stored as history under the slot, never as the current holder.
3. **Identity.** A slot write skips the concept-equality merge in `write-pipeline.ts:346`. The slot
   is the identity; the trust-blind closest-content match (AWM memory 547368bf, the rule a probe
   exploited) must not pick the target.
4. **Visibility.** Every supersession is reported in the write reply, and `supersedes: false`
   keeps a deliberate second fact.

When the agent gives no slot, AWM does **not** supersede on inference. It reports a suggestion in
the reply — "this may replace X (same concept, newer)" — and the agent decides. Inference becomes
automatic only after a false-supersession fixture (scope collisions, out-of-order writes,
adversarial concept matches) measures below 1%.

This is the change that addresses "superseding is a tooling problem": an agent writing
`slot: robert.flight-time` twice gets a correct history without knowing the first memory's id.

### 4.4 Enrichment: questions from the agent, or from an embedded model

**The rule (Robert, 2026-10-31, replacing the 2026-10-12 "no LLM in the write path"):** AWM may
embed a small or large language model, provided it is **embedded, not hosted**, and it **does not
make the system slow**. (Decision 1, §7; AWM memory 6f3c7c5d.)

Questions come from, in order of preference:

1. **The writing agent, at write time,** through the new `questions` field, asked for in the
   installed guidance. Free, and the agent has the most context.
2. **An embedded generator, off the hot path.** Memories missing questions go to a background
   queue in the model daemon, which generates them with a local model (ONNX through
   transformers.js, like the embedder and reranker). A write never waits for it: the memory is
   searchable at once, and its questions are indexed when they are ready. The model is chosen by
   measurement, smallest first (a doc2query T5-small class model, then a small instruction model),
   against the agent-written questions on `wq-eval.ts`; it ships only if it reaches at least
   two-thirds of the agent-written gain (NL +4 of the +6.2 on the sample) and keeps the daemon's
   resident memory within its current budget.
3. **The cognition-recipe hand-off,** for stores where the embedded generator is switched off:
   memories missing questions are handed to the calling agent on its next `memory_task_end` or
   `memory_restore`, a few at a time.

No hosted model is called from AWM.

Two deterministic guards, whichever source wrote the questions:

- **Coverage is measured.** `awm doctor` and `memory_stats` report the share of active memories
  with questions, per agent; gate calibration (§4.6) uses stored questions only where coverage is
  at least 50%, and falls back to the 0.21 probes below that.
- **A question must find its own memory.** A question is kept only if a keyword search for it
  ranks its memory in the top 10 (the Doc2Query-- filter, arXiv 2301.03266).

`awm enrich --backfill` fills an existing store through the same queue and prints the count and
an estimated time first. For reference, the experiment's questions were generated with Claude Haiku
5.5 (hosted, for measurement only) from redacted text; a reply budget of at least 1,500 tokens was
needed because the model may think first.

### 4.5 Recall

1. **Lifecycle first.** Retracted and out-of-window memories excluded; superseded ones carry the
   existing 0.15 stale factor unless the query asks about history (`as_of`, "what was", "before").
2. **Three channels** — BM25 (now with questions), vector, entity index — fused by reciprocal rank
   into a 32-candidate shortlist (0.21.1).
3. **Cross-encoder** over the shortlist, MiniLM-L6 at q8 (0.21.1; Ettin measured better on NL but
   3× slower — stays opt-in).
4. **One probability model per store,** two outputs:
   - per candidate: P(this is the answer), from the blend of cross-encoder and fused rank,
     **with the weight routed by the query's shape** (added 2026-10-31 from step 0): a natural
     question (question word, question mark, or ≥ 30% common words) blends at 0.5, a keyword lookup
     at 0.95. With questions indexed, the fused rank carries the question phrasings, so natural
     questions want it weighted more and keyword lookups still want the cross-encoder. Offline
     replay on the full store: NL 50.0 / topic 95.6 / identifier 93.5, against 44.8 / 95.6 / 93.4 at
     the single 0.85 weight. Without questions the same routing hurts NL (43.8 vs 45.9), so it ships
     only with them. Kept as the ranking until a fitted ranker beats it on all fixtures;
   - per query: P(the store holds the answer), from gate v2's eight features (cross-encoder top,
     second, vector; raw BM25 of best match; whole-store cosine top, gap, count ≥ 0.7; BM25 rank of
     the top). Answer / flag low / withhold.
5. **Trace.** Every recall can return its per-stage record (`trace: true`): candidates per stage,
   where the top result came from, the gate's features and probability. The `onStages` and
   `onRerankScores` hooks added for the experiments become the implementation.

### 4.6 Gate calibration

| Practice set | 0.21 | 0.22 |
|---|---|---|
| answerable | 150 keyword-shaped probes (title words + a unique term) | stored **questions** of sampled memories, with the memory as gold |
| never-stored | 100 mixed-title + 50 random-vocabulary | 100 mixed-title + **held-out** probes; random vocabulary dropped |
| deleted-fact | none | **held-out**: a stored question, recalled with its memory excluded (`excludeIds`, built) |

Rationale: the first live v2 run put the withhold line at −2.95 against −1.64 because random
vocabulary becomes trivially easy once density features exist (ledger §8); and the gate is
under-confident on natural correct answers because it has never seen one (ledger §4). Calibration
still runs after consolidation and on `awm calibrate`; models carry `version: 2` and a v1 model is
ignored with a one-time notice (built).

### 4.6b Answer check: a small reading model (experiment, then decide)

Every retrieval signal measures whether a memory is *about* the question; none checks whether it
*states the answer*. That is why deleted facts in familiar territory stay at 0.82–0.83 AUC whatever
the signals (ledger §4–5): the deleted fact's neighbours are still there and look like answers.

A question-answering encoder trained on SQuAD 2.0 does exactly the missing check: given a question
and a passage it returns an answer span or "no answer". It is an encoder of the cross-encoder's
class, not a generative model, and it runs on the **read** side, on the top 1–3 results only. It is embedded and local, which is
what Robert's 2026-10-31 rule requires; the speed limit below is the other half of that rule. Its no-answer score becomes one
more gate feature (and, where it finds a span, the span is the memory's quotable answer).

Before it is built:
- **Candidate models:** a SQuAD 2.0 encoder with ONNX weights transformers.js can load, as small
  as works; verify the repo and its no-answer head before measuring (the Ettin lesson: a model can
  load and score everything 0).
- **Experiment:** add its no-answer score to the gate's features offline (`prob-model.ts`) and end
  to end (`gate-eval.ts`), on both fixtures.
- **Ships only if:** NL deleted-fact AUC rises from 0.82 to at least 0.88 and NL correct answers
  withheld fall, with recall p50 rising no more than 15% (it reads 1–3 passages, not 32).
- **If it fails,** the 0.82 ceiling is stated as AWM's limit, in the docs, with this measurement.

### 4.7 Consolidation, scaled back

Keep: merge near-duplicates, link superseded versions, fade unrecalled content, redundancy prune
with its guards. Stop by default: pattern synthesis (it wrote one copy per cycle — 18,368 rows of 147
patterns — and its rows rarely reach the top; `AWM_SYNTHESIS=on` keeps it). Session synthesis stays.

### 4.8 Ranking factors: retire only what measures as inert

(Decision 3, §7.) Decay, Hebbian boosts, the graph walk and the composite score are candidates to
leave the ranking path. Evidence for: the cross-encoder decides the final top result today
(`rank-diagnose.ts`: zero cases of a boost overriding it), and the composite is the weakest ranker
measured (NL 9.8% alone). Evidence against: a synthetic associative suite scored 1.0 and credited
the graph walk and Hebbian links (AWM memory de5488c3), so the top-1 test alone is too narrow.

Each factor is removed **one at a time** and kept unless its removal moves nothing beyond noise on
**all** of: the three realstore fixtures at s@1, s@3 and s@5; the associative and multi-hop
suites; the public synthetic corpus; and recall latency. What is removed:

- the graph stays as `mode: "related"`, and the installed guidance tells agents when to use it
  ("what else is connected to this"), so the capability does not disappear by going uncalled;
- decay keeps feeding fade and archive;
- `AWM_LEGACY_RANKING=1` restores the old path for **two** releases, because a dependent pinned to
  0.21 may not upgrade within one.

### 4.9 Scaling

| | local, one agent | team / hive | large (1M+) |
|---|---|---|---|
| store | SQLite WAL | Postgres + pgvector, same schema | partition by workspace |
| vector search | brute force (≈ 3 M multiply-adds at 7.5k) | HNSW | HNSW |
| models | one shared daemon per machine (exists) | same | dedicated model service |
| enrichment | inline queue in the daemon | same | worker pool |

Recall latency is dominated by the fixed 32-pair cross-encoder pass, so it stays roughly flat as
the store grows; first-stage cost grows sublinearly with FTS and HNSW. The whole-store cosine pass
for gate v2 is replaced by the vector search's own top-50 above ~50k memories (already how the live
features are computed).

### 4.10 Evaluation as part of the product

- **Fixtures:** identifier, topic, natural-language, never-stored, deleted-fact; private snapshot
  plus the public synthetic corpus so outsiders can reproduce.
- **Baselines** on the same questions: BM25, dense, RRF — over the current store and the raw store
  (stale memories in), with the stale-top-1 rate.
- **Standing diagnostics:** `stage-diagnose.ts` (where the gold is lost), `signal-eval.ts` (what each
  signal knows), interleaved latency.
- **Release gate:** `npm run bench` fails the release if any fixture regresses beyond its noise or
  latency rises more than 10% without a CHANGELOG line; `benchmarks-current.md` and the README's
  numbers are generated from that output, not typed.

### 4.11 Profiles: the user chooses the trade-off, with the numbers in front of them

(Robert, 2026-10-31: a user may turn on a model if it is fast and the gain is shown — "this could
increase your natural language, but you would have to turn on this decision model".)

AWM ships as a set of profiles, one setting (`AWM_PROFILE`, also offered by `awm setup`), each a
named bundle of the switches that already exist or that this plan adds. Every profile is a row on
the generated benchmark page, so the README can say "turn this on and natural-language recall goes
from X to Y, at this cost" from measured numbers.

| Profile | Adds | What it buys | What it costs |
|---|---|---|---|
| `lean` | embedder + reranker (0.21.1) | keyword and topic recall at full strength | nothing new |
| `natural` | + embedded question generator in the daemon, off the hot path (§4.4) | natural-language recall (step 0 sample: +6.2 with agent-written questions) | daemon memory; background CPU after writes |
| `careful` | + answer-check reader on the top 1–3 results (§4.6b) | "does not know" past the 0.82 deleted-fact ceiling, if it passes its bar | recall latency, capped at +15% median |
| `full` | `natural` + `careful` | both | both |

A profile is only offered once its row exists on the benchmark page; until then it is not listed.
Individual env switches keep working and override the profile, so nothing an operator has set
changes underneath them.

### 4.12 Capability hand-off: the host's model does the work

AWM serves agents on any runtime — Claude Code, MWA (an agent runtime with its own decision
model), other CLIs, other platforms — all sharing one store. A host that already runs a model can
do AWM's model work with it, instead of AWM embedding one or calling a hosted service (which the
2026-10-31 rule excludes).

The cognition-recipe hand-off becomes an interface:

- A connecting host declares what it can do, once per session: `capabilities: ["questions",
  "answer-check", "skill-derivation", ...]` on `memory_restore` (MCP) or a header on the HTTP API.
- When AWM has such a job — a memory missing questions, a recall whose answer needs checking — and
  the connected host declared the capability, AWM hands the job to it (the existing recipe shape:
  a versioned prompt, a strict output contract, written back with provenance). Otherwise the
  embedded model does it if the profile enables one, otherwise the job waits.
- Results are validated the same way whoever produced them (the self-retrieval filter for
  questions, the contract shape for everything).

What this makes possible: the agent's own intelligence improves the shared memory, and the improved
memory serves every agent connected to it, on any platform — the "LLM supercharging itself with
memory it can share" framing. MWA is the first host to wire it.

## 5. What does not change

MCP tool names and existing parameters; the three storage backends; redaction and the vault; memory
classes and their salience floors; session notes; tasks and checkpoints; hooks and `awm setup`;
the hive/workspace model; the model daemon. A 0.21 store opens in 0.22 and works before backfill —
just without questions until enrichment runs.

## 6. Risks

| Risk | Mitigation |
|---|---|
| The +6.2 sample gain does not hold on the full store | step 0 measures it before anything is built |
| Generated questions are bland or wrong and pull wrong memories up | questions only in BM25 (measured safe); per-memory cap of 5; Doc2Query-style filter drops questions that do not retrieve their own memory |
| Automatic slot supersession hides a fact that was not a replacement | same agent and class only; reported in every write reply; `supersedes: false` override; `memory_supersede` history is reversible |
| Agents skip or botch the questions | coverage reported per agent; calibration falls back below 50% coverage; self-retrieval filter drops questions that do not find their memory |
| Retiring ranking factors loses something the fixtures do not test | measured per factor, with the public corpus too; `AWM_LEGACY_RANKING=1` escape hatch for two releases |
| Gate v2 still lands soft | ships only when it meets §2's gate targets end to end; otherwise v1 stays default |
| Machine memory (OOM history) during benches | one heavy job at a time; orphan check after any reaped run (AWM lesson bdf277c3) |

## 7. Decisions: recommendations, pending Robert's sign-off

Evaluated 2026-10-31 with the first-class-delivery decision process: grounded in AWM memory and the
code, challenged by an outside model (gpt-5.2-codex) for concrete production failures, each
challenge accepted or rejected with a reason.

| # | Decision | Recommendation | Why | Challenge taken |
|---|---|---|---|---|
| 1 | Enrichment default | **Agent-written first; an embedded local generator off the hot path second; recipe hand-off third; never a hosted model** | Robert's rule of 2026-10-31: embedded SLM/LLM allowed, no hosted model, speed maintained (replaces the 2026-10-12 no-LLM decision) | Uneven agent compliance → coverage metric and calibration fallback; quality drift → deterministic self-retrieval filter. Rejected: "phrasing fragments the index" — more phrasings is the gain |
| 2 | Slot supersession | **Explicit slots supersede by default; inferred slots only suggest** | The agent naming a slot is the claim; inference runs on the trust-blind concept match a probe once exploited (memory 547368bf) | Scope collisions → workspace + agent + class namespacing; out-of-order writes → newer-only rule; merge interaction → slot writes skip concept merge |
| 3 | Retire ranking factors | **Yes, one at a time, only where inert on every suite** | Boosts never change the real store's top result; composite is the weakest ranker | Top-1 too narrow → s@1/3/5 plus associative, multi-hop and public suites; "related" mode must be taught in guidance; escape hatch two releases, not one. Rejected: production query taxonomy — AWM has no telemetry by design |
| 4 | Version | **0.22.0** | 0.x minor is the semver signal for behaviour change; the NL target is unmeasured end to end; claiming 1.0 before it is met is the overclaim Robert asked us to avoid | "Behaviour changes" section in the CHANGELOG; check memory-working-agent's pin before release. Rejected: default-off for every behaviour change — the ranking change is a measured improvement on every fixture |

**1.0 criteria,** so the version means something when it comes: the write contract unchanged for
one full release; the NL target met end to end on the real store; the public reproducible benchmark
running as the release gate; slot inference measured below 1% false supersession.

## 8. Build order

Each step lands with its tests and its benchmark run; nothing proceeds on an unmeasured step.

| Step | Work | Proves | Size |
|---|---|---|---|
| 0 | Questions for every memory (generation in progress: 2,594 / 8,673); `store-wq.db`; full pipeline on all fixtures | the NL target is reachable | 1 day |
| 1 | Release 0.21.1 (ranking, corrected docs, dedup fix) — already built and tested | ship what is done | ½ day |
| 2 | Schema: `questions` column + FTS, `slots` table; migrations for SQLite, PGlite, Postgres | — | 2 days |
| 3 | `memory_write` fields, guidance, enrichment queue, `awm enrich --backfill` | write path | 3 days |
| 4 | Gate v2 calibration on stored questions + held-out probes; measure end to end | gate targets | 2 days |
| 4b | Routed blend implemented in `activation.ts` and run end to end with questions indexed | NL ≥ 50% | 1 day |
| 4c | Answer-check experiment (§4.6b): reading model's no-answer score as a gate feature | deleted-fact ceiling | 2 days |
| 5 | Ranking factors: measure removal one by one; retire what does not move a fixture | simpler core | 2 days |
| 6 | Slots: inference, automatic supersession, history queries; stale-top-1 fixture | lifecycle target | 3 days |
| 7 | Consolidation scaled back; trace output; bench as release gate; generated claims | observability | 2 days |
| 7b | Profiles (§4.11): `AWM_PROFILE`, `awm setup` choice, one benchmark row per profile | user choice with numbers | 2 days |
| 7c | Capability hand-off (§4.12): declaration on restore/HTTP, routing, validation; MWA wired as first host | shared intelligence | 3 days |
| 8 | Docs, migration guide, CHANGELOG, Linux suite, release | ship | 1 day |

About three weeks of focused work. Steps 0, 1 and 4 can start now; step 0 is blocked only on host
memory.
