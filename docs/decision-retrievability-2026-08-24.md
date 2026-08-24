# Decision — making memories reachable by the words people actually use

Decision Process (first-class-delivery), decision method only. Step 1–3 here;
step 4 `/ask-coworker`; steps 5–7 appended after.

## The decision

A memory can be active, canonical, and correct, and still be unreachable by the
words its own author uses to ask for it. Pick the approach(es) worth testing.

## Evidence base (all measured this session, on the live 11,294-engram store)

| finding | source |
|---|---|
| 66.2% of topical tag terms never appear in the memory body; 94.3% of tagged memories miss ≥1 | 7,791 tagged memories, live store |
| Tags are indexed by BM25 only — the embedding (`write-pipeline.ts:198`) and the rerank passage (`activation.ts:881`) are both built from `concept + content` | code |
| A canonical memory ("private plan… 88%… P1v3") was **not in the top 40** for "azure app service plan capacity increase internal application" | measured |
| flan-t5-small categorisation: **0/6**, CHOICE mode collapsed to one label 12/12 | `tests/realstore-eval/flan-category-probe.ts` |
| Query expansion is already **default-OFF**: "~doubles recall latency … for **no measured accuracy gain**" | `activation.ts:196` |
| flan-t5 is the largest model load (1,203ms) despite being unused by default | AWM latency decomposition |
| Temporal strip works (+3–8pp); window preference +4pp, **below its pre-registered bar**; oracle 96% | `tests/realstore-eval/temporal-runner.ts` |
| Codebase's own recorded conclusion: the design-aligned multi-hop fix is **harness-side decomposition** | `activation.ts:355` |
| Embedder upgrade (bge-small 384d → nomic 768d) deferred; needs re-embedding ~10k engrams | `docs/awm-architecture-history.md:444` |
| Phase 9b made `rerankerScore` authoritative — so tag-only vocabulary got *weaker* today | `src/core/rerank2.ts` |

## The 10 options

**1. Write-time guidance (shipped 0.13.6).** Tell agents to name the category.
*Case:* zero runtime cost; already deployed.
*Against:* 94.3% of memories already violate the guidance that was **already
there** ("write in the vocabulary of the future question"). Instruction is a
guess about harness behaviour, and harnesses change under you.

**2. Tags into the embedding text.** `embed(concept + content + tags)`.
*Case:* directly closes a measured hole — 66.2% of tag vocabulary is invisible
to the vector channel. One-line change at `write-pipeline.ts:198`.
*Against:* requires re-embedding to benefit existing memories; tags are terse
and may dilute the vector.

**3. Tags into the rerank passage.** `buildRerankPassage(concept, content, tags…)`.
*Case:* the reranker now decides final order (phase 9b), and it cannot see tags
at all. Cheap; no re-embed needed — applies to existing memories immediately.
*Against:* spends part of the 400-char budget on tags rather than content.

**4. Deterministic tag→body append at write time.** Mechanically write tag terms
into the content.
*Case:* no model, no latency, fixes all three channels at once.
*Against:* mutates stored content — breaks the invariant that AWM's model slots
are additive, never rewriting. Ugly bodies; duplicated terms.

**5. Learned aliases via co-occurrence mining.** Offline pass populates
`entity_aliases` (table already exists); query-time lookup expands terms.
*Case:* the knowledge needed is *local* ("private plan" ≡ "internal API" in
ShowConnect) and cannot come from any model's weights. Consolidation already
runs offline at 3am, so zero query-time cost, no network. Inspectable and cappable.
*Against:* co-occurrence is noisy; needs strict limits or it becomes a junk drawer.

**6. Small LLM categorisation (flan-t5-small).** Already loaded.
*Case:* deployment cost already paid; 87–101ms.
*Against:* **tested and refuted** — 0/6; CHOICE returned "equihub" 12/12; on the
one memory where the answer is "Azure" it produced "acc".

