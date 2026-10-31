// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Is a recall query phrased as a person's question, or as a keyword lookup?
 *
 * Used to route the final blend weight (activation.ts). Measured 2026-10-31: keyword lookups
 * rank best when the cross-encoder decides almost alone (weight 0.95), natural questions when
 * the BM25 + vector fused rank keeps a larger say. One weight cannot serve both
 * (docs/abstention-signals-2026-10-30.md §10).
 *
 * Judged from the text alone: it starts with a question word, ends with a question mark, or at
 * least 30% of its words are common function words. On the realstore fixtures this routes all
 * 194 natural-language questions natural and all 1,766 keyword-shaped ones keyword; real queries
 * are messier, and a misrouted one only gets the other weight, not a broken result.
 */

const FUNCTION_WORDS = new Set(('the a an and or of to in on for is are was were be been with what when where which who how did do does '
  + 'have has had at by from as it this that not but all any can will would should could into than then there their they them its '
  + 'we our i my you why about').split(' '));

const QUESTION_START = /^(what|how|why|when|where|which|who|whose|did|do|does|is|are|was|were|can|could|should|has|have|will|would)\b/i;

export function isNaturalQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (QUESTION_START.test(q) || q.endsWith('?')) return true;
  const words = q.toLowerCase().match(/[a-z0-9_.\-/]+/g) ?? [];
  if (words.length === 0) return false;
  return words.filter((w) => FUNCTION_WORDS.has(w)).length / words.length >= 0.3;
}
