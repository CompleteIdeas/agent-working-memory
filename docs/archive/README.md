# Archived investigations

Dated investigation records. Each one is a snapshot of what was measured **on the
day in its filename** — they are not maintained, and several contain
recommendations that later measurement overturned.

**Read this index, not the files, to find out what a doc concluded.** The
"outcome" column is authoritative; the file bodies preserve the evidence and the
reasoning, including the parts that turned out to be wrong. Nothing here was
deleted, because a refuted hypothesis is the record that stops it being
re-proposed a fourth time.

For what the system does *today*: [`../reference.md`](../reference.md) (flags and
current behaviour), [`../../CHANGELOG.md`](../../CHANGELOG.md) (release history),
[`../../README.md`](../../README.md) (overview).

---

## Shipped — measured wins now in the product

| doc | question | outcome |
|---|---|---|
| [rerank2-second-stage-2026-08-23](rerank2-second-stage-2026-08-23.md) | Should the cross-encoder's own score decide final order, instead of a blend that capped it at 70%? | **+9.7pp s@1** (37.8→47.6, p<0.001), no added inference. Shipped as `AWM_RERANK2`. ⚠ **Its standalone recommendation is WRONG** — see the truncation doc. |
| [rerank-truncation-2026-08-23](rerank-truncation-2026-08-23.md) | The reranker saw only the first 400 chars of each passage. Is a prefix the right 400? | No. Spending the same budget on the window densest in query terms: **25.0% → 87.5%** long-memory s@1, +0.07% CPU, zero added tokens. Shipped as `AWM_RERANK_WINDOW=query`. **Also corrects the doc above:** `AWM_RERANK2` alone regresses long-memory s@5 91.7→25.0, because BM25 over full content was covering the reranker's blindness. The two must ship together. |
| [decision-retrievability-2026-08-24](decision-retrievability-2026-08-24.md) | A memory can be active, canonical, correct — and unreachable by the words its own author uses. 10 ideas → which 4 are worth testing? | Selection record (decision method only). Picked options 1–4 below. |
| [retrievability-campaign-2026-08-24](retrievability-campaign-2026-08-24.md) | Shared protocol so four options are *comparable* — same fixtures, same metrics, same bars, fixed before implementation. | Protocol. Bars pre-registered; none was moved to let an option pass. |
| [retrievability-final-2026-08-24](retrievability-final-2026-08-24.md) | Which of the four won? | **Option 2 — tags into the rerank passage: +7.4pp** (56.4→63.8 s@1). Shipped as `AWM_RERANK_TAGS`. Options 1 (+0.3pp), 3 (−0.2pp), 4 (+0.7pp, −1.1pp combined) all **rejected**. Adversarial held 90.0% in every arm. |

**The unifying finding**, if you read only one thing here: all four options attacked
the same defect — a word the memory needs is missing from its body (66.2% of
topical tag terms never appear in the text). Supplying it where the ranker can
**see** it works. Supplying it where it is **diluted** does not. **Guessing** it
from corpus statistics does not. **Inferring around** it with a bigger embedder
does not. You cannot recover a word that was never written — you can only put the
word that *is* recorded, the tag, in front of the component that decides.

That finding is also why 0.13.6 changed the *writing guidance* rather than only the
ranker: the shipped advice ("pick the most specific topic") was producing memories
that were maximally specific and categorically anonymous.

## Refuted

| doc | question | outcome |
|---|---|---|
| [d11-spreading-activation-retest-2026-08-23](d11-spreading-activation-retest-2026-08-23.md) | H5 proposed Personalized PageRank over the Hebbian graph. Does spreading activation earn default-ON? | **No — 0 queries fixed.** H5 did not need building; `spreadActivation` (`activation.ts:1274`) already implements it with every guard D11 specifies. Third regression under D11's three-strikes rule. **Permanent-park decision is Robert's, not the run's** — still open. Note the boost is *in-pool only* (`activation.ts:1386` `if (!item) continue`), so it cannot fix a gold lost at pool/scoring. |

## Open decisions

| doc | question | status |
|---|---|---|
| [token-economics-2026-08-24](token-economics-2026-08-24.md) | Is the default recall limit of 5 a net token loss? | Measured **yes** — introduces *sufficiency* (does the delivered text actually contain the answer, or just point at it). k=3 measured +166 vs −504 tok/recall with s@1 48.0→50.0. **Default not yet flipped.** |

## Standing reference — older, but not superseded

| doc | what it is |
|---|---|
| [design-proposals-2026-07-30](design-proposals-2026-07-30.md) | **The D1–D16 catalogue.** Origin of the D-numbers used elsewhere, and of the three-strikes rule. Records Robert's framing ("a memory space for an LLM, not containing an LLM") and the binding constraints: local, fast, multi-agent/multi-CLI, deterministic engine, salience-selectivity is the product. |
| [gauntlet-baseline-2026-07-30](gauntlet-baseline-2026-07-30.md) | **Gauntlet methodology + the 0.11.x baseline.** Single-factor ablation across arms `awm` / `off` / `notes` / `longctx` / `rag`. Lives in the MWA repo (`src/gauntlet/`, `npm run gauntlet`). Read before interpreting any gauntlet number. |
| [eval-decisions-2026-07-30](eval-decisions-2026-07-30.md) | Per-item R1–R17 decisions with the BUILD NOW / NEXT / LATER / TABLE / RESHAPED vocabulary. |
| [deep-dive-eval-2026-07-29](deep-dive-eval-2026-07-29.md) | Full-stack evaluation of 0.11.0 across 4 workstreams. Its central claim — a gap between the system as *described* and as *shipped and operated* — is why several docs here exist. |
| [improvement-hypotheses-2026-08-23](improvement-hypotheses-2026-08-23.md) | The H-series hypotheses and the token-economics lens ("useful tokens per recall" as headline metric). H3 and H5 were taken from here. |

---

## A note on method

Two process lessons from these runs are worth more than any single result:

1. **The shared metric SET makes arms comparable; the FIXTURE must exercise the
   mechanism.** The eventual +7.4pp winner first measured as three identical arms
   and looked refuted — the identifier fixture is a unique-identifier hold-out, so
   300/300 golds already contained the query term and it *could not express* an
   option that adds missing vocabulary. One fixture fix moved it from "refuted" to
   the campaign winner.
2. **Instrument bugs mostly present as plausible output, not as errors.** Eight
   occurred across this campaign; six looked like results. Hence the completeness
   assertions and resumability now baked into
   [`../../tests/realstore-eval/`](../../tests/realstore-eval/) — e.g.
   `cosineSimilarity` returns 0 on dimension mismatch, so a re-embed killed at
   4,109/8,703 would have read as "the bigger model is catastrophic".
