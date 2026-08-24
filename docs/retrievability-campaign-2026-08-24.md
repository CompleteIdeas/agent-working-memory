# Retrievability campaign — shared test protocol for all four options

One protocol for all four candidates so results are **comparable**. Written
before any option is implemented; per-option bars fixed in advance.

## Why a shared protocol

Four options measured four different ways cannot be ranked against each other.
Every arm below runs the same fixtures, reports the same metrics, and passes the
same guards. Anything that only wins on its own bespoke metric has not won.

## The metric set (every arm reports all of these)

| metric | fixture | what it tells us |
|---|---|---|
| **success@1 / @5 / MRR** | identifier fixture, 1,316 probes | primary retrieval quality |
| **adversarial silence** | 10 absent-fact probes | selectivity — must NOT fall |
| **NO-OP guard** | same fixture, flag off vs on | change must be inert when disabled |
| **the Azure case** | one real query, verbatim | the failure that started this — binary, does it surface |
| **temporal s@1** | temporal fixture, 101 probes | cross-check that no arm breaks the other axis |
| **recall latency** | median over the probe run | read-time cost, which is nearly spent already |
| **write latency** | write path, where touched | only options 1 and 4 pay here |

## Pass bars, fixed in advance

An arm **PASSES** only if ALL hold:

1. **success@1 rises ≥3.0pp** on the identifier fixture. Below that is inside
   the noise band measured earlier today (a single query is ~0.8pp at n=120,
   ~0.08pp at n=1316; 3pp is a real effect at either size).
2. **adversarial silence does not fall.** Selectivity is the product; an arm
   that buys recall with precision has not won.
3. **temporal s@1 does not fall** by more than 1pp. No cross-axis damage.
4. **no-op verified** — flag off reproduces baseline exactly.
5. **read-time latency does not rise >10%** (warm recall is ~900ms and already
   ~90% cross-encoder; there is no headroom to spend).

An arm **WINS** on: highest success@1 gain that clears all guards, with ties
broken by (a) does it fix the Azure case, (b) lower cost, (c) reaches the
existing corpus rather than future writes only.

## Why these bars and not others

- **≥3.0pp** — today's phase 9b shipped at +9.7pp and the truncation fix at
  +15pp on its own eval; a sub-3pp change is not worth new machinery and
  permanent cost.
- **Adversarial as a hard guard** — this is the metric LoCoMo actively punished
  and the real-store benchmark was built to reward. Every arm here expands what
  is visible to retrieval, which is exactly the direction that damages
  selectivity.
- **Latency ceiling** — measured: warm recall ~900ms, ~90% cross-encoder. An
  arm that wins accuracy while adding 200ms has moved the cost, not removed it.

## Order of testing (cheapest and most informative first)

1. **Option 2 — tags into the rerank passage.** No re-embed. Tells us how much
   of the merged option's value comes from the cheap half, BEFORE paying for the
   expensive half.
2. **Option 1 — derived retrieval text + backfill.** Needs re-embedding the
   snapshot (~11k engrams). Superset of option 2.
3. **Option 3 — guarded alias mining.** Needs the mining pass plus five
   guardrails (PMI threshold, fan-out cap, directional, require ≥1 original-term
   hit, top-40 regression check).
4. **Option 4 — bigger embedder (bge-small 384d → nomic 768d).** Heaviest:
   model download plus full re-embed. Run last, and only if 1–3 leave a gap.

## Anti-vacuity rules (earned the hard way today)

Four separate null results this session turned out to be instrument bugs, not
findings. Each arm must therefore prove the change actually ran:

- **Prove the flag is live.** `memory_whoami` / `recallConfigFingerprint()` must
  show it. A stale process reporting a plausible number has already burned an
  afternoon once.
- **Prove the code path executed.** A change that reaches only a secondary
  branch (as the temporal boost did, landing in the Rocchio re-search) produces
  a clean null that looks like a real refutation.
- **A suspiciously exact null is a bug until proven otherwise.** "Identical to
  baseline" is the signature of a change that did not run.
