// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Passage selection for cross-encoder reranking.
 *
 * THE PROBLEM
 * -----------
 * Reranking truncates each passage to a fixed prefix (historically the first
 * 400 chars). That truncation exists for a real reason: cross-encoders pad to
 * the longest passage in the batch, so one 5,000-char memory in a 40-item pool
 * drags every passage to ~512 tokens and costs 3-4x. The reranker is already
 * ~90% of warm recall latency, so "just send everything" is not available.
 *
 * But a PREFIX is the wrong 400 chars. Measured on the live 29.8k store:
 *   - canonical memories median 1,965 chars, 98.7% exceed 400
 *   - the reranker cannot see 78.8% of each canonical memory's vocabulary
 *   - 99.9% of long canonical memories carry identifiers only past char 400
 * And measured on tests/longmem-eval: moving the answer from char 150 to char
 * 700 takes success@1 from 100% to 0%, with the gold's cross-encoder score
 * collapsing 0.986 -> 0.000 while its BM25 score barely moves. The memory stays
 * retrievable and stops being rankable.
 *
 * THE FIX
 * -------
 * Spend the same character budget on the window that actually contains the
 * query's terms, instead of on whatever happens to be at the top of the memory.
 * Cost is unchanged — same budget, same batch padding, same inference — so this
 * buys ranking quality without buying latency.
 *
 * The concept line is always kept: it is short, it is the memory's title, and
 * it is what a human wrote to summarise the thing.
 */

/** Cheap tokenizer for locating query terms inside a passage. */
function terms(query: string): string[] {
  const raw = query.toLowerCase().match(/[a-z0-9_][a-z0-9_.\-]{1,}/g) ?? [];
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'where', 'when',
    'which', 'does', 'did', 'was', 'were', 'are', 'is', 'be', 'to', 'of', 'in',
    'on', 'at', 'by', 'it', 'as', 'do', 'how', 'why', 'a', 'an', 'or',
  ]);
  return Array.from(new Set(raw.filter(t => t.length >= 3 && !STOP.has(t))));
}

/**
 * Choose the `budget`-char window of `content` densest in query terms.
 * Returns the head of the content when nothing matches — the old behaviour,
 * which is the right fallback: with no query signal there is no reason to
 * prefer any other part of the memory.
 */
export function densestWindow(content: string, query: string, budget: number): string {
  if (content.length <= budget) return content;

  const toks = terms(query);
  if (toks.length === 0) return content.slice(0, budget);

  const lower = content.toLowerCase();
  const hits: number[] = [];
  for (const t of toks) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(t, from);
      if (i < 0) break;
      hits.push(i);
      from = i + t.length;
    }
  }
  if (hits.length === 0) return content.slice(0, budget);
  hits.sort((a, b) => a - b);

  // Slide a window anchored slightly before each hit; keep the one covering most.
  let bestStart = 0;
  let bestCount = -1;
  for (let i = 0; i < hits.length; i++) {
    const start = Math.max(0, hits[i] - Math.floor(budget / 5));
    let count = 0;
    for (let j = i; j < hits.length && hits[j] - start < budget; j++) count++;
    if (count > bestCount) { bestCount = count; bestStart = start; }
  }

  // Snap to a word boundary so the cross-encoder is not handed a split token.
  let start = bestStart;
  if (start > 0) {
    const sp = content.indexOf(' ', start);
    if (sp >= 0 && sp - start < 40) start = sp + 1;
  }
  const slice = content.slice(start, start + budget);
  return (start > 0 ? '…' : '') + slice + (start + budget < content.length ? '…' : '');
}

/**
 * Build the passage handed to the cross-encoder for one candidate.
 *
 * `mode`:
 *  - `'prefix'` (default) — legacy behaviour, the first `budget` chars.
 *  - `'query'`  — the `budget`-char window densest in query terms.
 */
export function buildRerankPassage(
  concept: string,
  content: string,
  query: string,
  budget: number,
  mode: 'prefix' | 'query',
  tags?: string[],
): string {
  const body = mode === 'query'
    ? densestWindow(content, query, budget)
    : (content.length > budget ? content.slice(0, budget) : content);
  // Topical tags, when enabled. The cross-encoder decides final order since
  // phase 9b, and it cannot see tags at all — measured on the live store, 66.2%
  // of topical tag terms never appear in the body, so that vocabulary is
  // invisible to the stage that now decides ranking. Appended (not substituted)
  // and length-capped so it cannot crowd out the content window.
  const extra = rerankTagText(tags);
  return extra ? `${concept}: ${body} ${extra}` : `${concept}: ${body}`;
}

/** Whether topical tags are appended to the rerank passage. Default OFF. */
export function rerankTagsEnabled(): boolean {
  return process.env.AWM_RERANK_TAGS === '1';
}

/** Character budget for the appended tag text. */
export function rerankTagBudget(): number {
  const v = Number(process.env.AWM_RERANK_TAGS_LEN ?? 80);
  return Number.isFinite(v) && v > 0 ? v : 80;
}

/**
 * Render topical tags as plain terms for the cross-encoder.
 * Only `topic=` / `proj=` / `project=` carry query vocabulary; date/person/
 * ticket tags are identifiers the body usually already contains, and adding
 * them would spend the budget without adding reachable words.
 */
export function rerankTagText(tags?: string[]): string {
  if (!rerankTagsEnabled() || !tags || tags.length === 0) return '';
  const words = new Set<string>();
  for (const t of tags) {
    const m = /^(?:topic|proj|project)=(.+)$/i.exec(t);
    if (!m) continue;
    for (const w of m[1].toLowerCase().split(/[-_\s]+/)) {
      if (w.length > 2) words.add(w);
    }
  }
  if (words.size === 0) return '';
  return `[${[...words].join(' ').slice(0, rerankTagBudget())}]`;
}

/** Character budget for a rerank passage. */
export function rerankTruncation(): number {
  const v = Number(process.env.AWM_RERANK_TRUNC ?? 400);
  return Number.isFinite(v) && v > 0 ? v : 400;
}

/** Passage selection mode. Default `prefix` preserves shipped behaviour. */
export function rerankWindowMode(): 'prefix' | 'query' {
  return process.env.AWM_RERANK_WINDOW === 'query' ? 'query' : 'prefix';
}
