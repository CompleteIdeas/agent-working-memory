// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Conflict surfacing among the memories ONE recall returns.
 *
 * AWM keeps contradictions on purpose (edge-case test 7 requires both sides of
 * a contradiction in the top 5): settling them is the agent's job, with the
 * source. What it did not do, until 2026-10-19, was SAY that two returned
 * memories disagree, or which is newer. The MWA evaluation probe showed the
 * cost: "departs 10:15" and "now departs 8:40" came back as two undated lines,
 * the stale one first, and nothing on the page told the model it was looking
 * at two versions of one fact. In the BL-40 assessment "newer facts lose to
 * older sources" cost four checks.
 *
 * This is a detector over the returned set only — never over the store — so it
 * costs a handful of string comparisons per recall. It is deliberately
 * conservative and its output is a QUESTION ("possible conflict … confirm
 * against the source"), not a verdict: a false mark costs the agent one check,
 * a missed one costs a wrong answer stated with confidence.
 *
 * Two memories are flagged when
 *   1. they are about the same thing — related by embedding cosine, or by word
 *      overlap when an embedding is missing — and
 *   2. they carry a value of the same kind (a time, a date, a money amount, a
 *      bare number, a status word) and those values differ, and
 *   3. neither supersedes the other and neither is already stale (superseded,
 *      expired, not yet valid) — those are marked elsewhere.
 *
 * Known limit, measured in tests/core/conflicts.test.ts: "template twins" —
 * two genuinely distinct facts that share a template ("flight out 8:40",
 * "flight back 10:15") — are flagged. That is the precision cost of (1)+(2)
 * without a parser, and the reason the mark is phrased as a question.
 */

import { cosineSimilarity } from './embeddings.js';
import { validityState } from './validity.js';

export type SlotKind = 'time' | 'date' | 'money' | 'number' | 'status';

/** What this needs from a result — any ActivationResult qualifies. */
export interface ConflictCandidate {
  engram: {
    id: string;
    concept: string;
    content: string;
    embedding?: number[] | null;
    createdAt?: Date | string | null;
    supersededBy?: string | null;
    supersedes?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
  };
}

export interface ConflictMark {
  /** The other memory in the pair. */
  id: string;
  /** True when THIS memory was written after the other one. */
  newer: boolean;
  /** The kind of value the two disagree on. */
  slot: SlotKind;
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const STATUS_WORDS = new Set([
  'moved', 'cancelled', 'canceled', 'renewed', 'rejected', 'approved', 'closed', 'open', 'opened',
  'paused', 'resumed', 'delayed', 'postponed', 'confirmed', 'unpaid', 'paid', 'overdue', 'done',
  'blocked', 'shipped', 'deployed', 'reverted', 'merged', 'unmerged', 'live', 'offline', 'down', 'up',
]);
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'per', 'now', 'was', 'were', 'are', 'has',
  'have', 'had', 'into', 'onto', 'than', 'then', 'not', 'but', 'its', 'his', 'her', 'their', 'our',
  'according', 'page', 'said', 'says', 'still', 'also', 'any', 'all', 'one', 'two', 'about',
]);

