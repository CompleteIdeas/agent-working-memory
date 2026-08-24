# Pre-registration — temporal-aware recall

Written before implementing. Control and ceiling are already measured, so the
bar is not negotiable after the fact.

## Baseline (measured, 101 probes, real store)

| phrasing | s@1 |
|---|---|
| subject only (control) | **59.4%** |
| "…from last Friday" | 56.4% (−3.0pp) |
| "…from last week" | 56.4% (−3.0pp) |
| "…in May 2026" | 53.5% (−5.9pp) |
| "…on 2026-05-01" | 51.5% (−7.9pp) |
| **ORACLE (week-filtered)** | **96.0%** |

Nothing in the pipeline parses dates from query text, and `ActivationQuery` has
no date parameter. So temporal words are spent as ordinary BM25 tokens: they
dilute the subject terms and match `date=` tags corpus-wide. The most selective
thing the user said is currently a **penalty**.

## Hypothesis

Parsing the temporal expression and (a) removing it from the lexical query and
(b) preferring candidates inside the implied window will move success@1 from
59.4% toward the 96.0% oracle.

## Success condition

**success@1 on temporally-phrased queries rises >10pp above the 59.4% control**
(i.e. >69.4%), with guards intact.

Two sub-results are worth separating, because they have very different cost and
risk, and the cheap one may carry most of the value:

- **strip-only** — remove temporal words, no window logic. Expected to recover
  the −3 to −8pp loss, i.e. return to ~59.4%. Near-zero risk.
- **strip + window preference** — the actual hypothesis.

## Guards — any of these breaks it regardless of the headline

1. **Queries with NO temporal expression must be BIT-IDENTICAL.** The parser
   must be a strict no-op when it matches nothing. This is the main risk: a
   greedy matcher that fires on ordinary words would silently reshape every
   recall in the store. Verified against the identifier fixture, not just the
   temporal one.
2. **Adversarial abstention must not fall.** Boosting in-window candidates must
   not manufacture confidence on queries with no answer.
3. **No hard exclusion.** The window is a PREFERENCE, never a filter. Robert
   said "last Thursday **or** Friday" precisely because he was unsure; a hard
   filter would drop the answer whenever the user misremembers. A memory
   outside the window must still be reachable on subject strength alone.

## Failure conditions

- Gain ≤10pp → report refuted; do not go hunting for a boost constant that
  crosses the line. If strip-only carries the value, say so and ship only that.
- Any guard trips → bug, not a result.

## What will NOT be claimed

That 96.0% is achievable. The oracle knows the exact week; a parser working from
"last Friday" against an `asOf` anchor will sometimes pick the wrong window, and
users misremember. The oracle bounds the gain, it does not predict it.

## Default

Ships behind `AWM_TEMPORAL=1`, default OFF, whatever the result.
