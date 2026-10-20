// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Implicit feedback — the learning loop fed by what the agent DOES, not what it
 * volunteers.
 *
 * THE PROBLEM
 * -----------
 * Every adaptive mechanism downstream of `memory_feedback` (confidence
 * updates, validation-gated Hebbian strengthening, "AWM learns which recalls
 * were worth their tokens") depends on the agent calling it. Measured on the
 * live store on 2026-10-20: **12 retrieval_feedback rows against 23,653
 * activation events**, 4,018 of them in the preceding week. Agents do not
 * rate recalls, however the guidance asks. The loop was, in practice, off.
 *
 * THE SIGNAL
 * ----------
 * A recalled memory was *used* when its substance shows up in what the agent
 * did next: a `memory_write` whose content carries the same identifiers, a
 * `memory_supersede` of that very memory, a task summary, or the assistant's
 * reply and tool calls in the turn that followed (the Stop hook posts the
 * transcript tail). None of that needs the model to remember a tool.
 *
 * THE RULE
 * --------
 * For each memory returned by a recall within the window, it counts as used if
 *   - its id (first 8 characters) appears in the text, or
 *   - at least MIN_TOKENS of its DISTINCTIVE tokens appear: identifiers (4+
 *     digit numbers, money, ISO dates), file paths, tag values (`ticket=`,
 *     `person=`, `file=`, `pr=`, `entity:`), proper nouns and long words from
 *     the concept.
 * Common words never count, so "the API" does not credit a memory about the
 * API. One credit per (recall, memory); positives only — a recall the agent
 * did not use is simply not credited, because "not useful" from absence of
 * evidence would weaken good memories whenever the agent was interrupted.
 */

export interface RecalledEngramRef {
  id: string;
  concept: string;
  content: string;
  tags?: readonly string[] | null;
}

export interface RecallRecord {
  eventId: string;
  at: number;
  agentId: string;
  engrams: RecalledEngramRef[];
}

export interface ImplicitUse {
  eventId: string;
  engramId: string;
  /** What matched: 'id' or the distinctive tokens found. */
  evidence: string[];
}

const MIN_TOKENS = 2;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'than', 'then', 'when', 'where',
  'which', 'while', 'about', 'after', 'before', 'between', 'because', 'should', 'would', 'could',
  'memory', 'memories', 'recall', 'write', 'session', 'project', 'default', 'version', 'release',
  'update', 'updated', 'change', 'changed', 'config', 'setting', 'settings', 'service', 'server',
  'request', 'response', 'error', 'errors', 'result', 'results', 'number', 'string', 'value', 'values',
]);

/** The tokens that identify THIS memory rather than its subject area. */
export function distinctiveTokens(e: RecalledEngramRef): Set<string> {
  const out = new Set<string>();
  const text = `${e.concept} ${e.content}`;
  // Identifiers: 4+ digit numbers (tickets, ports, years are weak but rare in prose), money, ISO dates.
  for (const m of text.match(/\b\d{4,}\b/g) ?? []) out.add(m);
  for (const m of text.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []) out.add(m.replace(/,/g, ''));
  for (const m of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) out.add(m);
  // File paths and code identifiers: src/core/x.ts, foo.test.ts, snake_case_names, CamelCase.fn
  for (const m of text.match(/\b[\w./-]+\.(?:ts|js|mjs|cjs|md|json|sql|py|html|css|yml|yaml|toml|ps1|sh)\b/g) ?? []) out.add(m.toLowerCase());
  for (const m of text.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) out.add(m.toLowerCase());
  for (const m of text.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g) ?? []) out.add(m.toLowerCase());
  // Tag values that name a thing.
  for (const t of e.tags ?? []) {
    const m = /^(ticket|person|file|pr|entity|member|asset|version|branch|horse|event)[=:](.+)$/i.exec(t);
    if (m && m[2].length >= 3) out.add(m[2].toLowerCase());
  }
  // Proper nouns and long words from the concept (the concept is the memory's name).
  for (const w of e.concept.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? []) {
    const lw = w.toLowerCase();
    if (!STOP.has(lw)) out.add(lw);
  }
  for (const w of e.concept.toLowerCase().match(/\b[a-z]{8,}\b/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/** Which of `tokens` occur in `text` (whole-word for words, substring for paths/ids). */
function present(tokens: Set<string>, text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const t of tokens) {
    if (/^[a-z]+$/.test(t)) {
      if (new RegExp(`\\b${t}\\b`).test(lower)) found.push(t);
    } else if (lower.includes(t.toLowerCase())) {
      found.push(t);
    }
  }
  return found;
}

/**
 * The (recall, memory) pairs that `text` shows were used, among recalls newer
 * than `windowMs`. `credited` holds `${eventId}:${engramId}` keys already
 * counted; matches in it are skipped and new ones are added.
 */
export function matchUses(
  recalls: readonly RecallRecord[],
  text: string,
  opts: { now?: number; windowMs?: number; credited?: Set<string> } = {},
): ImplicitUse[] {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const credited = opts.credited ?? new Set<string>();
  const uses: ImplicitUse[] = [];
  if (!text || text.length < 8) return uses;
  const lower = text.toLowerCase();
  for (const r of recalls) {
    if (now - r.at > windowMs) continue;
    for (const e of r.engrams) {
      const key = `${r.eventId}:${e.id}`;
      if (credited.has(key)) continue;
      let evidence: string[] = [];
      if (lower.includes(e.id.slice(0, 8).toLowerCase())) {
        evidence = ['id'];
      } else {
        const hits = present(distinctiveTokens(e), text);
        if (hits.length >= MIN_TOKENS) evidence = hits;
      }
      if (evidence.length > 0) {
        credited.add(key);
        uses.push({ eventId: r.eventId, engramId: e.id, evidence });
      }
    }
  }
  return uses;
}
