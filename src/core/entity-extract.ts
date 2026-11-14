// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity extraction for the entity inverted index (D9, 2026-07-30).
 *
 * v1 is deliberately conservative for precision: entities come ONLY from
 * structured sources — prefix tags (`person=Avery`, `ticket=10002`) and
 * auto-tagger `entity:` tags — never from free-text guessing. Each entity is
 * normalized to `key:value` lowercase so lookups are exact.
 *
 * This is pure write-time bookkeeping. Retrieval behavior is unchanged until
 * D11 re-tests the graph features against the index (per the 2026-06-16
 * entity-centric retrieval roadmap).
 */

/** Prefix-tag keys whose values denote entities worth indexing.
 *  `contact` (0.23): a third party the agent's user deals with (MWA tags mail senders
 *  `contact=<email>`), kept apart from `person`, which agents use for the user themself. */
export const ENTITY_KEYS = new Set([
  'person', 'ticket', 'member', 'horse', 'usef', 'event', 'proj', 'project',
  'skill', 'about', 'file', 'sp', 'table', 'agent', 'version', 'org', 'contact',
]);

/** Keys that name a person, organisation or thing people call by other names. A write's
 *  `aliases` attach to its one entity of these kinds; `proj=`, `version=`, `file=` and the
 *  like are bookkeeping tags that every write carries and never take an alias. */
export const ALIASABLE_KEYS = new Set(['person', 'contact', 'org', 'entity', 'event', 'horse', 'member']);

/** Normalise an alternative name: trimmed, lowercase, inner whitespace collapsed. */
export function normalizeAlias(alias: string): string {
  return String(alias ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalise an entity key to the indexed `key:value` form. Accepts `person:Jenna Park`,
 * `person=Jenna Park` and `entity:the gala`; `project` becomes `proj`. Returns null for a
 * string that names no known key (a bare name is a lookup term, not a key).
 */
export function normalizeEntityKey(raw: string): string | null {
  const s = String(raw ?? '').trim();
  const m = /^([A-Za-z]+)\s*[:=]\s*(.+)$/.exec(s);
  if (!m) return null;
  let key = m[1].toLowerCase();
  if (key === 'project') key = 'proj';
  if (!ENTITY_KEYS.has(key) && key !== 'entity') return null;
  const value = normalizeAlias(m[2]);
  if (!value || value.length > 120) return null;
  return `${key}:${value}`;
}

/** Question words that never name an entity on their own. A phrase made only of these is skipped. */
const GRAM_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'about',
  'what', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'which', 'is', 'are', 'was', 'were', 'be',
  'been', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'may',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
  'they', 'them', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'any', 'anything', 'all',
  'new', 'tell', 'say', 'said', 'want', 'wanted', 'need', 'needs', 'get', 'got', 'going', 'on', 'up',
  'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'too', 'very', 'just', 'still', 'again', 'please',
  'last', 'next', 'today', 'tomorrow', 'yesterday', 'week', 'day', 'time', 'thing', 'things',
]);

/**
 * Lowercase 1–3 word phrases from a question, for exact matching against aliases and entity
 * values (0.23, AWM_ENTITY_ALIAS_MATCH). Possessives are dropped ("jenna's" → "jenna"); email
 * addresses and dotted names stay whole tokens. A phrase made only of stop words is skipped,
 * but a phrase may contain one ("the gala" is kept beside "gala"), since that is how people
 * register names. Capped so a long question costs one bounded lookup.
 */
export function entityQueryGrams(text: string, maxGrams = 150): string[] {
  const toks = (String(text ?? '').toLowerCase()
    .match(/[\p{L}\p{N}](?:[\p{L}\p{N}@._+'’-]*[\p{L}\p{N}])?/gu) ?? [])
    .map(t => t.replace(/['’]s$/u, ''))
    .slice(0, 80);
  const out = new Set<string>();
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= toks.length; i++) {
      const g = toks.slice(i, i + n);
      if (g.every(w => GRAM_STOP.has(w))) continue;
      if (n === 1 && g[0].length < 2) continue;
      out.add(g.join(' '));
      if (out.size >= maxGrams) return Array.from(out);
    }
  }
  return Array.from(out);
}

/**
 * Choose the entities a question names from exact phrase matches (0.23). Two rules:
 *  - a bare value counts only for name-like keys: `proj=`, `version=`, `file=` ride on
 *    almost every write, so "awm" matching proj:awm would pull in the whole project;
 *  - the longest name wins: a match whose words sit inside a longer matched phrase is
 *    dropped, so "jenna liu" does not also pull in whoever "jenna" is.
 * Returns entity keys, longest phrase first.
 */
export function selectEntityHits(hits: Array<{ term: string; entity: string; via: 'key' | 'alias' | 'value' }>): string[] {
  const named = hits.filter(h => h.via !== 'value' || ALIASABLE_KEYS.has(h.entity.slice(0, h.entity.indexOf(':'))));
  const terms = Array.from(new Set(named.map(h => h.term)));
  const inside = (a: string, b: string) => a !== b && ` ${b} `.includes(` ${a} `);
  const kept = named
    .filter(h => !terms.some(longer => inside(h.term, longer)))
    .sort((a, b) => b.term.length - a.term.length);
  return Array.from(new Set(kept.map(h => h.entity)));
}

/** The part of an entity key after `key:` ("person:jenna park" → "jenna park"). */
export function entityValue(entity: string): string {
  const i = entity.indexOf(':');
  return i >= 0 ? entity.slice(i + 1) : entity;
}

/** Extract normalized `key:value` entities from a tag list. Deduped, order-stable. */
export function extractEntitiesFromTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = String(raw).trim();
    let entity: string | null = null;
    const eq = tag.indexOf('=');
    if (eq > 0) {
      const key = tag.slice(0, eq).toLowerCase();
      const value = tag.slice(eq + 1).trim().toLowerCase();
      if (ENTITY_KEYS.has(key) && value.length > 0 && value.length <= 120) {
        entity = `${key === 'project' ? 'proj' : key}:${value}`;
      }
    } else if (tag.toLowerCase().startsWith('entity:')) {
      const value = tag.slice('entity:'.length).trim().toLowerCase();
      if (value.length > 0 && value.length <= 120) entity = `entity:${value}`;
    }
    if (entity && !seen.has(entity)) {
      seen.add(entity);
      out.push(entity);
    }
  }
  return out;
}
