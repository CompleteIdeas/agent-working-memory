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

> **92.7%** of identifier queries · **92.0%** of topic queries · **96.7%** in the top five

- **Produced by:** `tests/realstore-eval/runner.ts` over `fixture.json` (300 probes) and `fixture-category.json` (450 probes).
- **Corpus:** `snapshot/store.db` — a frozen copy of a real work store, 29,853 engrams total, **11,262 retrievable**. Gitignored and will stay that way.
- **Ground truth:** unique-identifier hold-out. An identifier appearing in exactly one active engram, uniqueness confirmed through FTS — the real retrieval path, not a regex. Derived by `tests/realstore-eval/build-fixture.mjs`.
- **Stamped at:** v0.14.6, commit `50362f2`, 2026-09-12 (`docs/benchmarks-current.md`).
- **Reproducibility:** **Method public.** `npm run bench:public` runs the *same* runner and the *same* hold-out code against a synthetic corpus anyone can rebuild. One implementation serves both corpora, so checking the method here checks the method used there.
- **Caveats a reviewer should hold us to:**
  - Quote the **retrievable** count (11,262), not the total (29,853). The ranker never considers staged, retracted or superseded rows. `benchmarks-current.md` says this; make sure every other page does too.
  - These numbers predate the shipped version. See §7.
  - Decay runs on the wall clock, so the snapshot must be clock-pinned or the same corpus scores differently on different days — measured, 70.0% vs 67.0% twenty hours apart before the clock was pinned.

## 2. Correct silence

> **90.0%** correct abstention on questions about facts never stored

- **Produced by:** the same runner. Adversarial probes are plausible in register and absent from the store; returning nothing is the correct answer and scores positively.
- **Reproducibility:** **Method public** — the public corpus carries the same ten adversarial probes and scores **100%** on them.
- **Why it matters:** this is the metric most agent-memory benchmarks invert. LoCoMo rewards indiscriminate retention, so it caps a salience filter at ~50% however good ranking gets, which is why it was retired in 0.13.x (`docs/benchmarks.md`).
- **Caveat:** ten probes is a small adversarial set. It demonstrates the property; it does not pin the rate to a point.

## 3. Token economics

> Scoped recall answers in **~630 tokens flat**. Carrying the store instead: **~1.3M tokens**

**Both halves of this row are weakly evidenced, and it is the weakest claim on the page.**

- **`~630 tokens`: no derivation in this repository.** It appears in `README.md` and in `docs/awm-for-agents.html`, and nothing computes it. The runner reports two *different* quantities — total **token spend** across a run, and **net** tokens saved against the ~2,106 measured cost of the agent reading the codebase instead. Neither is a "~630 per recall" cost figure, so the public benchmark's **+245 net per recall** does not reproduce it. Two quantities under one name.
- **`~1.3M tokens`: no derivation either.** A plausible order of magnitude for carrying 11,262 memories as context, but the arithmetic is not shown. Worse, `docs/awm-for-agents.html` compares the same ~630 figure against a **29M-token project**, so the repository publishes two different denominators for one claim without distinguishing them.
- **What *is* reproducible:** net token economics, by the accounting actually implemented — a recall is credited only when the delivered text contains the answer-bearing identifier, so a recall that returns an unusable pointer scores as a miss rather than a save. Public corpus: **+245** net per recall (seed 20261008), **+181** (seed 99). Private snapshot at the stamped commit: **+519**.
- **Reproducibility:** **Method public** for net economics. **Not reproducible** for the ~630 and ~1.3M headline figures as written.
- **Action, and it should come before any outreach:** either derive both numbers in `npm run bench` so they are stamped like everything else, or replace the row with the net figure the runner does compute and state the rest as an estimate with the arithmetic shown. Reconcile 1.3M against 29M while doing it.

## 4. Cheap model + AWM beats a frontier model

> **14 / 15 vs 7 / 15**, at ~1/40th the cost per task