**7. Larger local model (flan-t5-base / small Qwen).**
*Case:* genuinely more capable at categorisation.
*Against:* ~1GB more on disk, several hundred ms; the "add a model" route
already lost once on measurement (option 1's expansion result). Breaks the
lightweight-and-offline tenet Robert stated.

**8. Harness-side multi-query recall.** The agent generates N vocabulary variants
and chains recalls.
*Case:* the codebase's own recorded conclusion (`activation.ts:355`); Claude
knows project dialect that flan-t5 cannot; no engine change.
*Against:* N× recall latency (~900ms each); depends on harness compliance —
exactly the fragility Robert identified.

**9. Backfill/rewrite the 7,350 offending memories.** One-time batch supersede.
*Case:* the only option that fixes the *existing* corpus; everything else helps
new writes only.
*Against:* expensive, one-shot, doesn't prevent recurrence, and mass-rewriting
real memories is high-risk.

**10. Bigger embedding model (bge-small 384d → nomic 768d).**
*Case:* better semantic bridging would cross vocabulary gaps without any explicit
alias machinery. Already a recorded open question.
*Against:* re-embed ~10k engrams; larger model, slower; unproven for *project-
specific* drift, which is not general semantics.

## Step 3 — tradeoffs that bite THIS codebase

- **Latency is nearly spent.** Warm recall is ~900ms and already ~90% reranker.
  Anything adding read-time cost starts in deficit (options 7, 8).
- **"Add a model" already lost here once** on exactly this trade
  (`activation.ts:196`). That is precedent, not speculation.
- **Existing corpus vs new writes is the real split.** Options 1, 2, 4 help only
  future memories. 7,350 memories are already wrong. Only 3, 5, 8, 9 reach them.
- **Phase 9b raised the stakes today** — making the reranker authoritative made
  tag-only vocabulary *less* visible, which argues option 3 is now more valuable
  than it was this morning.
- **Robert's stated constraint:** lightweight, fast, offline; a boost may be
  opt-in but must never be required.

---

## Step 5 — evaluating the co-worker against context

**ACCEPTED: option 8 (harness multi-query) is my weakest, not option 2.**
I under-weighted my own evidence. `activation.ts:196` records expansion being
turned off because it "~doubles recall latency for no measured accuracy gain" —
and option 8 is expansion with N× the cost, relocated to the harness. It carries
two independent strikes: that measured precedent, and Robert's own point that
harness-dependent behaviour is a guess that breaks when harnesses change.

*Partial pushback:* 8 keeps one unique niche. Alias mining can only learn pairs
that already co-occur in the store; a genuinely NEW term has no alias to find.
Only a model that knows language can bridge that. So 8 is demoted as a primary
bet, not deleted.

**ACCEPTED, AND IT RESHAPES THE OPTION SET: targeted backfill into a
machine-only derived field.** This is the point I missed. I rejected option 4
because mutating stored content breaks the invariant that AWM's model slots are
additive and never rewrite. Codex's framing dissolves that objection: build a
**derived retrieval text** (`concept + content + tags`) used for embedding and
for the rerank passage, leaving the user-facing body untouched. That collapses
options 2, 3, 4 and 9 into one coherent change that ALSO reaches the existing
corpus via backfill. Strictly better than any of them alone.

**ACCEPTED: the alias failure mode I missed — hub aliases flooding the pool.**
Co-occurrence will happily learn "plan" ↔ "capacity", "private" ↔ half the
domain. Expanding on those explodes the BM25 candidate set toward generic
memories. And it is worse *here* than in a generic IR system for two reasons I
measured today: the rerank passage is truncated to 400 chars, and phase 9b just
made `rerankerScore` authoritative — so a poisoned candidate pool becomes a
final-ordering failure rather than a mild precision cost.

Required guardrails before option 5 ships: PMI/LLR threshold rather than raw
co-occurrence; max fan-out per term; directional aliases (A→B only where
precision holds); **require at least one ORIGINAL query term to hit**; and
evaluate on "was it in the top 40" regressions, not aggregate recall.

## Step 6 — decision: the four to test

1. **Derived retrieval text + backfill** (2+3+4+9 merged). `concept + content +
   tags` for the embedding and the rerank passage; body never mutated; backfilled
   over existing memories. Highest ceiling, reaches the 7,350 already-wrong
   memories, and directly closes the measured 2-of-3-channel hole.
2. **Tags into the rerank passage alone** (3, isolated). The cheap half of #1,
   testable with no re-embed. Worth measuring separately so we know how much of
   #1's gain comes from the expensive half.
3. **Guarded alias mining** (5). The only candidate that addresses genuine
   vocabulary drift, which is the part no representation change can fix. Ships
   only with the five guardrails above.
4. **Bigger embedding model** (10, bge-small 384d → nomic 768d). The honest
   alternative hypothesis to 1 and 3: if better semantics bridges the gap on its
   own, the explicit alias machinery is unnecessary. Shares the re-embed pass
   with #1, so testing them together is cheap. Heaviest of the four.

**Demoted:** 8 (harness multi-query — latency precedent + harness fragility),
1 (guidance — 94.3% already violate the pre-existing guidance), 6 (tested,
refuted), 7 (breaks the lightweight tenet; "add a model" already lost once).

## Step 7 — risks and mitigations

| risk | mitigation |
|---|---|
| Derived text dilutes the vector — tags are terse and repetitive | Measure against the identifier fixture with a strict no-op guard; if s@1 drops, cap tags appended or weight them |
| Rerank passage budget is 400 chars; tags steal from content | Test #2 alone first to isolate; consider appending tags only when the window has slack |
| Backfill re-embeds ~11k engrams | Run on the snapshot, never the live store; it is a copy by construction |
| Alias hub flooding | The five guardrails; evaluate on top-40 regressions specifically |
| Bigger embedder is slower on every query | It is the one option that adds permanent read-time cost — measure latency, not just accuracy |
