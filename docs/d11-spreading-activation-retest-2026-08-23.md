# D11 / H5 — Spreading activation re-test

**Date:** 2026-08-23
**Verdict:** **Does not earn default-ON.** Under the three-strikes rule in
`docs/design-proposals-2026-07-30.md` D11, this is the third regression.
**The decision to park permanently is Robert's, not this run's.**

---

## H5 did not need building — it was already built

H5 proposed "Personalized PageRank over the Hebbian graph." That already exists in
`src/engine/activation.ts:1274` (`spreadActivation`) and already contains every
guard D11 specifies:

| D11 requirement | Where |
|---|---|
| PPR restart term | `activation.ts:1352` — `(1-δ)·seed + δ·inflow` |
| Fan-effect normalization | `activation.ts:1333` — `weight / fan` |
| SYNAPSE lateral inhibition | `activation.ts:1342` — `AWM_SPREAD_INHIBIT`, divisive normalization |
| Bounded hops / node budget | `AWM_SPREAD_ITERS=3`, `AWM_SPREAD_BUDGET=64` |
| Out-of-pool injection, rerank-gated | `activation.ts:1397` — `AWM_SPREAD_INJECT` |

All default-OFF. The open work was never implementation — it was **the re-test
D11 staged and nobody ran**. So that is what this is.

## Method

`tests/locomo-eval/trace.ts` — the prescribed instrument (D11: *"judged by stage
attribution + adversarial suite, not end-score A/B"*). LoCoMo, 10 conversations,
**1,062 answerable + 446 adversarial probes**.

Four arms, run sequentially (the tracer uses a fixed DB and log path). The tracer
wipes and reseeds per arm, and `connections.ts:177` opts edge-discovery out of
spread — so **every arm builds an identical store and identical graph**, and the
arms are **paired** on an identical query set. That permits McNemar on discordant
pairs, which is both more sensitive than comparing marginals and a direct measure
of the thing at issue: *what did this break that baseline got right?*

Strike conditions and the success condition were **pre-registered before results**
(`tests/locomo-eval/d11-retest/PRE-REGISTRATION.md`), which also records a
post-hoc correction to one of its own assumptions.

**Positive control:** `AWM_SPREAD_INHIBIT` is not in the tracer's arm label, so
arms 2 and 3 both self-report `arm=spread`. Confirmed live by diffing outputs —
they differ (35.7% → 37.2% success@1). Inhibition demonstrably altered propagation.

## Results

| arm | overall s@1 | multi-hop | single-hop | adversarial |
|---|---|---|---|---|
| baseline | **37.8%** | **30.2%** | **51.2%** | **76.9%** |
| spread (unguarded) | 35.7% | 27.5% | 46.4% | 76.5% |
| spread + inhibit 0.3 | 37.2% | 30.2% | 49.6% | 76.9% |
| spread + inject + inhibit | 36.9% | 30.2% | 49.6% | 76.9% |

Paired, per query (b = baseline right / arm wrong; c = baseline wrong / arm right):

| arm | slice | broken | fixed |
|---|---|---:|---:|
| spread | multi-hop | 5 | 0 |
| spread | single-hop | 7 | 1 |
| spread | open-domain | 5 | 2 |
| spread | adversarial | 3 | 1 |
| **spread+inhibit** | **multi-hop** | **0** | **0** |
| spread+inhibit | single-hop | 2 | 0 |
| spread+inhibit | open-domain | 2 | 0 |
| **spread+inject+inhibit** | **multi-hop** | **0** | **0** |
| spread+inject+inhibit | single-hop | 2 | 0 |
| spread+inject+inhibit | open-domain | 4 | 0 |

## What this shows

**1. The instrument reproduces the historical regression.** Unguarded spread
breaks 20 queries and fixes 4, damaging every category including adversarial.
This is the displacing-gold failure that parked the feature, reproduced on demand
— which is what makes arms 3 and 4 trustworthy.

**2. Lateral inhibition works exactly as SYNAPSE claims.** λ=0.3 repairs nearly
all the damage: single-hop 46.4→49.6, multi-hop 27.5→30.2, adversarial 76.5→76.9.
The published fix is real. **This is a genuine positive finding about the
mechanism.**

**3. But it repairs by neutralising the feature, not by making it useful.** In
both guarded arms, across **1,062 answerable probes, spreading activation fixed
exactly ZERO queries** and broke 4–6. Multi-hop — the entire point — moved *not a
single query* out of 189, in either direction.

**4. Injection recovered nothing.** It is the only mechanism that can add
out-of-pool candidates, and it added no correct ones: 0 multi-hop fixed, 4
open-domain broken. `gold entered pool` fell 34.1%→33.3% and `lost@pool/scoring`
rose 33.1%→33.3% — it displaced slightly more than it surfaced.

**5. Against the pre-registered bar:**
- Success condition — multi-hop rises >3pp: **+0.0pp. Failed.**
- Strike condition — single-hop falls: **−1.6pp (2 broken, 0 fixed). Tripped.**

**Statistical honesty:** no individual slice reaches p<0.05; the single-hop drop
is 2 queries (p=0.46). This is *not* a statistically significant harm. The
argument is not "it is proven harmful" — it is that **the burden is on a feature
to demonstrate benefit before going default-ON, and it demonstrated none.** Across
15 slice×arm cells, `fixed > broken` in exactly **zero**. The unanimity of
direction is the signal, not any single cell.

## Where the value actually is

The dominant loss is unchanged by any arm: **32.5% `lost@pool/scoring`** — gold
that cleared the retrieval floor (89.1% do) and sits in the 80-candidate pool but
never gets ranked into the top 10. The cross-encoder is what rescues these today,
with a **+3.28 mean rank-lift**. Graph propagation adds nothing on top of it.

Two better targets than the graph, both visible in this data:

- **Temporal is the worst category by a wide margin — 5.7% success@1, 17.0%
  lost@candidate-floor**, roughly 5× the floor-loss of any other category. Nothing
  in D11 touches it. This is the largest single quality gap in the pipeline.
- **Ranking, not retrieval, is the bottleneck.** Gold is present and above floor
  ~89% of the time. The problem is ordering, which points at rerank/scoring work
  (or D10's sparse attribute layer) rather than at graph traversal.

This also confirms, independently, the conclusion already recorded in
`activation.ts:355` — that the design-aligned fix for multi-hop is **harness-side
decomposition** (the agent chaining sequential single-hop recalls), not in-engine
graph retrieval.

## Recommendation

Leave `AWM_SPREAD` default-OFF. Do not spend further effort on in-engine graph
propagation for multi-hop.

Keep the code and the `AWM_SPREAD_INHIBIT` implementation — inhibition is a real,
working mechanism that may matter if the graph ever becomes much denser (broad
entity edges, D9/D10). It is the *premise* that failed, not the implementation.

Whether that constitutes formally invoking the three-strikes park is Robert's call.

## Artifacts

All under `C:\Users\robert\Personal-Projects\AgentWorkingMemory\tests\locomo-eval\d11-retest\`:

- `PRE-REGISTRATION.md` — thresholds fixed before results, plus a post-hoc correction
- `run-arms.sh` — the four-arm driver
- `analyze.mjs` — paired McNemar analysis
- `{baseline,spread,spread-inhibit,spread-inject-inhib}.txt` / `.jsonl` — reports + per-query records
