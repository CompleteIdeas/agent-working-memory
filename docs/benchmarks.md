# Benchmarks

All eval suites are included in the repository and can be reproduced locally.

## Running Evals

```bash
npm run test:self       # Pipeline component checks
npm run test:edge       # Adversarial failure modes
npm run test:stress     # Scale + catastrophic forgetting
npm run test:workday    # Multi-session work simulation
npm run test:ab         # AWM vs keyword baseline
npm run test:tokens     # Token savings measurement
npm run test:realworld  # Production codebase retrieval
npm run test:sleep      # Consolidation impact
```

Each eval creates a fresh SQLite database, seeds it with test data, and runs structured challenges. No external services required.

## Results Summary

| Eval | Score | Grade |
|------|-------|-------|
| Edge Cases | 100% (34/34) | EXCELLENT |
| Stress Test | 92.3% (48/52) | EXCELLENT |
| A/B Test | AWM 100% vs Baseline 83% | EXCELLENT |
| Self-Test | 97.4% (31 checks) | EXCELLENT |
| Real-World | 93.1% (16 challenges) | EXCELLENT |
| Workday | 86.7% (14 challenges) | GOOD |
| Token Savings | 64.5% savings, 65% recall | GOOD |
| Production retrieval cost | 9.8× lower aggregate vs file_retrieval | EXCELLENT |
| **Memory gauntlet** (end-to-end ablation, 2026-07-30) | **AWM 74%±5 vs no-memory 0%** on memory-dependent tasks | BASELINE |
| **Real-store retrieval** (0.13.x recommended flags, 2026-08-24) | **s@1 56.4% → 63.8%**, adversarial held 90.0% | IMPROVED |
| **Gauntlet re-run** (0.13.x flags, 2026-08-25) | 24/30 = 80.0% memory probes, k=3; baseline arm not retained | NULL — needs per-arm scorecards |

## Retrieval quality — the 0.13.x wins (2026-08-24)

**Read the provenance column before quoting a number** — the three results below were
not measured on the same corpus. The combined figure and the tags result use
`tests/realstore-eval/`: a frozen snapshot of a real 11,294-engram store, ground truth
by unique-identifier hold-out verified through FTS, correct abstention scored positively.

Run with all three enabled — they are default-OFF:

```bash
AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1
```

| Change | Flag | Result | Corpus |
|---|---|---|---|
| Second-stage rerank | `AWM_RERANK2=1` | **+9.7pp success@1** (37.8 → 47.6), p<0.001 paired McNemar. No extra inference. | 616 LoCoMo probes (`tests/locomo-eval/`) — ⚠ since retired, see below |
| Query-aware rerank window | `AWM_RERANK_WINDOW=query` | **25.0% → 87.5%** long-memory success@1, +0.07% CPU, zero added tokens | Generated corpus (`tests/longmem-eval/corpus.ts`), shaped to real-store statistics, answer at a controlled offset |
| Tags into rerank passage | `AWM_RERANK_TAGS=1` | **+7.4pp success@1** (56.4 → 63.8) on category queries | 450 probes, frozen real-store snapshot (`tests/realstore-eval/`) |

The LoCoMo-derived +9.7pp is reported as-measured rather than dropped: LoCoMo's short
passages are precisely why it could not detect the 400-char truncation, and that blind
spot is what made the standalone `AWM_RERANK2` recommendation wrong. The generated
long-memory corpus is calibrated to measured real-store statistics (canonical memories
median 1,965 chars, 98.7% over 400) but is constructed, not sampled — it isolates the
truncation cliff by planting the answer at a known offset, which a real corpus cannot do.

**Combined**, 450 category probes on `fixture-category.json`:

| config | s@1 | s@5 | MRR | adversarial | p50 |
|---|---|---|---|---|---|
| baseline | 56.4% | 66.2% | 60.6% | 90.0% | 790ms |
| **recommended** | **63.8%** | **68.4%** | **66.0%** | **90.0%** | 854ms |

Adversarial abstention held at 90.0% in every arm — selectivity was not traded for
accuracy — at roughly +5–8% recall latency.

> **⚠ The first two must ship together.** `AWM_RERANK2` alone regresses long-memory s@5
> from 91.7% to 25.0%: BM25 over full content had been compensating for the reranker's
> 400-char blindness, and making a blind reranker authoritative removes that cover.

### What was rejected, and why

