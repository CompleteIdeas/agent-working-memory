# Token economics on the real store — the default recall limit is a net loss

**Date:** 2026-08-24 · Instrument: `tests/realstore-eval` (frozen snapshot of the
live store, 1,316 unique-identifier ground-truth probes, n=150 per arm)

---

## The measurement that changed the answer: sufficiency

Retrieval is only half the job. A recall that ranks the right memory first but
**omits the answer** leaves the agent to go read the code anyway — so it pays the
~2,106-token fallback *on top of* what the recall cost. Crediting retrieval with
a saving overstates AWM's value.

The fixture makes this mechanical, no LLM judge required: every probe carries the
answer-bearing identifier, so "did the delivered text contain it?" is checkable.

- **SUFFICIENCY** — of retrieved golds, how many actually contain the answer
- **EFFECTIVE** — retrieved *and* sufficient, over all probes
- **NET** — `sufficient × 2106 − tokens actually spent`

## Results

| config | s@1 | sufficiency | effective | tok/answer | **net/recall** |
|---|---:|---:|---:|---:|---:|
| k=7 `full` | 46.7% | 100% | 76.7% | 3,788 | −1,290 |
| **k=5 `full` — shipped default** | 48.0% | 100% | **76.7%** | 2,764 | **−504** |
| **k=3 `full`** | **50.0%** | 100% | 74.0% | **1,882** | **+166** |
| k=7 `compact@200` | 46.7% | 20.9% | 16.0% | 2,900 | −127 |
| k=6 `compact@600` | 46.7% | 40.0% | 30.7% | 3,429 | −406 |
| k=3 `compact@400` | 50.0% | 30.6% | 22.7% | 1,482 | +141 |

## Two conclusions, one of which reverses an earlier recommendation

**1. Lower the default recall limit from 5 to 3.** The shipped default costs
2,764 tokens per delivered answer against a 2,106-token fallback — AWM is
currently a net token *loss* of ~504 per recall. k=3 costs 1,882 and is net
**+166**, a 670 token/recall swing, for 4 fewer answers out of 150
(76.7% → 74.0% effective) and a *better* success@1 (48.0% → 50.0%).

Success@1 rising as k falls is not noise: `topN = limit × AWM_TOPN_MULT`, so a
smaller limit narrows the candidate pool and gives the ranker less to be
distracted by.

**2. Do NOT default to `compact`.** An earlier note here recommended exactly that,
on the strength of "identical retrieval quality, +993 tokens/recall". That was
wrong twice over:
 - the economics credited *retrieval* rather than *delivery*; once corrected,
   compact@200 is −127/recall, not +993;
 - and compact's snippet contains the answer only **20.9%** of the time, so the
   effective answer rate collapses **76.7% → 16.0%**. It saves tokens by not
   answering.

## Why compact fails, and the fix worth trying

The compact snippet is query-aware — it picks the window densest in query terms.
But the query contains concept words *and* the identifier, so the densest window
often lands on the concept-matching region and misses the identifier. Weighting
by term **rarity** (the identifier is the rare term) rather than raw density
should recover most of the gap at 200 chars, which would make compact genuinely
cheap *and* sufficient. Untested — the honest next experiment.

## Caveats

- n=150 per arm from a 1,316-probe fixture; directionally strong, and the k=5→k=3
  gap (670 tok/recall) is far outside noise, but the small deltas are not.
- Sufficiency is "the identifier appears in the delivered text". That is
  necessary, not provably sufficient for the agent to act — a stricter test would
  need a downstream task.
- `FALLBACK_TOKENS = 2106` is AWM's own published figure for a file-read
  fallback. Every net number scales linearly with it; if the true fallback is
  larger, AWM looks better, and vice versa.
