// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Derived retrieval text — the machine-facing view of a memory.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured on the live 11,294-engram store: 66.2% of topical tag terms never
 * appear in the memory body, and 94.3% of tagged memories are missing at least
 * one of their own topical terms. Tags are indexed by BM25 only — the embedding
 * is built from `concept + content` (write-pipeline.ts) and so is the
 * cross-encoder rerank passage (activation.ts). So that vocabulary is invisible
 * to two of the three retrieval channels, including the one that decides final
 * ordering since phase 9b.
 *
 * The consequence, observed on a real memory: "private plan memory peaked 88%,
 * scale P1v3 -> P2v3" was NOT in the top 40 candidates for "azure app service
 * plan capacity increase internal application". Its body contains no "azure",
 * no "capacity", no "app service plan" — only `topic=azure` as a tag.
 *
 * THE SHAPE THAT MATTERS
 * ----------------------
 * This builds a DERIVED text used for embedding and reranking. It does NOT
 * mutate `content`. That distinction is the whole design:
 *
 *   - AWM's model slots have always been ADDITIVE — the embedder, expander and
 *     reranker score or expand, they never rewrite what was stored. Appending
 *     tag terms into the body would break that invariant, and a normaliser that
 *     silently edits stored memories is unrecoverable if it is wrong.
 *   - A derived view is recomputable. If the rule turns out to be bad, re-derive
 *     and re-embed; the source of truth was never touched.
 *   - And it can be BACKFILLED over the existing corpus, which body-only fixes
 *     (write-time guidance, future writes) cannot reach. 7,350 memories are
 *     already wrong.
 *
 * Only `topic=` / `proj=` / `project=` are included. Date, person and ticket
 * tags are identifiers the body usually already carries, so adding them spends
 * budget without adding reachable words.
 */

/** Whether the derived retrieval text includes tag vocabulary. Default OFF. */
export function retrievalTextEnabled(): boolean {
  return process.env.AWM_RETRIEVAL_TEXT === '1';
}

/**
 * Extract the topical vocabulary a future question is likely to use.
 * Deduplicated and lowercased; order follows first appearance so the output is
 * deterministic for a given tag list (important: a non-deterministic embedding
 * input would make re-embedding produce different vectors for the same memory).
 */
export function topicalTerms(tags?: string[]): string[] {
  if (!tags || tags.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const m = /^(?:topic|proj|project)=(.+)$/i.exec(t);
    if (!m) continue;
    for (const w of m[1].toLowerCase().split(/[-_\s]+/)) {
      if (w.length > 2 && !seen.has(w)) { seen.add(w); out.push(w); }
    }
  }
  return out;
}

/**
 * Build the text used for EMBEDDING a memory.
 *
 * When disabled this returns exactly `concept + ' ' + content`, byte-identical
 * to the historical input — so leaving the flag off cannot change a single
 * stored vector.
 */
export function buildRetrievalText(concept: string, content: string, tags?: string[]): string {
  const base = `${concept} ${content}`;
  if (!retrievalTextEnabled()) return base;
  const terms = topicalTerms(tags);
  if (terms.length === 0) return base;
  // Appended at the END. The embedding model truncates beyond its context
  // window, and the head of the content is what anchors the topic — putting tag
  // terms first would displace the memory's actual subject in the vector.
  return `${base} ${terms.join(' ')}`;
}
