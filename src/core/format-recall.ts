import type { ActivationResult } from '../types/engram.js';

/**
 * Formats one memory_recall result line for the MCP text response.
 *
 * Extracted out of the inline closure in mcp.ts (0.12.1) so the format itself
 * — specifically, that every result carries its engram id — can be unit
 * tested without booting the MCP server (mcp.ts has a top-level `await` and
 * opens the store as a side effect of import, so it cannot be imported by a
 * test directly).
 *
 * The id is placed right after the score, not at the end of the line: result
 * bodies can be long, and a consumer scanning for `[id: ...]` shouldn't have
 * to read past a paragraph of content to find it.
 */
/**
 * True when Phase 5.5 has already trimmed this engram's body.
 *
 * The fade marker is written INTO the content (`consolidation.ts` appends
 * `'… [faded]'` after slicing to FADE_KEEP_CHARS), which means it is only
 * visible to a reader who reaches the end of the body. Two things hide it
 * there: `granularity: 'compact'`/`'auto'`, where the displayed body is a
 * query-aware 200-char window that will rarely include the tail, and the
 * plain length of a full body. So the marker is detected on the CONTENT and
 * rendered in the header, next to `[valid until …]`, where a partial answer
 * cannot be mistaken for a complete one.
 *
 * Matched anywhere rather than at the end because merge-on-reinforce
 * (`AWM_REINFORCE_MERGE_CONTENT`) can append text after a fade, which would
 * leave the marker mid-body. A false positive labels a full memory partial,
 * which is the harmless direction.
 */
export function isFaded(content: string): boolean {
  return content.includes('[faded]');
}

export function formatRecallResultLine(r: ActivationResult, index: number): string {
  const body = r.summary ?? r.engram.content;
  // Fade retains 7.1% of answer-bearing identifiers while leaving findability
  // intact (docs/eval-gap-2026-10-11.md §8.1) — 37 of 38 faded engrams still
  // surface by cue. That combination is the worst possible shape: the result
  // ranks, reads as an answer, and no longer contains one. The label does not
  // fix the retrieval, it stops the silent part.
  const faded = isFaded(r.engram.content)
    // Fade overwrites the content (consolidation.ts Phase 5.5); no tool can bring the
    // rest back, so the label says what to do instead.
    ? ' [faded — body trimmed, the rest is gone; confirm against the source or a newer memory]'
    : '';
  const chain = r.engram.supersededBy
    ? ` ⚠ SUPERSEDED by ${r.engram.supersededBy} — treat as historical; recall/fetch the successor before relying on this.`
    : '';
  const validity = r.engram.validTo
    ? ` [valid until ${r.engram.validTo}]`
    : '';
  return `${index + 1}. **${r.engram.concept}** (${r.score.toFixed(3)}) [id: ${r.engram.id}]${validity}${faded}: ${body}${chain}`;
}
