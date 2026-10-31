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
| topic (450) | 92.7% | 95.8% | ≥ 95.8% |
| identifier (1,316) | 91.6% | 93.3% | ≥ 93.3% |
| recall latency, median | baseline | ≈ +21% | ≤ 0.21.1 |
| gate: NL correct answers withheld | 18 / 80 | 21 / 88 | **≤ 9 / 88** |
| gate: never-stored withheld (73) | 65 | 65 | ≥ 63 |
| gate: NL deleted withheld (97) | 69 | 60 | ≥ 60 |
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

A write that names a slot already held by an active memory of the same agent supersedes it, unless
the write says it does not (`supersedes: false` for a deliberate second fact). Slot inference when
the agent gives none, in order: an explicit `supersedes`; `correction: true`'s existing nearest-match
logic; then the concept-equality match the write pipeline already uses for merges. Inference never
supersedes across agents or across memory classes, and every automatic supersession is reported in
the write reply so the agent sees it.

This is the change that addresses "superseding is a tooling problem": an agent writing
`slot: robert.flight-time` twice gets a correct history without knowing the first memory's id.

### 4.4 Enrichment queue

When a write arrives without questions, a background job generates them. AWM contains no LLM, so
the queue uses the same pattern as the cognition recipes: it hands the generation prompt to the
calling agent on its next `memory_task_end` or `memory_restore`, or, when `AWM_ENRICH_MODEL` names
an API model, calls it directly from the daemon. Questions are generated from redacted text. A
backfill command (`awm enrich --backfill`) fills existing stores, with a cost estimate printed
first. Cost with Claude Haiku 5.5 is estimated at about a dollar per 1,000 memories (to be confirmed against the bill for step 0's run); the reply budget must be ≥ 1,500
tokens because the model may think first (half the first run came back empty at 200).

### 4.5 Recall

1. **Lifecycle first.** Retracted and out-of-window memories excluded; superseded ones carry the
   existing 0.15 stale factor unless the query asks about history (`as_of`, "what was", "before").
2. **Three channels** — BM25 (now with questions), vector, entity index — fused by reciprocal rank
   into a 32-candidate shortlist (0.21.1).
3. **Cross-encoder** over the shortlist, MiniLM-L6 at q8 (0.21.1; Ettin measured better on NL but
   3× slower — stays opt-in).
4. **One probability model per store,** two outputs:
   - per candidate: P(this is the answer), from the 0.85 / 0.15 blend of cross-encoder and fused
     rank (0.21.1), kept as the ranking until a fitted ranker beats it on all fixtures;
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

### 4.7 Consolidation, scaled back

Keep: merge near-duplicates, link superseded versions, fade unrecalled content, redundancy prune
with its guards. Stop by default: pattern synthesis (it wrote one copy per cycle — 18,368 rows of 147
patterns — and its rows rarely reach the top; `AWM_SYNTHESIS=on` keeps it). Session synthesis stays.

### 4.8 Ranking factors retired

Decay, Hebbian boosts, the graph walk and the composite score leave the ranking path. Evidence: the
cross-encoder fully decides the final order today (`rank-diagnose.ts`: zero cases of a boost
overriding it), and the composite is the weakest ranker measured (NL 9.8% alone). The graph stays,
as an explicit exploration mode (`mode: "related"`), and decay keeps feeding fade and archive. This
is measured before it ships (§8, step 5): if removing them moves any fixture by more than its noise,
they stay.

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
| API cost and privacy of enrichment | off unless configured; redaction before sending; cost estimate before backfill; agent-written questions cost nothing |
| Retiring ranking factors loses something the fixtures do not test | measured per factor, with the public corpus too; `AWM_LEGACY_RANKING=1` escape hatch for one release |
| Gate v2 still lands soft | ships only when it meets §2's gate targets end to end; otherwise v1 stays default |
| Machine memory (OOM history) during benches | one heavy job at a time; orphan check after any reaped run (AWM lesson bdf277c3) |

## 7. Open decisions for Robert

1. **Enrichment default:** agent-written questions only (free, depends on the agent), or also an API
   model when a key is configured?
2. **Automatic slot supersession on by default,** or opt-in for one release?
3. **Retire decay / Hebbian / graph from ranking** if step 5 shows no measurable effect — yes, or keep
   them as a non-default mode?
4. **Version:** 0.22.0, or call this 1.0 (new write contract, structural lifecycle, evaluated release
   gate)?

## 8. Build order

Each step lands with its tests and its benchmark run; nothing proceeds on an unmeasured step.

| Step | Work | Proves | Size |
|---|---|---|---|
| 0 | Questions for every memory (generation in progress: 2,594 / 8,673); `store-wq.db`; full pipeline on all fixtures | the NL target is reachable | 1 day |
| 1 | Release 0.21.1 (ranking, corrected docs, dedup fix) — already built and tested | ship what is done | ½ day |
| 2 | Schema: `questions` column + FTS, `slots` table; migrations for SQLite, PGlite, Postgres | — | 2 days |
| 3 | `memory_write` fields, guidance, enrichment queue, `awm enrich --backfill` | write path | 3 days |
| 4 | Gate v2 calibration on stored questions + held-out probes; measure end to end | gate targets | 2 days |
| 5 | Ranking factors: measure removal one by one; retire what does not move a fixture | simpler core | 2 days |
| 6 | Slots: inference, automatic supersession, history queries; stale-top-1 fixture | lifecycle target | 3 days |
| 7 | Consolidation scaled back; trace output; bench as release gate; generated claims | observability | 2 days |
| 8 | Docs, migration guide, CHANGELOG, Linux suite, release | ship | 1 day |

About three weeks of focused work. Steps 0, 1 and 4 can start now; step 0 is blocked only on host
memory.