- **Never tune a constant to cross a bar.** Diagnose the shape instead, and say
  so.

---

## RESULT — Option 2 (tags into the rerank passage): **PASS**

Measured on `fixture-category.json`, 450 probes.

| arm | s@1 | s@5 | MRR | adversarial | p50 latency |
|---|---|---|---|---|---|
| baseline | 56.4% | 66.2% | 60.6% | 90.0% | 790ms |
| **+ tags@80** | **63.8%** | **68.4%** | **66.0%** | 90.0% | 854ms |
| + tags@160 | 63.8% | 68.4% | 66.0% | 90.0% | — |

| bar | required | actual | |
|---|---|---|---|
| success@1 gain | ≥3.0pp | **+7.4pp** | PASS |
| adversarial silence | no fall | 90.0 → 90.0 | PASS |
| temporal s@1 | no fall >1pp | 58.4 → 58.4 | PASS |
| no-op when disabled | exact | identifier fixture identical (67.3 all arms) | PASS |
| read latency | ≤+10% | **+8.1%** | PASS (tight) |

`tags@160` is byte-identical to `tags@80` — the extra budget buys nothing, so 80
is the right default. The +8.1% latency is the honest cost: +80 chars on a
400-char passage is +20% passage text, and the cross-encoder pads to the longest
in the batch.

### The finding that mattered more than the result

The first run of this option reported **three arms identical on every metric**
and looked like a clean refutation. It was not — the fixture was wrong.

The identifier fixture is built by unique-identifier hold-out, so **300/300 of
its golds contain the query term in their own body**. An option whose mechanism
is "add vocabulary the body lacks" is invisible to it by construction. Same
error class as using LoCoMo to measure the 400-char truncation: a benchmark
whose data cannot exercise the mechanism reports a confident null.

The campaign protocol caused this. It required one shared fixture "so results
are comparable" — but comparability is worthless if the fixture cannot express
the mechanism. **Corrected rule: the shared metric SET is what makes arms
comparable; the fixture must be chosen to exercise the mechanism.** The
identifier fixture keeps a real job — it is now the no-regression guard, which
is what it is actually suited for.

---

## RESULT — Option 1 (derived retrieval text + backfill): **REJECT**

Backfill executed and verified: 7,827 of 8,703 engrams re-embedded in 155s;
independent byte-comparison confirmed 113/200 sampled tagged engrams have
genuinely different vectors.

| arm | snapshot | rerank tags | s@1 | vs baseline |
|---|---|---|---|---|
| A baseline | original | off | 56.4% | — |
| B rerank half only | original | on | **63.8%** | **+7.4pp** |
| C embedding half only | backfilled | off | 56.7% | +0.3pp |
| D both | backfilled | on | **63.8%** | **+7.4pp** |

**D equals B exactly.** The embedding half contributes zero, alone (+0.3pp) and
in combination (0.0pp difference). Option 1 costs a corpus-wide re-embed and
delivers nothing option 2 does not already give for free.

### Why — the proportionality principle

Added vocabulary helps in proportion to how much of a channel's INPUT it
represents.

- The **reranker** sees 400 chars. 80 chars of tags is ~20% of everything it
  gets. Result: +7.4pp.
- The **embedder** sees the whole memory — canonical median 1,965 chars. Eight
  short tag words appended barely perturb a 384-dim vector. Result: +0.3pp.

This is a reusable prediction, not a post-hoc story. It says option 4 (a bigger
embedder) is unlikely to fix THIS problem: it is the same diluted-signal channel
with more dimensions, not a channel where the missing words become salient.

### Measurement corrections made during this option

- **Latency noise is ~4.5%** (identical config measured 755ms and 790ms). Option
  2's "+8.1%" is therefore directionally real but only ~2x the noise band —
  quote it as roughly +5-8%, not a precise figure. It still clears the ≤10% bar.
- **Arm C's 863ms was compared against a 120-probe baseline while C ran 450
  probes.** Different query sets, not comparable. C carries no tags, so its
  latency says nothing about the change. Caught before it reached a conclusion.
