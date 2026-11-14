// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * "Everything about X" (0.23): every memory indexed under one person, organisation or thing,
 * in date order. This is a deterministic lookup on the entity index (D9), not ranked recall:
 * recall returns the top k against the question's wording, so the ninth memory about Jenna
 * never shows, and a question that says "the hotel" may not reach memories that say "Harbor
 * Hotel". The index answers "all of them" exactly.
 *
 * Resolution order for the name the caller gives:
 *   1. an exact key (`person:jenna park`, also written `person=Jenna Park`);
 *   2. an exact alias registered with memory_alias (the agent's own before a shared one);
 *   3. an exact value after the key prefix ("jenna park" matches `person:jenna park`);
 *   4. otherwise a substring search, which returns CANDIDATES and no memories.
 * A name that resolves to two different entities (two Jennas) comes back as candidates too.
 * Two people are never merged silently: a wrong merge feeds false facts into every later answer.
 */

import type { Engram } from '../types/engram.js';
import type { EngramStore } from '../storage/store.js';
import { normalizeAlias, normalizeEntityKey } from '../core/entity-extract.js';

export interface AboutQuery {
  /** A name, alias or key: "Jenna Park", "jenna", "person:jenna park", "contact=events@harborhotel.example". */
  entity: string;
  /** Agents whose memories count (the caller, or every agent in its workspace). */
  agentIds: string[];
  /** Keep superseded memories, labelled as history. Default true. */
  includeSuperseded?: boolean;
  /** Keep staged (weak, unconfirmed) memories. Default false, as in recall. */
  includeStaging?: boolean;
  /** At most this many memories; the NEWEST are kept and the reply says how many older ones were left out. Default 50. */
  limit?: number;
  /** Only memories this session wrote (mirrors recall's scope: "session"). */
  sessionOnly?: boolean;
  sessionId?: string;
}

export interface AboutMemory {
  engram: Engram;
  /** The date the timeline is ordered by: valid_from when set, else when it was written. */
  date: string;
  superseded: boolean;
}

export interface AboutResult {
  /** found: memories returned. ambiguous: the name names more than one entity. candidates: no exact match, near names listed. not_found: nothing. */
  status: 'found' | 'ambiguous' | 'candidates' | 'not_found';
  query: string;
  entity?: string;
  matchedBy?: 'key' | 'alias' | 'value';
  /** The alias or value text that matched, when it wasn't the key itself. */
  matchedTerm?: string;
  candidates: string[];
  memories: AboutMemory[];
  /** Memories indexed under the entity that passed the filters, before `limit`. */
  total: number;
  /** Older memories left out by `limit`. */
  omitted: number;
  /** Other names registered for the entity. */
  aliases: string[];
}

function dateOf(e: Engram): string {
  const vf = e.validFrom ? Date.parse(e.validFrom) : NaN;
  const d = Number.isFinite(vf) ? new Date(vf) : new Date(e.createdAt);
  return d.toISOString();
}

export async function memoryAbout(store: EngramStore, q: AboutQuery): Promise<AboutResult> {
  const raw = String(q.entity ?? '').trim();
  const base: AboutResult = { status: 'not_found', query: raw, candidates: [], memories: [], total: 0, omitted: 0, aliases: [] };
  if (!raw || q.agentIds.length === 0) return base;

  const asKey = normalizeEntityKey(raw);
  const term = normalizeAlias(raw);
  const terms = asKey && asKey !== term ? [asKey, term] : [term];
  const matches = await store.matchEntityTerms(terms, q.agentIds);

  // Pick the most specific route that matched: key, then alias, then value.
  let entity: string | undefined;
  let matchedBy: 'key' | 'alias' | 'value' | undefined;
  let matchedTerm: string | undefined;
  for (const via of ['key', 'alias', 'value'] as const) {
    let hits = matches.filter(m => m.via === via);
    if (via === 'alias' && hits.length > 0) {
      // An agent's own alias overrides a shared ('') one for that agent.
      const own = hits.filter(m => m.agentId !== '');
      if (own.length > 0) hits = own;
    }
    const ents = Array.from(new Set(hits.map(m => m.entity)));
    if (ents.length === 1) { entity = ents[0]; matchedBy = via; matchedTerm = hits[0].term; break; }
    if (ents.length > 1) return { ...base, status: 'ambiguous', candidates: ents.sort() };
  }

  if (!entity) {
    const near = await store.searchEntities(term, 8, q.agentIds);
    return near.length > 0 ? { ...base, status: 'candidates', candidates: near } : base;
  }

  // Every memory indexed under the entity, for every agent in scope.
  const ids = new Set<string>();
  for (const agentId of q.agentIds) {
    for (const id of await store.getEngramIdsByEntity(entity, agentId)) ids.add(id);
  }
  const includeSuperseded = q.includeSuperseded ?? true;
  const engrams = (await store.getEngramsByIds(Array.from(ids))).filter(e => {
    if (!q.agentIds.includes(e.agentId)) return false;
    if (e.retracted) return false;
    if (q.sessionOnly && q.sessionId && e.writerSession !== q.sessionId) return false;
    // A superseded memory is history: shown (labelled) unless the caller opts out, even
    // though superseding archives it.
    if (e.supersededBy) return includeSuperseded;
    if (e.stage === 'staging') return !!q.includeStaging;
    // archived and not superseded = evicted; recall never returns those either.
    if (e.stage === 'archived') return false;
    return true;
  });

  const rows: AboutMemory[] = engrams
    .map(e => ({ engram: e, date: dateOf(e), superseded: !!e.supersededBy }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.engram.id < b.engram.id ? -1 : 1));
  const limit = Math.max(1, Math.floor(q.limit ?? 50));
  const kept = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  const aliases = (await store.listEntityAliases(q.agentIds, entity)).map(a => a.alias);

  return {
    ...base,
    status: 'found',
    entity,
    matchedBy,
    matchedTerm: matchedTerm !== entity ? matchedTerm : undefined,
    memories: kept,
    total: rows.length,
    omitted: rows.length - kept.length,
    aliases: Array.from(new Set(aliases)),
  };
}

/**
 * Register an alternative name. Validates the key, normalises the alias, and reports a
 * replaced target, so a caller learns when "jenna" moved from one person to another.
 */
export async function registerAlias(
  store: EngramStore, agentId: string, alias: string, entity: string,
): Promise<{ ok: true; alias: string; entity: string; previous: string | null } | { ok: false; error: string }> {
  const a = normalizeAlias(alias);
  const key = normalizeEntityKey(entity);
  if (!a) return { ok: false, error: 'alias is empty' };
  if (a.length > 160) return { ok: false, error: 'alias is longer than 160 characters' };
  if (!key) return { ok: false, error: `"${entity}" is not an entity key. Use key:value, e.g. person:jenna park, contact:events@harborhotel.example, org:harbor hotel or entity:the gala.` };
  if (a === key) return { ok: false, error: 'alias and entity are the same' };
  const { previous } = await store.setEntityAlias(agentId, a, key);
  return { ok: true, alias: a, entity: key, previous };
}
