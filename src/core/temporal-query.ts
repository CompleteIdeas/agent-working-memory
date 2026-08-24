// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Temporal expressions in a recall query.
 *
 * THE PROBLEM
 * -----------
 * Nothing in the pipeline parsed dates out of query text, and `ActivationQuery`
 * had no date parameter. So "azure app plan from last Thursday or Friday" spent
 * "last", "Thursday" and "Friday" as ordinary BM25 tokens — diluting the subject
 * terms and matching `date=` tags right across the corpus.
 *
 * Measured on the real store (101 probes, tests/realstore-eval):
 *   subject only ............ 59.4% success@1   <- control
 *   + "from last Friday" .... 56.4%  (-3.0pp)
 *   + "on 2026-05-01" ....... 51.5%  (-7.9pp)
 *   ORACLE, week-filtered ... 96.0%  (+36.6pp)
 *
 * So the most selective thing the user said was a PENALTY, and a working
 * temporal filter is worth more than anything else measured on this store.
 *
 * DESIGN NOTES
 * ------------
 * - `asOf` is required for relative phrases. Using the wall clock would make a
 *   fixture non-reproducible: "last week" would silently mean something new on
 *   every run. Callers pass the query time explicitly.
 * - Matching is deliberately CONSERVATIVE. A greedy matcher that fired on
 *   ordinary words would reshape every recall in the store, so each pattern is
 *   anchored on an unambiguous cue ("last", "yesterday", an ISO date, a month
 *   name). When nothing matches, this returns `null` and callers must treat
 *   that as a strict no-op.
 * - The window is a PREFERENCE for callers, never a filter. People misremember
 *   dates — "last Thursday or Friday" is itself an admission of uncertainty —
 *   so a memory outside the window must stay reachable on subject strength.
 */

export interface TemporalMatch {
  /** Inclusive window start (UTC ms). */
  from: number;
  /** Exclusive window end (UTC ms). */
  to: number;
  /** The literal phrases matched, for logging and for stripping. */
  matched: string[];
  /** The query with temporal phrases removed, for the lexical channel. */
  stripped: string;
  /** How the window was derived — useful when explaining a recall. */
  kind: 'relative-day' | 'relative-week' | 'relative-month' | 'recent' | 'absolute-date' | 'absolute-month';
}

const DAY = 86400000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;

/**
 * Parse a temporal expression out of `query`, anchored at `asOf`.
 * Returns `null` when nothing matches — callers MUST treat that as a no-op.
 *
 * Windows are padded generously rather than tightly: the goal is to prefer a
 * neighbourhood, not to pin an exact day the user probably misremembers.
 */
