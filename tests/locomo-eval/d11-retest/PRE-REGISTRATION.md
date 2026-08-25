# D11 re-test — pre-registration

**Written 2026-08-23, BEFORE any arm results were read.** Baseline figures quoted
below are from a 1-conversation smoke run only; the real comparison is against
arm 1 of the same 10-conversation run.

The point of writing this first: the rule being tested is a **three-strikes rule
with two strikes already spent**, and the consequence is permanent. Deciding what
counts as a regression *after* seeing the numbers would be motivated reasoning on
exactly the decision that can least afford it.

---

## What each arm can and cannot do (verified in source, not assumed)

`spreadActivation(topN)` receives the **already-cut candidate pool**
(`activation.ts:792` — `sorted.slice(0, limit * topNMult)`). That constrains what
each arm is even capable of moving:

| Mechanism | Code | Reach |
|---|---|---|
| **Boost** | `activation.ts:1386` — `const item = scoreMap.get(id); if (!item) continue;` | **In-pool only.** Skips any reached node that is not already a candidate. |
| **Inject** | `activation.ts:1398` — `.filter(([id]) => !scoreMap.has(id))` → `topN.push(...)` | **The only path that adds out-of-pool engrams.** |

Consequences, registered in advance:

- Arms 2 and 3 (`spread`, `spread-inhibit`) can only convert `found@2-5` /
  `found@6-10` → `success@1`. They are **structurally incapable** of recovering
  `lost@pool/scoring` (23.5% of answerable) or `lost@candidate-floor` (9.4%).
- **A flat multi-hop result in arm 3 is therefore the EXPECTED outcome, not a
  refutation of D11.** Only arm 4 tests the hypothesis that matters.
- Inhibition's job in arms 2/3 is *precision*: it should show up as adversarial
  abstention and single-hop being protected, not as a multi-hop gain.

## Strike conditions (co-equal — either one trips it)

A "regression" for three-strikes purposes is **either** of:

1. **single-hop success@1 falls** vs arm 1. Classic displacing-gold.
2. **adversarial abstention falls** vs arm 1. Equally weighted, and arguably the
   more sensitive detector — injection is the mechanism most likely to damage it.
   The source comment claims *"adversarial queries have weak/empty seeds, so
   nothing meaningful propagates and abstention is unaffected"*
   (`activation.ts:1266`). That is a **claim, not a measurement**. This run is the
   first thing capable of checking it, so it is tested, not trusted.

## Success condition

**multi-hop success@1 rises** by more than noise, with neither strike condition
tripped.

Noise floor: ~250 multi-hop probes across 10 convs at p≈0.2 gives SE≈2.5pp per
arm. Treat anything under **3pp** as not a finding.

**Preferred test — paired, not independent.** Every arm probes the identical
query set in the identical order and logs per-query records to
`<arm>.jsonl`. So the arms are *paired*, and the correct test is **McNemar on
the discordant pairs** (queries that flipped success↔failure between arms), which
is materially more sensitive than comparing two marginal percentages. Report
discordant counts (b, c), not just the delta in success@1.

## Known instrumentation gap

`AWM_SPREAD_INHIBIT` is **not** in the tracer's arm-label list
(`trace.ts:64` covers only QUERY_BRIDGE / AUTOTAG / SPREAD / SPREAD_INJECT /
BROAD_EDGES). Arms 2 and 3 will both self-report `arm=spread`. The filenames
distinguish them; the output does not.

Positive control required before arm 3 is interpreted at all:

- `diff spread.txt spread-inhibit.txt` → metrics differ ⇒ inhibition demonstrably
  altered propagation.
- Bit-identical ⇒ **ambiguous**, not "λ=0.3 is a no-op". Re-run with
  `AWM_SPREAD_DEBUG=1` and compare the `[spread] seeds=… reached=… maxGa=…`
  stderr lines across the two settings.

## Adjudication

If arm 4 regresses, that is the third regression under the rule recorded in
`docs/archive/design-proposals-2026-07-30.md` D11. **Parking the feature permanently is
Robert's decision, not this run's.** Report the attribution table, state plainly
that the rule's condition is met, and leave the call to him.

---

## POST-HOC CORRECTION (written after results, before conclusions)

**A pre-registered assumption above is wrong, and it was wrong in the direction
that flattered the feature.** Recording it rather than editing it out, because a
pre-registration that gets silently revised is worth nothing.

The claim was: *"Arms 2 and 3 are structurally incapable of recovering
`lost@pool/scoring`."* That rested on reading `preRank` as "gold entered the
candidate pool." It does not mean that. `trace.ts:120-121` issues **two separate
`activate()` calls**, both capped at `limit = 10`:

```
pre  = activate({ ..., limit: LIMIT, useReranker: false })   // preRank
post = activate({ ..., limit: LIMIT })                        // postRank
```

So `preRank > 0` means "gold landed in the top-**10** without the reranker" — not
"gold was among the candidates." The actual candidate pool is
`limit * topNMult` = **80** engrams (`activation.ts:792`), and `spreadActivation`
boosts across all 80.

Therefore `lost@pool/scoring` (32.5% of answerable, the dominant bucket) is
largely gold that **was** in the 80-candidate pool and simply never got ranked
into the top 10. Boost could have lifted exactly those. Gold cleared the
retrieval floor in 89.1% of cases, so it was available to the scorer.

**Consequence for the verdict:** arms 2 and 3 had a genuine, large opportunity to
move the dominant loss bucket. A null there is *not* "expected" as pre-registered
— it is a real failure to deliver. This strengthens the refutation.

The strike conditions and the success condition are unaffected: they were defined
on single-hop, adversarial, and multi-hop success@1, none of which depend on this
misreading.
