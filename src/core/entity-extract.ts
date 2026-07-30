// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity extraction for the entity inverted index (D9, 2026-07-30).
 *
 * v1 is deliberately conservative for precision: entities come ONLY from
 * structured sources — prefix tags (`person=Seetha`, `ticket=18999`) and
 * auto-tagger `entity:` tags — never from free-text guessing. Each entity is
 * normalized to `key:value` lowercase so lookups are exact.
 *
 * This is pure write-time bookkeeping. Retrieval behavior is unchanged until
 * D11 re-tests the graph features against the index (per the 2026-06-16
 * entity-centric retrieval roadmap).
 */

/** Prefix-tag keys whose values denote entities worth indexing. */
const ENTITY_KEYS = new Set([
  'person', 'ticket', 'member', 'horse', 'usef', 'event', 'proj', 'project',
  'skill', 'about', 'file', 'sp', 'table', 'agent', 'version', 'org',
]);

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