/** Normalise a clock time to HH:MM (24h). Returns null when it is not one. */
function clock(h: string, m: string | undefined, ampm: string | undefined): string | null {
  let hh = Number(h);
  const mm = m ? Number(m) : 0;
  if (!Number.isFinite(hh) || hh > 23 || mm > 59) return null;
  if (ampm) {
    const p = ampm.toLowerCase();
    if (hh > 12) return null;
    if (p === 'pm' && hh < 12) hh += 12;
    if (p === 'am' && hh === 12) hh = 0;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * The comparable values in a text, by kind. Text matched by an earlier,
 * more specific kind is blanked before a later kind runs, so "3:30pm" is one
 * time rather than a time and the numbers 3 and 30, and "$49" is money, not
 * a number.
 */
export function valueSlots(text: string): Map<SlotKind, Set<string>> {
  const slots = new Map<SlotKind, Set<string>>();
  const add = (k: SlotKind, v: string) => {
    if (!slots.has(k)) slots.set(k, new Set());
    slots.get(k)!.add(v);
  };
  let t = ` ${text} `;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    t = t.replace(re, (...args) => {
      const m = args as unknown as RegExpExecArray;
      fn(m);
      return ' ';
    });
  };

  // Times: 8:40 AM, 3:30pm, 14:00, 7pm.
  take(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi, m => { const c = clock(m[1], m[2], m[3]); if (c) add('time', c); });
  take(/\b(\d{1,2})\s*(am|pm)\b/gi, m => { const c = clock(m[1], undefined, m[2]); if (c) add('time', c); });
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, m => { const c = clock(m[1], m[2], undefined); if (c) add('time', c); });
  // Dates: 2026-01-15, Nov 14, 14 Nov, November 14th.
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => add('date', `${m[1]}-${m[2]}-${m[3]}`));
  take(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    m => add('date', `${m[1].slice(0, 3).toLowerCase()}-${Number(m[2])}`));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\b`, 'gi'),
    m => add('date', `${m[2].slice(0, 3).toLowerCase()}-${Number(m[1])}`));
  // Money: $1.45, $2,400, $49/month.
  take(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, m => add('money', m[1].replace(/,/g, '')));
  // Bare numbers (ids, counts, flight numbers): shared ones do no harm, differing ones may.
  take(/\b\d+(?:\.\d+)?\b/g, m => add('number', m[0]));
  // Status vocabulary.
  for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STATUS_WORDS.has(w)) add('status', w);
  }
  return slots;
}

/** Content words for the overlap fallback: lower-case, 3+ letters, no stopwords, no digits. */
function words(c: ConflictCandidate): Set<string> {
  const out = new Set<string>();
  for (const w of `${c.engram.concept} ${c.engram.content}`.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const COSINE_RELATED = 0.80;
const OVERLAP_RELATED = 0.30;

/** True when the two memories look like they are about the same thing. */
export function related(a: ConflictCandidate, b: ConflictCandidate): boolean {
  const ea = a.engram.embedding, eb = b.engram.embedding;
  if (ea && eb && ea.length === eb.length && ea.length > 0) {
    if (cosineSimilarity(ea, eb) >= COSINE_RELATED) return true;
  }
  return jaccard(words(a), words(b)) >= OVERLAP_RELATED;
}

/** The first kind of value present in BOTH texts on which they disagree, or null. */
export function disagreement(a: ConflictCandidate, b: ConflictCandidate): SlotKind | null {
  const sa = valueSlots(a.engram.content), sb = valueSlots(b.engram.content);
  for (const kind of ['time', 'date', 'money', 'status', 'number'] as SlotKind[]) {
    const va = sa.get(kind), vb = sb.get(kind);
    if (!va || !vb) continue;
    // Disagree when neither set contains the other: a memory that mentions
    // two times, one of which the other repeats, is an elaboration, not a conflict.
    const aInB = [...va].every(v => vb.has(v));
    const bInA = [...vb].every(v => va.has(v));
    if (!aInB && !bInA) return kind;
  }
  return null;
}

function createdMs(c: ConflictCandidate): number {
  const v = c.engram.createdAt;
  if (!v) return NaN;
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

function stale(c: ConflictCandidate, now: number): boolean {
  return !!c.engram.supersededBy || validityState(c.engram, now) !== 'current';
}

/**
 * Pairwise over the returned set. Returns one list of marks per input, in
 * input order; an empty list means no conflict for that memory.
 */
export function detectConflicts(results: ConflictCandidate[], now: number = Date.now()): ConflictMark[][] {
  const marks: ConflictMark[][] = results.map(() => []);
  for (let i = 0; i < results.length; i++) {
    const a = results[i];
    if (stale(a, now)) continue;
    for (let j = i + 1; j < results.length; j++) {
      const b = results[j];
      if (stale(b, now)) continue;
      if (a.engram.supersedes === b.engram.id || b.engram.supersedes === a.engram.id) continue;
      if (!related(a, b)) continue;
      const slot = disagreement(a, b);
      if (!slot) continue;
      const ta = createdMs(a), tb = createdMs(b);
      const aNewer = Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : false;
      const bNewer = Number.isFinite(ta) && Number.isFinite(tb) ? tb > ta : false;
      marks[i].push({ id: b.engram.id, newer: aNewer, slot });
      marks[j].push({ id: a.engram.id, newer: bNewer, slot });
    }
  }
  return marks;
}

/** The id of the most recently written memory among those carrying a mark, or null. */
export function newestConflicting(results: ConflictCandidate[], marks: ConflictMark[][]): string | null {
  let best: string | null = null, bestMs = -Infinity;
  results.forEach((r, i) => {
    if (marks[i].length === 0) return;
    const ms = createdMs(r);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.engram.id; }
  });
  return best;
}
