# Retrievability campaign — final results

Protocol and per-option detail: `retrievability-campaign-2026-08-24.md`.
Decision process that selected the four: `decision-retrievability-2026-08-24.md`.

## All four options

Measured on `fixture-category.json` (450 probes, real store snapshot), same
metric set and same five bars for every arm.

| config | s@1 | s@5 | MRR | adversarial | p50 |
|---|---|---|---|---|---|
| baseline (bge-small) | 56.4% | 66.2% | 60.6% | 90.0% | 790ms |
| **option 2 — tags into rerank passage** | **63.8%** | **68.4%** | **66.0%** | 90.0% | 854ms |
| option 1 — tags into embedding only | 56.7% | — | — | 90.0% | — |
| option 1 — full (embedding + rerank) | 63.8% | 68.2% | 65.9% | 90.0% | — |
| option 3 — + mined dialect aliases | 63.6% | 68.2% | 65.8% | 90.0% | 877ms |
| option 4 — bge-base 768d alone | 57.1% | 65.1% | 60.5% | 90.0% | 777ms |
| option 4 + option 2 | 62.7% | 66.9% | 64.7% | 90.0% | 842ms |

**Winner: option 2 alone, +7.4pp. No combination beats it.** Every addition is
neutral or slightly negative. Adversarial silence held at exactly 90.0% in every
arm, so nothing bought recall by spending selectivity.

## The unifying finding

All four options attack the same defect: **a word the memory needs is missing
from its body.** Measured on the live store, 66.2% of topical tag terms never
appear in the text, and 94.3% of tagged memories are missing at least one. They
differ only in what they do about that, and the difference IS the result:

| approach | what it does with the missing word | outcome |
|---|---|---|
| option 2 | **supplies it to the stage that decides** | **+7.4pp** |
| option 1 | supplies it where it is diluted | +0.3pp |
| option 3 | *guesses* it from corpus statistics | −0.2pp |
| option 4 | tries to *infer around* it with better semantics | +0.7pp |

**Why dilution kills option 1.** The reranker sees a 400-char passage, so 80
chars of tags is ~20% of its entire input. The embedder sees the whole memory —
canonical median 1,965 chars — where the same eight words barely perturb a
384-dim vector. Added vocabulary helps in proportion to how much of a channel's
input it represents.

**Why guessing fails here.** PMI over 8-memory categories is a thin signal.
A hub guardrail removed 20 terms and 182 entries of session-summary boilerplate
(`discussed, turns, topics, summary` had been learned as "dialect" for many
unrelated categories), but roughly half the survivors are still coincidence.
That is a statement about corpus mass, not about the technique.

**Why a bigger model fails.** No model's weights encode that "private plan"
means Azure *in ShowConnect*. That knowledge is local to this store, not to the
English language. This also retroactively explains the flan-t5 categorisation
result (0/6, mode collapse): both were "add model capability" bets, and both
lost for the same reason rather than because the model was too small.

**You cannot recover a word that was never written.** You can only put the word
that IS recorded — the tag — in front of the component that decides.

## Recommendation

Ship **option 2 only**:

```
AWM_RERANK_TAGS=1            # 80-char budget; 160 was byte-identical
AWM_RERANK2=1                # already validated, +9.7pp on identifier queries
AWM_RERANK_WINDOW=query      # already validated, long-memory 25% -> 87.5%
```

Cost: ~+5–8% recall latency (run-to-run noise is ~4.5%, so treat as
approximate). **No** re-embed, **no** new model, **no** mined artifact to
maintain, **no** write-path change, and the existing corpus benefits
immediately — tags are already stored on every memory.

Rejected and why, in one line each:
- **Option 1** — costs a full-corpus re-embed, adds exactly 0.0pp over option 2.
- **Option 3** — needs a mined artifact kept current, returns −0.2pp.
- **Option 4** — needs a 440MB model and a full re-embed, returns +0.7pp alone
  and −1.1pp in combination.

## Process — eight instrument bugs, six of them silent

| # | bug | how it presented |
|---|---|---|
| 1 | stale MCP process | version unchanged after reconnect |
| 2 | stale benchmark server | two arms byte-identical |
| 3 | partially-applied edit | metric unchanged when it had to move |
| 4 | boost landed in the wrong branch | clean null |
| 5 | `expandQuery` skip heuristic | empty output at 0ms |
| 6 | **fixture could not express the mechanism** | **three arms identical** |
| 7 | undefined field on a new fixture | missing metrics, not an error |
| 8 | backfill run under plain `node` | **exit code 0**, file unchanged |

**#6 decided the campaign.** Option 2 — the eventual winner — first measured as
three identical arms and looked refuted. The identifier fixture is
unique-identifier hold-out, so 300/300 of its golds already contain the query
term; an option whose mechanism is "add vocabulary the body LACKS" is invisible
to it by construction. One instrument fix moved the winner from *refuted* to
*+7.4pp*.

Corrected protocol rule: **the shared metric SET is what makes arms comparable;
the FIXTURE must be chosen to exercise the mechanism.** The identifier fixture
kept a real job — no-regression guard — which is what it is actually suited for.

## Guards that earned their place

- **Completeness assertion (option 4).** `cosineSimilarity` returns 0 on
  dimension mismatch, so a half-migrated corpus scores zero on the vector
  channel for every un-migrated row. The re-embed WAS killed at 4,109/8,703.
  Without the assertion that would have read as "bge-base is catastrophic",
  complete with a plausible explanation ready to hand.
- **Resumability.** After that kill, making the job idempotent let it converge
  across restarts rather than restarting from zero. A long job that can be
  killed must be restartable, not merely correct.
- **Scope as guardrail (option 3).** "Require ≥1 original query term" was
  enforced by letting alias terms reach only the BM25 search string, never
  `queryTokens`. Adversarial held at 90.0% in every arm. A constraint enforced
  by where data may flow cannot be bypassed; a gate can be forgotten.
- **Inspectable artifacts (option 3).** Reading the mined alias map revealed its
  own contamination before any measurement. An 80M model offered no equivalent
  visibility — its failure was only detectable by scoring it.
