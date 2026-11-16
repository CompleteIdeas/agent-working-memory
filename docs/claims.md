# Claims and evidence

Every number AWM publishes, what produced it, and **who can reproduce it**.

This page exists because the project asks to be taken seriously on measurement,
and that obliges it to be explicit about which numbers a stranger can check and
which ones rest on a private corpus or a one-off experiment. Where the evidence
is weak, this page says so rather than waiting for a reviewer to find it.

**Reproducibility is rated for a reader with nothing but this repository.**

| Rating | Meaning |
|---|---|
| **Public** | `git clone`, run one command, get a comparable number. |
| **Method public** | The code and the derivation are published; the corpus is not. You can verify *how* it is measured and reproduce the shape of the result on synthetic data, but not the exact figure. |
| **Maintainer only** | Needs the private snapshot. Published code, unpublished data. |
| **Not reproducible** | A one-off experiment. The result is recorded in prose; the harness was not kept. |

---

## 1. Retrieval accuracy

> **95.0%** of identifier queries · **96.2%** of topic queries · **98.7%** in the top five (both)

- **Produced by:** `tests/realstore-eval/runner.ts` over a seeded 300-probe sample of `fixture.json` (1,316 probes; `REALSTORE_LIMIT=300` in `scripts/bench-current.mjs`) and all 450 probes of `fixture-category.json`.
- **Corpus:** `snapshot/store.db` — a frozen copy of a real work store, 29,853 engrams total, **11,262 retrievable**. Gitignored and will stay that way.
- **Ground truth:** unique-identifier hold-out. An identifier appearing in exactly one active engram, uniqueness confirmed through FTS — the real retrieval path, not a regex. Derived by `tests/realstore-eval/build-fixture.mjs`.
- **Stamped at:** v0.22.4 / `29365a9`, 2026-11-16 — `docs/benchmarks-current.md`. Measured by `npm run bench` at `29365a9` (`bench-runs/0.22.4-2026-11-16/`: identifier.log, category.log, results.json; gitignored and maintainer-only, like the snapshot itself). The same figures, down to the delivered-token spend, appeared at `4238a43` (`bench-runs/0.22.3-2026-11-15/`, labelled 0.22.3 because `package.json` had not been bumped; the commit is inside 0.22.4).
- **Previous figures** (identifier `s@1` / topic `s@1` / top five): 93.3% / 96.0% / 98.7% at v0.21.1 – v0.22.3 (the v0.22.3 tag re-measured identically: `bench-runs/0.22.3-2026-11-14/` at `a0038b8`); 92.7% / 92.7% / 97.3% (identifier top five) at v0.19.0 – v0.21.0, first at `72a0934`, the q8-reranker commit, in a run labelled 0.18.1; 93.0% / 92.2% / 97.0% at v0.16.0 – v0.18.1 (runs at `eb0620f`, `2375582`, `7daa286`, `181012b`).
- **95.0% here, 95.4% in the CHANGELOG and README:** the release notes score all 1,316 identifier queries (93.8% → 95.4% across 0.22.3 → 0.22.4); this page and the benchmark page score the seeded 300-probe sample (93.3% → 95.0%). Same code, different denominators.
- **Reproducibility:** **Method public.** `npm run bench:public` runs the *same* runner and the *same* hold-out code against a synthetic corpus anyone can rebuild. One implementation serves both corpora, so checking the method here checks the method used there.
- **Caveats a reviewer should hold us to:**
  - Quote the **retrievable** count (11,262), not the total (29,853). The ranker never considers retracted rows; staged and superseded rows can still enter the candidate pool (the BM25 channel filters on agent and retraction only) and superseded, expired and not-yet-valid rows are down-ranked to 0.15 of their score rather than excluded. The benchmark denominator excludes them. Every page that quotes these figures should say so.
  - These numbers describe **what is published**: nothing between `29365a9` and the v0.22.4 tag touches `src/` (§7).
  - **History (0.16.0):** the 93.0% / 92.2% figures were measured twice by different
    drivers at `eb0620f` (`npm run bench` and `npm run profile:recall`, which agreed to
    the decimal), then at `2375582`, a commit inside 0.16.1 whose only later source
    change was a comment. They reproduced *identically* across two transformers majors
    (3.8.1 and 4.3.1), down to the delivered-token spend.
  - Decay runs on the wall clock, so the snapshot must be clock-pinned or the same corpus scores differently on different days — measured, 70.0% vs 67.0% twenty hours apart before the clock was pinned.

## 2. Correct silence