export function parseTemporal(query: string, asOf: Date | number): TemporalMatch | null {
  const anchorMs = typeof asOf === 'number' ? asOf : asOf.getTime();
  if (!Number.isFinite(anchorMs)) return null;
  const q = query.toLowerCase();
  const today = utcDay(anchorMs);
  const matched: string[] = [];

  const build = (from: number, to: number, kind: TemporalMatch['kind']): TemporalMatch => ({
    from, to, matched,
    stripped: stripPhrases(query, matched),
    kind,
  });

  // ── absolute ISO date — ONLY with an explicit temporal cue ──
  // A BARE date must not trigger this. Memories routinely carry a date as part
  // of their SUBJECT ("Hive close-out 2026-04-24 PASS", "FIXED 2026-08-21 event
  // River Glen"), where the date IS the fact, not a "when" filter. Treating
  // those as temporal strips a strongly discriminative term and makes recall
  // worse: measured, a bare-date rule fired on 98 of 1,316 (7.4%) real
  // identifier queries and cost success@1 75.8% -> 75.0%. Same reason the month
  // rule below requires an "in"/"during" cue.
  const iso = q.match(/\b(on|from|since|before|after|around|during|dated)\s+(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    matched.push(iso[0]);
    const d = Date.UTC(+iso[2], +iso[3] - 1, +iso[4]);
    // +/- 3 days: a remembered date is often a day or two off.
    return build(d - 3 * DAY, d + 4 * DAY, 'absolute-date');
  }

  // ── "yesterday" / "today" ──
  if (/\byesterday\b/.test(q)) {
    matched.push('yesterday');
    return build(today - DAY, today, 'relative-day');
  }
  if (/\btoday\b/.test(q)) {
    matched.push('today');
    return build(today, today + DAY, 'relative-day');
  }

  // ── "last <weekday>" / "on <weekday>" ──
  const wd = q.match(/\b(?:last|this|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    matched.push(wd[0]);
    // A second weekday ("Thursday or Friday") widens rather than confuses.
    const second = q.match(/\bor\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (second) matched.push(second[0]);
    const targets = [WEEKDAYS.indexOf(wd[1])];
    if (second) targets.push(WEEKDAYS.indexOf(second[1]));
    const anchorDow = new Date(today).getUTCDay();
    const days = targets.map(t => {
      let back = (anchorDow - t + 7) % 7;
      if (back === 0) back = 7;                 // "last Friday" on a Friday means the previous one
      return today - back * DAY;
    });
    // +/- 1 day of slack around the named day(s).
    return build(Math.min(...days) - DAY, Math.max(...days) + 2 * DAY, 'relative-day');
  }

  // ── "last week" / "this week" / "past week" ──
  if (/\b(?:last|this|past)\s+week\b/.test(q)) {
    matched.push((q.match(/\b(?:last|this|past)\s+week\b/) as RegExpMatchArray)[0]);
    return build(today - 14 * DAY, today + DAY, 'relative-week');
  }

  // ── "last month" / "this month" / "past month" ──
  if (/\b(?:last|this|past)\s+month\b/.test(q)) {
    matched.push((q.match(/\b(?:last|this|past)\s+month\b/) as RegExpMatchArray)[0]);
    return build(today - 45 * DAY, today + DAY, 'relative-month');
  }

  // ── "last N days/weeks/months" ──
  const lastN = q.match(/\b(?:last|past)\s+(\d{1,3})\s+(day|week|month)s?\b/);
  if (lastN) {
    matched.push(lastN[0]);
    const n = +lastN[1];
    const mult = lastN[2] === 'day' ? DAY : lastN[2] === 'week' ? 7 * DAY : 30 * DAY;
    return build(today - n * mult, today + DAY, 'relative-week');
  }

  // ── "recently" / "recent" / "the other day" / "a few days ago" ──
  if (/\b(?:recently|the other day|a few days ago|just now)\b/.test(q)) {
    matched.push((q.match(/\b(?:recently|the other day|a few days ago|just now)\b/) as RegExpMatchArray)[0]);
    return build(today - 14 * DAY, today + DAY, 'recent');
  }

  // ── "in <Month> [Year]" — requires the "in"/"during" cue so a project named
  //    "May" or a sentence containing "march" cannot trigger it accidentally.
  const mon = q.match(/\b(?:in|during|back in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/);
  if (mon) {
    matched.push(mon[0]);
    const mIdx = MONTHS.indexOf(mon[1]);
    const anchorYear = new Date(today).getUTCFullYear();
    const year = mon[2] ? +mon[2] : anchorYear;
    const from = Date.UTC(year, mIdx, 1);
    const to = Date.UTC(mIdx === 11 ? year + 1 : year, (mIdx + 1) % 12, 1);
    return build(from, to, 'absolute-month');
  }

  return null;
}

/** Remove matched temporal phrases (and now-dangling connectives) from a query. */
function stripPhrases(query: string, phrases: string[]): string {
  let out = query;
  // Longest first, so "on 2026-05-01" is removed before the bare date.
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(p), 'gi'), ' ');
  }
  return out
    .replace(/\b(?:from|on|in|during|back in|since)\s*$/i, ' ')
    .replace(/\s+(?:from|on|in|during)\s+(?=\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether temporal handling is enabled. Default OFF. */
export function temporalEnabled(): boolean {
  return process.env.AWM_TEMPORAL === '1';
}

/**
 * Boost applied to a candidate whose creation time falls inside the window.
 * A PREFERENCE, not a filter — see the design note above.
 */
export function temporalBoost(): number {
  const v = Number(process.env.AWM_TEMPORAL_BOOST ?? 0.35);
  return Number.isFinite(v) && v >= 0 ? v : 0.35;
}