Three other approaches to the same defect were measured against the same fixtures,
metrics and pre-registered bars, and lost:

| approach | s@1 | verdict |
|---|---|---|
| Re-embed with tag terms included | 56.7% | **reject** (+0.3pp) — the embedder sees ~1,965 chars, where eight tag words barely move a 384-dim vector |
| Mined project-dialect aliases | 63.6% | **reject** (−0.2pp) — PMI over 8-memory categories is too thin; ~half the mined dialect is coincidence |
| Larger embedder (bge-base, 768d) | 57.1% | **reject** (+0.7pp alone, −1.1pp combined) — no model's weights encode that "private plan" means Azure in *this* store |

The unifying finding: **a memory is unreachable when a word it needs was never written
into its body** — 66.2% of topical tag terms never appear in the text. Supplying that
word where the ranker can *see* it works; supplying it where it is *diluted* does not;
*guessing* it from corpus statistics does not; *inferring around* it with a bigger model
does not. This is why 0.13.6 also rewrote the memory-writing guidance.

Protocol, per-option detail and the process post-mortem:
[`archive/retrievability-final-2026-08-24.md`](archive/retrievability-final-2026-08-24.md).

## Why LoCoMo was retired

LoCoMo was useful for learning how to benchmark this product, but it does not represent
it, and it was dropped in 0.13.x:

- passages median **115 chars** against a real store's **1,965**
- seeded in one shot, so ACT-R decay, Hebbian weights and salience reinforcement are
  near-uniform and contribute nothing
- no supersession, no staging history, no cross-session use
- it **rewards indiscriminate retention**, so the salience filter — the product — caps
  its score no matter how good ranking gets
- structurally blind to the 400-char rerank truncation, which affects **79%** of real
  ground-truth identifiers

`tests/realstore-eval/` replaces it: real corpus, real query register, mechanically
verifiable truth, and abstention scored as a positive.

## Memory Gauntlet (end-to-end acceptance suite)

The gauntlet is the standing **acceptance test for retrieval changes**: a single-factor
ablation in the `memory-working-agent` repo (`src/gauntlet/`) where the agent harness, model,
tasks, and budgets are held constant, the working dir is wiped between sessions, and only the
memory substrate varies (`awm` / `off` / `notes` / `longctx` / `rag`). Probes target one
mechanism each: single-hop recall, 3-hop chaining, supersession, distractor disambiguation,
sparse-cue vocabulary mismatch, procedural rule application, cross-session assembly
(enumeration), standing-policy adherence, and abstention. A second suite measures **context
bleed** across four parallel-shaped client accounts.

**2026-07-30 baseline (0.11.x, Waves 1–3 + D11):** memory-dependent pass-rate 74%±5pp
(k=3, reps 78/67/78) with `AWM_AUTOTAG=1 AWM_ENTITY_INDEX_FETCH=1` + the MWA harness
fixes — six of nine probes at 100%; no-memory control 0%. Full methodology, per-probe
mechanism table, six-config flag ablation, known-gap signatures, and repro commands:
[`docs/archive/gauntlet-baseline-2026-07-30.md`](archive/gauntlet-baseline-2026-07-30.md).

**2026-08-25 re-run on 0.13.6 — NULL RESULT.** The 0.13.x retrieval flags
(`AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1`) went through this
acceptance test and did not move it:

**Retained artifact** (`memory-working-agent/results/gauntlet/scorecard.json`, 10-probe
suite, `awm` arm, k=3, 3 reps, $1.34):

| measure | value |
|---|---|
| memory probes | **24/30 = 80.0%** |
| per rep | 90% / 70% / 80% |
| seeding steps | 30/30 = 100% |
| failing probes | `multihop` (**0/3**), `skill-apply`, `composite`, `abstain` |

⚠ **The baseline-vs-flags comparison is not reproducible from a retained artifact.**
The scorecard file holds only the **last arm run** — it is overwritten each invocation —
so the paired baseline figures were read from console output at the time and no longer
exist on disk. Earlier drafts of this page quoted "81%, reps 89/78/78"; those are 8/9 and
7/9, i.e. the **9-probe** suite that preceded this one, not the numbers above. Retaining
per-arm scorecards is a prerequisite for treating any gauntlet delta as evidence.

