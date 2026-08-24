// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Project-dialect alias expansion.
 *
 * WHAT IT SOLVES
 * --------------
 * A memory tagged `topic=azure` whose body says "private plan… P1v3… app
 * service" but never "azure". Asked for with "azure", it was not in the top 40.
 * No general model knows that connection — it is local to this project — but it
 * is recoverable from the store, because memories tagged `azure` share body
 * vocabulary that the corpus at large does not.
 *
 * The map is mined offline (tests/realstore-eval/mine-aliases.ts) and is a plain
 * JSON artifact: inspectable, cappable, diffable. That mattered immediately —
 * reading the first mined map showed it had learned
 * `agent -> discussed, turns, topics, summary`, i.e. session-summary boilerplate
 * masquerading as dialect, and a hub guardrail was added before any measurement.
 *
 * GUARDRAIL 4 — "require at least one ORIGINAL query term" — is implemented by
 * SCOPE rather than by an extra filter:
 *
 *   - alias terms are added ONLY to the BM25 search string, widening what gets
 *     retrieved;
 *   - `queryTokens`, which drives textMatch scoring, stays ORIGINAL.
 *
 * So a candidate that matches only alias terms enters the pool with a near-zero
 * textMatch and is filtered by the existing minScore gate, while a candidate
 * that matches an original term too is scored normally. The alias terms buy
 * REACH; the original terms still decide RELEVANCE. That is exactly the
 * separation Codex asked for, and it needs no new gate to enforce.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cache: Record<string, string[]> | null = null;

function mapPath(): string {
  if (process.env.AWM_ALIAS_MAP) return process.env.AWM_ALIAS_MAP;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'data', 'alias-map.json');
}

/** Load the mined map once. Missing file is not an error — the feature is opt-in. */
export function aliasMap(): Record<string, string[]> {
  if (cache) return cache;
  const p = mapPath();
  if (!existsSync(p)) { cache = {}; return cache; }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    cache = (parsed.map ?? parsed) as Record<string, string[]>;
  } catch {
    cache = {};
  }
  return cache;
}

/** Reset the cache — tests only. */
export function clearAliasCache(): void { cache = null; }

/** Whether alias expansion is enabled. Default OFF. */
export function aliasEnabled(): boolean {
  return process.env.AWM_ALIASES === '1';
}

/** Max alias terms added to a single query, regardless of how many match. */
export function aliasQueryCap(): number {
  const v = Number(process.env.AWM_ALIAS_QUERY_CAP ?? 8);
  return Number.isFinite(v) && v > 0 ? v : 8;
}

/**
 * Expand a query with dialect terms for any category word it mentions.
 * Returns the added terms (never the rewritten query) so the caller decides
 * which channel sees them — the whole safety property depends on alias terms
 * reaching BM25 only, not the scoring tokens.
 */
export function aliasTermsFor(query: string): string[] {
  if (!aliasEnabled()) return [];
  const m = aliasMap();
  if (Object.keys(m).length === 0) return [];
  const toks = new Set((query.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []));
  const out: string[] = [];
  const seen = new Set<string>(toks);
  for (const t of toks) {
    const aliases = m[t];
    if (!aliases) continue;
    for (const a of aliases) {
      if (seen.has(a)) continue;      // never re-add a term the query already has
      seen.add(a);
      out.push(a);
      if (out.length >= aliasQueryCap()) return out;
    }
  }
  return out;
}
