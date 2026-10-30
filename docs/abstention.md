# Abstention: knowing when the store does not have it

**Opt-in.** Set `AWM_ABSTAIN_GATE=calibrated` in the AWM server's environment, then run
`awm calibrate`, or let the next consolidation do it.

A memory that answers every question with its nearest match is a confident liar. The correct
answer to "what is our Kafka consumer-lag threshold?", when nobody ever stored one, is "I don't
have that". The calibrated gate makes AWM say so, using a noise floor it learns from its own
store.

## Why the old gate could not do it

The shipped `require_confidence` gate judges the *shape* of one query's scores ("is #1 clearly
ahead of #2?"). Measured on a frozen 29,853-memory store, with 750 answerable questions and 73
verified-absent ones, it could not separate the two at any threshold:

| `require_confidence` | Correct answers silenced (of 695) | Absent facts silenced |
|---|---|---|
| 0.05 (shipped) | 0 | ~0% |
| 0.20 | 40 | ~35% |
| 0.30 | 293 | ~88% |

**A correction.** AWM previously published "90.0% correct abstention" next to "92.7% first-result
accuracy". These came from different configurations and were never true together. The strict
gate behind the 90% (`abstentionThreshold` 0.3) drops first-result accuracy to 38% (identifier)
and 57% (topic). The 90% was also measured on only 10 questions.

## What separates "has it" from "doesn't"

Each signal was scored by AUC against two kinds of absence (1.0 = perfect, 0.5 = chance):
- **Absent, new vocabulary:** the question's distinctive words never occur in the store.
- **Absent, familiar vocabulary:** real answerable questions asked of a copy of the store with
  their answer deleted. Every word still exists nearby, and only the fact is gone.

| Signal | vs absent, new vocabulary | vs absent, familiar vocabulary |
|---|---|---|
| Cross-encoder score of the top result | **0.998** | **0.905** |
| Vector similarity of the top result | 0.867 | 0.871 |
| Score-shape confidence (the old gate) | 0.868 | 0.671 |
| Rarity of the question's words | 0.955 | 0.589 |

The cross-encoder reads the question and the memory together. It was in the pipeline all along,
but the gate was not listening to it.

## How the calibrated gate works

1. **Features.** It uses three numbers from the final ranking:
   - the cross-encoder score of the top result, on the logit scale (scores bunch near 1, and the
     logit keeps them apart);
   - the vector similarity of the top result;
   - the logit margin between results #1 and #2.
2. **Self-calibration, with no labels.** After a full consolidation, or on `awm calibrate`, AWM
   generates about 300 queries from its own store and runs them as internal recalls, which leave
   no trace. There are three kinds:
   - **Answerable:** a random memory's title words plus a word unique to it. Its answer is known.
   - **Familiar nonsense:** title words of two unrelated memories, mixed. Every word is real, but
     there is no such fact.
   - **Random:** words from the store's vocabulary.
3. **Fit.** A small class-balanced logistic model is fitted on those queries, per agent, and saved
   in `abstention-model.json` beside the store.
4. **Bands.** Every recall lands in one band:
   - **Answer:** the score is at least the level that keeps 98% of the synthetic correct answers.
   - **Low signal:** the score is between that level and the median score of the synthetic
     nonsense queries. The results are returned with *⚠ LOW SIGNAL — this store probably does not
     hold the answer*.
   - **Withhold:** below the nonsense median. Nothing is returned, and the reply says
     `RECALL ABSTAINED — this store most likely does not hold this`, with the numbers. It is
     never a silent empty result.
5. **Refit.** The model is refitted when it is missing, older than 7 days
   (`AWM_ABSTAIN_RECALIBRATE_DAYS`), or the store has grown by a fifth. The floor follows the
   store.

`require_confidence: 0` on `memory_recall` opens the gate, for when the user has reason to think
the fact *is* stored.

## Measured: the shipped code on the real snapshot

`tests/realstore-eval/gate-eval.ts` runs the real `calibrateGate()` per agent from the store
alone, switches the gate on, and sends every labelled question through ordinary recall.

| | Answered | ⚠ Low signal | Withheld |
|---|---|---|---|
| Correct answers (695) | 690 | 4 | **1** |
| Absent, new vocabulary (73) | 4 | 3 | **65 (89%)** + 1 empty |
| Absent, familiar vocabulary (200) | 78 | 30 | **92 (46%)** |

The same gate on **natural-language questions** (`GATE_FIXTURE=fixture-nl.json`: 194 questions
written per memory, vetted to use at most one store-rare word and no identifiers):

| | Answered | ⚠ Low signal | Withheld |
|---|---|---|---|
| Correct answers (80) | 56 | 6 | **18 (22%)** |
| Absent, new vocabulary (73) | 4 | 3 | **65 (89%)** + 1 empty |
| Absent, familiar vocabulary (97) | 19 | 9 | **69 (71%)** |

**Correction (2026-10-30).** 0.21.0 published "0 of 694 correct answers withheld". The harness
judged correctness from the gated recall, so a withheld answer could never be counted correct;
the figure was 0 by construction. It now judges correctness from an ungated recall.

Calibration took 118 s for the 7,458-memory agent and 92 s for the 1,215-memory one. The two
agents got different floors (answer at −0.60 and −1.87), which is the gate adapting to each
store.

**What this means:**
- **Never-stored facts:** AWM now withholds 90% of questions about facts that were never stored,
  up from about 0%.
- **Correct answers:** on keyword-shaped questions it withholds one and flags four. On
  natural-language questions it withholds 18 of 80. Calibration generates keyword-shaped probes
  (title words plus a distinctive term), so a naturally phrased question scores below the floor
  it learned. Fixing the probes is the next step.
- **The hard case:** facts whose surroundings are familiar but the answer is gone. It withholds
  or flags 61% and still answers 39%.

## Limits

- **Measured on one store.** It is a real 29,853-memory store, but only one. The public
  synthetic corpus (`npm run bench:public`) is the reproducible check for others.
- **The question set is keyword-style.** It contains no natural-language questions; that is a
  benchmark gap to close.
- **The cross-encoder must run.** With the reranker disabled, the gate stands aside.
- **The familiar-vocabulary absent set** is built by deleting one memory. If the same fact is
  repeated in another memory, that "absent" question is really answerable, so the 39% is a
  pessimistic figure.