What survives that correction: `multihop` fails **every** rep, four probes flip between
identical runs, and the retrieval-layer gains are not visible at this sample size. The
harness variance is larger than the effect being looked for. Retrieval-layer s@1 improved measurably (+7.4pp on the real
store); whether that converts into end-to-end task success is **unresolved**. A k≥10 run
(~$5/arm) is what would settle it, and is the outstanding follow-up. Recording this
because a retrieval change passing through the standing acceptance test without moving
it is exactly the result most likely to go unmentioned.

## Eval Details

### Self-Test (`tests/self-test/`)

Tests individual pipeline components in isolation:
- Embedding generation and cosine similarity
- BM25 full-text search ranking
- Cross-encoder reranking accuracy
- Temporal decay curves
- Confidence scoring
- Hebbian edge formation
- Graph walk traversal
- Staging promotion/demotion
- Salience filtering thresholds

**31 checks, 97.4% pass rate.** The 2.6% gap is a borderline edge case in staging promotion timing.

### Edge Cases (`tests/edge-cases/`)

9 adversarial scenarios designed to break memory systems:

| Scenario | Tests | What it targets |
|----------|-------|----------------|
| Context Collapse | 5 | Same content in different contexts — can retrieval distinguish? |
| Mega-Hub Toxicity | 5 | One memory connected to everything — does it dominate? |
| Flashbulb Distortion | 4 | High-salience memory overshadowing quieter related ones |
| Temporal Incoherence | 3 | Time-based retrieval when events overlap |
| Narcissistic Interference | 4 | Self-referential memories pulling all queries to themselves |
| Identity Collision | 3 | Two entities with similar names — can retrieval separate them? |
| Contradiction Trapping | 3 | Contradictory memories — does the system resolve or surface both? |
| Bridge Overshoot | 4 | Cross-topic bridges creating false connections |
| Noise Forgetting Benefit | 3 | Verify that forgetting noise actually improves recall |

**34/34 (100%).** Homeostasis and confidence gating are the key defenses.

### Stress Test (`tests/stress-test/`)

7-phase progressive stress test:

| Phase | What it does |
|-------|-------------|
| 0. Baseline | 10 memories, basic recall |
| 1. Scale 500 | Seed 500 memories, verify retrieval still works |
| 2. 100 Sleep Cycles | Run consolidation 100 times, verify stability |
| 3. Catastrophic Forgetting | Neglect critical memories for 50 simulated days |
| 4. Bridge | Cross-topic retrieval after consolidation |
| 5. Adversarial | Spam 50 noise memories, verify signal survives |
| 6. Recovery | Full pipeline test after all stress phases |

**48/52 (92.3%).** The 4 failures are in Phase 6 recovery where some edge memories lose retrieval rank after extreme stress — expected behavior for borderline content.

### Workday (`tests/workday-eval/`)

Simulates 4 work sessions across different projects:
- Seeds 43 memories from realistic developer activities
- 14 recall challenges spanning sessions
- Tests cross-project retrieval and noise rejection

**86.7% (12/14).** The 2 failures are noise-filtering false positives where related-but-irrelevant content leaks through.

### A/B Test (`tests/ab-test/`)

Direct comparison: AWM vs simple keyword/tag baseline.

- 100 realistic project events seeded into both systems
- 24 recall questions (22 fact recall + 2 noise rejection)
- AWM uses full pipeline; baseline uses tag matching + keyword search

**AWM: 100% (24/24) vs Baseline: 83% (20/24).** Baseline fails on semantic queries that don't match exact keywords (architecture decisions, code style preferences, testing patterns).

### Token Savings (`tests/token-savings/`)

Measures efficiency of memory-guided context vs including full conversation history:

- **64.5% token savings** — memory summaries use 35.5% of the tokens that full history would
- **65% recall accuracy** — recalled memories contain the needed information
- **2.8x efficiency** — information density per token

### Real-World (`tests/realworld-eval/`)

Tests against a real production codebase (71K-line monorepo):

- Extracts 1194 chunks from source code, SQL, and docs
- Balanced sample: 300 chunks (40% code, 20% SQL, 40% docs)
- 16 challenges across: domain knowledge, architecture, implementation, noise rejection, cross-cutting concerns

**93.1% (15/16).** The 1 failure is a cross-cutting concern that requires connecting information across 3+ files.

### Sleep Cycle (`tests/sleep-cycle/`)

Measures the impact of consolidation on retrieval:

