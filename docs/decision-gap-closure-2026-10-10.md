# Decision — which gaps found against opencode-mem are worth closing

Comparison source: `opencode-mem` 2.29.2, read from its source (`src/services/turso/vector-search.ts`,
`src/services/auto-capture.ts`), not its README. 1,723 GitHub stars, 13,273 npm downloads/month
against AWM's 1,538 — 8.6x the installs.

Six gaps were proposed. **Two were already decided and measured against, and are closed here
rather than rebuilt.** One is reopened as a measurement, not a build. Four are new scope.

---

## The decision

Four items scheduled, one measurement first, in this order:

| # | Item | Kind | Why this position |
|---|---|---|---|
| M1 | Long-context embedding A/B on first-stage recall | **measurement** | Closes a transfer-risk hole in a prior rejection; cheap; it is a measurement, which is what this project is for |
| S1 | Write-time redaction + PII policy + its own eval harness | build | Trust-critical. **Must precede S2** — see the ordering constraint below |
| S2 | Recall-trace explain artifact, CLI/JSON-first | build | The differentiator is invisible; this is the cheapest way to make it visible without becoming a web app |
| S3 | Reduce missed writes — deterministic hooks + explicit promote path | build | The write half of the #1 documented failure mode, scoped to what is possible without an LLM |
| S4 | Encryption at rest — threat-model RFC, then build | spec first | Not one checkbox; key-management UX is the hard part and the dangerous part |

---

## Triage — what was already decided, with citations

### CLOSED: tags into the embedding (proposed gap 1)

AWM supports tags in **three** retrieval channels already: FTS5/BM25 indexes them, the entity
inverted index resolves them with alias matching, and since the retrievability campaign the
cross-encoder rerank passage carries `topic=` / `proj=` / `project=` tags. The last of those ships
on every install path — `src/adapters/common.ts:82` (`AWM_RERANK_TAGS: '1'`),
`plugin/.claude-plugin/plugin.json`, `mcpb/manifest.json`.

The one channel tags do *not* enter is the embedding, and that is a measured decision, not an
oversight. From `docs/archive/retrievability-final-2026-08-24.md`, 450-probe category fixture:

| config | s@1 |
|---|---|
| baseline | 56.4% |
| tags into embedding only | 56.7% (**+0.3pp**) |
| tags into rerank passage only | **63.8%** (+7.4pp) |
| both | 63.8% (**+0.0pp marginal**) |

The expensive half adds nothing alone and nothing in combination, and costs a full-corpus re-embed.
**opencode-mem's separate tags-embedding column, weighted 0.3, is the approach AWM tested and
rejected on evidence.** The proportionality principle from that campaign explains why: 80 chars of
tags is ~20% of a 400-char rerank passage, but noise inside a whole-memory embedding whose canonical
median is 1,965 chars.

*Residual, not scheduled:* the result is not stratified by memory length or tag density. The fixture
it was measured on was purpose-built so the query uses a tag word **absent from the gold body** —
i.e. the stratum where tag vocabulary matters most — so a stratified re-cut is unlikely to resurrect
a +0.0pp marginal. Noted, not reopened.

### REOPENED AS A MEASUREMENT: long-context embedding (proposed gap 6)

The campaign tested **bge-base**, and the inference drawn from it does not cover the axis that
matters. Verified against each model's `config.json`:

| model | `max_position_embeddings` | `hidden_size` | |
|---|---|---|---|
| `BAAI/bge-small-en-v1.5` (shipped) | 512 | 384 | baseline |
| `BAAI/bge-base-en-v1.5` | **512** | 768 | what option 4 tested |
| `nomic-ai/nomic-embed-text-v1` | **8192** | 768 | never tested |

The campaign varied **dimensionality at constant context**. It never varied context. So
"a bigger embedder does not help" is established for dimensions (+0.7pp alone, −1.1pp in
combination) and **unestablished for the 16x truncation difference**.

`AWM_RERANK_WINDOW=query` fixed long-memory recall 25% -> 87.5%, but that is a *rerank-stage* fix.
It cannot rescue a memory that never enters the candidate pool, and a memory longer than ~512 tokens
is embedded only on its head. That is a first-stage recall question and it is open.

**M1 is therefore narrow:** does a long-context embedder improve *candidate recall before rerank*
on memories longer than the 512-token window? Stratify the existing category fixture by gold length,
measure recall@pool (not s@1) with bge-small vs nomic, and hold everything else constant. If it does
not move recall@pool on the long stratum, gap 6 closes permanently with the context axis covered.

---

## Step 4/5 — co-worker challenge, and what was taken

