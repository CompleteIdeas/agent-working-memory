# Pre-registration — rarity-weighted snippet selection

**Written before implementing or measuring.** Thresholds fixed in advance because
this session has already produced two results that were read wrong by deciding
what counted as success after seeing the numbers.

---

## Hypothesis

`summaryFor()` (`activation.ts:1028`) chooses the snippet window by **raw query-term
hit count** — every hit contributes exactly 1:

```js
for (const tok of snippetTokens) { ...hits.push(idx)... }
// window with the most hits wins
```

A real query is concept words **plus** a rare identifier ("Pipeline requires_horse
missing from division mock d.requires_horse"). In a long memory the concept words
recur throughout while the identifier appears once or twice, so the densest window
lands on the concept region and **misses the identifier**.

Measured consequence: compact@200 delivers the answer only **20.9%** of the time,
collapsing the effective answer rate from 76.7% to 16.0%.

**H:** weighting each hit by its **rarity** — so one occurrence of a rare term
outweighs many occurrences of a common one — moves the window onto the identifier
and raises sufficiency at the same character budget.

Implementation: weight a hit by `1 / (occurrences of that token in this document)`.
Doc-local, needs no corpus statistics, adds no queries, no latency. (Global IDF is
the alternative if this is insufficient — noted, not the first attempt.)

## Success condition

**Sufficiency at `COMPACT_LEN=200` rises by more than 10pp** over the 20.9%
baseline (i.e. > 30.9%), with the guards below intact.

Secondary, expected but not required: effective answer rate rises roughly in step,
and net tokens/recall improves.

## Guards — any of these breaks the change regardless of sufficiency

1. **Retrieval quality must be BIT-IDENTICAL.** Snippet selection runs *after*
   ranking and cannot influence which memories are returned or their order.
   `success@1`, `success@5` and `MRR` must be unchanged. Any movement means the
   change leaked into ranking and is a bug, not an improvement. This is the same
   internal-consistency check that validated phase 9b via Recall@10.
2. **Token spend must not rise materially.** The snippet is capped at
   `COMPACT_LEN` either way; a large increase means the cap is being violated.
3. **`full` granularity must be unaffected** — it does not call `summaryFor`.

## Failure conditions

- Sufficiency gain ≤ 10pp → the density heuristic was not the binding constraint;
  report as refuted and do not ship. Do **not** then go hunting for a threshold
  that makes it look positive.
- Any guard trips → bug, not a result.

## What will NOT be claimed

That sufficiency equals usefulness. "The identifier appears in the delivered text"
is necessary, not proof the agent can act on it. A stricter test needs a
downstream task, and this experiment does not attempt one.

## Default

Ships behind `AWM_SNIPPET_WEIGHT=rarity`, default OFF, regardless of outcome.
Flipping a default is a separate decision on separate evidence.