> With the opt-in calibrated gate, AWM withholds **50 of 73** questions about facts never stored, and withholds **1 of 718** correct answers to keyword-shaped questions; on natural-language questions, once memories carry questions, it withholds **3 of 103** correct answers

- **Current figures (v0.22.4, re-measured 2026-11-15):** keyword questions: of 750 answerable, 739 answered, 9 flagged, 2 withheld (1 of them a correct answer, of 718); never-stored 50 of 73 withheld, 3 flagged, 1 empty; familiar-vocabulary deleted facts 95 of 200 withheld, 19 flagged, 86 answered. Natural-language questions on the snapshot with questions (`store-wq.db`, `GATE_FIXTURE=fixture-nl.json`): 183 answered, 11 withheld (3 of them correct, of 103); never-stored 50 of 73; deleted facts 9 of 97 withheld, 88 answered. The v0.22.3 tag, re-run the same day, gives the same thresholds and the same counts; the 0.22.4 ranking only adds correct first answers (712 → 718, 102 → 103).
- **Correction (2026-11-15):** README and these pages published **58 of 73** (and 66 of 73 at 0.21.0) never-stored facts withheld, and **10 of 97** correct natural answers withheld. Neither reproduces: the v0.22.0 and v0.22.3 tags both measure 50 of 73, and the v0.22.3 tag 2 of 102 natural. The earlier figures came from runs whose tree was not recorded.

