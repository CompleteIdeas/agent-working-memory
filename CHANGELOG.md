# Changelog

## Unreleased (2026-06-14) — docs: scale rationale + AWM-Native Harness pattern

Documentation only — no library code or version change. Folds into the next release.

- **README "Why it matters at scale"**: real-world token-economics from a 20,000+
  memory work agent over a ~29M-token codebase + docs project — ~2,000× fewer
  tokens per query than carrying the store (and ~5× fewer than opening the single
  best-matching doc file), supersede-tracked staleness, dead-weight-costs-nothing,
  plus an honest trade-offs section (no win on small one-shot tasks; recall latency;
  write-quality-bound accuracy; recall-first-then-verify).
- **New `docs/patterns/awm-native-harness.md`**: the AWM-Native Agent Harness
  pattern — treat AWM as an always-on cognitive *substrate* (PRIME → ACT → VERIFY →
  LEARN) so a cheap model performs at a high level and gets cheaper + better over
  time. Measured on a real domain workload: gpt-5.4-mini + AWM scored 14/15 vs a
  frontier model's 7/15 at ~1/40th the cost. README links it from the intro.

## 0.8.8 (2026-06-12) — Hermes Agent integration recipe (docs)

Documents using AWM as the memory backend for any MCP-capable agent host, with
[Nous Hermes Agent](https://github.com/NousResearch/hermes-agent) as the worked
example — **no adapter code required**.

- New `docs/integrations/hermes.md`: derived Docker image, `config.yaml`
  `mcp_servers` block, model-provider examples (Anthropic + Azure
  `azure-foundry`), a write/recall verification, `mcp_<server>_<tool>` naming,
  and gotchas (the Windows CRLF/s6 clone fix; the Azure GPT-5.x `/openai/v1`
  responses-path 404; first-call embedding-model download).
- README: new **Integrations** section with the concise Hermes how-to.

Verified on `claude-haiku-4-5` and Azure `gpt-5-4-mini`. No library code
changes.

## 0.8.7 (2026-06-10) — TOON output compression for token-efficient tool results

Adds an output-only compressor so agents can shrink large **structured tool
outputs** before they enter the context window — without changing the data or
touching the memory write/recall paths.

New module `src/core/lite-compress.ts`:

- `liteCompress(value, opts?)` encodes JSON objects/arrays as **TOON**
  (Token-Oriented Object Notation — a compact, schema-aware tabular form of
  JSON), cutting ~50–65% of tokens on uniform arrays. An A/B test on
  `claude-sonnet-4-6` and `claude-haiku-4-5` found **identical** retrieval
  accuracy reading TOON vs JSON (same scores, same misses), so the saving is
  free of comprehension cost.
- **Fidelity guard:** every encode is self-verified (`encode → decode →
  deep-equal`). TOON is emitted only when it round-trips exactly *and* clears a
  minimum-saving threshold; ambiguous cases (e.g. a string `"00123"` that would
  decode as a number) and prose fall back to JSON / passthrough.
- **CCR-lite:** verbatim originals are stashed (bounded FIFO) and retrievable by
  a `ref` handle, so the exact source is never lost.

New MCP tools in `src/mcp.ts`:

- **`compress_output`** — compress a structured tool output to TOON + `ref`.
- **`retrieve_original`** — get the verbatim source back for a `ref`.

Notes: `memory_recall` output is intentionally **not** TOON-encoded — it is
already compact prose, so the guard would simply fall back. Adds dependency
`@toon-format/toon`.

## 0.8.6 (2026-05-26) — installer template surfaces 0.8.x features to downstream agents

A behavior-driven release with no library code changes: the `AWM_INSTRUCTION_CONTENT`
template that `awm setup --global` writes into the user's CLAUDE.md was missing
guidance on the 0.8.x features. MCP tool schemas already documented the
parameters (`granularity`, `require_confidence`, `workspace`) so the model
could discover them when looking at a specific tool, but the global CLAUDE.md
— which shapes behavioral defaults — never told the agent *when* to use them.
Result: agents on 0.8.x never used compact granularity, never opted into
abstention, and didn't know about content fade or PGlite backend.

Added to `src/adapters/common.ts` (the installer's CLAUDE.md template):

- **§ Recall tuning (0.8.x — opt-in parameters)** — when to use
  `granularity: 'compact'` (scanning 5+ results), `granularity: 'auto'`
  (unknown winner), `require_confidence: 0.10–0.40` (high-stakes recall
  with opt-in abstention), and `workspace: "<name>"` (hive-mode cross-agent
  recall).
- **§ Content fade — write-and-forget is safe (0.8.x)** — un-recalled
  engrams fade their content while preserving cue pathways. Don't manually
  purge, don't over-pin with canonical, recall keeps content alive, use
  `memory_supersede` for stale facts (counter-narrative replacement carries
  associations forward).
- **§ Backend (SQLite vs PGlite, 0.8.x)** — SQLite is default + multi-process
  safe; PGlite is opt-in and single-process; auto-detect from `AWM_DB_PATH`
  shape (directory → PGlite, file → SQLite). Points to
  `docs/pglite-feature-parity.md` for the comparison table.
- **§ Diagnostics / escape hatches** — added the 0.8.x env-var knobs:
  `AWM_REINFORCE_MAX_CONTENT_LEN`, `AWM_REINFORCE_MERGE_CONTENT`,
  `AWM_NOVELTY_EMBED`, `AWM_GRANULARITY_COMPACT_LEN`, `AWM_GRANULARITY_FULL_LEN`,
  `AWM_PGLITE_BM25_M`, `AWM_IVFFLAT_PROBES`. Reorganized into
  "Recall pipeline (0.7.x)", "Write pipeline + lifecycle (0.8.x)", and
  "PGlite backend (0.8.x)" subsections.

**Roll-out note for existing 0.8.5 users:** `awm setup --global` is idempotent
and uses a section-replacement strategy that preserves surrounding CLAUDE.md
content. Existing users should re-run `awm setup --global` after upgrading to
0.8.6 to pick up the new instructions. No DB migration required — purely a
docs/template change.

**Validation:**
- `vitest run` — 561/561 pass through the template change.
- `awm setup --global` smoke test — section replaced cleanly, surrounding
  user content preserved, all four new headings present in the updated
  CLAUDE.md.

Files changed:
- `package.json` — version 0.8.5 → 0.8.6
- `src/adapters/common.ts` — 4 new sections in `AWM_INSTRUCTION_CONTENT`
- `src/mcp.ts`, `src/cli.ts`, `src/api/routes.ts` — hardcoded version strings bumped

## 0.8.5 follow-up (2026-05-26 PM) — PGlite cross-backend gap closed + production retrieval benchmark

After the initial 0.8.5 ship in the morning, a deeper investigation into the
PGlite vs SQLite recall divergence produced two surgical fixes and one new
benchmark that reframes the entire token-savings story.

**Recall-pipeline cross-backend gap (closed):** the earlier 0.8.5 ship logged
a PGlite-specific gap in `test:self` retrieval (73.3% vs SQLite 100%). Deep
trace of the actual recall pipeline showed both backends behave **identically**
— SQLite test:self at 73.3% as well, failing the same test 2.1 ("exact topic
match: 1 DB-related in top results"). The "gap" was a measurement artifact;
test 2.1 is structurally fragile (only one DB-relevant engram exists in the
corpus, so precision can't exceed 1/N) and is a test-shape issue, not a
recall-pipeline divergence. See `scripts/trace-self-test-2-1.ts`.

**Merge-on-reinforce content cap tightened:** the morning ship introduced
content merge on reinforce (so subsequent same-concept writes don't discard
their content), with cap=4000 chars and skip-on-overflow. On
concept-collision corpora (e.g. `test:tokens`, where every turn uses
`concept = "${task} ${role} conversation"`), the 4000-char cap produced
~3.5× baseline AWM context size at recall. Cap dropped to **1500 chars**
(~375 tokens) and overflow behavior changed from skip-on-overflow to
**drop-oldest-segment** (recency wins because later reinforces usually
elaborate with more specific keywords). `src/core/write-pipeline.ts`.

**Novelty combine rule — investigated, kept as MAX:** the diagnostic in
`scripts/trace-tokens-content-size.ts` showed PGlite was creating 21 active
engrams vs SQLite's 26 for the same 44-turn corpus, with PGlite engrams
averaging 2× larger because `ts_rank_cd` gives partial credit more
liberally than FTS5 BM25 (over-merging on the reinforce path). Tested
MIN combine (SQLite accuracy dropped 97.5% → 82.5%, one challenge fully
failed) and cosine-primary combine (worse on both backends: SQLite
77.5%, PGlite 82.5%). Both reverted. **MAX kept as-is** because the bloat
is a recall-output problem, not a write-novelty problem — the merged
engrams are correct memories, just verbose at output time.

**Query-aware snippet for `granularity: 'compact'`:** the existing
`granularity: 'compact'` parameter on `/memory/activate` previously did
front-truncation (first 200 chars of content). Replaced with **query-aware
snippet extraction**: tokenizes the query, finds the densest window of
matching terms in the content, returns ±100 chars around it. Falls back
to head-truncation if no query terms match. Default behavior unchanged
(`granularity: 'full'`) — opt-in via the API parameter.
`src/engine/activation.ts:770-826`.

**M-calibration sweep — investigated, abandoned:** swept
`AWM_PGLITE_BM25_M` from 1 → 50 to test if calibrating PGlite ts_rank_cd
to SQLite FTS5 BM25 distribution would close the engram-count gap.
Higher M produced more distinct engrams (22 → 25 of 26 target) BUT
also boosted BM25 scores in the **recall ranking** layer (where
`calibrateBm25` is also applied), which dropped test:tokens savings
from -23% to -78% at M=50. The knob is single — tuning it for novelty
breaks recall. Conclusion: M=1 (passthrough) stays the default; M
tuning is documented as a per-deployment escape hatch in
`docs/benchmarks.md`.

**Production retrieval cost benchmark (new):** `test:tokens` measures
AWM vs "stuff entire conversation history into context," which isn't
what real agents do. Real agents grep/read/grep until they find what
they need. New benchmark — `scripts/measure-claude-vs-awm.ts` — walks
actual Claude Code session transcripts (`~/.claude/projects/*.jsonl`),
classifies every tool call by category, and attributes
`cache_creation_input_tokens` (Anthropic's tokenizer, reported in the
transcript) proportionally to the tool categories that contributed
each turn's new content.

  **Result across 15 most recent sessions on `C:/Users/robert/project/`:**
  - `file_retrieval` (Read/Grep/Glob/Bash-find): **5,777,217 tokens / 2,743 calls = 2,106 tok/call**
  - `awm_retrieval` (memory_recall/restore/task_list): **591,366 tokens / 131 calls = 4,514 tok/call**
  - Call ratio file_retrieval:awm_retrieval = **20.9 : 1**
  - **Aggregate cost ratio = 9.8 : 1** (file retrieval costs 9.8× more in total tokens)

  Per-call AWM costs more (single recall returns 5 ranked engrams with full
  content) but the 21:1 call ratio reflects AWM replacing multi-call
  workflows. Documented in `docs/benchmarks.md` under "Production
  Retrieval Cost — Claude Code Session Audit."

**Validation (PGlite + SQLite, this session):**
- `vitest run` — 561/561 pass through every change.
- `test:self` — 95.4% EXCELLENT on both backends (test 2.1 structural failure
  on both; same root cause; not a pipeline issue).
- `test:tokens` (PGlite, MAX combine, cap=1500 + drop-oldest):
  **100% accuracy (40/40 keywords), 10/10 challenges, -23.2% savings.**
- `test:tokens` (SQLite, MAX combine, cap=1500 + drop-oldest):
  **97.5% accuracy (39/40), 10/10 challenges, +20.2% savings.**
- Token-savings metric is corpus-size-dependent and inverts at scale:
  at 44 turns, baseline is small (616 tok/challenge) so AWM's 759 looks
  worse; at 440 turns baseline would be ~6,200 tok while AWM stays
  ~800 — that's the actual win, captured by the new production-retrieval
  benchmark not by `test:tokens`.

**Files changed this session:**
- `src/core/write-pipeline.ts` — `REINFORCE_MAX_CONTENT_LEN` 4000 → 1500, drop-oldest on overflow
- `src/engine/activation.ts` — `granularity: 'compact'` now query-aware snippet
- `src/core/salience.ts` — novelty combine rule kept as MAX (tested + reverted MIN and cosine-primary)
- `docs/benchmarks.md` — new "Production Retrieval Cost" section
- `README.md` — added production-retrieval line to benchmarks table
- `scripts/measure-claude-vs-awm.ts` (new) — session-transcript analyzer
- `scripts/trace-recall-divergence.ts`, `trace-tokens-content-size.ts`, `trace-self-test-2-1.ts`, `sweep-pglite-m.ts`, `count-engrams-pglite.ts`, `measure-compact-recall.ts` (new diagnostics retained for reproducibility)

## 0.8.5 (2026-05-26) — research-grounded recall hardening + write-path rewrite

AWM 0.8.5 lands six pieces of research-grounded retrieval and lifecycle work
plus a root-cause fix for the per-write event-loop block, all **fully additive**
— every existing caller continues to work without change.

The version jump from 0.8.1 → 0.8.5 (skipping .2/.3/.4) reflects the scope:
multiple research-grounded features, a recall-quality regression root-caused
and fixed, and a write-path rewrite that takes per-write wall-clock from
300+ ms to under 10 ms of pipeline work. Not a patch-level update.

The release name is the work the agent actually does: recall is now confidence-
aware and can abstain when the result set is noisy; retraction propagates by
narrative coherence rather than uniform depth-2 decay; supersession lets the
new fact inherit the old one's coherent associations; un-recalled engrams fade
their content while preserving cue pathways; recall output adapts its verbosity
to recall quality.

**PGlite parity battery (run against AWM_STORE_BACKEND=pglite, 2026-05-26):**

PGlite ran as the production backend for the full integration battery so its
parity with SQLite is documented rather than assumed.

| Suite | SQLite | PGlite | Δ |
|---|---|---|---|
| vitest (all backends) | 561/561 | 561/561 | parity |
| vitest storage-tests (5 files) | n/a | **64/64** | PGlite-native |
| test:mcp | 5/5 | 5/5 | parity |
| test:self composite | 97.6% EXCELLENT | **95.4% EXCELLENT** | −2.2pp |
| test:ab vs baseline | AWM 89.3% vs Baseline 83.0% (+6.4) | AWM 85.0% vs Baseline 83.0% (+2.0) | AWM still wins, smaller margin |
| test:ab Fact Recall | 21/22 | **22/22 = 100%** | PGlite actually higher |
| test:perf in-process | 4/4 PASS | 4/4 PASS | parity (backend-agnostic) |
| test:sleep post-sleep | 78.6% | **85.7%** | PGlite higher (sleep cycle lift) |
| test:edge | 31/34 (91.2%) | **31/34 (91.2%)** | parity (different individual fails but same total) |
| test:pilot top-1 / top-5 | 90% / 90% | **100% / 100%** | PGlite higher recall |
| test:stress | 100% (52/52) | **100% (52/52)** | parity |
| test:tokens savings / accuracy | 62% / 42.5% | 57% / 25% | PGlite **regression on tokens accuracy** |

**Known PGlite gaps (logged for follow-up — see `tasks/#29`):**
1. `test:self` retrieval section dropped to 73.3% (1 of 3 tests fails on "exact
   topic match: 1 DB-related in top results"). Not a probes issue —
   `AWM_IVFFLAT_PROBES=5` is already set in `src/storage/pglite.ts`. Investigated
   2026-05-26: root cause is **algorithmic difference between Postgres
   `ts_rank_cd` and SQLite FTS5 BM25**, not score magnitude. For the
   short-text searches the salience filter relies on, the two algorithms
   identify different document pairs as duplicates. Constant-multiplier
   calibration (any M) preserves relative rank but doesn't cross the
   right thresholds. Real fix needs embedding-based novelty or per-backend
   salience calibration — both architectural changes deferred. The
   `calibrateBm25()` helper in `src/storage/pglite.ts` defaults to
   pass-through (M=1) and remains as a tuning surface.
2. `test:tokens` recall accuracy regressed further on PGlite (25% vs 42.5%
   on SQLite). Same root cause as #1 — PGlite's `ts_rank_cd` produces
   different BM25 magnitudes than FTS5's BM25, so the salience filter
   stages more writes (11 active / 33 staging on PGlite vs 16/28 on SQLite
   for the same 44-turn corpus). Recall then surfaces wrong content.
   Mitigation: backend-aware BM25-score normalization in `searchBM25WithRank`.
3. Coordination plugin auto-disabled on PGlite (by design — see
   [docs/pglite-feature-parity.md](docs/pglite-feature-parity.md)).
4. **Multi-process safety:** PGlite is single-process WASM. Multiple
   concurrent Claude MCP sessions against the same `memory-pglite/`
   directory cause the second process to abort. SQLite (WAL mode) is
   multi-process safe and is the recommended MCP backend until a real
   Postgres server is wired in. Documented in
   [docs/pglite-feature-parity.md](docs/pglite-feature-parity.md).

PGlite is **functional for cognitive workloads** but SQLite remains the
recommended default for write-heavy + coordination scenarios pending the
v0.9.x flip.

### Doc + code-comment freshness audit (2026-05-26)

Purged stale references introduced during the rapid v0.8.0 → v0.8.5 cycle:

- All in-code `AWM 2.0` / `AWM 2.0.x` comments updated to `AWM 0.8.x` (the
  semver under which the work actually shipped). The "AWM 2.0" codename
  survives only in `docs/awm-architecture-history.md` where it correctly
  refers to the project milestone, with a status header explaining the
  semver mapping.
- Renamed `docs/awm-2.0-architecture.md` → `docs/awm-architecture-history.md`
  and updated all internal references (`src/core/ml-worker.ts`,
  `tests/perf-test/runner.ts`).
- Feature docs (`docs/features/staging-consolidation.md`, `memory-activation.md`,
  `retraction.md`) and `docs/architecture.md`, `docs/reference.md` updated
  from `v0.8.2` → `v0.8.5` for the features that shipped in 0.8.5.
- Hardcoded version strings in `src/api/routes.ts`, `src/mcp.ts`, `src/cli.ts`,
  `src/index.ts` updated to `0.8.5` (caught two stragglers that were still
  reporting older versions).

**Validation gate (SQLite, extended battery — for reference):**
- `vitest run` — 549/549 pass (+43 net new tests across confidence,
  abstention, fade, granularity, PGlite engine integration).
- `test:self` — **97.6% EXCELLENT** composite (was 91.4% on 0.8.0).
- `test:ab` — **AWM 89.3% vs Baseline 83.0% (+6.4 pts)** — AWM now wins the
  head-to-head; 0.8.0 was a tie at 20/24.
- `test:perf` — 4/4 PASS, event-loop max-block under 1500ms on every
  scenario (in-process mode).
- `test:stress` — **100% (52/52)** across 6 phases (Baseline, Scale 500,
  100 Cycles, Catastrophic Forgetting, Bridge Formation, Adversarial,
  Recovery). Up from 96.2% on 0.8.0 baseline. (Initial 0.8.2 run had a
  Phase 2 collapse at cycle 90 caused by Phase 6 archiving engrams in the
  same cycle they faded — fixed by gating Phase 6 to `stage === 'active'`.)
- `test:sleep` — 78.6%, matches the 0.8.0 baseline curve.
- `test:edge` — 9 failure-mode suites; **3 individual checks regress** in
  Flashbulb Distortion (numeric ordering on 2 of 4 distortions) and
  Temporal Incoherence (1 of 3 backdated contradiction). The 5 other
  failure-mode suites (Identity Collision, Contradiction Trapping, Bridge
  Overshoot, Narcissistic Interference, Noise Forgetting) all pass cleanly.
- `test:pilot` — 90% top-1 hit rate, 90% top-5 (post-sleep).
- `test:mcp` — 5/5 MCP smoke tests pass.
- `test:tokens` — **62% savings (improved from 56.3%), 42.5% accuracy
  (regressed from prior 72.5%)**. Two of ten challenges return ≤16 AWM
  tokens, suggesting the integration recall path is sometimes returning
  empty/weak results on this specific corpus. Worth a follow-up
  recall-trace before publishing.
- `npm run eval` — Associative 1.000, Redundancy 0.966, Temporal 0.932 all
  hold. **Retrieval Recall@5 = 0.46 regresses from v0.6.0 baseline of 0.80**
  on the eval harness's 200-fact / 50-query corpus — likely a tuning issue
  on the vector candidate floor or vectorMatch scoring formula. Tracked
  for follow-up; the eval harness still gates 3/4 suites green.
- Build clean. TypeScript strict mode clean. No async/await regressions.

### Recall confidence as data (PR-1) — score-distribution-aware signal

A new score-distribution predictor attached to every recall result. The signal
is the *shape* of the result set, not the top-1 score in isolation. Three
complementary measures blended via weighted geometric mean:

- **Sharpness**: `top1 / mean(top5)`, mapped to [0,1] via `(s-1)/(s+1)`. A clear
  winner has high sharpness; a flat distribution has low sharpness.
- **Cliff**: `(top1 - top10) / top1`. A confident recall has a sharp drop-off
  from the winner to the tail. A noisy recall stays flat.
- **Floor**: `clamp(top1, 0, 1)`. Distinguishes "confident pick from a strong
  pool" from "best of a bad bunch" — the cliff can be sharp but the floor low.

PR-1 is **data only** — the engine attaches `confidence` to every
`ActivationResult` and the HTTP route surfaces it once per recall. Default
behavior is unchanged. Research grounding: Geifman & El-Yaniv (NeurIPS 2017),
Roitero et al (SIGIR 2022), Carmel & Yom-Tov (Synthesis Lectures 2010).

- New `src/engine/confidence.ts` with `computeRecallConfidence(scoresDesc)`.
- `ActivationResult.confidence?: number` — set on every result in a recall;
  all results in the same recall carry the *same* value (it describes the set).
- HTTP route `POST /memory/activate` surfaces `confidence` as a top-level
  response field too — useful for 0-result recalls.
- Env knobs: `AWM_CONF_SHARPNESS_W` (0.4), `AWM_CONF_CLIFF_W` (0.3),
  `AWM_CONF_FLOOR_W` (0.3).
- 8 new tests in `tests/engine/confidence.test.ts`.

### Opt-in confidence-based abstention (PR-2)

Callers who want a recall-quality gate can opt in. When `requireConfidence` is
set, the engine returns `[]` for recalls whose distribution shape falls below
the caller's threshold — independent of the legacy reranker-score abstention
(`abstentionThreshold`). Either gate trips abstains.

- New `ActivationQuery.requireConfidence?: number`. Typical values: `0.10`
  strict (only abstain on clearly noisy queries), `0.25` balanced, `0.40`
  aggressive.
- Wired through HTTP (`POST /memory/activate`) and MCP (`memory_recall`).
- 6 new tests in `tests/engine/abstention.test.ts` including the "best of bad
  bunch" trap.

### Coherence-weighted retraction (#18) — narrative-coherence decay

The retraction confidence-propagation penalty is no longer uniform. Penalty
weight to each neighbor is scaled by the local *neighborhood cohesion*:

```
multiplier = 0.5 + cohesion       // range: [0.5, 1.5]
cohesion   = density × (0.5 + 0.5 × tagOverlap)
```

Dense, topically-coherent neighborhoods (a narrative cluster) get a higher
multiplier — when the seed is wrong, the surrounding cluster is more likely
to be wrong too. Hub structures (a popular node with many unrelated edges)
get a lower multiplier — the central node being wrong doesn't impeach its
heterogeneous neighbors.

Research grounding: Carrillo et al, "Continued Influence Effect in
Misinformation Correction" (ICCM 2025).

- New `src/engine/retraction.ts:computeNeighborhoodCohesion(seedId)`.
- `retract()` return type extended with `cohesion: NeighborhoodCohesion` so
  callers can introspect the propagation behavior.
- Existing tests + new coherence tests in
  `tests/engine/coherence-retraction.test.ts`.

### Counter-narrative replacement on supersede/correction (#19)

When a retraction creates a `counterContent` correction, the new engram
inherits the original's `'connection'` edges (skipping `invalidation`,
`causal`, and `temporal` which are correction-specific or directional).
Inherited edges land at `0.7 ×` the original weight, capped at 10 inheritances.

This implements the "counter-narrative replacement" mechanic from the CIE
literature: the corrected fact takes over the structural role of the wrong
fact in the graph, rather than leaving the corrected fact disconnected.

- `retract()` return type extended with `narrativeEdgesInherited: number`.
- New constants in `src/engine/retraction.ts`: `NARRATIVE_INHERIT_WEIGHT_SCALE`
  (0.7), `NARRATIVE_INHERIT_MAX` (10), `NARRATIVE_INHERIT_MIN` (0.4 weight
  floor), `NARRATIVE_INHERIT_SKIP_TYPES`.
- 7 new tests in `tests/engine/coherence-retraction.test.ts` cover inherit,
  weight scale, threshold, type filter, retracted-skip, cap-at-10, no-counter.

### Content fade stage (#20) — Paper 1: PLOS Comp Biology storage degradation

Adds an intermediate `'fading'` lifecycle stage between `'active'` and
`'archived'`. Once-useful but stale engrams (accessed at least once, no
access in 45+ days, content > 250 chars) get content trimmed to 150 chars
plus a `… [faded]` marker. Concept, tags, and embedding are preserved so
the engram still participates in BM25 + vector recall — with less body to
score against.

Models how human memory loses surface detail while retaining cue-association
pathways. Heavily-used (`accessCount >= 10`), `canonical`, `structural`, and
retracted engrams are excluded.

- New stage `'fading'` on `EngramStage` (`src/types/engram.ts`).
- New store method `updateContent(id, content)` on both SQLite and PGlite.
- New consolidation phase **5.5: Content fade** runs before forgetting
  (`src/engine/consolidation.ts`).
- `searchByVector` on both backends now matches `stage IN ('active', 'fading')`
  so faded engrams still surface in semantic recall.
- New `ConsolidationResult.memoriesFaded` counter.
- Singleton-engram agents no longer short-circuit consolidation — the cluster
  phase is gated by `engrams.length >= 2`, but per-engram phases (fade, forget,
  confidence drift, staging sweep) still run.
- Env knobs: `AWM_FADE_DAYS_SINCE_ACCESS` (45), `AWM_FADE_KEEP_CHARS` (150),
  `AWM_FADE_MIN_CONTENT_LEN` (250), `AWM_FADE_MAX_PER_CYCLE` (25).
- 9 new tests in `tests/engine/content-fade.test.ts`.

### Merge-on-reinforce: accumulate content instead of discarding

`reinforceMatched()` in `src/core/write-pipeline.ts` now merges the new
write's content into the existing engram (separator
`\n\n--- reinforced ---\n`) and re-embeds the merged content. The old
behavior — bump confidence + access count, throw away the new write's
content — lost information whenever the agent restated the same topic
with new detail later in a conversation.

**Why this matters:** the `test:tokens` corpus uses
`concept = "${task} ${role} conversation"`, so all 6 auth-assistant turns
share the same concept. With the old reinforce behavior, only the 1st
auth-assistant turn's content survived (a generic "I'll set up JWT auth
with jsonwebtoken..." preamble). The 4th turn's HS256 detail and the 6th
turn's "access tokens (15 min) + refresh tokens (7 day)" answer — the
exact content Auth-JWT recall is checking for — got thrown away.

Skip conditions (no append):
- New content is already a substring of existing content (true repeat).
- Merged would exceed `AWM_REINFORCE_MAX_CONTENT_LEN` (default 4000 chars).
  At that point the engram has enough info; confidence + access count
  still bump.

Disable via `AWM_REINFORCE_MERGE_CONTENT=0` (reverts to pre-0.8.5 behavior).

**Measured impact:**
- `test:tokens` accuracy, SQLite: 45.0% → **97.5%** (+52.5pp).
- `test:tokens` accuracy, PGlite: 27.5% → **100%** (+72.5pp — closes the entire gap).
- `test:tokens` token savings drop (engrams now carry more content):
  - SQLite: 61.2% → 20.2% savings (still positive)
  - PGlite: 58.6% → -33.5% savings (now slightly above baseline)
- `vitest`: 561/561 pass. No regressions.

The savings drop is the cost of the accuracy gain — preserved content
means the recall returns more text. The original token-savings claim
was achievable only because reinforce was silently throwing data away.

### Dual-signal novelty: BM25 ∨ cosine (max), with correction override

The salience filter's novelty signal now uses both lexical and semantic
matching — `matchScore = max(BM25, cosineSimilarity)`. The cosine channel
fires whenever the caller passes an embedding (which `performWrite` now does
by pre-embedding once before novelty check, then passing through to
`createEngram`). When the caller omits the embedding, the function falls
back to BM25-only — fully backward-compatible.

**Why both:**
- BM25 catches verbatim duplicates, identifier-driven matches, and recall-
  output reingestion (the original design rationale).
- Cosine catches paraphrased duplicates, vocabulary-drifted restatements,
  cross-role rephrasings (user question → assistant answer about the same
  fact). Particularly valuable for LoCoMo-style multi-session paraphrasing.
- The two signals catch different failure modes; combining maximizes recall
  of duplicate-detection while preserving the strengths of each.

**Cross-backend consistency:** the embedding model (BGE-small) is identical
on SQLite and PGlite — so cosine novelty produces identical scores on both
backends. The salience filter's disposition decisions (active / staging /
discard) are now backend-agnostic. Verified empirically via
`scripts/trace-salience.ts`: same novelty score and same disposition on
every write across both backends.

**Correction-signal override:** when `eventType === 'surprise' | 'friction'`
*and* a matched engram exists (R3 supersession path), disposition is forced
to `'active'` regardless of salience score. Without this override, cosine's
correct identification of "this correction is semantically similar to the
engram it's correcting" would push the correction's salience low → staging
disposition → broke the R2 superseder-reinforce chain for later writes. The
user's explicit correction intent must win over the duplicate-detection
signal.

**Measured impact:**
- `test:tokens` recall accuracy (SQLite): 42.5% → **45.0%** (+2.5pp).
- `test:tokens` recall accuracy (PGlite): unchanged at 27.5%. Salience
  dispositions now match SQLite but PGlite's activation pipeline still
  produces different rankings — gap relocated to activation, see task #29.
- Write latency cost: ~50-100ms added (pre-embed). Replaces what was
  previously fire-and-forget post-write embed. Net cost: same total work.

**Code changes:**
- `src/core/salience.ts:computeNoveltyWithMatch` — accepts optional
  `embedding` arg, computes both channels, max-combines, returns engram
  from winning signal. Backward-compat: BM25-only path when embedding omitted.
- `src/core/write-pipeline.ts:performWrite` — pre-embeds once
  (`AWM_NOVELTY_EMBED=0` to disable), passes embedding to novelty +
  createEngram, skips post-create async embed when embedding is already set.
- `src/core/write-pipeline.ts:performWrite` (R3 branch) — overrides
  disposition to `'active'` for correction signals.
- New `scripts/trace-salience.ts`, `scripts/debug-supersede-test.ts`,
  `scripts/measure-bm25.ts` — diagnostic tooling kept for future investigation.

### Backend auto-detect + warn-don't-fail (upgrade safety)

`src/storage/factory.ts` now auto-detects the storage backend from on-disk
state when `AWM_STORE_BACKEND` is unset. Existing users on `memory.db` no
longer need to set anything — AWM finds the file and opens it as SQLite.
Users who migrated to PGlite have a `memory-pglite/` directory and the
factory picks that up automatically.

When `AWM_STORE_BACKEND` is explicit but the on-disk state disagrees (env
says pglite but only `memory.db` is present with data), `openStore` prints
a one-line stderr warning suggesting `awm migrate`. The configured backend
still wins — we never silently switch behind the user's back.

Suppress the warning with `AWM_SUPPRESS_BACKEND_WARNINGS=1`.

- New auto-detect logic in `factory.ts:detectBackendFromDisk()`.
- New `warnIfBackendDisagreesWithDisk()` in `openStore`.
- 7 new tests in `tests/storage/factory.test.ts` covering the four
  precedence rules (env → memory-pglite/ → memory.db → fresh) and the
  AWM_DB_PATH shape inference.
- See `docs/pglite-feature-parity.md` for the full SQLite ↔ PGlite parity
  audit (7 SQLite-only code paths, all gracefully gated; effort estimates
  for porting each to PGlite; roadmap from 0.8.x → 1.0).

### Connection-discovery moved to consolidation cycle (write-path rewrite)

Per-write connection discovery has been removed. Each `memory_write`
previously enqueued a background `findConnections()` call — a full
activation cycle (embed + BM25 + vector + cross-encoder rerank) per write,
~200-500 ms of event-loop blocking queued ahead of the next request. Under
load this manifested as writes appearing to hang for seconds.

The work now batches into the existing sleep-cycle consolidation as
**Phase 0** of `ConsolidationEngine.consolidate()`. Discovery runs on the
cron/quiescence-gated schedule already established for consolidation, so
there's no per-write cost and no idle work when AWM sits unused.

**Cold-start exception:** when the agent has fewer than
`AWM_CONNECTION_COLD_START_THRESHOLD` (default 10) active engrams, callers
can opt into inline drain via `enqueueAndMaybeFlush()` so the first few
writes still produce a useful association graph before the next
consolidation cycle fires. Once the pool grows past the threshold, all
discovery defers to consolidation.

**Measured impact:** in-pipeline write work dropped from prior measurements
of 300+ ms to **2-6 ms** with `AWM_PROFILE_WRITE=1` instrumentation:

```
[awm-write] action=create novelty=1.5ms create=1.4ms total=2.9ms agent=x id=y
[awm-write] action=create novelty=1.2ms create=0.8ms total=2.1ms agent=x id=y
```

- Modified `src/engine/connections.ts` — `enqueue()` no longer auto-triggers;
  added `enqueueAndMaybeFlush()` for cold-start; `processQueue()` exposed
  publicly with reentry guard.
- Modified `src/engine/consolidation.ts` — `ConsolidationEngine` constructor
  now takes optional `connectionEngine?`; Phase 0 drains the queue at the
  start of every consolidation pass.
- Modified `src/core/write-pipeline.ts` — uses `enqueueAndMaybeFlush()`;
  `AWM_PROFILE_WRITE=1` env-gated stderr timing log.
- Modified `src/mcp.ts`, `src/index.ts` — pass `connectionEngine` into the
  ConsolidationEngine constructor.
- Removed `src/storage/pglite.ts:transaction()` — known-deadlocking wrapper
  (callback ignored the `tx` argument); unused; moved `transaction` to the
  SqliteSpecificMethods set in `store.ts` since SQLite still has the sync
  version for back-compat.
- New `tests/engine/connections-defer.test.ts` — 5 tests covering enqueue
  no-trigger, cold-start drain, post-threshold defer, consolidation drain,
  reentry safety.
- Env knobs: `AWM_CONNECTION_COLD_START_THRESHOLD` (10),
  `AWM_PROFILE_WRITE` (off by default).

### Recall@5 root-cause fix — entity-bridge clone inversion

A previously-undiagnosed Recall@5 regression on the eval harness's 200-fact
/ 50-query corpus turned out to be the Entity-Bridge boost (Phase 3.7 in
the activation pipeline). The boost rewards candidates that share entity
tags with the top text-match anchors but **excludes** the anchors
themselves. In a corpus with many near-clones per concept (eval has 10
clones per concept; production-style structured data is often similar),
the genuine top-1 is one of the anchors and gets no boost, while the 8-9
other clones each get +0.30-0.40 from sharing the same tags. Net: the
non-anchor clones overtake the genuine match. Only 1 of N clones is the
ground truth → Recall@5 collapses to ~1/N.

**Fix:** proportional gating. The bridge boost magnitude now scales with
the textMatch gap between candidate and anchor:

```
gapRatio = (anchorTextMatch - candidateTextMatch) / anchorTextMatch  // clamped [0, 1]
bridgeBoost = sharedEntities × 0.15 × gapRatio  // capped at 0.4
```

- Candidates near the anchor's textMatch (clones — the inversion case) →
  near-zero boost.
- Candidates far below the anchor (genuine lateral relevance: different
  content, shared entities) → full boost.

Preserves the original "she said X → boost candidates connected to X"
intent while preventing the clone-inversion failure mode.

- Modified `src/engine/activation.ts` — Phase 3.7 gate.
- Env override `AWM_DISABLE_ENTITY_BRIDGE=1` to skip the phase entirely
  (last-resort escape hatch if the proportional gate doesn't fit some
  future corpus shape).
- Eval Retrieval Recall@5: **0.46 → 0.980** post-fix.
- Secondary fix in `src/storage/{sqlite,pglite}.ts`: BM25 sanitize regex
  changed from `.replace(/[^\w\s]/g, '')` to `.replace(/[^\w\s]/g, ' ')`.
  Old behavior turned `PROJ-1000` → `PROJ1000` (joined) which couldn't
  match FTS5's separator-split index tokens. New behavior splits to
  `PROJ 1000` matching the index. Worked in isolation but the
  entity-bridge bug was the dominant factor.

### Adaptive output granularity (#21) — Paper 3: Brill 2018 ACT-R cognitive teaming

Recall responses now adapt their output verbosity to recall quality, trading depth
for breadth based on how confident the engine is in a clear winner. Same engrams,
less to read when the agent should be scanning a diverse set.

- New `granularity?: 'full' | 'compact' | 'auto'` on `ActivationQuery`.
  - `'full'` (default): no change, existing callers unaffected.
  - `'compact'`: every result carries a `summary` field truncated to
    `AWM_GRANULARITY_COMPACT_LEN` chars (default 200).
  - `'auto'`: confidence-adaptive. When `recall confidence ≥ AWM_GRANULARITY_AUTO_THRESHOLD`
    (default 0.4), the top result gets a `AWM_GRANULARITY_FULL_LEN`-char summary
    (default 1000) and lower-ranked results get compact summaries. When confidence
    is lower, all results get compact summaries.
- New optional `summary?: string` on `ActivationResult` — engine-computed,
  confidence-aware. The engram body itself is never modified.
- HTTP route `POST /memory/activate` accepts `granularity` (forwarded to the engine).
- MCP `memory_recall` tool accepts `granularity` and surfaces `summary` to text-rendered
  results when set.
- 8 new tests in `tests/engine/granularity.test.ts`.

## 0.8.1 (2026-05-22) — control-layer for worker outputs

AWM 0.8.1 adds three production primitives to the coordination layer to reduce
the 11.5% failure-with-no-retry rate (81/703 assignments lost). All changes are
**fully additive**: 0.5.x, 0.7.x, and 0.8.0 clients continue to work without
modification.

### What's new

- **FailureMode taxonomy** (`src/coordination/failure-modes.ts`) — seven-category
  enum (`agent_stale`, `timeout`, `output_invalid`, `test_fail`, `lint_fail`,
  `merge_conflict`, `unknown`) with a `classifyFailure(result)` classifier and a
  `MUTATION_HINTS` map of corrective guidance injected into retried task descriptions.

- **Mutation-hint retry in `cleanupStale`** — orphaned assignments now retry up to
  3 times before being permanently failed. Each retry appends a mode-specific hint
  block to the task description so the next worker has corrective context. New helper
  `retryOrFailAssignment()` is also callable from the voluntary-fail endpoint.

- **`POST /assignment/:id/fail`** — workers can voluntarily fail an assignment
  (with a result string and optional mode override) to trigger the same retry logic
  without waiting to go stale.

- **Per-worker CircuitBreaker** (`src/coordination/circuit-breaker.ts`) — tracks
  consecutive failures per worker in the new `coord_circuit_state` table. Opens at 5
  consecutive failures; auto-transitions to `half_open` after 30 s; resets to `closed`
  on any successful completion. Both `/next` and `/channel/push` refuse to dispatch to
  open-circuit workers (HTTP 423).

### Schema changes (additive)

- `coord_assignments` — two new columns: `attempt_count INTEGER DEFAULT 0`,
  `last_failure_mode TEXT NULL`. Added via `try/catch` ALTER TABLE migration.
- `coord_circuit_state` — new table (CREATE IF NOT EXISTS).

## 0.8.0 (2026-05-17) — substrate primitives for long-form structured memory

AWM 0.8 introduces five new HTTP endpoints, three query operators, a fourth
`memory_class` value, and two optional engram columns — all of which enable
substrate-grade structured memory for long-running creative and technical
projects. Every change is **fully additive**: 0.5.x and 0.7.x clients
continue to work without modification.

The work was developed against [NovelForge](https://github.com/CompleteIdeas/novelforge),
a novel-writing platform whose 36,000-word "Drawdown" test bed proved out
the substrate pattern — chapter summaries, narrative promises, emotional
state per character, and motif phases tracked across 18 chapters with no
LLM-side drift. The substrate primitives generalize beyond fiction to any
long-running structured project (codebase state, design docs, ops incidents).

**Full eval-suite validation (2026-05-17):**
- `test:run` — 384/384 unit tests pass (43 new for 0.8 across clusters)
- `test:self` — 91.4% composite, EXCELLENT grade
- `test:stress` — 52/52 across 6 phases (100%)
- `test:ab` — AWM 20/24 = Baseline 20/24 (matches; beats baseline on architecture)
- `test:pilot` — matches March-25 baseline exactly
- `test:sleep` — healthy consolidation curve (71.4% → 78.6%)
- Zero regressions across every comparable benchmark.

### What's new

**Four new HTTP endpoints** consolidate substrate-style reductions that
previously had to be done client-side:

  - `POST /memory/latest-by-tag` — for each distinct value of a tag key,
    return the most-recent active engram. Single SQL `GROUP BY` instead of
    list-all + Python reduce. Used for "latest emotional state per
    character", "latest motif phase per motif", "latest commit per branch".

  - `POST /memory/top-by` — filter by tag-set operators, sort by numeric
    value extracted from a tag prefix, return top N. Used for "top 40
    active promises by weight excluding advancements", "highest-severity
    open bugs", etc.

  - `POST /memory/resolve` — compute effective state of an engram from
    referenced events. Returns `active | resolved | subverted | abandoned
    | superseded` plus the resolving event chain. Used for "did this
    requirement get addressed?", "is this promise still open?".

  - `GET /memory/sequence/:agentId/next` — race-free atomic increment via
    `BEGIN IMMEDIATE`. Used for story-time / chronology assignment.

**One extended endpoint:**

  - `POST /memory/supersede` Form B — new alternative shape that performs
    a single atomic `{matchConcept, newEngram}` write-and-supersede in one
    SQL transaction. Form A (by engram IDs) unchanged. Distinct from R3
    corrections-override: Form B fires on different-concept supersession
    by reference, R3 on same-concept self-correction.

**Three query operator extensions** on `POST /memory/search`:

  - `tagsAll: string[]` — explicit AND (alias for legacy `tags`)
  - `tagsAny: string[]` — OR (at least one)
  - `tagsNone: string[]` — NOT (exclude all)
  - Composition: `result = tagsAll ∧ (tagsAny[0] ∨ ...) ∧ ¬(tagsNone[0] ∨ ...)`.
    Empty arrays skip the clause.
  - New `sortBy: "createdAt" | "sequence" | "salience" | "confidence" |
    "lastAccessed"` with `sortOrder: "asc" | "desc"`. Default behavior
    preserved when `sortBy` is unspecified (`lastAccessed DESC`).

**New `memory_class: "structural"`** — system-written event-log records:
  - Salience floor 0.7 like `canonical` (bypass filter, never staged)
  - **Excluded from cognitive `/activate` by default** (opt in via
    `includeStructural: true`); excluded from temporal-adjacency graph;
    no embedding by default (opt in via `embed: true` on write)
  - For high-volume deterministic substrate where cognitive retrieval is
    noise rather than signal — e.g. one engram per chapter per character
    per motif. The salience bypass keeps every record; the cognitive
    exclusion keeps `/activate` clean for canonical authoritative facts.

**Two new optional engram columns:**

  - `sequence INTEGER NULL` — story-time / chronology field, separate
    from `createdAt`. Indexed via partial index (only non-NULL rows).
    NULL by default; existing engrams unaffected.
  - `references_json TEXT NULL` — typed cross-record links
    (`advances | resolves | subverts | abandons | extends | supersedes`),
    stored as JSON. Wired through `POST /memory/write` body's
    `references: Array<{ type, matchEngramId?, matchConcept?, matchTags? }>`.
    AWM resolves `matchConcept → matchEngramId` at write time when
    possible, giving a stable link that survives concept renames.

**New `EngramStore` methods** for embedded users:

  - `findActiveMatchByConcept(agentId, concept, requiredTags?)` —
    case-insensitive trimmed concept match, excludes superseded /
    retracted / non-active.
  - `transaction<T>(fn)` — wrap arbitrary multi-write logic atomically.
  - `getLatestByTag(opts)`, `getTopBy(opts)`, `resolveEffectiveState(id)`,
    `allocateNextSequence(agentId)` — backing the new HTTP endpoints.

### Migration notes

- All schema additions are `ALTER TABLE ... ADD COLUMN ... NULL` —
  non-destructive. Existing engrams continue to load with `sequence:
  NULL` and `references: null`.
- The new `structural` enum is opt-in. Existing `canonical`, `working`,
  `ephemeral` writes are unchanged.
- New endpoints are NEW paths; existing endpoints' bodies grew with
  optional fields only.
- NPM consumers of 0.7.x upgrade with `npm install agent-working-memory@0.8.0`
  without code changes.

### 0.8 Cluster C — materialized-view + atomic-counter endpoints

Four new HTTP endpoints that consolidate substrate-style reductions
previously done client-side. Fully additive — no existing endpoint changes.

- **`POST /memory/latest-by-tag`** — for each distinct value of `tagKey`
  (e.g. `"character="`), return the most recent active engram. Optional
  `scopeTagsAll` narrowing, `sortBy: "createdAt" | "sequence"`, `limit`.
  With `sortBy: "sequence"`, engrams without a sequence are excluded.

  Replaces NovelForge's `_gather_latest_emotional_states` /
  `_gather_latest_motif_phases` Python reductions (1 call instead of
  list-all + reduce).

- **`POST /memory/top-by`** — filter by `filterTagsAll` /
  `filterTagsAny` / `filterTagsNone`, sort by numeric value extracted from
  a tag prefix (`sortField: "weight="`), return top N. NaN values sort last.

  Replaces NovelForge's `_gather_active_promises` (1 call instead of
  list-all + filter + sort + slice).

- **`POST /memory/resolve`** — compute the effective state of an engram
  from referenced events. Returns
  `{ engram, effectiveState, resolvingEvents }`. States:
  - `superseded` if `supersededBy` is set
  - `resolved` / `subverted` / `abandoned` if a reference with that
    relation type points at this engram (latest by `createdAt` wins)
  - `active` otherwise

  Two targeting modes: `targetEngramId` or `matchConcept` (+ optional
  `matchTags`). Same concept-match semantics as Form B's
  `findActiveMatchByConcept`. Replaces NovelForge's Option-C client-side
  cross-reference filter.

- **`GET /memory/sequence/:agentId/next`** — race-free next-sequence
  allocator. Returns `{ agentId, next }`. Caller writes the engram with
  the returned value. Atomic via `BEGIN IMMEDIATE` transaction; concurrent
  callers serialize without conflict.

- **New `EngramStore` methods:** `getLatestByTag`, `getTopBy`,
  `resolveEffectiveState`, `allocateNextSequence`, plus a private
  `extractTagValue` helper for tag-prefix→value extraction.

- 15 new tests in `tests/core/cluster-c-endpoints.test.ts`. Full suite:
  384/384 passing (was 369 in Cluster D).

### 0.8 Cluster D — supersede Form B + references[] on /memory/write

Atomic single-call write-and-supersede by concept match, plus typed
cross-record links on the standard write path. Fully additive — Form A
(by engram IDs) unchanged.

- **`POST /memory/supersede` Form B** — atomic alternative form:
  ```json
  {
    "agentId": "string",
    "matchConcept": "string",
    "matchTags": ["topic=promise"],
    "newEngram": {
      "concept": "string", "content": "string",
      "tags": [...], "memory_class": "structural"
    },
    "reason": "..."
  }
  ```
  Single SQL transaction: find most recent active match by case-insensitive
  trimmed concept equality (+ optional tag intersection), write new engram
  via `performWrite`, link via causal association + 20% confidence decay
  on the old + `supersedeEngram`. If no match found: write new engram
  anyway, return `{ superseded: null }`. Returns `{ newEngram, superseded,
  supersededBy, reason }`.

- **Form A vs Form B detection** by field presence: `oldEngramId`+`newEngramId`
  → Form A; `agentId`+`matchConcept`+`newEngram` → Form B; both → 400.

- **`references[]` body field on `/memory/write` and `/memory/write-batch`**
  — `Array<{ type, matchEngramId?, matchConcept?, matchTags? }>` with relation
  types `advances | resolves | subverts | abandons | extends | supersedes`.
  When `matchConcept` is given without `matchEngramId`, AWM resolves it to
  the most recent active engram at write time and stores both — gives a
  stable link that survives concept renames. No match found → stores just
  `matchConcept`, preserving the writer's intent.

- **Distinct from 0.7.17 R3** (corrections override on surprise/friction +
  same-concept). R3 fires on same-concept self-correction; Form B fires on
  different-concept supersession by reference. Both supported.

- **`EngramStore.transaction<T>(fn)`** helper exposed for callers needing
  multi-write atomicity (used by Form B route handler).

- **`EngramStore.findActiveMatchByConcept(agentId, concept, requiredTags?)`**
  new helper — case-insensitive trimmed concept match, excludes superseded
  + retracted + non-active stage. Used by Form B and reference resolution.

- 7 new tests in `tests/core/supersede-form-b.test.ts`. Full suite:
  369/369 passing (was 362 in Cluster B).

### 0.8 Cluster B — set-theoretic tag operators + sortBy on /memory/search

Extends `/memory/search` and `store.search()` with composable tag set
operators and explicit sort control. Fully additive — existing callers
using `tags: string[]` continue to work unchanged.

- **`tagsAll: string[]`** — explicit AND. Alias for legacy `tags`. If both
  are passed, both apply (intersection of intersections).

- **`tagsAny: string[]`** — OR. Engram must have at least one of these tags.

- **`tagsNone: string[]`** — NOT. Engram must have none of these tags.

- Composition: `result = tagsAll ∧ (tagsAny[0] ∨ ...) ∧ ¬(tagsNone[0] ∨ ...)`.
  Empty arrays skip the clause (vacuous truth).

- **`sortBy: 'createdAt' | 'sequence' | 'salience' | 'confidence' | 'lastAccessed'`**
  with **`sortOrder: 'asc' | 'desc'`**. Default behavior preserved
  (`lastAccessed DESC` when sortBy is unspecified).

- `sortBy: "sequence"` puts NULL last regardless of direction so engrams
  without a story-time value don't shuffle into the middle.

- 14 new tests in `tests/storage/search-operators.test.ts`. Full suite:
  362/362 passing (was 348 in Cluster A).

### 0.8 Cluster A — schema + structural memory_class

Foundation work for the 0.8 substrate primitives spec
(`docs/0.8-substrate-primitives-spec.md`). Fully additive — no breaking
changes for 0.7.x callers.

- **New `memory_class: "structural"`** — system-written event-log records.
  Behaves like `canonical` for salience (0.7 floor, always active) but is
  **excluded from cognitive `/activate` by default**, **skips temporal-
  adjacency edges**, **skips episode assignment**, and **skips default
  embedding** (opt in with `embed: true`). Reason code `class:structural`.

- **`sequence INTEGER NULL` column on `engrams`** — optional story-time /
  chronology ordering. Partial index `idx_engrams_agent_sequence` keeps
  cost low. Surfaced through `/memory/write` body `sequence?: number`.
  Used by Cluster B `sortBy: "sequence"` and Cluster C `/memory/latest-by-tag`.

- **`references_json TEXT NULL` column on `engrams`** — schema slot for
  typed cross-record links. `EngramReference[]` type with relations
  `advances | resolves | subverts | abandons | extends | supersedes`.
  Wired through `performWrite` and `createEngram`; HTTP body surface comes
  in Cluster D.

- **`performWrite` accepts `sequence`, `references`, `embed` parameters**
  — caller controls story-time, typed links, and embedding opt-in.

- Migrations are additive `ALTER TABLE ADD COLUMN` with NULL defaults.
  Existing engrams untouched. Auto-migrate runs on `EngramStore`
  construction.

- 7 new tests in `tests/core/structural-class.test.ts`. Full suite: 348/348
  passing (was 341/341 in 0.7.17).


## 0.7.17 (2026-05-12) — unified write pipeline

Introduces a shared write-time pipeline that implements three rules
distinguishing AWM as a "memory" system (selective retention) rather than
"storage" (retrieve-all). Both the HTTP `POST /memory/write` route and the
MCP `memory_write` tool now delegate to the same implementation.

### The three rules

  - **R1 — Reinforce on duplicate.** Repeat = stronger memory. When a new
    write shares the EXACT same concept as an existing engram, boost that
    engram's confidence (+0.05, capped at 0.95) and increment its
    access_count instead of creating a near-duplicate.

  - **R2 — Pick the RIGHT match.** Skip the matched engram if it's
    already superseded, in non-active stage, or has unhealthy confidence
    (<0.3). If it was superseded, reinforce the *superseder* instead so
    corrections strengthen over time rather than the original wrong fact.

  - **R3 — Corrections override.** When the write has `eventType` in
    `['surprise', 'friction']` AND matches the same concept as an existing
    engram, the new write supersedes the matched engram (rather than
    reinforcing it). Fresh truth beats old habit.

### Critical implementation detail

The match-vs-create pivot is **concept equality**, not raw novelty.
A draft of this change used `novelty < 0.65` and collapsed 419
conversation turns into 7 engrams during LoCoMo testing because turn
content all shares session/speaker prefix language ("[session_3] Caroline:
...") and BM25 over-matched. Recall coverage dropped 0.342 → 0.168.
Switching the gate to case-insensitive concept equality restored coverage
to 0.342 with zero false reinforces, while still firing correctly for
agent-summary writes that legitimately repeat the same concept (schema
discoveries, correction writes, working-query patterns).

### MCP bug fixed in passing

The MCP path previously had a partial reinforce-on-duplicate
implementation gated on `matchScore > 0.85`, but `matchScore` is the
raw BM25 score (typically ~0.0001 in this implementation, not normalized
to 0..1). That gate was unreachable — the reinforce branch never fired
in practice. The unified pipeline replaces it with a working
concept-equality gate that respects all three rules.

### Public API additions

  - `core/write-pipeline.ts` exports `performWrite(engines, input)` for
    downstream embedded users. Engines `{ store, connectionEngine }` and
    `WriteInput` (agentId, concept, content, tags, eventType, etc.).
    Returns `WriteResult` with `action: 'create' | 'reinforce' | 'supersede'`,
    the resulting engram, salience result (null for reinforce), novelty
    info, and reinforce/supersede metadata.

  - HTTP `POST /memory/write` response now includes an `action` field
    matching the three action values. Action `'reinforce'` returns HTTP
    200 (not 201) with `stored: false` and reinforcement detail.

### Environment knobs

  - `AWM_WRITE_PIPELINE=off` — disable reinforce/supersede branching at
    the pipeline level. Reverts to always-create behavior. One-knob
    revert for regression isolation.

### Tests

  - `tests/core/write-pipeline.test.ts` covers all four branches:
    create / reinforce / supersede / chain-walk-to-superseder, plus the
    flag-off revert and the user_feedback auto-canonical path. 7 tests
    green. Full regression suite (331 tests) still passes.

### Fix: `memory_class` HTTP route regression

`POST /memory/write` lost the `memory_class` field from its body schema
during the 0.7.x refactor, even though `core/salience.ts` and
`core/write-pipeline.ts` (line 77) still expect and honor it. HTTP callers
passing `memory_class: 'canonical'` were silently downgraded to the
default `working` class — losing the salience-floor bypass that canonical
memories rely on. The MCP path and the storage layer were unaffected.

Restored the field in the route's body type and pass it through to
`performWrite()` as `memoryClass`. NovelForge, the first known
high-volume HTTP caller writing structured substrate engrams, depends on
this for its ~270 canonical writes per 18-chapter book.

## 0.7.16 (2026-05-10) — doc release

### Instruction content updates (no retriever change)

`AWM_INSTRUCTION_CONTENT` (the system prompt installed by `awm setup --global`)
gets two new sections aimed at agents that consume AWM:

1. **Writing for recall** — explicit guidance that a memory's recall quality
   is determined at write time. Lead with the rule/fact, pick the most specific
   topic, include 2+ retrievable identifiers (file paths, function names, IDs),
   write in the vocabulary of the future query, reserve canonical for stable
   invariants, include the why for feedback memories.
2. **Recall strategy** — formalizes the multi-query reformulation behavior
   observed in practice. When one query returns nothing, agents should
   reformulate (synonyms, more specific nouns, exact identifiers). Recall is
   ~300ms — two-three reformulations cost less than one filesystem search.
   Cap at three reformulations to prevent loops.

These document the writer + reader behaviors AWM was always designed around
but were previously implicit. Encoding them in the system prompt materially
improves recall quality without any retriever change.

### What was tried and reverted

This release originally included two mode-aware retriever changes (wider
candidate pool for exploratory queries, relaxed agreement gate). LoCoMo
benchmarking showed these regressed adversarial precision 86.8% → 78.7%
without meaningful open-domain gain (26.2% → 23.1% overall). Both changes
reverted in this release; retriever is identical to 0.7.15.

The decision: AWM's existing speed/precision profile (~300ms recall, 86.8%
adversarial) is the right corner for the cheap-LLM force-multiplier use case.
Chasing benchmark recall at the cost of precision is the wrong optimization
target — single-query benchmarks like LoCoMo don't measure what AWM actually
does in production (multi-query reader strategy + writer cooperation).

### Tests

All 334 tests pass.

## 0.7.15 (2026-05-08)

### Documentation refresh — full coverage of 0.7.6→0.7.14 perf work

Documentation-only release that ships the updated CLAUDE.md install template
to every install via `awm setup --global`. No functional code change.

### What changed

**`src/adapters/common.ts` — `AWM_INSTRUCTION_CONTENT`** — the diagnostics /
escape-hatches section now lists all four perf-related env-vars instead of
just `AWM_DISABLE_POOL_FILTER`:

- `AWM_DISABLE_POOL_FILTER` (0.7.7+)
- `AWM_DISABLE_SLIM_CACHE` (0.7.10+)
- `AWM_DISABLE_RERANK_SKIP` (0.7.10+)
- `AWM_DISABLE_EXPANSION_CACHE` (0.7.11+)

Also adds context: agents see "in production, leave these all unset; use only
when diagnosing a suspected recall-quality regression."

**`docs/troubleshooting.md`** — "Very slow activation queries" rewritten for
the 0.7.14 reality (floor ~300ms, typical 400-700ms warm). Adds a section
clarifying that `memory_stats` reports a 24h rolling avg that lags upgrades.

**`docs/quickstart.md`** — "first conversation will be slower" reworded to
distinguish the one-time model download (~30s, once per machine) from the
~3s cold-start cost paid on the first recall after each process start.

**`docs/user-guide.md`** — example `/health` response updated from `v0.3.0`
to current 0.7.x output.

**`docs/claude-code-setup.md`** — `Avg recall latency` example updated from
180ms to 400ms warm + ~3s cold.

### Upgrade path for existing installs

```bash
npm install -g agent-working-memory@latest
awm setup --global   # rewrites CLAUDE.md with the updated env-var doc
# restart Claude Code
```

### Tests

All 334 tests pass.

## 0.7.14 (2026-05-08)

### Recall Latency Round 8 — Batched cross-encoder + passage truncation + eager cache warm

Three fixes that drop the recall floor to **~300ms** — a 37× speedup vs the
0.7.4 baseline of 11s.

### Fix 1: Batched cross-encoder inference (`src/core/reranker.ts`)

Previously the reranker tokenized + ran the model **once per passage**,
serializing 15-30 inference calls. Now all query-passage pairs go through
one tokenizer call + one model forward pass.

**Direct measurement (15 passages × 50 chars):** 27ms vs 210ms (~7× faster).

Falls back to the per-passage loop if the batch path errors (e.g. model
doesn't support batched text_pair).

### Fix 2: Truncate passages before rerank (`src/engine/activation.ts`)

Previously passed full `engram.content` (some 5000+ chars) to the reranker.
The cross-encoder has a 512-token max and pads to the longest passage in
the batch, so full content meant everything padded to ~512 tokens.

Truncating each passage to `concept + content[:400]` drops tokenization +
inference cost 3-4× on long memory pools. The first 400 chars + concept
carry the core relevance signal — full content was wasted on the reranker.

### Fix 3: Eager slim-cache populate at startup (`src/index.ts`)

Previously the first user recall after process start paid a ~600ms one-time
cost to populate the slim cache. Now the AWM coordinator warms the cache
in `setImmediate` after model preload — invisible to users.

Added `EngramStore.warmSlimCache()` (public) and `getSlimCacheStats()` for
diagnostics.

### End-to-end measurement

| Query | 0.7.13 | 0.7.14 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 756ms | 411ms | -46% |
| "Education LMS architecture programs certifications" | 842ms | 336ms | -60% |
| "short query" | 339ms | 304ms | -10% |
| "Stripe webhook handler..." | 691ms | 595ms | -14% |
| "sprint current work completed findings pending" | 781ms | 646ms | -17% |

**Cumulative since 0.7.4 baseline:** 11s → ~300-650ms (~25-37× faster).

### Recall quality preserved

A/B test (8 diverse queries):
- 8/8 top-1 results identical
- 4.50/5 top-5 overlap (was 4.63 in 0.7.13)
- 9.38/10 top-10 overlap (was 9.50)

Slight top-5/10 reordering is from passage truncation reordering some
candidates. Top-1 is rock solid.

### Tests

All 334 tests pass.

## 0.7.13 (2026-05-08)

### Recall Latency Round 7 — Reranker pool size reduction

After 0.7.12, phase-breakdown showed the cross-encoder reranker was 210-265ms
(60-70% of recall floor). Cross-encoder cost scales linearly with passage
count, and the previous pool of `max(limit*3, 30)` reranked 30 candidates
even when the user only wanted top-5 or top-10.

### Fix: tighter rerank pool

**`src/engine/activation.ts`** — pool size reduced from `max(limit*3, 30)` to
`max(limit*2, 15)`. For typical agent queries with `limit=5` or `limit=10`,
that's 15-20 candidates instead of 30. Halves the cross-encoder cost.

The smaller pool also means more queries hit the rerank-skip "smallPool"
condition (small + cleanWinner), saving the full 210ms when triggered.

### Recall quality preserved

A/B test (8 diverse queries):
- 8/8 top-1 results identical
- 4.63/5 top-5 overlap (unchanged from 0.7.12)
- 9.50/10 top-10 overlap (unchanged)

When the user requests top-5 or top-10, reranking the 21st-30th candidates
is wasted work — those candidates won't appear in the result anyway.

### Measured impact

Avg savings: ~50-100ms per recall (varies by query type).

| Query | 0.7.12 | 0.7.13 |
|---|---|---|
| short query | 393ms | 339ms |
| Stripe webhook | 691ms | 691ms |
| Education LMS | 774ms | 842ms (noise) |

### Tests

All 334 tests pass.

## 0.7.12 (2026-05-08)

### Recall Latency Round 6 — Aggregate stats instead of full association objects

After 0.7.11, phase-breakdown showed `getAssociationsForBatch` over ~300 survivors
took 222ms (25% of recall floor). The scoring loop only reads `count` and
`sumWeight` from the associations — never any other field. Materializing
thousands of full Association objects is wasted work.

### Fix: `getAssociationStatsForBatch`

**`src/storage/sqlite.ts`** — new method that returns scalar stats per engram:

```typescript
getAssociationStatsForBatch(engramIds: string[]):
  Map<string, { count: number; sumWeight: number }>
```

Single SQL aggregate via `GROUP BY` over a `UNION ALL` of from + to endpoints.
Same semantics as the prior bucketed approach (each association contributes to
both endpoints' stats), 10× cheaper.

**`src/engine/activation.ts`** — Phase 3b uses stats instead of full assocs:

```typescript
const stats = assocStats.get(engram.id) ?? { count: 0, sumWeight: 0 };
const rawHebbian = stats.count > 0 ? stats.sumWeight / stats.count : 0;
const centralityBoost = stats.count > 0 ? Math.min(0.1, 0.03 * Math.log1p(stats.sumWeight)) : 0;
```

Graph walk still needs full associations, but it operates on top-N (~30
candidates) — its on-demand `getAssociationsFor` lookups total ~5ms.

### End-to-end measurement

Floor dropped to ~400ms (short query); median ~750ms.

| Query | 0.7.11 | 0.7.12 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 1352ms | 785ms | -42% |
| "Education LMS architecture programs certifications" | 1437ms | 774ms | -46% |
| "short query" | 976ms | 393ms | -60% |
| "Stripe webhook handler..." | 1362ms | 691ms | -49% |
| "sprint current work completed findings pending" | 1967ms | 836ms | -57% |

**Cumulative since 0.7.4 baseline:** 11-23s → ~400-850ms (~25× faster median).

### Recall quality preserved

A/B test (8 diverse queries):
- **8/8 top-1 results identical**
- 4.50/5 top-5 overlap (vs 4.63 in 0.7.11 — within noise)
- 9.50/10 top-10 overlap (vs 9.63 in 0.7.11)

Identical hebbian/centrality scoring (same formulas, same data, just
aggregated in SQL instead of JS). Top-K differences come from rerank-skip /
expansion-skip interactions, not the assoc-stats change.

### Tests

All 334 tests pass.

## 0.7.11 (2026-05-08)

### Recall Latency Round 5 — Query expansion skip + LRU cache

After 0.7.10, query expansion (flan-t5-small) was 164ms per call (18% of recall
floor). Two-pronged fix in `src/core/query-expander.ts`:

1. **Skip heuristic** — long or specific queries (>50 chars OR ≥5 distinct
   meaningful tokens) skip the expander entirely. Already-narrow queries
   gain little from synonym expansion; flan-t5's general-vocabulary terms
   add noise more than recall.

2. **LRU expansion cache** — `Map<normalized_query, expanded_query>` with
   500-entry capacity. Cache hit ≈ 0ms vs 164ms cold. Map insertion-order
   gives free LRU semantics (re-set on hit moves to most-recent).

Disable both via `AWM_DISABLE_EXPANSION_CACHE=1`.

### Measured impact

- ~30% of typical queries hit the skip heuristic (long/specific) → -164ms each
- Repeated queries (same agent re-recalls same topic) hit cache → -164ms each
- Average savings: -100 to -150ms per recall

### Recall quality preserved

A/B test (8 diverse queries):
- **8/8 top-1 results identical**
- 4.63/5 top-5 overlap, 9.63/10 top-10 overlap

The slight top-10 dip vs 0.7.10 (9.75 → 9.63) is within noise — the queries
that skip expansion still find the same canonical results via BM25 and cosine.

### Tests

All 334 tests pass. Build clean.

## 0.7.10 (2026-05-08)

### Recall Latency Round 4 — In-memory slim cache + reranker skip

After 0.7.9, phase-breakdown showed the slim fetch was still 310ms cold per
recall (Buffer→Float32Array conversion of 10K embeddings on every call) and
the cross-encoder reranker was 354ms (40% of recall floor). Two more fixes.

### Fix 1: In-memory slim cache (`src/storage/sqlite.ts`)

**`EngramStore.slimCache`** — `Map<engramId, SlimCacheEntry>` populated lazily
on first `getEngramsByAgentSlim()` call. Subsequent calls iterate the Map
in-process, skipping SQL + Buffer conversion entirely.

**Cache invariants:**
- Lazy-populated on first slim fetch (one ~300-700ms cost at startup)
- Updated on every mutation: `createEngram`, `updateStage`, `updateEmbedding`,
  `retractEngram`, `deleteEngram`. Cache hooks live in the same methods that
  run the SQL.
- ~22 bytes overhead per entry plus the 1.5KB embedding → ~15MB at 10K engrams,
  ~150MB at 100K. Acceptable for a long-running AWM coordinator.
- Disable via `AWM_DISABLE_SLIM_CACHE=1` for A/B testing.

**Measured:** slim fetch 306ms → **5ms** with warm cache (~60× faster).
Two-pass total (slim + hydrate-200): 314ms → **29ms** (~11× faster).

### Fix 2: Reranker skip on clear winners (`src/engine/activation.ts`)

The cross-encoder is most useful when BM25 returns ambiguous matches. When
BM25 already has a clear winner, the cross-encoder rarely changes the top
result and burns ~300ms.

**Skip heuristic (conservative):**
- top-1 textMatch ≥ 0.8 (high BM25 + jaccard agreement), AND
- top-1 score is ≥ 1.5× top-2 score (clear separation), AND
- rerankPool size ≤ `max(limit*2, 20)` (small pool — reranker has less to do)

When all three conditions hit, skip the reranker. Otherwise it still runs.
Disable the heuristic via `AWM_DISABLE_RERANK_SKIP=1`.

### Recall quality preserved

A/B test on 8 representative queries:
- **8/8 top-1 results identical** (was 8/8 in 0.7.9)
- **avg 4.63/5 top-5 overlap** (was 4.75/5)
- **avg 9.75/10 top-10 overlap** (unchanged)

The slight top-5 reordering reflects cases where the cross-encoder would have
reordered candidates that are all relevant. Top-1 stability is what matters
for cognitive recall, and that's preserved.

### Cumulative recall latency (0.7.4 → 0.7.10)

| Version | Floor | Median |
|---|---|---|
| 0.7.4 (baseline) | 11s | 18s |
| 0.7.6 (BM25 CTE) | 1.8s | 2.5s |
| 0.7.7 (pool reduction) | 0.9s | 1.6s |
| 0.7.9 (two-pass fetch) | 0.9s | 1.4s |
| 0.7.10 (slim cache + rerank skip) | **0.7s** | **0.9s** |

**Total: 11s → 0.9s, ~12-15× faster.** Recall is now sub-second on a 10K-engram
corpus. Cold start for the cache is one ~600ms penalty per AWM coordinator
process; all subsequent recalls hit the cache.

### Tests

All 334 tests pass. Build clean. Slim cache invariants are exercised by the
existing engram CRUD test suite (createEngram, updateStage, etc. all flow
through the cache hooks).

## 0.7.9 (2026-05-08)

### Recall Latency Round 3 — Two-pass fetch (slim → hydrate survivors)

**Why:** After 0.7.7's pool reduction, phase-breakdown showed `getEngramsByAgent`
fetching all 10K active engrams was the new bottleneck (440ms = 40% of recall).
Most of that cost was row materialization of `content`, `tags`, and JSON columns
the pre-filter doesn't read. The pre-filter only needs `(id, concept, embedding)`.

### Fix: two-pass fetch

**`src/storage/sqlite.ts`** — three new methods:

- `getEngramsByAgentSlim(agentId, stage, includeRetracted)` — returns
  `{id, concept, embedding}` only. Avoids materializing content/tags/JSON for
  rows that will be filtered out.
- `getEngramsByAgentsSlim(agentIds, ...)` — multi-agent variant for workspace
  recall.
- `getEngramsByIds(ids[])` — chunked IN-clause hydration of full rows by ID.
  Used to load the full Engram only for survivors that pass the pool filter.

**`src/engine/activation.ts`** — Phase 3 refactored to:
1. **Pass 1 (slim):** fetch all active engrams as slim rows, run cosine similarity
   and pool filter on this minimal payload.
2. **Pass 2 (hydrate):** fetch full Engram rows only for survivor IDs (typically
   100-300, vs the 10K full rows fetched before).

The pool filter logic itself is unchanged — same survival criteria, same
`AWM_DISABLE_POOL_FILTER=1` escape hatch. Only the fetch strategy changed.

### End-to-end measurement

| Query | 0.7.7 | 0.7.9 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 1640ms | 1222ms | -25% |
| "Education LMS architecture programs certifications" | 2160ms | 1502ms | -30% |
| "short query" | 1413ms | 1017ms | -28% |
| "Stripe webhook handler transfer.paid Connect destination charges" | 1791ms | 1144ms | -36% |
| "sprint current work completed findings pending" | 1688ms | 1599ms | -5% |

**Cumulative since 0.7.4 baseline:** 11-23s → ~1.0-1.6s (~10-20× faster).

Recall floor for cheap queries is now ~1.0s.

### Recall quality preserved (and slightly improved)

A/B test on 8 representative queries:
- **8/8 top-1 results identical**
- **avg 4.75/5 top-5 overlap** (was 4.50)
- **avg 9.75/10 top-10 overlap** (was 9.38)

The slight improvement vs 0.7.7 is likely from more deterministic candidate
ordering through the explicit ID-set + hydrate pipeline.

### Tests

All 334 tests pass.

## 0.7.8 (2026-05-08)

### Documentation + install template — settings & rules for the new behaviors

This release ships only documentation/install changes — no functional code change.
A version bump is needed so `awm setup --global` reaches existing installs with
the updated CLAUDE.md template that teaches agents about the 0.7.5/0.7.6/0.7.7
behaviors.

### `AWM_INSTRUCTION_CONTENT` extended (the template `awm setup` writes to CLAUDE.md)

**`src/adapters/common.ts`** — added three sections to the agent instructions:

- **Memory classes** — `canonical | working | ephemeral`, when to use each, and the
  hive-multi-agent rule that cross-agent writes must use `canonical`.
- **Salience auto-promotion** — explains the two patterns the salience filter
  auto-promotes (`detectUserFeedback` for stakeholder quotes, `detectVerifiedFinding`
  for operational records with action-verb + concrete IDs). Defense in depth — agents
  shouldn't rely on it for important writes.
- **Diagnostics / escape hatches** — `AWM_DISABLE_POOL_FILTER=1` documented as an
  A/B testing hatch if a recall regression is suspected.

Also added a "before stating any fact, recall first" guidance and a note that recall
is fast (~1s) so agents shouldn't ration recalls.

### Env var table extended

**`README.md`** — added `AWM_COORDINATION`, `AWM_DISABLE_POOL_FILTER`, `AWM_WORKSPACE`
to the environment variables table.

### Troubleshooting guide

**`docs/troubleshooting.md`** — added "very slow recall on 0.7.7+" and "recall returning
slightly different top-K than before 0.7.7" entries with the disable hatch.

### Hive agent rules (in this repo only — not shipped via npm)

`.claude/agents/coordinator.md`, `dev-lead.md`, `worker.md` — added auto-promotion
backstop note and the latency claim update so hive agents know:
1. Always set `memory_class: canonical` explicitly for shared writes
2. The auto-promote patterns are a backstop, not the primary mechanism
3. Recall is now ~1s (so don't avoid it for perceived cost)

### Upgrade path

For existing installs:
```
npm install -g agent-working-memory@latest
awm setup --global   # rewrites CLAUDE.md with the new instructions
```
Restart Claude Code to pick up the new CLAUDE.md.

## 0.7.7 (2026-05-08)

### Recall Latency Round 2 — 2.5s → 1.0s end-to-end (~50% on top of 0.7.6)

**Why:** Phase-breakdown spike (`spike/phase-breakdown.ts`) showed that after the
0.7.6 BM25 fix, the new dominant cost was `getAssociationsForBatch` over all
~10K candidates: **1518ms / 2226ms total = 68% of recall latency**. Most of those
candidates had zero text relevance and would score below the relevance gate
(`textMatch > 0.1`) anyway — so fetching their associations and tokenizing their
full content was wasted work.

### Pool reduction — pre-filter before deep scoring

**`src/engine/activation.ts`** — added a cheap pre-filter pass before the
batch-association fetch. Candidates survive into deep scoring only if they have:

1. **BM25 hit** (`bm25Score > 0`), OR
2. **Cosine z-score above the gate** (would produce non-zero vectorMatch), OR
3. **Concept-token overlap** with the query (cheap — concept is short)

Anything else gets dropped before the expensive phase. From ~10K candidates
down to typically 100-300 survivors. Graph walk preserves correctness because
it only boosts neighbors whose own `textMatch >= 0.05` — and any candidate
meeting that floor would also pass this filter.

### End-to-end measurement

| Query | 0.7.6 | 0.7.7 | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | 2683ms | **1143ms** | -57% |
| "Education LMS architecture programs certifications" | 2801ms | **1554ms** | -45% |
| "short query" | 2494ms | **884ms** | -65% |
| "Stripe webhook handler transfer.paid Connect destination charges" | 2642ms | **1146ms** | -57% |
| "sprint current work completed findings pending" | 2685ms | **1225ms** | -54% |

**Cumulative since 0.7.4 baseline:** 11-23s → 0.9-1.6s (~10-15× faster).

### Recall quality preserved

A/B test (`spike/recall-quality.ts`) on 8 representative queries:
- **8/8 top-1 results identical**
- **avg 4.50/5 top-5 overlap** (90%)
- **avg 9.38/10 top-10 overlap** (94%)

The few reorderings happen at the bottom of top-K and swap between memories
that are all relevant — typically a re-rank, not a recall miss.

### Escape hatch

Set `AWM_DISABLE_POOL_FILTER=1` to revert to the pre-0.7.7 path. For A/B
testing or if a regression appears in production. Same recall semantics,
just slower.

### Tests

All 334 tests pass. New `spike/phase-breakdown.ts` and `spike/recall-quality.ts`
captured for future regression diagnosis.

## 0.7.6 (2026-05-08)

### Recall Latency — 11-23s → 2.5s end-to-end

**Why:** 24h telemetry showed activate() floor of 11-23s with p95 of 257s. Initial
hypothesis was vector-search cost (cosine over 17K vectors). Measurement spike
revealed the actual culprits:

1. **BM25 JOIN materialized too early.** SQLite's planner ran FTS5 MATCH, then
   joined ALL matching rows with engrams (including 1.5KB embedding blobs per
   row), then sorted by rank, then applied LIMIT. With wide OR queries on a
   17K-engram corpus, that's thousands of materializations before the LIMIT fires.
   - Pure SQL test (better-sqlite3 12.6.2, SQLite 3.51.2):
     - Original query: **3682ms** for `"USEF" OR "results" OR "submission" OR "Staff" OR "Services"`
     - CTE-prefilter rewrite: **6.5ms** (567× faster)
   - Same SQLite, same data — pure plan rewrite.
   - Equivalence verified: top-30 results identical, ranks identical.
2. **N+1 association lookups.** `getAssociationsFor` called once per candidate
   (10K+ calls per recall) accumulated 1300ms of per-call overhead.

### Fix 1: CTE-prefilter BM25

**`src/storage/sqlite.ts`** — `searchBM25WithRank` and `searchBM25WithRankMultiAgent`
now use a Common Table Expression to force FTS5 LIMIT before the engrams JOIN:

```sql
WITH top_fts AS (
  SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
)
SELECT e.*, top_fts.rank FROM top_fts
JOIN engrams e ON e.rowid = top_fts.rowid
WHERE e.agent_id = ? AND e.retracted = 0
ORDER BY top_fts.rank LIMIT ?
```

The inner LIMIT (5× outer LIMIT, min 50) over-fetches to give headroom for the
agent + retracted filter applied after the CTE.

### Fix 2: Batch association lookup

**`src/storage/sqlite.ts`** — added `getAssociationsForBatch(engramIds[])` which
chunks IDs into IN-clause queries (400 per chunk to stay under SQLite's
SQLITE_LIMIT_VARIABLE_NUMBER) and returns a Map keyed by engram id.

**`src/engine/activation.ts`** — Phase 3b scoring loop now batch-fetches
associations once per recall instead of per-candidate.

### End-to-end measurement

`activate()` benchmarked on production memory.db (17K engrams, 133K associations):

| Query | Before | After | Δ |
|---|---|---|---|
| "USEF results submission Staff Services" | ~5400ms | 2683ms | -50% |
| "Education LMS architecture programs certifications" | ~3100ms | 2801ms | -10% |
| "short query" | ~2400ms | 2494ms | flat |
| Wide-OR floor (telemetry) | 11000-23000ms | 2500-2800ms | **~5× faster** |

The remaining ~2.5s is dominated by query expansion (flan-t5-small) and the
per-candidate scoring loop over 10K candidates. Pool reduction (filter to
relevant subset before deep scoring) is a follow-up — it's a behavioral change
and needs its own evaluation.

### Tests

All 334 existing tests pass. Equivalence test verifies top-30 BM25 results are
identical between old and new queries (same IDs, same ranks).

### Investigation artifacts

`spike/` directory contains the measurement scripts used to localize the
bottleneck:
- `recall-phases.ts` — phase-instrumented activate()
- `bm25-only.ts` — better-sqlite3 vs SQL plan isolation
- `bm25-equivalence.ts` — top-K equivalence check
- `activate-e2e.ts` — end-to-end production-path timing

## 0.7.5 (2026-05-07)

### Salience Filter — Auto-Promote Verified Operational Records

**Why:** 24h telemetry review surfaced a salience filter gap: verified operational
records (batch summaries, completion reconciliations, incident triages) were
being discarded at 0.14 because they share terminology with prior session
memories — BM25 novelty couldn't distinguish "useful new operational record"
from "duplicate observation." Specific case: a 6-event USEF results submission
summary 2026-05-07 was discarded at salience 0.14 despite naming concrete event
IDs and dates that future-recall would care about. The procedural memory
written 90 seconds later (same topic, "how to" framing) scored 0.70.

### New: `detectVerifiedFinding(content)` auto-promoter

**`src/core/salience.ts`** — pattern detector parallel to `detectUserFeedback()`.

Pattern requires BOTH:
1. An action-verb header — Submitted, Finalized, Completed, Reconciled, Triaged,
   Posted, Resolved, Stamped, Pushed, Deployed, Migrated, Imported, Exported,
   Backfilled.
2. At least 2 concrete identifiers — absolute dates (YYYY-MM-DD) OR contextual
   numeric IDs (event/ticket/comp/usef/usea/class/case/order/payment + digits).

**Behavior on match:**
- Bumps `eventType` from 'observation' to 'decision' (typeBonus +0.15)
- Applies salience floor of 0.45 (active disposition)
- Tags with reasonCode `auto:verified_finding`
- Does NOT promote to canonical — operational records are verified, not source-of-truth

**Distinction vs `detectUserFeedback`:**
- User feedback (e.g., "Robert said X") → canonical, salience floor 0.7
- Verified finding (e.g., "Submitted 6 events 2026-05-07 — IDs 18969, 18971...") → working, salience floor 0.45

### Tests

**`tests/core/salience.test.ts`** — 7 new test cases covering pattern matching
(USEF batch, Freshdesk triage), pattern rejection (no verb, no IDs, empty input),
end-to-end disposition (low-novelty operational record → active not discard),
and confirms ordinary observations still discard.

23 salience tests pass; full core suite (56 tests) green.

### Known issue: recall latency

Same telemetry review found activate() floor of 11-23s (warm) with outliers
extending to 11+ minutes. Outliers correlate with multiple MCP server startups
in rapid succession (5 startups in 13s on 2026-05-08 02:10 UTC). Root cause:
SQLite WAL contention when concurrent Claude Code sessions all spawn MCP
channel-server instances and hammer memory.db simultaneously. Not addressed
in this release — needs a launcher-side fix to debounce MCP startups.

## 0.7.4 (2026-05-06)

### Channel Push — Telemetry + Role-Based Addressing + Stale Cleanup

**Why:** Production sessions reported "agents alive but not seeing each other for work."
Cyber-investigation revealed three concrete failures:
1. Channel push delivery had no observability — no way to measure failure rates.
2. Workers can't notify the coordinator after a coordinator restart because the
   coordinator's UUID changes (cleanSlate marks all agents dead, fresh agentId
   on next checkin) — workers had no way to address "the coordinator" abstractly.
3. `cleanupStale` existed but was only invoked manually; zombie agents
   accumulated between coordinator sessions until /stale/cleanup was hit.

### New: `GET /telemetry/channels` + Prometheus counters

**`src/coordination/routes.ts`** — process-scoped counters around channel push:

| Counter | What it tracks |
|---|---|
| `attempts` | Every call to `deliverToChannel` |
| `delivered` | Fetch returned 2xx |
| `failed_http` | Fetch returned non-2xx (worker reachable, rejected) |
| `failed_unreachable` | Fetch threw (timeout, ECONNREFUSED) — session marked disconnected |
| `no_session` | Push intent existed but no connected session for that agent |
| `fallback_mailbox` | Live delivery failed, message queued to coord_mailbox |
| `session_disconnects` | Sessions marked 'disconnected' after delivery failure |

JSON endpoint `GET /telemetry/channels` returns counters + `delivery_rate` + per-agent
`push_count`/`last_push_at`/`status`. Prometheus scrape `GET /metrics` exposes:
`coord_channel_push_attempts_total`, `..._delivered_total`,
`..._failed_total{reason="http|unreachable"}`, `..._no_session_total`,
`..._fallback_mailbox_total`, `..._session_disconnects_total`.

Counters reset on coordinator restart (process-scoped) — intended for short-window
observability. Persistent counters require a `coord_metrics` table, deferred until
we know which series are worth keeping.

### New: Role-based addressing on `POST /channel/push`

**`src/coordination/schemas.ts` + `src/coordination/routes.ts`** — `channelPushSchema`
now accepts either `{agentId, message}` (existing) OR `{role, workspace, message}`
(new). Server resolves role+workspace via:

```sql
SELECT id FROM coord_agents
WHERE role = ? AND workspace = ? AND status != 'dead'
ORDER BY last_seen DESC LIMIT 1
```

This lets workers notify the coordinator without hardcoding its UUID. Use case:
worker pushes `COMPLETED <assignment_id>: result` to `role:"coordinator"` after
finishing a task — coordinator wakes immediately and chains the next assignment.

Returns 404 with descriptive error if no alive agent matches role+workspace:
```
{"error":"No alive agent found for role='coordinator' workspace='WORK'"}
```

Returns 400 (Zod) if neither `agentId` nor `role+workspace` provided.

### New: `cleanupStale` runs on a 5-minute schedule

**`src/coordination/index.ts`** — `cleanupStale(db, 600)` now fires every
5 minutes via setInterval. 600s threshold is forgiving for long edits (workers
should pulse every 60s during active work; 10 min silence means genuinely dead).
Logs `[stale-cleanup] auto-cleaned N stale agent(s), M resource(s) released`
when cleanup happens.

Without this, only an explicit `POST /stale/cleanup?seconds=N` call (made by the
coordinator agent on startup) ever fires cleanupStale, leaving zombie agents
accumulating between coordinator sessions.

### New: `user_feedback` salience event type + auto-detect

**`src/core/salience.ts`** — direct user-stated content was getting
discarded by the BM25 novelty floor when it shared terminology with prior
memories ("LMS", "ECP", project terms). A pivotal user UX decision was lost
this way.

**Fix** — two-part:

1. New `SalienceEventType` value `'user_feedback'` with bonus 0.3 (highest of
   any event type — outranks decision/causal/friction).

2. Auto-detect at the top of `evaluateSalience`:
   ```typescript
   const USER_FEEDBACK_PATTERN =
     /^(Robert|Katherine|Catherine|Nancy|Brandy|Brandi|Hannah|Marilyn|Kaylee|
        Pete|Abby|Tom|Wendy|Sita|Nick|Rob|Joan|Jennifer|Cindy|Jason|Alex|Molly)
       \s+(said|verbatim|feedback|asked|wants|prefers|requested|directed|
            decided|confirmed|clarified|chose|specified|explained)\b/i;
   ```
   When content matches, eventType is forced to `'user_feedback'` and
   memoryClass to `'canonical'` (which provides salience floor 0.7).

Reason code `auto:user_feedback` surfaces when the auto-promote fires.

Pattern is intentionally conservative — anchored to start of content, requires
both name and a feedback verb, word boundary on the verb. "Roberta said good
morning" doesn't match (different name); "...as Robert said earlier..." doesn't
match (not at start).

Tunable: extend the staff name list as new staff join.

## 0.7.3 (2026-05-05)

### Salience Filter — Production Tuning

**Bug:** In a populated DB (>10K engrams), the novelty calculation pinned at the
0.10 floor for almost every write. Root cause was the linear curve
`novelty = max(0.10, 1 - topScore)` combined with BM25's `|rank|/(1+|rank|)`
normalization, which puts even loosely-related matches at topScore ≥ 0.9.
Result: most worker writes scored salience ~0.17 (below the 0.4 active threshold,
above the 0.2 staging threshold), bunched 86% of all engrams at salience 0.5
across the database, and made the salience signal effectively dead.

**Fix** (`src/core/salience.ts`):
- Quadratic dampening on the novelty curve: `novelty = max(0.05, 1 - topScore²)`.
  Mid-range matches now produce mid-range novelty instead of collapsing to floor.
- Concept-match penalty reduced from 0.4 to 0.3 and **scoped to last 30 days**.
  Re-using a concept name for a different topic months later is no longer punished.
- Floor lowered from 0.10 → 0.05 so true duplicates can clearly score below the
  staging threshold (0.2) and discriminate.
- Same fix applied to `computeNoveltyWithMatch` for consistency.

Curve comparison (topScore → new novelty):
- 0.30 → 0.91 (different topic — strong signal)
- 0.60 → 0.64 (loosely related — partial credit)
- 0.80 → 0.36 (related but distinct)
- 0.95 → 0.10 (near-duplicate — still suppressed)

### Maintenance Scripts (new)

- **`scripts/prune-backups.cjs`** — keeps all backups from last 24h plus the most
  recent N older snapshots (configurable via `AWM_BACKUP_KEEP`, default 6).
  Manual snapshots (`memory-pre-*`, `memory-safety-*`) are preserved for human
  curation. Supports `--dry-run`. Run hourly via cron / Task Scheduler.
- **`scripts/evict-stale.cjs`** — drops working-class engrams that meet ALL of:
  salience < 0.30, access_count < 2, last_accessed older than 90 days, not the
  head of a supersession chain, agent not in protected list (default
  `claude-code`). Uses cascading delete: associations first, then engrams, then
  FTS rebuild. Supports `--dry-run`. Run weekly or monthly.
- **`scripts/cleanup-2026-05-05.cjs`** — one-shot pruner used to reset the prod
  DB on 2026-05-05 (38,446 engrams + 197,255 associations removed; 424 → 122 MB
  after `VACUUM INTO`). Kept as a reference template for future bulk cleanups.

### Tests

- **6 new regression tests** for the novelty curve in `tests/core/salience.test.ts`
  (`Novelty curve (production-tuned)`) covering: empty DB, near-dupe suppression,
  mid-range novelty preservation, recent vs old concept-match penalty.
- All 321 existing tests still pass.

### Operational notes

- Old backups deleted (kept latest 1) — freed ~2 GB.
- `lme_*` LongMemEval and `bench_*` benchmark agent leftovers were pruned along
  with low-salience non-claude-code memories. Going forward, evals should write
  to a separate test DB to avoid polluting prod.
- The salience filter fix takes effect after `npm run build && restart`.

## 0.7.1 (2026-04-13)

### Agent-Provided Metadata Tags
- **`memory_write` accepts structured metadata** — `project`, `topic`, `source`, `confidence_level`, `session_id`, `intent` parameters on both MCP and HTTP API.
- **Stored as prefixed searchable tags** — `proj=EquiHub`, `topic=database-migration`, `sid=abc123`, `src=debugging`, `conf=verified`, `intent=decision`. Indexed in FTS5 for BM25 recall boost.
- **Session ID tags** proven to improve recall 3x on LongMemEval (20% → 50-62%) by enabling AWM's entity-bridge boost to associate memories from the same conversation.
- **Batch write supports sessionId** at batch level or per-memory.

### Dual Synthesis (Consolidation Phase 2.5)
- **Session synthesis (Type A)** — groups memories by shared metadata tags (`sid=`, `proj=`, `topic=`), creates keyword-extracted summaries. Helps perfect recall by providing topical anchors.
- **Pattern synthesis (Type B)** — uses vector-similarity clusters that span multiple sessions/projects. Discovers cross-domain patterns for novel recall. Lower confidence (0.4) — these are speculative connections.
- Synthesis memories tagged `synth=true` + `synth-type=session|pattern`. Linked to sources via causal/bridge edges.
- Recursive synthesis prevention — existing syntheses excluded from clustering.
- Capped at 5 syntheses per consolidation cycle.

### Bulk Write & Supersession
- **`POST /memory/write-batch`** — batch ingestion with synchronous embedding and inline supersession.
- **`POST /memory/supersede`** — HTTP endpoint for marking outdated memories (was MCP-only).
- **Superseded engrams filtered from BM25 and retrieval** — `superseded_by IS NULL` on search queries.

### Retrieval Improvements
- **BM25 hyphen preservation** — entity names like "Salem-Keizer" no longer stripped of hyphens.
- **`bm25Only` mode** on ActivationQuery — skip embedding for fast text-only retrieval in bulk scenarios.
- **Auto-tagger module** created (`core/auto-tagger.ts`) with 13 categories + entity extraction. Disabled by default — generic tags dilute BM25 signal. Preserved for future use with smarter context models.

### Benchmarks
- **LongMemEval baseline established** — 40-50% with gpt-4o-mini (session tags + synthesis). Adapter at `LongMemEval/awm_benchmark.py`.
- **MemoryAgentBench CR** — 21% exact match on FactConsolidation. Adapter built.
- **Internal eval maintained** — 4/4 suites pass (Recall@5=0.800, Associative=1.000, Redundancy=0.966, Temporal=0.932).
- **Stress test improved** — 96.2% (up from 94.2%), catastrophic forgetting 100% (was 80%).

## 0.7.0 (2026-04-12)

### Workspace-Scoped Recall
- **`workspace` parameter on `memory_recall`** — search across all agents in a workspace for hive memory sharing. Omit for agent-scoped recall (standalone mode). Set `AWM_WORKSPACE` env var for automatic workspace scoping on all recalls.
- **Workspace-aware BM25 and retrieval** — `searchBM25WithRankMultiAgent()` and `getEngramsByAgents()` for multi-agent corpus search.
- **`getWorkspaceAgentIds()`** — resolves all live agents in a workspace via coordination tables. Falls back to single-agent if coordination is disabled.
- Also added to HTTP API (`POST /memory/activate`) and internal `memory_restore` / `memory_task_begin` recalls.

### Validation-Gated Hebbian Learning (Kairos-Inspired)
- **Edges no longer strengthen on co-retrieval alone.** Co-activated pairs are held in a `ValidationGatedBuffer` until `memory_feedback` is called.
- **Positive feedback → strengthen** associations between co-retrieved memories (signal=1.0).
- **Negative feedback → slight weakening** (signal=-0.3).
- **No feedback within 60 seconds → discard** (neutral — no strengthening or weakening).
- This structurally prevents hub toxicity from noisy co-retrieval (e.g., "Task completed" memories that co-activate with everything but add no value).
- `memory_feedback` response now reports how many associations were strengthened/weakened.

### Multi-Graph Traversal (MAGMA-Inspired)
- **Graph walk decomposed into four orthogonal sub-graphs** instead of one beam search over all edge types:
  - **Semantic** (connection + hebbian edges, weight 0.40) — standard weight-based walk
  - **Temporal** (temporal edges, weight 0.20) — recency-weighted connections
  - **Causal** (causal edges, weight 0.25) — 2x boost (high-value reasoning chains)
  - **Entity** (bridge edges, weight 0.15) — cross-topic entity connections
- Each sub-graph runs an independent beam search with proportional beam width.
- Boosts are **fused** across sub-graphs and capped at 0.25 total per engram.
- Inspired by MAGMA (Jiang et al., Jan 2026) which demonstrated 45.5% accuracy gains from multi-graph decomposition.

### Power-Law Edge Decay (DASH Model)
- **Replaced exponential decay** (`weight × 0.5^(t/halfLife)`) with **power-law decay** (`weight × (1 + t/scale)^(-0.8)`).
- Power law retains associations longer: at 30 days, retains ~32% vs exponential's ~6%. At 90 days: ~20% vs ~0.02%.
- Matches empirical forgetting research (Averell & Heathcote, 2011) and prevents premature loss of valuable old associations.

## 0.6.1 (2026-04-12)

### Memory Integrity
- **Embedding version tracking** — New `embedding_model` column on engrams table. Every embedding now records which model generated it, preventing silent drift when the embedding model is changed. `updateEmbedding()` accepts optional `modelId` parameter.
- **Batch embedding backfill** — Consolidation Phase 1 now uses `embedBatch()` (batch size 32) instead of single-item loop. 10x faster for large backfill operations. Logs progress: "Backfilled N/M embeddings (model: X)".
- **`getModelId()` export** — New function in `core/embeddings.ts` returns the current embedding model ID for version tracking.
- **Deeper retraction propagation** — `propagateConfidenceReduction` now traverses depth 2 (was 1) with 50% penalty decay per hop. Capped at 20 total affected nodes to prevent graph-wide cascades. Uses `visited` set for cycle safety.

### Retrieval Reliability
- **Query expansion timeout** — 5-second timeout on flan-t5-small expansion model. Falls back to original query on timeout. Timer properly cleaned up on the happy path.
- **Reranker timeout** — 10-second timeout on ms-marco cross-encoder reranker. Falls back to composite scores on timeout. Timer properly cleaned up.

### Coordination
- **Channel push delivery** — POST /assign now delivers assignments directly to worker channel HTTP endpoints (not just recording in DB). Falls back to mailbox queue if live delivery fails.
- **Mailbox queue** — Persistent message queue for workers that survive disconnects. Delivered on next /next poll. Messages queued when live push fails.
- **Channel auto-registration** — `channelUrl` parameter on /checkin and /next auto-registers channel sessions.
- **Cross-UUID assignment migration** — /next and GET /assignment resolve assignments across alternate UUIDs for the same agent name.
- **Channel liveness probe** — Periodic 60s health check marks unreachable channel sessions as disconnected. Manual POST /channel/probe endpoint.
- **POST /channel/push** — Now tries live delivery first, falls back to mailbox. Returns `{ delivered, queued }` status.
- **RESUME clears global commands** — RESUME for a workspace now also clears global (workspace=NULL) commands that would otherwise persist forever.
- **Stale threshold** — Agent alive threshold increased from 120s to 300s to accommodate longer task execution.

### Added
- **POST /decisions** — Explicit decision creation endpoint (previously only via memory_write hook).
- **POST /reassign** — Move assignments between workers or return to pending.
- **GET /assignments** — Paginated listing with status/workspace/agent_id filters and total count.
- **DELETE /command/:id** — Clear individual commands by ID.
- **GET /metrics** — Prometheus exposition format metrics (agents, assignments, locks, findings, events, uptime).
- **GET /timeline** — Unified activity feed combining events and decisions.
- **GET /agent/:id** — Individual agent details with active assignment and locks.
- **DELETE /agent/:id** — Kill an agent and fail its assignments.
- **GET /health/deep** — DB integrity and agent health check.
- **PATCH /finding/:id** — Update finding status/severity/suggestion.
- **Context field** — `context` TEXT column on `coord_assignments` for structured task references (files, decisions, acceptance criteria).
- **Engram bridge** — POST /assign with valid context JSON auto-creates canonical engrams for cross-agent recall.
- **Request logging** — All requests logged with method, URL, status code, and response time. Noisy polling endpoints suppressed at 2xx.
- **Rate limiting** — 60 requests/minute per agent (sliding window). /health exempt.
- **Workspace isolation** — GET /decisions now filters by workspace.
- **API docs** — `docs/coordination-api.md` with all 38 endpoints.
- **Tests** — context-bridge (4), concurrency (3), assignments (11), error-handling (18), reassign/command tests.

### Fixed
- **started_at on direct assign** — POST /assign now sets `started_at` when agentId is provided, fixing avg_completion_seconds.
- **Stats null handling** — COALESCE on decisions.last_hour, Math.round on avg_completion_seconds.
- **Multi-assign guard** — POST /assign rejects if agent already has active assignment (409).
- **cleanSlate order** — Fixed initialization ordering in coordination startup.
- **Unbounded queries** — LIMIT 200 added to GET /status, /workers, /locks.
- **Assignment list status enum** — Expanded to include `pending` and `assigned` (was missing from query schema).
- **Legacy test file** — Removed empty coordination.test.ts that caused vitest "no suite found" failure.

### Security
- **Rate limiting** — Per-agent 60 req/min sliding window prevents runaway polling.
- **Query limits** — All list endpoints capped at LIMIT 200.
- **Assignment status validation** — State transition validation on PATCH (e.g., cannot go from completed to in_progress).

## 0.6.0 (2026-03-25)

### New Features
- **Memory taxonomy** — `episodic` | `semantic` | `procedural` | `unclassified` classification on all engrams. Auto-classified on write based on content heuristics. Optional `memory_type` filter on `memory_recall`.
- **Query-adaptive retrieval** — `targeted` | `exploratory` | `balanced` | `auto` pipeline modes. Targeted queries boost BM25 and narrow beam search; exploratory queries boost vector signals and widen graph walk.
- **Decision propagation** — `coord_decisions` table + `GET /decisions` endpoint. When `decision_made=true` on `memory_write`, automatically broadcasts to coordination layer for cross-agent discovery. `memory_restore` shows peer decisions from last 30 minutes.
- **Completion verification gates** — Workers must provide a result summary (min 20 chars) containing an action word (commit, build, test, verified, etc.) or commit SHA when marking assignments completed. Optional `commit_sha` field stored on assignment. `GET /assignment/:id` endpoint for verification.
- **Task priority & dependencies** — `priority` (0-10) and `blocked_by` fields on `coord_assignments`. Higher priority tasks dispatched first.
- **Eval harness** — `npm run eval` runs 4 benchmark suites: Retrieval (Recall@5), Associative (multi-hop success@10), Redundancy (dedup F1), Temporal (Spearman correlation). Includes ablation mode (`--no-graph-walk`, `--bm25-only`, etc.).

### Fixes
- **Engram ID in write response** — `memory_write` now returns the engram ID (`ID: <uuid>`) so downstream tools (feedback, retract, supersede) can reference the written memory. Fixes MCP smoke test failures.
- **Retrieval pipeline tuning** — Softened z-score gate (1.0 → 0.5) for homogeneous corpora. Blended BM25+vector scoring replaces max(). Rocchio feedback uses consistent gate.
- **Consolidation threshold** — Lowered redundancy cosine threshold from 0.85 to 0.75 to catch MiniLM paraphrases (which score 0.75-0.88). Dedup F1: 0.078 → 0.966.

### Improvements
- **Worker registration dedup** — Checkin and `/next` reuse dead agent UUIDs instead of creating new ones.
- **Consolidation recall fix** — Redundancy pruning now transfers associations and merges tags from pruned memory to survivor. Post-consolidation retrieval improves by 30% (0.650 → 0.950).
- **SQLite DB hardening** — `busy_timeout=5000`, `synchronous=NORMAL` pragmas. Integrity check on startup with auto-restore from backups. Hot backup every 10 min (keeps last 6). WAL checkpoint on shutdown.
- **Dead agent cleanup** — `purgeDeadAgents()` removes agents dead >24h. Runs on the heartbeat prune interval.
- **Confidence boost on retrieval** — Frequently accessed memories gain confidence over time.

### Infrastructure
- **Docker Compose** updated to run AWM on port 8400 with `AWM_COORDINATION=true` (replaces legacy coordinator on 8410).
- **Architecture evaluation** — Comprehensive competitive analysis at `docs/architecture-evaluation.md`.

## 0.5.7 (2026-03-25)

- **`POST /next` endpoint** — combined checkin + command check + assignment poll in one call. Agents identify by `(name, workspace)` instead of tracking UUIDs. Eliminates the most common agent polling failure (forgetting `agentId` across tool calls).
- **Name+workspace fallback on `GET /assignment`** — when `agentId` query param is missing, accepts `?name=X&workspace=Y` and resolves the agent internally. Backward-compatible with existing UUID-based polling.
- **`nextSchema`** added to coordination schemas.

## 0.5.2 (2026-03-20)

- **Fix: Multi-port hook fallback** — `awm setup --global` now installs PreCompact and SessionEnd hooks that try the primary port then fall back to the alternate port. Fixes silent checkpoint failures when using separate memory pools (work on 8401, personal on 8402) with global hooks.
- **Agent ID fallback** — MCP server checks `WORKER_NAME` env var as fallback for `AWM_AGENT_ID`, improving multi-agent hive compatibility.

## 0.5.1 (2026-03-18)

- **Fix: Task-end hub toxicity** — `memory_task_end` no longer falls back to generic "Task completed" concept. Unknown/auto-checkpoint tasks now use the first 60 chars of the summary as concept. Salience floor (0.7) only applies to named tasks, not unknown ones.
- **Fix: Novelty penalty for duplicate concepts** — `computeNovelty` now detects exact concept string matches in existing memories and applies a 0.4 novelty penalty. Prevents hub formation from repeated identical concepts.
- **Fix: Relative edge protection in consolidation** — Phase 6 forgetting now uses 25th-percentile edge count as protection threshold instead of absolute 3. With dense graphs (avg 12 edges/node), the old absolute threshold protected everything.
- **Cycle-based archiving** — Memories with 0 accesses after 5 consolidation cycles are archived regardless of age. Tracks `consolidation_cycle_count` in `conscious_state` table. Handles young/small pools where time-based thresholds are too generous.
- **DB migration** — Auto-adds `consolidation_cycle_count` column to existing databases on startup.
- **Agent ID fallback** — MCP server now checks `WORKER_NAME` env var as fallback for `AWM_AGENT_ID`.
- New docs: `claude-code-setup.md` (standalone setup guide), `telemetry-recommendations.md`

## 0.5.0 (2026-03-12)

- **Supersession mechanism** — replace outdated memories without deleting them. New `memory_supersede` MCP tool, `supersedes` param on `memory_write` and `memory_task_end`, bidirectional `superseded_by`/`supersedes` columns on engrams. Superseded memories are down-ranked 85% in recall but remain searchable for history.
- **Memory classes** — `canonical` | `working` | `ephemeral`. Canonical memories bypass staging (minimum salience 0.7, always active). Ephemeral memories tagged for faster decay. New `memory_class` param on `memory_write`.
- **Enhanced task_end hygiene** — `memory_task_end` accepts optional `supersedes[]` to auto-mark old memories as superseded during task completion.
- **Stable CI config** — `vitest.config.ts` with `pool: 'forks'` and `maxWorkers: 1` to prevent ONNX/thread crashes on Windows.
- **Supersession tests** — 9 new tests covering down-ranking, bidirectional links, memory class behavior, and storage persistence.
- Total MCP tools: 12 (was 11)

## 0.4.3 (2026-03-11)

- **Fix:** Novelty scoring thresholds now match 0..1 normalized BM25 scores (was comparing against unreachable 25/15/8/3)
- **Fix:** Embedding deserialization respects Node Buffer byteOffset/byteLength (prevents silent similarity corruption)
- **Fix:** Homeostasis phase normalizes outgoing edges only, tracks processed edges to prevent double-scaling
- **Fix:** `/memory/write` validates required fields, returns 400 instead of 500 on malformed requests
- SPDX license headers on all source files
- Added docs: architecture, cognitive model, benchmarks
- Added examples: Claude Code configs, task ledger pattern
- Community files: NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG

## 0.4.2 (2026-03-11)

- Restructured README — quick start first, tighter claims, before/after example
- Memory invocation strategy with specific trigger policies
- Compact tool responses (single-line, less visual noise)
- `/stats` endpoint on hook sidecar (daily activity counts)
- 15-minute silent auto-checkpoint timer in sidecar
- Stop hook now nudges recall and task switching
- Faster SessionEnd hook timeout (2s) to avoid cancellation
- CLI setup now installs all 3 hooks (Stop, PreCompact, SessionEnd)
- License changed from MIT to Apache 2.0

## 0.4.1 (2026-03-11)

- Compact tool responses
- `/stats` endpoint
- Recall nudge in Stop hook

## 0.4.0 (2026-03-10)

- Hook sidecar — lightweight HTTP server for Claude Code hooks
- Novelty-based salience scoring (BM25 duplicate check before write)
- Activity logging (`data/awm.log`)
- Task bracket tools (`memory_task_begin`, `memory_task_end`)
- `memory_recall` accepts `query` parameter (alias for `context`)
- Consolidation on graceful exit (SessionEnd hook)
- Consolidation fallback on restore (if graceful exit missed)
- Incognito mode (`AWM_INCOGNITO=1` — registers zero tools)
- Memory pool isolation (per-folder `AWM_AGENT_ID`)
- CLI installs hooks in `~/.claude/settings.json`

## 0.3.2 (2026-03-09)

- Global setup writes `~/.claude/CLAUDE.md` with AWM workflow instructions

## 0.3.1 (2026-03-09)

- `--global` flag for CLI setup

## 0.3.0 (2026-03-08)

- Checkpointing system (save/restore execution state)
- Consolidation scheduler (idle/volume/time/adaptive triggers)
- CLI onboarding (`awm setup`)
- HTTP auth (`AWM_API_KEY`)
- Task management tools (add, update, list, next)
- 11 MCP tools
- 8 eval suites
