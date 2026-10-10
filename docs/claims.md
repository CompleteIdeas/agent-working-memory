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

> **93.0%** of identifier queries · **92.2%** of topic queries · **97.0%** in the top five

- **Produced by:** `tests/realstore-eval/runner.ts` over `fixture.json` (300 probes) and `fixture-category.json` (450 probes).
- **Corpus:** `snapshot/store.db` — a frozen copy of a real work store, 29,853 engrams total, **11,262 retrievable**. Gitignored and will stay that way.
- **Ground truth:** unique-identifier hold-out. An identifier appearing in exactly one active engram, uniqueness confirmed through FTS — the real retrieval path, not a regex. Derived by `tests/realstore-eval/build-fixture.mjs`.
- **Stamped at:** v0.15.9, commit `eb0620f`, 2026-10-09 — `bench-runs/0.15.9-2026-10-09/`
  (identifier.log, category.log; gitignored and maintainer-only, like the snapshot
  itself). Measured twice by different drivers, `npm run bench` and
  `npm run profile:recall`, which agree to the decimal.
- **Reproducibility:** **Method public.** `npm run bench:public` runs the *same* runner and the *same* hold-out code against a synthetic corpus anyone can rebuild. One implementation serves both corpora, so checking the method here checks the method used there.
- **Caveats a reviewer should hold us to:**
  - Quote the **retrievable** count (11,262), not the total (29,853). The ranker never considers staged, retracted or superseded rows. `benchmarks-current.md` says this; make sure every other page does too.
  - These numbers describe **what is published**. They were measured at `eb0620f`,
    which sits behind the `v0.16.0` release commit, but no retrieval code changed
    in between and §7 carries the diff that establishes it. Until 0.16.0 shipped
    they described an unpublished commit, and an install got the old 92.7% /
    92.0% / 96.7% with the Rocchio pass still on.
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

- **`~630 tokens`: not derived, and the harness measures something 2.4x larger.** It appears in `README.md` and in `docs/awm-for-agents.html`, and nothing computes it. What the runner *does* measure, at the shipped `k=3` on the private snapshot, is the delivered-token spend per recall:

  | Suite | spend | recalls | mean per recall |
  |---|---|---|---|
  | Identifier | 455,486 | 300 | **1,518** |
  | Topic | 713,745 | 450 | **1,586** |

  (From the stamped run, `bench-runs/0.15.9-2026-10-09/{identifier,category}.log`.
  The previous figures here — 1,510 and 1,588 — were from the 2026-10-08 run, before
  the Rocchio pass was defaulted off.)

  So a scoped recall costs roughly **1.5k tokens**, not ~630, and the published figure understates the cost of the product's central operation by about 2.4x — an error in AWM's own favor, which is the direction that most deserves scrutiny.

  **A possible benign explanation, untested:** `granularity: 'compact'` saves roughly 70% of recall output, and 1,518 x 0.30 is about 455, so ~630 may be a compact-mode or `auto`-mode figure from an earlier default. The shipped default is `full`. If that is the origin, the claim needs the mode stated next to it; if it is not, the number should be replaced with the measured one. Either way it should not stand unqualified.

  Note also that **net** economics and **cost** are different quantities, and were conflated here previously: the runner reports +518 net per recall on the identifier suite (what a successful recall saves against the ~2,106-token cost of the agent reading the codebase instead), which is not a cost figure and does not reproduce ~630.
- **`~1.3M tokens`: now derived, and it holds.** `npm run bench` computes it from the snapshot and stamps it in the provenance table, using the same token estimator the runner applies to what a recall delivers, so both sides of the comparison are measured alike. Over the 11,262 retrievable engrams: **1,234,429** tokens of `concept + content`, **1,545,526** including tags, mean **110** per engram. The published "~1.3M" sits between those two and was correct all along — it simply had no arithmetic behind it. Separately, `docs/awm-for-agents.html` compares the same ~630 against a **29M-token project**: that is a *different* denominator (a codebase, not the store), and the figures are not in conflict, but neither page says which it is using.
- **What *is* reproducible:** net token economics, by the accounting actually implemented — a recall is credited only when the delivered text contains the answer-bearing identifier, so a recall that returns an unusable pointer scores as a miss rather than a save. Public corpus: **+245** net per recall (seed 20261008), **+181** (seed 99). Private snapshot at the stamped commit: **+518**.
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

## 7. Version currency — the headline now describes what ships

