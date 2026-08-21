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
export function formatRecallResultLine(r: ActivationResult, index: number): string {
  const body = r.summary ?? r.engram.content;
  const chain = r.engram.supersededBy
    ? ` ⚠ SUPERSEDED by ${r.engram.supersededBy} — treat as historical; recall/fetch the successor before relying on this.`
    : '';
  const validity = r.engram.validTo
    ? ` [valid until ${r.engram.validTo}]`
    : '';
  return `${index + 1}. **${r.engram.concept}** (${r.score.toFixed(3)}) [id: ${r.engram.id}]${validity}: ${body}${chain}`;
}
