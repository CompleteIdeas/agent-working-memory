// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Questions a memory answers (0.22).
 *
 * A writer (the agent, an embedded generator, or a host through the capability hand-off) may
 * attach a few natural questions to a memory. They are indexed for keyword search only, which
 * measured as the shape that helps: natural-language recall up, identifier and topic unchanged
 * (docs/abstention-signals-2026-10-30.md §9–10).
 *
 * Guard: normalisation only — trimmed, 8–300 characters, de-duplicated case-insensitively, at
 * most 5. Two filters were considered and rejected, measured 2026-10-31 on 25,992 generated
 * questions:
 * - "a search for the question finds its memory" is circular once the question is indexed on
 *   that memory: it keeps nearly everything;
 * - "the question shares a word with its memory" would drop 14% of them, and those are often the
 *   most useful — they bridge the vocabulary gap the feature exists for ("How is the awm source
 *   code organized?" for a memory titled "src module map").
 * A real relevance filter (Doc2Query--, arXiv 2301.03266) needs a relevance model; it is
 * evaluated with the embedded generator (plan §4.4), not assumed.
 */

import type { IEngramStore } from '../storage/store.js';
import { withRedaction } from '../storage/redacting-store.js';

export const MAX_QUESTIONS = 5;
const MIN_LEN = 8;
const MAX_LEN = 300;

const clean = (q: string) => q.replace(/\s+/g, ' ').trim();

/** Clean a writer's questions: trim, length-bound, de-duplicate, cap. */
export function normalizeQuestions(input: unknown, cap: number = MAX_QUESTIONS): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const q = clean(raw);
    if (q.length < MIN_LEN || q.length > MAX_LEN) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

export interface QuestionsOutcome {
  /** Questions now stored on the memory. */
  kept: string[];
  /** Questions offered by this write that were not kept, with the reason. */
  dropped: Array<{ question: string; reason: 'invalid' | 'over-limit' }>;
}

/**
 * Merge new questions into a memory's existing ones and store them. Existing questions keep
 * their place; new ones fill up to the cap. Returns what was kept and why anything was dropped.
 *
 * The write always goes through the redacting store wrapper, so a host that embeds AWM and opened
 * its store directly (MWA) gets the same redaction as the MCP and HTTP paths. Wrapping an
 * already-wrapped store is a no-op.
 */
export async function attachQuestions(
  store: IEngramStore,
  engramId: string,
  offered: unknown,
  existing: string[] | null | undefined,
): Promise<QuestionsOutcome> {
  const raw = Array.isArray(offered) ? offered.filter((q): q is string => typeof q === 'string') : [];
  const valid = normalizeQuestions(raw.slice(0, 50), Infinity);
  const validKeys = new Set(valid.map((q) => q.toLowerCase()));
  const dropped: QuestionsOutcome['dropped'] = raw
    .filter((q) => !validKeys.has(clean(q).toLowerCase()))
    .map((q) => ({ question: q, reason: 'invalid' as const }));

  const prior = normalizeQuestions(existing ?? []);
  const merged = [...prior];
  for (const q of valid) {
    if (merged.some((m) => m.toLowerCase() === q.toLowerCase())) continue;
    if (merged.length >= MAX_QUESTIONS) { dropped.push({ question: q, reason: 'over-limit' }); continue; }
    merged.push(q);
  }
  if (merged.length !== prior.length) await withRedaction(store).setQuestions(engramId, merged);
  return { kept: merged, dropped };
}