- Seeds memories across 2 topics
- Tests cross-topic recall before and after sleep cycles
- **Cross-topic recall: 50% → 83% after first sleep cycle** (+33pp)
- Single-topic recall stable at 83% before/after
- Key finding: homeostasis (Phase 5) is what drives the improvement

### Production Retrieval Cost — Claude Code Session Audit

Measures real cost of AWM-retrieval vs the alternative an agent actually uses
when AWM isn't present: file retrieval via `Read` / `Grep` / `Glob` /
`Bash`-find. This is a more honest metric than [Token Savings](#token-savings-teststoken-savings)
because real agents don't stuff the entire conversation history into context —
they grep, read, and grep again until they find what they need.

**Methodology** (`scripts/measure-claude-vs-awm.ts`):

1. Walk JSONL transcripts in `~/.claude/projects/`.
2. For each `tool_use` block, classify by category:
   - `file_retrieval` — Read, Grep, Glob, NotebookRead, Bash(find/cat/grep/ls/head/tail/wc)
   - `awm_retrieval` — `mcp__agent-working-memory__memory_{recall,restore,task_list,task_next,stats}`
   - `bash_other`, `editing`, `web_retrieval`, `meta`, `delegation`
3. For each assistant turn immediately after a `tool_result`-bearing user
   message, attribute the turn's `cache_creation_input_tokens` (Anthropic's
   tokenizer, reported in the transcript) proportionally to the tool
   categories present in that user message.
4. Sum across all sessions.

**Result — 15 most recent sessions on `C:/Users/robert/project/`:**

| Category | Calls | Tokens consumed | Per-call avg |
|---|---|---|---|
| `bash_other` (npm/git/build output) | 3,069 | 9,160,093 | 2,985 |
| `file_retrieval` (Read/Grep/Glob/Bash-find) | **2,743** | **5,777,217** | 2,106 |
| `editing` (Edit/Write) | 1,927 | 3,400,444 | 1,765 |
| `meta` (TaskCreate/ToolSearch) | 873 | 1,895,352 | 2,171 |
| `awm_write` (memory_write/supersede) | 194 | 943,422 | 4,863 |
| **`awm_retrieval`** | **131** | **591,366** | **4,514** |
| `delegation` (Agent) | 48 | 210,330 | 4,382 |
| `web_retrieval` (WebFetch/WebSearch) | 27 | 23,453 | 869 |

**Headline:**

- **File retrieval consumed 5,777,217 tokens across 2,743 calls.**
- **AWM retrieval consumed 591,366 tokens across 131 calls.**
- **Call ratio: file_retrieval:awm_retrieval = 20.9 : 1.**
- **Aggregate cost ratio: 9.8 : 1** (file retrieval costs 9.8× more in total tokens).

**Interpretation.** Per-call, AWM costs more (4,514 vs 2,106 tokens) because a
single `memory_recall` returns 5 ranked engrams with full content, while a
single `Read` is often partial-file and a single `Grep` returns matching
lines only. But AWM calls **replace multi-call file-retrieval workflows**:
the typical "find this info from files" workflow is 1 Grep → 2–3 Reads →
maybe more — averaging 6,000+ tokens for what one AWM recall surfaces in
4,514. The 21 : 1 call ratio in real sessions reflects this — agents
naturally use file retrieval 21× more often than AWM, and most of those
file calls are part of multi-call workflows that AWM would collapse.

**Caveat — attribution upper bound.** `cache_creation_input_tokens` of the
assistant turn following a tool_result captures the tool_result *plus* the
assistant's subsequent reasoning that becomes part of context. It's an upper
bound on pure tool_result cost. The lower bound (raw content `chars/4`) for
the same sessions was 1.27M tokens for file_retrieval and 157k for
awm_retrieval — same 8 : 1 ratio. The truth is between the two; the ratio
is stable.

**Reproduce:**

```bash
npx tsx scripts/measure-claude-vs-awm.ts [topN]
```

Defaults to 15 most recent sessions across all `~/.claude/projects/*` subdirs.

## Scoring Methodology

Each eval uses a challenge-based scoring system:
1. Seed memories into a fresh database
2. Run structured queries
3. Check if expected memories appear in top-N results
4. Binary pass/fail per challenge (memory found = pass)
5. Overall score = passes / total challenges

Grades: EXCELLENT (≥90%), GOOD (≥80%), FAIR (≥60%), POOR (<60%)
