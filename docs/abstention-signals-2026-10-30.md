# Abstention signals: what each one knows, and a probability model over all of them

*Findings ledger, 2026-10-30. Measured on the frozen private snapshot (29,853 memories; agents
`work` 7,458 and `personal` 1,215 retrievable) with the 0.21.1 ranking (fused shortlist, 32-candidate
pool, 0.85 cross-encoder blend). Questions: 750 keyword-shaped answerable (300 identifier + 450 topic),
194 natural-language answerable, 73 never-stored, 200 keyword + 97 natural-language "deleted"
(the question's answer removed from a copy, its neighbours kept). Tools:
`tests/realstore-eval/signal-dump.ts`, `density-dump.ts`, `signal-eval.ts`, `signal-gestalt.ts`,
`gate-candidate.ts`, `prob-model.ts`. Each entry is dated so later runs can append rather than
overwrite.*

**AUC** below is the chance that a random correct answer scores above a random absent question:
0.5 is a coin flip, 1.0 is perfect. **Honest** means fitted the way the shipped gate is fitted, on
synthetic probes generated from the store alone. **Ceiling** means fitted by 5-fold cross-validation
on the labelled questions themselves: what the signals could do with representative training data,
never something to ship.

## 1. The question

The opt-in calibrated gate (`AWM_ABSTAIN_GATE=calibrated`) reads three signals from the top result:
the cross-encoder's score, its margin over the second result, and the top result's vector
similarity. On keyword-shaped questions it is nearly perfect. On natural-language questions it
withholds about a quarter of correct answers and still answers a fifth of questions whose answer
was deleted. Robert asked (2026-10-30) whether other signals, combined as probabilities, would do
better, and whether "how much of the store matches the query" could be one of them.

## 2. Every signal on its own (2026-10-30)

Value measured on the top result the shipped ranking returns. `+` means a higher value says the
answer exists; `−` means the reverse.

| Signal | kw vs never-stored | kw vs deleted | NL vs never-stored | NL vs deleted |
|---|---|---|---|---|
| **Cross-encoder score** | +1.000 | +0.929 | +0.921 | +0.746 |
| Cross-encoder margin over 2nd | +0.919 | +0.798 | +0.829 | +0.694 |
| Cross-encoder z-score within the pool | +0.788 | +0.514 | +0.840 | +0.604 |
| Vector similarity of the top result | +0.897 | +0.894 | +0.894 | +0.741 |
| … relative to the pool's mean | +0.768 | +0.866 | +0.801 | +0.672 |
| Vector rank of the top result | +0.816 | +0.860 | +0.784 | +0.745 |
| BM25 rank of the top result | +0.739 | +0.767 | +0.578 | +0.634 |
| **Raw BM25 score of the best match** (FTS5 rank, unnormalised) | +0.978 | +0.889 | **+0.978** | **+0.757** |
| Raw BM25 of the 10th match | +0.715 | +0.664 | +0.963 | +0.576 |
| Every query term in one memory (count) | +0.998 | +0.886 | 0.500 | 0.500 |
| … as a fraction of any-term matches | +0.998 | +0.910 | 0.500 | 0.500 |
| Memories matching any query term | +0.648 | +0.542 | +0.706 | +0.543 |
| Best cosine over the whole store | +0.915 | +0.797 | +0.890 | +0.710 |
| Best cosine minus the 10th | +0.885 | +0.807 | +0.885 | +0.707 |
| Mean of the top-10 cosines | +0.822 | +0.652 | +0.779 | +0.592 |
| Memories above cosine 0.5 / 0.6 / 0.7 / 0.8 | 0.68 / 0.77 / 0.81 / 0.59 | 0.57 / 0.60 / 0.70 / 0.59 | 0.55 / 0.73 / 0.74 / 0.51 | 0.52 / 0.55 / 0.66 / 0.50 |
| Question asks when/how many/who, answer lacks date/number/name | 0.500 | 0.500 | 0.523 | −0.513 |
| Top memory is canonical | +0.723 | +0.567 | +0.625 | −0.558 |
| Top memory is a consolidation synthesis | 0.518 | −0.524 | −0.504 | 0.507 |
| Top memory's confidence / access count / age / length | 0.56–0.78 | 0.51–0.65 | 0.52–0.66 | 0.51–0.58 |

What this says:

- **The raw BM25 score was hidden.** AWM normalises `textMatch` within each query, which destroys
  the one thing a gate needs: whether the match is strong in absolute terms. Unnormalised, it is
  the best single signal on natural-language deleted facts and ties the cross-encoder on
  never-stored ones. It is free: the number is already computed.
- **Match density, counted, is weak; shaped, it is useful.** Counting memories above a cosine
  level is 0.5–0.8. The *shape* carries the information: how strong the best match is and how far
  it stands above the rest. A store that knows a topic has one clear peak.
- **"All the query's words in one memory" is near-perfect for keyword lookups and useless for
  natural questions**, which are too long to match word for word.
- **Answer type and memory kind are not signals.** Whether a "when" question's top memory holds a
  date tells nothing. Syntheses rarely reach the top, so they are not what fools the gate.
- **The three channels are nearly independent** (Spearman over 29,795 candidates: cross-encoder
  vs vector −0.01, vs BM25 0.31, BM25 vs vector −0.32). That is why fusion helps ranking, and why
  adding channels to the gate helps a little.
- **Two recorded signals are meaningless as measured** and were dropped: the vector hit count is
  always 50 (the search cap), and the normalised `textMatch` cannot compare across queries.

## 3. Candidate-level probability (2026-10-30)

A logistic model of P(this candidate is the answer) over twelve candidate signals (own and relative
to the pool), fitted per agent on the calibration probes. Ranking by that P, against the shipped
blend:

| | Keyword (750) | Natural-language (194) |
|---|---|---|
| Shipped blend (0.85 cross-encoder + 0.15 fused rank) | **706** | 88 |
| Rank by P | 681 | **94** |

Standardised weights (work agent): BM25 rank 0.36, cross-encoder z-score 0.30, cross-encoder
score 0.26, vector rank 0.19, BM25+vector agreement 0.16, cosine 0.12, composite 0.11. The
probability is well ordered: when P(top) is 0.7–0.9 the top is the gold 100% (kw) and 96% (NL) of
the time; when it is under 0.1, 53% and 27%.

Reading: a learned blend trained on keyword-shaped probes still ranks natural questions better
than the hand-set blend, and keyword questions worse. The hand-set blend was tuned on the
labelled set, so the comparison flatters it. Not adopted for ranking yet; a fit on natural
calibration data is the right test.

## 4. Query-level probability: P(the store holds the answer) (2026-10-30)

Twenty-five signals in five families — cross-encoder (3), vector (5), match density (9), query
shape (4), candidate-model summaries (4) — in an unregularised-bias, L2 logistic model, fitted per
agent on the calibration probes. Against the shipped three signals fitted the same way:

| Honest fit | kw never-stored | kw deleted | kw log-loss | NL never-stored | NL deleted | NL log-loss |
|---|---|---|---|---|---|---|
| Shipped 3 signals | 0.995 | 0.965 | 0.206 | 0.901 | 0.799 | 0.679 |
| **All 25 signals** | 0.996 | 0.969 | **0.176** | **0.933** | **0.824** | **0.566** |

| Ceiling (CV on labelled) | kw never-stored | kw deleted | NL never-stored | NL deleted |
|---|---|---|---|---|
| Shipped 3 signals | 0.998 | 0.969 | 0.932 | 0.827 |
| All 25 signals | 0.998 | 0.970 | **0.997** | 0.826 |

Reliability of the honest full model (predicted P → observed rate of "answer exists"):
keyword 0.0–0.1 → 4%, 0.3–0.5 → 61%, 0.7–0.9 → 90%, 0.9–1.0 → 99%: well calibrated.
Natural-language 0.0–0.1 → 15%, 0.3–0.5 → 50%, 0.7–0.9 → 100%: calibrated in order but
**under-confident on correct answers** — the median correct natural-language answer gets P 0.52,
against 0.99 for keyword. The model has never seen a natural question with an answer, because
the calibration probes are keyword-shaped.

Drop-one-family ablation on the honest model (NL AUC, deleted / never-stored; change vs full):

| Dropped family | NL deleted | NL never-stored |
|---|---|---|
| none (full) | 0.824 | 0.933 |
| cross-encoder | 0.810 (−0.014) | 0.908 |
| **match density** | 0.809 (−0.015) | **0.885 (−0.048)** |
| vector | 0.823 (−0.001) | 0.927 |
| query shape | 0.824 (0) | 0.933 |
| candidate-model summaries | 0.826 (+0.002) | 0.931 |

One family alone (honest, NL deleted / never-stored): cross-encoder 0.756 / 0.877; vector
0.779 / 0.780; **density 0.780 / 0.946**; query shape 0.494 / 0.716; candidate summaries
0.785 / 0.842.

Weights the honest query model leans on (work, standardised): cross-encoder score +1.48, margin
+1.34, BM25 rank of top +0.74, **raw BM25 of best match +0.71**, cosine of top +0.66, candidate
sum-of-P −0.53, cosine relative to pool +0.49, memories matching any term −0.40.

## 5. Findings

1. **Match density is the best family for "was this ever stored?"** Alone it reaches 0.946 on
   natural-language never-stored questions (the cross-encoder: 0.877), and with representative
   training the ceiling is 0.997. Dropping it costs the most of any family. Robert's instinct was
   right about the *idea*; the useful form is the raw BM25 of the best match and the shape of the
   cosine distribution, not a count.
2. **Deleted facts in familiar territory are the hard limit, at about 0.82–0.83 on natural
   language**, whatever the signals and however they are fitted. The deleted fact's neighbours are
   still in the store and look like answers. No signal here distinguishes "the right memory" from
   "a memory about the same thing". That needs content-level evidence (does the top memory
   actually contain what was asked), which none of these signals carry.
3. **Query shape and gestalt interactions add nothing.** The signals add; they do not change each
   other's meaning. A natural-vs-keyword flag helps only by base rate in a mixed stream.
4. **The honest model is better calibrated than the shipped gate** (log-loss 0.566 vs 0.679 on
   natural language, 0.176 vs 0.206 on keyword) with no keyword regression. Its remaining fault is
   under-confidence on natural-language correct answers, which is a training-data fault: the
   calibration probes are keyword-shaped.
5. **Therefore the lever is calibration data, not signals.** Natural questions with known answers
   — e.g. "questions this memory answers", written by the agent at write time — would let the gate
   learn what a natural question with an answer looks like, and would serve ranking as
   write-time expansion at the same time.

## 6. What to ship, and what not to

- **Ship (candidate for 0.21.2):** add the raw BM25 of the best match, the whole-store cosine
  shape (best, best−10th, count above 0.7, any-term match count) and the top result's BM25 rank
  to the gate's features. Cost: one brute-force cosine pass over the agent's vectors
  (7,458 × 384 ≈ 3 M multiply-adds, a few ms) and reading a number FTS5 already computes.
  Expected on this store: NL never-stored 0.90 → 0.93, NL deleted 0.80 → 0.82, log-loss down a
  sixth, keyword unchanged. Measure before claiming.
- **Do not ship:** answer-type matching, memory-kind features, query-shape features, interaction
  terms, P-ranking in place of the blend (it loses 25 keyword questions).
- **Next experiment:** natural calibration data. Prototype agent-written questions at write time
  on the snapshot (one question per memory for a sample), recalibrate on them, and re-run
  `gate-eval.ts` with `GATE_FIXTURE=fixture-nl.json`. Success is NL correct-withheld well under
  the current 22 of 88 with never-stored still ≥ 60 of 73.

## 7. Method notes

- `fitLogistic()` in `abstention-gate.ts` is class-balanced, which is right for picking a
  threshold and wrong for probabilities. `prob-model.ts` uses an unweighted damped-Newton L2
  logistic for calibrated outputs. The first run without damping diverged on the 32:1 candidate
  imbalance (standardised weights of 98) and ranked the gold first on 179 of 750; the damped fit
  with L2 3e-2 gives 681. Keep damping.
- The never-stored questions are all keyword-shaped, so any query-shape feature can learn
  "natural = absent" from them. The query-shape test in `signal-fit.ts` therefore uses
  answerable + deleted only, mixed across fixtures.
- Seven natural-language golds are themselves consolidation pattern rows.

## 8. Building it: the forecast did not survive the first live run (2026-10-30, later)

The v2 features (shipped three + raw BM25 of the best match, whole-store cosine shape, BM25 rank of
the top result) were built into `abstention-gate.ts` / `activation.ts` (model version 2) and run
end to end through `gate-eval.ts`, which calibrates with the production code.

| v2 gate, first live run | Correct withheld | Never-stored withheld | Deleted withheld |
|---|---|---|---|
| keyword (offline forecast) | 1 of 706 | 61 of 73 | 76 of 200 |
| **keyword (live)** | 0 of 706 (11 flagged) | **51 of 73** (14 flagged) | **52 of 200** (56 flagged) |
| natural-language (offline forecast) | 6 of 88 | 61 of 73 | 37 of 97 |
| **natural-language (live)** | 3 of 88 (5 flagged) | 51 of 73 | **9 of 97** (25 flagged) |

The withhold line landed far lower than the shipped gate's (−2.95 vs −1.64 for `work`), so the
gate went soft on everything. Two causes identified so far:

1. **A definition gap between the offline features and the live ones.** Offline, the cosine gap
   was best-minus-10th over the whole store. Live, the vector search drops hits under cosine 0.40,
   so a query with fewer than ten survivors had no 10th; the code used 0, which gave never-stored
   queries (few hits) the widest gap of all and made them read as "one clear peak". Fixed: the
   floor stands in for a missing 10th. Re-measuring.
2. **Probably, the synthetic no-answer probes.** Fifty of the 150 calibration nulls are random
   mid-frequency vocabulary. With density features those are trivially rejected (near-zero BM25,
   few vector hits), which pulls the null median, and with it the withhold line, far below where
   real absent questions sit. If the gap fix does not restore the never-stored rate, the fix is on
   the data side again: nulls that look like real absent questions (coherent phrasing about a
   topic the store knows nothing about), the mirror image of the natural-positive problem.

Lesson for the ledger: an offline feature study forecasts the *ordering* a model can achieve; the
thresholds a self-calibrating gate chooses depend on the synthetic probes, so only the end-to-end
run says where the gate will actually sit.

## 9. Vector shape and write-time questions (2026-10-31)

**Vector shape** (`vector-shape-ab.ts`, vector-only, all 8,673 retrievable memories, bge-small).
s@1 / s@3 / in top 32:

| Shape | natural-language | identifier | topic |
|---|---|---|---|
| whole note (shipped) | **42.8 / 64.9 / 92.3** | 90.3 / 96.3 / 99.7 | 60.0 / 72.0 / 88.2 |
| title only | 18.6 / 32.5 / 57.2 | 91.0 / 97.0 / 98.3 | **71.6 / 82.4 / 94.0** |
| best ~300-char sentence piece | 38.7 / 55.7 / 90.2 | 90.0 / 96.7 / 98.7 | 66.9 / 81.1 / 93.1 |
| max(whole, title) | 33.5 / 57.2 / 88.7 | 91.0 / 96.7 / 98.3 | 72.2 / 82.4 / 93.8 |
| max(whole, best piece) | 38.7 / 59.8 / 91.8 | 90.0 / 96.7 / 98.7 | 67.6 / 81.8 / 93.3 |

Natural questions match the meaning of the whole note better than its title or any one sentence.
Titles and pieces help topic lookups, where the full pipeline is already at 95.8%. Not adopted.

**Write-time questions** (`wq-generate.ts`, `wq-eval.ts`). Claude Haiku 5.5 wrote 3 natural
questions for every memory of a fixed 1,994-memory sample (the 194 natural-language golds + 1,800
random memories of the same agents), from redacted text, without seeing any fixture question.
Every arm searches the same sample, so the absolute numbers are higher than on the full store and
only the comparison counts. s@1 / s@3 / in top 32:

| Arm | natural-language (194) | identifier (393) | topic (124) |
|---|---|---|---|
| BM25 note (shipped) | 63.4 / 75.3 / 94.8 | 98.5 / 99.7 / 100 | 90.3 / 97.6 / 100 |
| BM25 note + questions | 70.6 / 83.5 / 96.9 | 98.5 / 99.7 / 100 | 89.5 / 99.2 / 100 |
| vector note (shipped) | 60.3 / 79.9 / 96.9 | 94.7 / 98.7 / 100 | 68.5 / 79.8 / 93.5 |
| vector max(note, questions) | 61.9 / 78.9 / 95.9 | 92.4 / 97.2 / 99.5 | 58.9 / 68.5 / 90.3 |
| fused, note (shipped) | 67.0 / 84.0 / 97.4 | 98.5 / 100 / 100 | 80.6 / 90.3 / 100 |
| **fused, questions in BM25 only, vector on the note** | **73.2 / 87.1 / 98.5** | **98.5 / 100 / 100** | **82.3 / 90.3 / 100** |
| fused, questions in both channels | 74.2 / 89.2 / 98.5 | 97.7 / 99.7 / 100 | 74.2 / 87.9 / 100 |
| fused, questions as a third RRF channel | 72.7 / 90.2 / 99.0 | 84.7 / 92.6 / 100 | 58.9 / 72.6 / 98.4 |

Bias check: word overlap between the gold's generated questions and the fixture question averages
0.179 (a random memory's: 0.016); none of 194 overlap by more than half. Both were written by a
model that saw the memory, so some optimism remains; it is not copying.

Findings:
1. **Questions belong in the keyword index, not in the vector.** In BM25 they add natural phrasings
   a person would use; in the vector they pull a memory toward its topic's centre and blur topic
   lookups (−9.6 on topic).
2. **The adopted shape helps everywhere on the sample:** natural-language +6.2, topic +1.7,
   identifier unchanged. First change of the day that lifts natural-language retrieval without
   taking from anything else.
3. **First generation run lost half its output:** Haiku 5.5 sometimes thinks before answering,
   and a 200-token reply budget was spent on thinking, leaving 976 of 1,994 memories with no
   questions. Raised to 1,500 and the resume logic retries empty results.

Next: questions for every retrievable memory (about 6,700 more), then the full pipeline
(reranker, blend, gate) end to end, with the questions also serving as natural positives for gate
calibration.

## 10. Step 0: write-time questions end to end, and the routed blend (2026-10-31)

Questions generated for all 8,673 retrievable memories and indexed in the keyword index only
(`wq-index.ts` → `snapshot/store-wq.db`); the 0.21.1 pipeline otherwise unchanged.

| Full pipeline, k = 3 | NL: reaches cross-encoder | NL first | topic first | identifier first |
|---|---|---|---|---|
| 0.21.1 | 86.6% | 45.4% | 95.8% | 93.3% |
| + questions, blend 0.85 | 90.7% | 44.8% | 95.6% | 93.4% |
| + questions, blend 0.5 (offline replay) | — | 50.0% | 93.6% | 92.2% |
| **+ questions, blend routed by query shape** (offline replay) | — | **50.0%** | **95.6%** | **93.5%** |

Findings:
1. **Questions get more right answers to the reranker (86.6 → 90.7%) but the final order did not
   improve** at the shipped 0.85 weight: the cross-encoder decides 85% of the score and never sees
   the questions.
2. **The fused rank now carries the question phrasings, so natural questions want it weighted
   more; keyword lookups still want the cross-encoder.** One weight cannot serve both.
3. **Routing the weight by the query's shape** (question word, question mark, or ≥ 30% common
   words → 0.5; otherwise 0.95), judged from the text alone, meets the 0.22 target of ≥ 50% with
   topic and identifier unchanged. Natural weights 0.5–0.7 all land at 48.5–50.0%, so the choice is
   not knife-edge. Without questions the same routing makes NL worse (43.8 vs 45.9): it belongs
   with the questions, in 0.22.
4. Still to do before claiming it: the routed blend implemented in `activation.ts` and run end to
   end (this table's last two rows are replays of saved scores), and the reranker reading the
   best-matching question (the other way to carry the gain through).

## 11. Step 4b built: questions + routed blend end to end, and why there are two keyword indexes (2026-10-31)

Built on branch `feat/0.22`: `questions` column, write path, a natural-question blend weight of
0.5 when at least half the candidate pool carries questions (else 0.85; keyword lookups 0.95).
Measured on the snapshot with questions set through the real store (`wq-index.ts`), published
harness for identifier and topic:

| Design | identifier first / top 5 / MRR | topic first / top 5 / MRR | NL first |
|---|---|---|---|
| 0.21.1 | 93.3 / 98.7 / 95.8 | 96.0 / 98.7 / 97.3 | 45.4 |
| one index holding questions, all queries search it | 92.3 / 98.3 / 95.2 | 95.8 / 98.7 / 97.1 | 50.0 |
| one index, keyword queries exclude the questions column | 92.7 / 98.7 / 95.4 | 96.0 / 98.7 / 97.3 | — |
| **two indexes: questions only in the one natural queries search** | **93.3 / 98.7 / 95.8** | **96.0 / 98.7 / 97.3** | **50.0** |
| control: index rebuilt, no questions | 93.3 / 98.7 / 95.8 | — | — |

Findings:
1. **Questions hurt keyword lookups when they share an index with them.** The losses were exact
   lookups overtaken by a near-duplicate whose questions mention the same topic (two FIN-05
   memories; refund questions on one).
2. **Excluding the column is not enough.** FTS5's term statistics span every column of the index,
   so questions shift the scores of searches that never read them; near-ties flip (2 of 300).
   The rebuild control rules out index drift as the cause.
3. **Two indexes make both paths exactly the measured ones.** Keyword-shaped recall and every
   other caller read the three-column index, unchanged since 0.21.1; natural-language recall
   reads the four-column one. Cost: a second FTS index and its trigger writes.
4. Postgres and PGlite: split the same way the same day — `fts` (concept, content, tags) and
   `fts_q` (+ questions), chosen by the same flag.

## 12. The answer check (plan §4.6b): measured, does not meet its bar (2026-10-31)

Reader: `deepset/minilm-uncased-squad2` (33M, SQuAD 2.0, with a no-answer head), exported to ONNX
locally and quantized to int8 (`tests/realstore-eval/qa-signal.ts`). It reads the top result's
query-centred 1,200-character window and scores best answer span minus no-answer. Sanity check on a
deploy note: "How do I deploy RosterKeep?" +1.50; two unrelated questions −8.75 and −16.16.

| | keyword | natural-language |
|---|---|---|
| reader alone, correct vs never-stored (AUC) | 0.773 | **0.946** |
| reader alone, correct vs deleted | 0.592 | 0.722 (cross-encoder alone: 0.746) |
| ceiling, shipped 3 gate signals, correct vs deleted | 0.969 | 0.827 |
| ceiling, + reader | 0.968 | **0.840** |
| plan's bar | — | ≥ 0.88 |

Median margin: natural-language correct −1.29, deleted −6.29, never-stored −12.94. Time: 86 ms per
question on this machine with another benchmark running, over the ~55 ms budget.

Findings:
1. **The reader separates "never stored" well and "deleted" weakly.** A deleted fact's neighbour
   usually still contains an answer-shaped span about the same thing, so the reader finds
   *something*; it cannot know that the something is not what was asked.
2. **It adds 0.013 to the natural-language ceiling** — below the bar, and at more than the speed
   budget. Not built into recall.
3. **So the deleted-fact limit stands: about 0.83 AUC on natural-language questions** with every
   signal measured — retrieval, density, query shape, memory kind, and now an answer reader. It is
   documented as AWM's limit (docs/abstention.md). Closing it would need a model that compares the
   question's specifics with the memory's — a larger generative check, which is outside the speed
   rule for the recall path.

**Addendum, same day — a larger reader, under the revised speed rule.** Robert set the speed rule in
absolute terms (a recall under about one second; tens to hundreds of milliseconds are fine for a
real gain), so the stronger `deepset/deberta-v3-base-squad2` (184M) was measured too. Int8
quantization breaks it (every passage gets the same span and margin); at fp32 it reads well —
"railway up --service rowos-app --ci" for the deploy question, margins −22 and −24 for unrelated
ones.

| Reader | NL correct vs deleted, alone | NL ceiling with gate signals | time per question |
|---|---|---|---|
| none | — | 0.827 | — |
| MiniLM (33M, int8) | 0.722 | 0.840 | ~86 ms |
| DeBERTa-v3-base (184M, fp32) | 0.746 | 0.845 | ~655 ms |

A reader 5.5× larger and 8× slower adds 0.005. Both fail the same way: the deleted fact's neighbour
does contain an answer — to a nearby question — and an extractive reader cannot tell. The limit is
about 0.83–0.85 for readers of this kind, measured at two sizes. (A `-Infinity` margin when a
passage leaves no room for a span first poisoned the fit; it is now floored at −30.)

## 13. Recent decisions: a fixture for what Robert uses AWM for (2026-10-31)

Robert: "it's decisions that are made throughout that are important to bring back in real time."
No fixture tested recency, and since 0.21.1 decay no longer changes the top result, so
`tests/realstore-eval/decisions-eval.ts` builds one from the snapshot: every current
`intent=decision` memory with at least two OLDER current memories sharing a `proj=` and `topic=`
tag (120 decisions, median 4 older neighbours), asked with one of its generated natural questions.

| Pipeline | decision first | in top 3 | lost to an older memory | lost to a newer one |
|---|---|---|---|---|
| shipped (0.21.1 + routing), no questions | 63 (52.5%) | 87 (72.5%) | 46 (3 same tags) | 11 |
| + recency term 0.05 / 0.1 / 0.2 (`AWM_BLEND_RECENCY`) | 64 / 64 / 63 | 91 / 91 / 87 | 36 / 31 / 27 | 20 / 25 / 30 |
| questions indexed, query's own question removed | 61 (50.8%) | 85 (70.8%) | 42 | 17 |

Findings:
1. **Age is not what keeps a decision from the top.** Favouring newer memories hands first place
   to a newer non-decision instead; first place moves by at most one.
2. **Stored questions do not help here either** once the query's own question is excluded — the
   decision's other generated questions are paraphrases, and every neighbour gains questions too.
3. **A sixth of all misses are another decision** (20 of 57): sibling decisions restating the
   same choice. Some of what reads as a miss may be a right answer under another id; the fixture
   needs an answer-containment check (as `nl-dupcheck.ts` does for the NL fixture) before its
   first-place rate is read as a ranking ceiling.
4. **The guard stands:** decay may leave the ranking path only if removing it moves this fixture
   by nothing beyond noise. The recency experiment stays an off-by-default switch.
