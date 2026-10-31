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