`docs/benchmarks-current.md` is stamped **v0.15.9 / `eb0620f` / 2026-10-09**, and
0.16.0 is the release that makes that commit's behavior the published behavior.
The figures in §1 therefore describe **the code on npm** — which is what this
section could not say before 2026-10-09.

The stamp still names the *previous* version, so the problem has not vanished; it
has shrunk from a wrong number to a stale label. `eb0620f` sits behind the
`v0.16.0` release commit, and what separates them is documentation plus exactly
three non-comment source changes, none of which can move a score:

| Change | Why it cannot move a ranking |
|---|---|
| `src/core/recall-config.ts` | Adds `AWM_RERANKER_DTYPE` to `RECALL_FLAGS`, the provenance label list. It changes the `arm=` string a benchmark *prints*, not the pipeline it prints about |
| `src/mcp.ts` | Two tool-description strings — the reranker's share of warm latency 78% → 83%, and the prime hook's abstention threshold 0.25 → 0.10. Prompts, not scoring |
| `src/adapters/common.ts` | The generated agent guidance (`SKILL.md`) |

Do not take that on trust; it is one command:

```bash
git diff --stat eb0620f..v0.16.0 -- src/
```

Every other change in that range is a comment or a document. **Re-running
`npm run bench` at the release commit would restamp the page and retire this
section**, and that is the right fix — it has not been run because the engine is
provably unchanged, not because the result is in doubt.

**Both previous states of this section, kept because the pattern is the claim.**
Until 2026-10-09 it warned that the published numbers were three patch releases
*behind* what shipped. It was then rewritten to warn of the inverse: figures 21
commits *ahead* of the released tag, describing a repository rather than a
package, where an install still ran the Rocchio pass and scored the old 92.7% /
92.0% / 96.7%. Now it records a lag of zero commits with a label one version
stale. Three different states in one day, all from one missing field:
`benchmarks-current.md` records a version and a commit but never says whether
that commit is **released**, so a reader cannot tell which side of the tag they
are on without doing the tag arithmetic by hand.

- **Action:** have `scripts/bench-current.mjs` stamp the commit's position
  relative to the newest tag — "released" or "N commits past v0.16.0" — so the
  page answers this itself instead of delegating it to this section.

## 8. What the public benchmark does and does not tell you

`npm run bench:public:build && npm run bench:public` is fully reproducible.
Current baseline, 400 probes: `s@1` **56.3%**, `s@5` 62.0%, MRR 58.9%, **100%**
correct silence, **100%** sufficiency, **+245** tokens per recall. Split by
identifier position: **97.3%** where the reranker can see the identifier,
**46.8%** where it cannot.

**Measured 2026-10-08 (seed 20261008), with the Rocchio pass still ON**, so this
baseline sits on the pre-flip pipeline like §1's did. It has not been re-run at
the new default. A 200-probe arm of the same corpus was diffed per query across
the flip and **0 of 200 queries changed** in gold rank, top-1 identity or top-1
score, so these figures are expected to carry forward unchanged — but that is an
inference from a subset, not a re-run of the 400.

- It **does** verify the method, the abstention accounting, the sufficiency
  check and the truncation cliff, on data you can rebuild byte-for-byte.
- It **does not** reproduce the published numbers, and is not comparable to
  them. A synthetic corpus scores **lower**: generated prose is more
  self-similar, so same-domain neighbors are harder to separate.
- **Noise floor:** two builds differing only in seed gave `s@1` 56.3% and
  52.0%. The corpus *shape* reproduces to 0.2pp and every qualitative result
  holds, but a 2pp move in the absolute is noise. Confirm on two seeds.

---

## Where the evidence is weakest

Listed deliberately, in the order we would attack it ourselves:

1. **`~630 tokens` is not derived, and the harness measures ~1,518 instead** —
   the published figure understates the cost of a scoped recall by about 2.4x,
   in the product's favor (§3).
   `~1.3M` now is — `npm run bench` computes 1,234,429 from the snapshot and
   stamps it — and it confirmed the published figure rather than contradicting
   it. Two pages still fail to say which denominator they use, so ~1.3M (the
   store) and 29M (a codebase) read as a conflict when they are not.
2. **The benchmark page is stamped with the previous version number** — the
   figures do describe what 0.16.0 ships, but the page says v0.15.9 / `eb0620f`
   and nothing on it states whether that commit is released, so the reader has to
   do the tag arithmetic to find out (§7).
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
