# Abstention: knowing when the store does not have it

**Opt-in.** Set `AWM_ABSTAIN_GATE=calibrated` in the AWM server's environment, then run
`awm calibrate`, or let the next consolidation do it.

A memory that answers every question with its nearest match is a confident liar. The correct
answer to "what is our Kafka consumer-lag threshold?", when nobody ever stored one, is "I don't
have that". The calibrated gate makes AWM say so, using a noise floor it learns from its own
store.

**Current figures (v0.22.4, one real store, re-measured 2026-11-15).** Keyword-shaped questions: withholds **50 of 73** never-stored facts and **1 of 718** correct answers (flags 6); of 200 questions whose fact was deleted, withholds 95 and flags 19. Natural-language questions, once memories carry questions: withholds **3 of 103** correct answers, but answers 88 of 97 questions whose fact was deleted. Earlier pages published 58 (and 66) of 73 and 10 of 97; those do not reproduce ([claims §2](claims.md)). The sections below are the history of how the gate was built, with the figures measured at each step.

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

1. **Features.** It uses three numbers from the ranking:
   - the cross-encoder score of the top result, on the logit scale (scores bunch near 1, and the
     logit keeps them apart);
   - the vector similarity of the top result;
   - the logit margin between results #1 and #2.

   Since 0.22.4 those are read from the **blend's** order (`gateOrder` in
   `src/engine/activation.ts`), not from the final order after the first-place rule: the
   thresholds were fitted on the blend's #1, and scoring the rule's #1 shifted the gate's
   decisions. Calibration labels its probes by the same result (`gateTopId`). A natural-language
   question (`src/core/query-shape.ts`) is scored by a **separate model** (`GateModel.natural`,
   0.22), fitted on the memories' stored questions; when the store has too few questions to fit
   it, natural queries use the main model. `AWM_GATE_FEATURES=2` selects an eight-signal set
   (adds BM25 and cosine-distribution features); the three-signal set is the default.
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

## History: 0.21.1 measurements on the real snapshot

> **History, not current figures.** This section records the 0.21.1 measurements, before the
> natural-question model and stored questions (0.22) and the first-place rule (0.22.4). The
> current figures are at the top of this page.

`tests/realstore-eval/gate-eval.ts` runs the real `calibrateGate()` per agent from the store
alone, switches the gate on, and sends every labelled question through ordinary recall. Figures
below are for the 0.21.1 ranking (fused shortlist, 32-candidate pool, blended order), recalibrated;
the 0.21.0 figures are in the CHANGELOG.

| | Answered | ⚠ Low signal | Withheld |
|---|---|---|---|
| Correct answers (706) | 701 | 3 | **2** |
| Absent, new vocabulary (73) | 5 | 2 | **65 (89%)** + 1 empty |
| Absent, familiar vocabulary (200) | 74 | 28 | **98 (49%)** |

The same 0.21.1 gate on **natural-language questions** (`GATE_FIXTURE=fixture-nl.json`: 194 questions
written per memory, vetted to use at most one store-rare word and no identifiers):

| | Answered | ⚠ Low signal | Withheld |
|---|---|---|---|
| Correct answers (88) | 64 | 3 | **21 (24%)** |
| Absent, new vocabulary (73) | 5 | 2 | **65 (89%)** + 1 empty |
| Absent, familiar vocabulary (97) | 28 | 9 | **60 (62%)** |

**Correction (2026-10-30).** 0.21.0 published "0 of 694 correct answers withheld". The harness
judged correctness from the gated recall, so a withheld answer could never be counted correct;
the figure was 0 by construction. It now judges correctness from an ungated recall; on the 0.21.0
ranking the true figure was 1 of 695.

The two agents got different floors (answer at −0.93 and −2.10 on that run), which is the gate
adapting to each store.

In 0.21.1 natural-language questions lost a quarter of their correct answers (21 of 88) because
calibration generates keyword-shaped probes, so a naturally phrased question scored below the
floor it learned ([abstention-signals-2026-10-30.md](abstention-signals-2026-10-30.md)). 0.22
shipped the fix: a separate model for natural-language questions, fitted on stored questions.

**What this means (v0.22.4, re-measured 2026-11-15):**
- **Never-stored facts:** AWM withholds 50 of 73 questions about facts that were never stored,
  up from about 0% with the default gate.
- **Correct answers:** on keyword-shaped questions it withholds 1 of 718 and flags 6. On
  natural-language questions, once memories carry questions, it withholds 3 of 103.
- **The hard case:** facts whose surroundings are familiar but the answer is gone. On keyword
  questions it withholds 95 of 200 and flags 19 more; on natural-language questions it still
  answers 88 of 97.

## Limits

- **A deleted fact in familiar territory is the hard limit: about 0.83 AUC on natural-language
  questions.** When the answer is gone but memories about the same thing remain, those neighbours
  look like answers. Every signal measured stops near the same place — the cross-encoder, vector
  and keyword ranks, how much of the store matches, the question's shape, the memory's kind, and a
  small reading model that checks whether the top memory states an answer (0.827 → 0.840, below
  the 0.88 that would have justified its 86 ms). Never-stored facts are a different story: those
  are caught at 0.95–1.0. Measurements: [abstention-signals-2026-10-30.md](abstention-signals-2026-10-30.md)
  §4–5 and §12.
- **Measured on one store.** It is a real 29,853-memory store, but only one. The public
  synthetic corpus (`npm run bench:public`) is the reproducible check for others.
- **Two question sets, one store.** The keyword-style set is the main one; the natural-language
  fixture (`fixture-nl.json`, 194 questions written per memory) is smaller, so its figures move
  more from run to run.
- **The cross-encoder must run.** With the reranker disabled, the gate stands aside.
- **The familiar-vocabulary absent set** is built by deleting one memory. If the same fact is
  repeated in another memory, that "absent" question is really answerable, so the share of
  deleted-fact questions still answered (for example 88 of 97 natural-language ones) is a
  pessimistic figure.
