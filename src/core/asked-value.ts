// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * "Known subject, attribute not stored" — the near-miss that invites invention.
 *
 * The strongest mechanistic account of hallucination (Ferrando et al., ICLR
 * 2025; Lindsey et al. 2025) is that a model fabricates when it RECOGNISES an
 * entity but lacks the fact asked about it: recognition switches off the
 * "can't answer" default. A memory layer cannot reach the model's internals,
 * but it can stop handing the model exactly that shape of context: three
 * memories that are plainly about Sam's Denver flight, none of which holds a
 * departure time, read to the model as "I know this flight", and the time
 * gets made up. AWM's abstention gate does not fire here, by design: a
 * near-miss usually has a clear winner.
 *
 * So, when the query asks for a KIND of value — a time, a date, an amount, a
 * count, a status — and no returned memory holds a value of that kind, the
 * reply says so in one line. It costs the agent one read of the source; the
 * alternative is a confident wrong number. Detection is deliberately simple
 * and conservative: it only ever ADDS a line, never changes ranking, and says
 * nothing when the query names no kind.
 */

import { valueSlots, type SlotKind } from './conflicts.js';

/** Query phrasings that ask for each kind of value. Lower-case, tested as regexes. */
const ASKS: Array<[SlotKind, RegExp]> = [
  ['time',   /\b(what time|time does|time is|what hour|o'?clock|depart(?:s|ure)?|leaves?|arrives?|arrival|starts? at|ends? at|opens? at|closes? at)\b/],
  ['date',   /\b(what day|what date|which day|which date|due|deadline|by when|expire|expires|renews?|renewal date)\b/],
  ['money',  /\b(how much|price|prices|cost|costs|fee|fees|rate|rates|charge|charges|amount|invoice total|\$)/],
  ['number', /\b(how many|count|which port|port number|version|how old|what number|phone|extension|zip|room number|flight number)\b/],
  ['status', /\b(status|(?:is|are|was|were) (?:\w+ ){0,4}(?:open|closed|paid|unpaid|cancell?ed|confirmed|approved|done|live|down|blocked|overdue|pending)|still (?:open|unpaid|pending|blocked)|did (?:\w+ ){0,3}(?:pay|cancel|confirm|approve|renew|ship|deploy))\b/],
];

/** "when" asks for a time OR a date; either kind stored answers it. */
const WHEN = /\b(when)\b/;

/** The kinds of value the query asks for; empty when it names none. */
export function askedKinds(query: string): Set<SlotKind> {
  const q = query.toLowerCase();
  const out = new Set<SlotKind>();
  for (const [kind, re] of ASKS) if (re.test(q)) out.add(kind);
  if (WHEN.test(q)) { out.add('time'); out.add('date'); }
  return out;
}

/** What this needs from a result. */
export interface ValueBearing { engram: { content: string } }

/**
 * The kinds asked for that NO returned memory holds, or an empty array. With
 * a "when" question, a stored time or date on any result satisfies both.
 */
export function missingAskedKinds(query: string, results: ValueBearing[]): SlotKind[] {
  const asked = askedKinds(query);
  if (asked.size === 0 || results.length === 0) return [];
  const held = new Set<SlotKind>();
  for (const r of results) for (const k of valueSlots(r.engram.content).keys()) held.add(k);
  const whenAsked = WHEN.test(query.toLowerCase());
  if (whenAsked && (held.has('time') || held.has('date'))) { asked.delete('time'); asked.delete('date'); }
  return [...asked].filter(k => !held.has(k));
}

const LABEL: Record<SlotKind, string> = {
  time: 'a time', date: 'a date', money: 'an amount', number: 'a number', status: 'a status',
};

/** One reply line, or empty. */
export function missingValueNote(query: string, results: ValueBearing[]): string {
  const missing = missingAskedKinds(query, results);
  if (missing.length === 0) return '';
  const what = missing.map(k => LABEL[k]).join(' or ');
  return `\n⚠ These memories are about the subject, but none of them holds ${what}, which is what the question asks for. Do not state one from memory — read the source.`;
}
