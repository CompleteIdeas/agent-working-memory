// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Trust tiers on writes and memories, and the one rule the write pipeline
 * applies with them: a merge or a replacement must never RAISE the trust of
 * text, and must never retire a more-trusted memory on the word of a
 * less-trusted write.
 *
 * Found by MWA BL-17 (2026-10-14/15), five isolated-review rounds with
 * probes: the pipeline merged a write into an existing memory on concept
 * equality and the merged engram KEPT THE OLD ENGRAM'S TAGS — so a poisoned
 * skill merged into a clean one came back trust=medium and primeable; a
 * planted untrusted decoy under the same concept let a poisoned near-copy
 * merge into the trusted fact; an archived trusted fact was revived with
 * poisoned text merged in; and an R3 "correction" (eventType surprise) from
 * untrusted text retired a trusted memory. MWA works around all of it in its
 * own wrapper. Any other client writing mixed-trust content was exposed.
 *
 * AWM has no trust model of its own, and this does not add one. It reads the
 * tag MWA's memory spine already writes (`trust=<tier>`) and refuses the
 * dangerous direction. The write is still stored — as its own engram, with
 * its own tags — so nothing is lost and the conflict mark can say the two
 * disagree. Untagged writes and memories are unaffected: the rule only fires
 * when the write is EXPLICITLY untrusted, or when both sides carry a tier and
 * the write's is lower.
 */

/** Ordered tiers; higher is more trusted. */
const TIERS: Record<string, number> = {
  untrusted: 0, none: 0, quarantine: 0,
  low: 1,
  medium: 2, med: 2,
  high: 3, trusted: 3, verified: 3, owner: 3,
};

/** The tier a `trust=<tier>` tag declares, or null when there is none. */
export function trustTier(tags: readonly string[] | null | undefined): number | null {
  if (!tags) return null;
  let found: number | null = null;
  for (const t of tags) {
    const m = /^trust=([a-z]+)$/i.exec(t.trim());
    if (!m) continue;
    const v = TIERS[m[1].toLowerCase()];
    if (v === undefined) continue;
    // Several tags: the lowest wins — a memory is as trusted as its least trusted label.
    found = found === null ? v : Math.min(found, v);
  }
  return found;
}

/**
 * True when `writeTags` must not merge into, supersede or revive a memory
 * carrying `targetTags`.
 */
export function mergeBlockedByTrust(
  writeTags: readonly string[] | null | undefined,
  targetTags: readonly string[] | null | undefined,
): boolean {
  const w = trustTier(writeTags);
  if (w === null) return false;                  // untagged write: no rule
  const t = trustTier(targetTags);
  if (w === 0) return t === null || t > 0;       // explicitly untrusted: only into untrusted
  if (t === null) return false;                  // tagged write, untagged target: no rule
  return w < t;
}