- **Produced by:** `tests/realstore-eval/gate-eval.ts`. The shipped `calibrateGate()` fits each agent's gate from the store alone, on synthetic queries with no labels. Then every labelled question goes through ordinary recall: 750 answerable, 73 verified absent (`fixture-absent.json`, every distinctive term checked absent from the store), and 200 "familiar" absent (real questions asked of a copy with their answer deleted). Method and full table: `docs/abstention.md`.
- **Also measured:** of the 200 familiar-vocabulary absent questions, it withholds 95, flags 19 as low signal and answers 86 (v0.22.4; 0.21.1 published 98 / 28 / 74). That is the hard case, and the figure is pessimistic, because a deleted fact may be repeated elsewhere.
- **History — natural-language questions (0.21.1 ranking, 2026-10-31):** On natural-language questions (194, written per memory and vetted so they can't lean on rare store words) it withholds **21 of 88** correct answers (24%) and flags 3, while still withholding 65 of 73 never-stored facts (0.21.1; not re-measured; 66 of 73 at 0.21.0 did not reproduce, see above). Its calibration probes are keyword-shaped, so natural questions score below the floor it learns. Reproduce with `GATE_FIXTURE=fixture-nl.json`.
- **Correction (2026-10-30):** 0.21.0 published "withholds **0 of 694** correct answers". `gate-eval.ts` judged correctness from the gated recall, so a withheld answer could never count as correct and that figure was 0 by construction. Judged from an ungated recall, it is **1 of 695**.
- **Reproducibility:** **Maintainer only**, one real store. The gate's tests (`tests/core/abstention-gate.test.ts`) pin the mechanics anywhere; the rates are measured only on the private snapshot so far.
- **Correction (2026-10-29):** this row used to read "**90.0%** correct abstention", published next to 92.7% first-result accuracy. The two were measured in different configurations and were never true together. The 90% came from a strict gate (`abstentionThreshold` 0.3) that drops first-result accuracy to 38% (identifier) and 57% (topic), and it was measured on 10 probes. With the gate actually shipped, `require_confidence` 0.05, AWM withheld **0 of 10**. The old gate could not separate absent from answerable at any threshold; the calibrated gate replaces it as the opt-in.
- **Why it matters:** this is the metric most agent-memory benchmarks invert. LoCoMo rewards indiscriminate retention, so it caps a salience filter at ~50% however good ranking gets, which is why it was retired in 0.13.x (`docs/benchmarks.md`).

## 3. Token economics

> Scoped recall answers in **~630 tokens flat**. Carrying the store instead: **~1.3M tokens**

**Both halves of this row are weakly evidenced, and it is the weakest claim on the page.**

- **`~630 tokens`: not derived, and the harness measures something 2.4x larger.** It appears in `README.md` and in `docs/awm-for-agents.html`, and nothing computes it. What the runner *does* measure, at the shipped `k=3` on the private snapshot, is the delivered-token spend per recall:

  | Suite | spend | recalls | mean per recall |
  |---|---|---|---|
  | Identifier | 453,125 | 300 | **1,510** |
  | Topic | 715,655 | 450 | **1,590** |

  (From the stamped run, `bench-runs/0.22.4-2026-11-16/{identifier,category}.log`;
  both totals reproduced to the token at `4238a43`. History: 455,486 and 713,745
  — 1,518 and 1,586 per recall — at v0.16.0 (`bench-runs/0.16.0-2026-10-10/`),
  and 1,510 and 1,588 on the 2026-10-08 run, before the Rocchio pass was defaulted off.)

  So a scoped recall costs roughly **1.5k tokens**, not ~630, and the published figure understates the cost of the product's central operation by about 2.4x — an error in AWM's own favor, which is the direction that most deserves scrutiny.

  **A possible benign explanation, untested:** `granularity: 'compact'` saves roughly 70% of recall output, and 1,510 x 0.30 is about 453, so ~630 may be a compact-mode or `auto`-mode figure from an earlier default. The shipped default is `full`. If that is the origin, the claim needs the mode stated next to it; if it is not, the number should be replaced with the measured one. Either way it should not stand unqualified.

  Note also that **net** economics and **cost** are different quantities, and were conflated here previously: the runner reports +560 net per recall on the identifier suite (what a successful recall saves against the ~2,106-token cost of the agent reading the codebase instead), which is not a cost figure and does not reproduce ~630.
- **`~1.3M tokens`: now derived, and it holds.** `npm run bench` computes it from the snapshot and stamps it in the provenance table, using the same token estimator the runner applies to what a recall delivers, so both sides of the comparison are measured alike. Over the 11,262 retrievable engrams: **1,234,429** tokens of `concept + content`, **1,545,526** including tags, mean **110** per engram. The published "~1.3M" sits between those two and was correct all along — it simply had no arithmetic behind it. Separately, `docs/awm-for-agents.html` compares the same ~630 against a **29M-token project**: that is a *different* denominator (a codebase, not the store), and the figures are not in conflict, but neither page says which it is using.
- **What *is* reproducible:** net token economics, by the accounting actually implemented — a recall is credited only when the delivered text contains the answer-bearing identifier, so a recall that returns an unusable pointer scores as a miss rather than a save. Public corpus: **+354** net per recall (seed 20261008, v0.22.4; the seed-99 run's net figure was not archived). Private snapshot at the stamped commit: **+560**. History: October published +245 (seed 20261008) and +181 (seed 99) public, +518 private (v0.16.0).
- **Reproducibility:** **Maintainer only** for `~1.3M` — the derivation is published and runs on any store, but reproducing *this* figure needs the private snapshot. **Not reproducible** for `~630` as written, because nothing derives it. **Method public** for net economics.
- **Action remaining:** `~1.3M` is done. `~630` needs resolving before outreach: re-measure the identifier suite with `REALSTORE_GRANULARITY=compact` to test whether that is the figure's origin, then either qualify the claim with the mode or replace it with the measured ~1.5k. Both pages should also say which denominator they are using, so ~1.3M (the store) and 29M (a codebase) stop reading as a contradiction.

## 4. Cheap model + AWM beats a frontier model

> **14 / 15 vs 7 / 15**, at ~1/40th the cost per task

- **Produced by:** a 15-task stress suite over a real member-support domain, documented in `docs/patterns/awm-native-harness.md`.
- **Reproducibility:** **Not reproducible from this repository.** The reference implementation is an agent harness in a different codebase, and the workload is private domain data.
- **Caveats, stated plainly because this is the most quotable number on the page:**
  - **n = 15.** It is a stress suite, not a benchmark. Treat it as an existence proof that the substrate can carry domain capability, not as a measured ratio.
  - The comparison is substrate-primed vs not primed. It does not claim the small model is better than the frontier model; it claims the knowledge was in the store rather than in the weights.
  - The cost ratio follows from model pricing at the time, not from anything AWM does.

## 5. Halves the digging

> Four real support tickets: 2× the specific facts (16 vs 7 of 28), half the file and database lookups (49 vs 100), 41% fewer database queries (47 vs 79), 26% fewer output tokens (73.7k vs 99.0k). Excluding the ticket where the memoryless arm exhausted its budget: −40% lookups, −20% queries, −16% output tokens, +22 points of facts found.

- **Recorded in:** `docs/for-decision-makers.md`.
- **Reproducibility:** **Not reproducible.** A one-off A/B on live tickets. `tests/realworld-eval/runner.ts` is a different experiment (codebase crawl) and does not produce this figure; no harness for this one was kept.
- **Honest framing:** n = 4, hand-run, on data that cannot be published. Useful as an anecdote with numbers attached. Not evidence of a rate.

## 6. Decisions survive for months

> Recalled a median of **30 days** after being written, some after **167**. **41%** of the technical identifiers the agent used had entered the conversation only through a recall.

- **Recorded in:** `docs/for-decision-makers.md`, with the underlying analysis in `docs/archive/decision-retrievability-2026-08-24.md`.
- **Reproducibility:** **Maintainer only** — it is an observational measurement over one private store's own activation log, not a suite.
- **Strength:** the 41% figure is the most interesting claim AWM makes, because it is the one that says memory changed what the agent did rather than merely being retrievable. It deserves a repeatable harness.
  - **Action:** a script over `activation_events` would make this **Method public** and let anyone run it against their own store.

## 7. Version currency — the page is measured inside the release it describes

`docs/benchmarks-current.md` is stamped **v0.22.4 / `29365a9` / 2026-11-16**. The v0.22.4 tag
is `4e14a30`, one commit later, and that commit changes documentation only (the regenerated
page, README and other docs). Nothing between the two touches `src/`:

```bash
git diff 29365a9 v0.22.4 -- src/
```

returns nothing, so §1 describes the code on npm. 0.22.5 (2026-11-16) is a documentation release:
its `src/` changes are comments, tool and flag descriptions, the benchmark-label list
(`RECALL_FLAGS`) and the plugin's hook wiring; none changes how recall ranks, so the
0.22.4 page still describes it.

**What is still missing is structural, and it has produced a rewrite of this section at
nearly every release.** The page records a version and a commit but never says whether that
commit is *released*, so a reader cannot tell which side of the tag they are on without doing
the arithmetic by hand. Numbers behind the package, numbers ahead of it, and numbers level
with it all trace to that one absent field.

- **Action:** have `scripts/bench-current.mjs` stamp the commit's position relative to the
  newest tag — "released" or "N commits past vX.Y.Z" — so the page answers this itself instead
  of delegating it to this section. Open, and deliberately not fixed inside a release that
  would have had to change a release gate to do it.

**The previous states of this section, kept because the pattern is the claim.** Until
2026-10-09 it warned that the published numbers were three patch releases *behind* what
shipped. It was then rewritten to warn of the inverse: figures 21 commits *ahead* of the
released tag, describing a repository rather than a package, where an install still ran the
Rocchio pass and scored the old 92.7% / 92.0% / 96.7%.

At 0.16.1 the page was stamped **v0.16.0 / `2375582` / 2026-10-10**, a commit inside 0.16.1
(the dependency sweep it shipped). `git diff 2375582..v0.16.1 -- src/` returned one file,
`src/core/reranker.ts`, and every changed line was a comment, so that page also described the
code on npm. The label read 0.16.0 because that is what `package.json` said when the suites
ran. It was not re-run after the version bump because the bench preflight refused to start
(`4.8 GB free (need 8)`; five eval runs had been OOM-killed on the machine), a refusal left in
force rather than overridden with `BENCH_MIN_HEADROOM_GB`.

## 8. What the public benchmark does and does not tell you

`npm run bench:public:build && npm run bench:public` is fully reproducible.
Current baseline (v0.22.4, 2026-11-15, seed 20261008), 400 probes: `s@1` **52.8%**,
`s@5` 67.8%, MRR 59.1%, **100%** sufficiency, **+354** tokens per recall. Split by
identifier position: **86.7%** where the reranker can see the identifier, **44.9%**
where it cannot. Seed 99: `s@1` 47.5%, `s@5` 66.3%. Correct silence on the 10
adversarial probes is **40%** (4 of 10), as on 0.22.3; the October figure was 100%,
and the cause of that drop has not been traced yet.

**The 0.21.1 blend cost this corpus 17 points, and 0.22.4 won most of it back.** On
0.22.3 the same run scored `s@1` 38.8% (seed 99: 35.3%): the final blend's slice of
first-stage rank let the vector channel's #1 outvote a cross-encoder that was sure.
Run with the October configuration, the same corpus still scores 56.5%, so the
instrument is sound; the 0.22.4 rule (`src/core/blend-rule.ts`) brings it to 52.8%
without costing any real-store suite a point. The long-memory suite (`tests/longmem-eval/runner.ts`, 48 questions
about memories longer than the rerank window) moved the same way: **87.5%** first when
the query-dense rerank window shipped (2026-08-24), 72.9% on 0.22.3, **77.1%** on 0.22.4.

**History — measured 2026-10-08 (seed 20261008), with the Rocchio pass still ON:**
`s@1` 56.3%, `s@5` 62.0%, MRR 58.9%, 100% correct silence, +245 tokens per recall,
97.3% / 46.8% by identifier position.

- It **does** verify the method, the abstention accounting, the sufficiency
  check and the truncation cliff, on data you can rebuild byte-for-byte.
- It **does not** reproduce the published numbers, and is not comparable to
  them. A synthetic corpus scores **lower**: generated prose is more
  self-similar, so same-domain neighbors are harder to separate.
- **Noise floor:** measured 2026-10-08: two builds differing only in seed gave
  `s@1` 56.3% and 52.0%. The corpus *shape* reproduces to 0.2pp and every
  qualitative result holds, but a 2pp move in the absolute is noise. On 0.22.4
  the two seeds differ by 5.3pp (52.8% vs 47.5%). Confirm on two seeds.

---

## 9. One thread, any number of topics

> Context comes fresh from memory every turn, so one long-running agent can switch topics, lose detail to compaction, and get it back

- **What it is:** the model AWM is built around (Robert Winter, 2026-10-16: "Fresh context comes from AWM every time"). The agent's working context is not carried forward and patched. It is re-drawn from memory: a recall primed on every prompt, per step, and after compaction. Three consequences are claimed:
  - topic switching is cheap;
  - compaction loses little, because the detail is recalled back;
  - recalled memories reinforce what the agent needs mid-window.
- **Produced by:** the memory-working-agent BL-30 measurement (2026-10-17, `scripts/measure-topic-switch.mts`). One continuous multi-task run, closed book, gpt-5.4-mini, 26 trials. Runs with a fully right final report:

  | Arm | Fully right |
  |---|---|
  | summary compaction **+ AWM** | **4/5** |
  | full 200-step window, no memory (the ceiling) | 3/5 |
  | OpenClaw-style summary + MEMORY.md | 2/3 |
  | 12-step window, no memory | 0/5 |
  | 12-step window + AWM | 0/5 |

- **What it does not show:** AWM's own share. In the fully right compaction runs the facts came mostly from the summary, and there was no "compaction without memory" arm besides OpenClaw's. The 12-step-window arm shows that AWM recall alone does not give an agent back its place in a multi-task job when its history is cut that short.
- **What would settle it:** one continuous run that switches A→B→C→A, **compaction on in every arm**, with and without AWM, scored on per-topic fact errors, cross-topic bleed, and stale use of a fact changed mid-run.
- **Reproducibility:** **Not reproducible** from this repository; the harness lives in memory-working-agent.
- **In daily use:** the maintainer runs single Claude Code threads across days and unrelated projects, with compactions, restored by AWM. That is a use pattern, not a measurement.

---

## Where the evidence is weakest

Listed deliberately, in the order we would attack it ourselves:

1. **`~630 tokens` is not derived, and the harness measures ~1,510 instead** —
   the published figure understates the cost of a scoped recall by about 2.4x,
   in the product's favor (§3).
   `~1.3M` now is — `npm run bench` computes 1,234,429 from the snapshot and
   stamps it — and it confirmed the published figure rather than contradicting
   it. Two pages still fail to say which denominator they use, so ~1.3M (the
   store) and 29M (a codebase) read as a conflict when they are not.
2. **The benchmark page cannot say whether the commit it names is released** — the
   figures do describe what 0.22.4 ships, and §7 carries a one-command proof, but the
   page itself records only a version and a commit, so a reader has to do the tag
   arithmetic by hand. Every rewrite of §7 traces to that one absent field (§7).
3. **The two most rhetorically effective claims — 14/15 and 49-vs-100 — are
   `n = 15` and `n = 4`, and neither is reproducible** (§4, §5).
4. **The 41% "entered only through a recall" figure has no harness** (§6),
   despite being the most load-bearing claim about whether any of this changes
   outcomes.
5. **The abstention figures come from one private store** (§2). The old ten-probe basis is
   replaced by 73 verified-absent plus 200 familiar-vocabulary probes, and natural-language
   questions are measured too (194 in `fixture-nl.json`), but every population is drawn from
   that one store.
6. **The headline model — one thread, any number of topics — rests on 4/5 vs 3/5** in one
   multi-task run, where AWM's own share was not isolated (§9).

Weaknesses AWM already publishes about itself, with evidence, live in
[`known-limitations.md`](known-limitations.md) — including the measured finding
that its own association graph changes the top-3 result set in **0%** of
queries. [`unknowns.md`](unknowns.md) lists what has not been established at all.
