// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Text rendering for memory_about (0.23). Kept apart from the MCP server so it can be unit
 * tested without booting one, like core/format-recall.ts.
 */

import type { AboutResult } from '../engine/entity-about.js';
import { estimateTokens } from './token-budget.js';

const COMPACT_LEN = 200;

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function formatAboutResult(res: AboutResult, opts: { full?: boolean; maxTokens?: number } = {}): string {
  if (res.status === 'ambiguous') {
    return [
      `"${res.query}" names more than one entity, so no memories were merged:`,
      ...res.candidates.map(c => `  - ${c}`),
      `Ask again with the full key, e.g. memory_about entity: "${res.candidates[0]}".`,
    ].join('\n');
  }
  if (res.status === 'candidates') {
    return [
      `No entity is named exactly "${res.query}". Close matches:`,
      ...res.candidates.map(c => `  - ${c}`),
      `Ask again with one of these keys, or register the name with memory_alias.`,
    ].join('\n');
  }
  if (res.status === 'not_found') {
    return `No entity is named "${res.query}". memory_about finds memories by their name tags (person=, contact=, org=, event=, entity:…) and registered aliases; try memory_recall for a ranked search of the text.`;
  }

  const how = res.matchedBy === 'alias' ? ` (alias "${res.matchedTerm}")`
    : res.matchedBy === 'value' ? ` (matched "${res.matchedTerm}")` : '';
  const head = `${res.entity}${how}: ${res.total} memor${res.total === 1 ? 'y' : 'ies'}, oldest first`
    + (res.aliases.length ? `\nAlso called: ${res.aliases.join(', ')}` : '');

  const lines = res.memories.map(m => {
    const e = m.engram;
    const body = opts.full ? e.content : oneLine(e.content, COMPACT_LEN);
    const valid = e.validTo ? ` [valid until ${e.validTo}]` : '';
    const hist = m.superseded ? ` ⚠ SUPERSEDED by ${e.supersededBy} (history)` : '';
    const staged = e.stage === 'staging' ? ' (staged)' : '';
    return `${m.date.slice(0, 10)} · ${e.concept} [${e.memoryClass}]${valid}${hist}${staged}\n  ${body}\n  id: ${e.id}`;
  });

  // Token budget: keep the newest memories (the tail) that fit, still printed oldest first.
  let kept = lines;
  let budgetOmitted = 0;
  if (opts.maxTokens && opts.maxTokens > 0) {
    let spent = estimateTokens(head) + 30;
    const take: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const c = estimateTokens(lines[i]);
      if (spent + c > opts.maxTokens && take.length > 0) break;
      spent += c;
      take.unshift(lines[i]);
    }
    budgetOmitted = lines.length - take.length;
    kept = take;
  }
  const omitted = res.omitted + budgetOmitted;
  const foot = omitted > 0
    ? `\n(${omitted} older memor${omitted === 1 ? 'y' : 'ies'} left out by ${res.omitted > 0 && budgetOmitted > 0 ? 'limit and max_tokens' : res.omitted > 0 ? 'limit' : 'max_tokens'}; raise it to see them.)`
    : '';
  return `${head}\n\n${kept.join('\n')}${foot}`;
}