- **Produced by:** a 15-task stress suite over a real member-support domain, documented in `docs/patterns/awm-native-harness.md`.
- **Reproducibility:** **Not reproducible from this repository.** The reference implementation is an agent harness in a different codebase, and the workload is private domain data.
- **Caveats, stated plainly because this is the most quotable number on the page:**
  - **n = 15.** It is a stress suite, not a benchmark. Treat it as an existence proof that the substrate can carry domain capability, not as a measured ratio.
  - The comparison is substrate-primed vs not primed. It does not claim the small model is better than the frontier model; it claims the knowledge was in the store rather than in the weights.
  - The cost ratio follows from model pricing at the time, not from anything AWM does.

## 5. Halves the digging

> Four real support tickets: 2× the specific facts, half the database queries (49 vs 100)

- **Recorded in:** `docs/for-decision-makers.md`.
- **Reproducibility:** **Not reproducible.** A one-off A/B on live tickets. `tests/realworld-eval/runner.ts` is a different experiment (codebase crawl) and does not produce this figure; no harness for this one was kept.
- **Honest framing:** n = 4, hand-run, on data that cannot be published. Useful as an anecdote with numbers attached. Not evidence of a rate.

## 6. Decisions survive for months

> Recalled a median of **30 days** after being written, some after **167**. **41%** of the technical identifiers the agent used had entered the conversation only through a recall.

- **Recorded in:** `docs/for-decision-makers.md`, with the underlying analysis in `docs/archive/decision-retrievability-2026-08-24.md`.
- **Reproducibility:** **Maintainer only** — it is an observational measurement over one private store's own activation log, not a suite.
- **Strength:** the 41% figure is the most interesting claim AWM makes, because it is the one that says memory changed what the agent did rather than merely being retrievable. It deserves a repeatable harness.
  - **Action:** a script over `activation_events` would make this **Method public** and let anyone run it against their own store.

## 7. Known staleness

`docs/benchmarks-current.md` is stamped **v0.14.6 / `50362f2` / 2026-09-12**. The
shipped package is **0.15.9**. The file states plainly that nothing is carried
forward between versions, which is the right policy — and it means the
published headline numbers are from three patch releases ago.

- **Action:** re-run `npm run bench` on the shipped version before inviting
  scrutiny, or label the headline table with the version it came from.

## 8. What the public benchmark does and does not tell you

`npm run bench:public:build && npm run bench:public` is fully reproducible.
Current baseline, 400 probes: `s@1` **56.3%**, `s@5` 62.0%, MRR 58.9%, **100%**
correct silence, **100%** sufficiency, **+245** tokens per recall. Split by
identifier position: **97.3%** where the reranker can see the identifier,
**46.8%** where it cannot.

- It **does** verify the method, the abstention accounting, the sufficiency
  check and the truncation cliff, on data you can rebuild byte-for-byte.
- It **does not** reproduce the published numbers, and is not comparable to
  them. A synthetic corpus scores **lower**: generated prose is more
  self-similar, so same-domain neighbours are harder to separate.
- **Noise floor:** two builds differing only in seed gave `s@1` 56.3% and
  52.0%. The corpus *shape* reproduces to 0.2pp and every qualitative result
  holds, but a 2pp move in the absolute is noise. Confirm on two seeds.

---

## Where the evidence is weakest

Listed deliberately, in the order we would attack it ourselves:

1. **Neither `~630 tokens` nor `~1.3M tokens` is derived anywhere in the
   repository**, and a second page compares the same 630 against a different
   denominator (29M) (§3).
2. **The headline numbers are a version behind what ships** (§7).
3. **The two most rhetorically effective claims — 14/15 and 49-vs-100 — are
   `n = 15` and `n = 4`, and neither is reproducible** (§4, §5).
4. **The 41% "entered only through a recall" figure has no harness** (§6),
   despite being the most load-bearing claim about whether any of this changes
   outcomes.
5. **Ten adversarial probes** is a thin basis for an abstention rate (§2).

Weaknesses AWM already publishes about itself, with evidence, live in
[`known-limitations.md`](known-limitations.md) — including the measured finding
that its own association graph changes the top-3 result set in **0%** of
queries. [`unknowns.md`](unknowns.md) lists what has not been established at all.