`/ask-coworker` (gpt-5.3-codex) was given the cited evidence and asked to challenge, not vote.

**Taken:**

1. **The bge-base-vs-nomic inference is weak on the truncation axis.** Correct, and verified above.
   This is M1 and it is the reason gap 6 is a measurement rather than a closure.
2. **Redaction is trust-critical, not cheap.** The original sequencing justified it as "cheapest
   first," which undersells it. A project whose entire position is honesty about what it measures,
   shipping 21 real people's first names in its npm tarball (`src/core/salience.ts:40`, open task
   `494c917b`) with no write-time redaction, is a credibility contradiction.
3. **Do not build "a UI."** Build an explain *artifact* — per-recall channel scores, rerank deltas,
   abstention margin — exported as JSON/HTML from the CLI, with an optional minimal local inspector
   later. A web app inherits auth, state, compatibility and support obligations that a solo
   maintainer should not take on at 1.5k downloads/month. An export artifact is also strictly better
   for this project's purpose: it is *reproducible*, reviewable and diffable, and it can serve the
   harness `claims.md` §6 admits it lacks for the 41% figure.
4. **Do not promise semantic capture parity.** Without an LLM, S3 is workflow instrumentation —
   deterministic hooks on tool outcomes, rule/entity extractors, an explicit promote-to-memory
   primitive. Reframed from "fix the write failure" to "reduce missed writes." Framing it as
   equivalent to idle LLM extraction would be an overpromise.
5. **Encryption is mis-scoped as one item.** Threat model, key-management UX, SQLite cipher strategy
   and bench-pipeline impact are four separate decisions. Spec before code.
6. **Safety features need their own eval harness.** AWM demands measurement for retrieval and would
   otherwise ship redaction unmeasured — the exact thing it criticises. S1 includes a
   false-positive / false-negative fixture.

**Rejected or qualified:**

- *"Stratify gap 1 by length and tag density before closing."* Qualified down to the residual noted
  above. The marginal figure is +0.0pp on the fixture built specifically to exercise tag vocabulary.
- *"The sequence ignores migration risk."* Lands on S4, not S1. Redaction is write-path only and
  needs no schema change if it runs before insert; encryption needs a backfill, for which
  RosterKeep's `backfill-medical-encryption.ts` is the in-house precedent.
- *"Abstention calibration may drift."* Accepted as a guard rather than a sequencing input, and it is
  already covered: the identifier fixture is the no-regression guard and `check:release`'s
  `benchmark-spread` gate blocks a figure moving in one doc and not the rest.

---

## The ordering constraint that is not obvious

**S1 must ship before S2.** The recall-trace artifact contains memory content by construction, and
an export artifact is precisely the thing a user pastes into a GitHub issue. Build the trace first
and the project ships a convenient way to leak the store. One data-handling policy has to span
ingest, storage, logs and exports, and redaction is where it starts.

This is the cross-item failure that neither item would have caught on its own.

---

## Risks and mitigations

| risk | mitigation |
|---|---|
| M1 shows nomic *does* improve long-stratum recall, reopening a 440MB model and a full re-embed | Measure recall@pool first, which is cheap and decides nothing by itself. A positive result argues for long-memory **chunking** at write — same benefit, no model swap, no read-time cost |
| Redaction false positives silently drop real content | Fixture with labelled positives/negatives before the rule set ships; redact into a side field, never destroy the original on the first release |
| Redaction cannot reach the 7,000+ memories already written | Accept explicitly. S1 governs new writes; a backfill is its own item and carries the same mass-rewrite risk the campaign rejected for option 9 |
| The trace artifact becomes a de-facto API people script against | Version it and say in the file that it is diagnostic, not a contract |
| S3's deterministic extractors produce low-value noise that pollutes the store | They must route through the existing salience gate, not bypass it; measure store growth and recall precision before and after |
| S4 key loss makes the store unrecoverable | The RosterKeep lesson, stated in the RFC: key unset must be a no-op, and the backup warning belongs in the setup output, not only the docs |
| Four items at once on one maintainer | M1 is measurement, S4 is a document. Only S1 and S2 are builds, and they are ordered |

---

## What this comparison did *not* find

opencode-mem has no cross-encoder, no decay, no consolidation, no graph walk, no distribution-shape
abstention, and **zero eval or benchmark files in 356**. Its keyword channel is `LIKE %token%` scored
`matched/total` — no IDF, no length normalisation. Its ranking weights are hand-chosen constants.

So the download gap is not evidence that it retrieves better. It is evidence that a memory system is
adopted on what a user can **see** and how little they must **do** — which is why S2 and S3 are on
this list at all, and why no retrieval work is.
