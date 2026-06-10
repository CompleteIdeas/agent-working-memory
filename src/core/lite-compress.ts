// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Lite output compressor — token-efficient encoding of STRUCTURED tool output.
 *
 * Why this exists: agents burn tokens re-reading large structured tool results
 * (JSON arrays, query rows, log dumps). Encoding them as TOON (Token-Oriented
 * Object Notation — a compact, schema-aware tabular form of JSON) cuts ~50-65%
 * of the tokens on uniform arrays at ZERO comprehension cost. An A/B test on
 * claude-sonnet-4-6 and claude-haiku-4-5 found identical retrieval accuracy
 * reading TOON vs JSON (95.8%/83.3% on both encodings, identical misses).
 *
 * This is OUTPUT-ONLY. It never touches stored memory content or the write
 * path. It is intentionally narrow and safe:
 *   - Structured data (parseable JSON object/array)  -> TOON, IF it round-trips
 *   - Prose / non-JSON                               -> passthrough untouched
 *   - TOON that would lose fidelity or barely save   -> plain JSON fallback
 *
 * Safety: TOON (like CSV/YAML) can type-coerce ambiguous bare scalars
 * (the string "123" can decode back as the number 123). So every encode is
 * SELF-VERIFIED (encode -> decode -> deep-equal) and we only emit TOON when it
 * reproduces the input exactly. Originals are stashed so the agent can retrieve
 * the verbatim source via a CCR-lite handle if it ever needs it.
 *
 * No ML, no network, no I/O — a pure in-process structural transform.
 */
import { encode, decode } from '@toon-format/toon';

export interface CompressResult {
  /** The text to put in the model's context. */
  text: string;
  /** 'toon' when compressed, 'json'/'passthrough' when not. */
  format: 'toon' | 'json' | 'passthrough';
  /** Retrieval handle for the verbatim original, or null when unchanged. */
  ref: string | null;
  charsBefore: number;
  charsAfter: number;
  /** Approx fraction of characters saved (0..1); a rough proxy for token savings. */
  ratio: number;
}

export interface CompressOptions {
  /** Don't bother emitting TOON unless it saves at least this many chars. Default 40. */
  minSavingChars?: number;
}

// ── CCR-lite: stash verbatim originals, hand back a retrieval id ────────────
// Bounded FIFO so a long-lived MCP process can't leak memory.
const MAX_STORE = 512;
const _store = new Map<string, string>();
let _seq = 0;

function stash(original: string): string {
  const id = `awm_orig_${++_seq}`;
  _store.set(id, original);
  if (_store.size > MAX_STORE) {
    const oldest = _store.keys().next().value;
    if (oldest !== undefined) _store.delete(oldest);
  }
  return id;
}

/** Retrieve the verbatim original for a CCR-lite ref, or undefined if evicted. */
export function retrieveOriginal(ref: string): string | undefined {
  return _store.get(ref);
}

/** True if TOON encode->decode reproduces `obj` exactly (no scalar coercion drift). */
function roundTrips(obj: unknown, toon: string): boolean {
  try {
    return JSON.stringify(decode(toon)) === JSON.stringify(obj);
  } catch {
    return false;
  }
}

/**
 * Compress a structured tool output for model consumption.
 *
 * @param value Either a JS object/array, or a string (JSON is parsed; anything
 *              that isn't valid JSON is treated as prose and passed through).
 */
export function liteCompress(value: unknown, options: CompressOptions = {}): CompressResult {
  const minSaving = options.minSavingChars ?? 40;

  let obj: unknown;
  let jsonText: string;

  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      // Not JSON — prose. Leave it alone; that's granularity:compact's job.
      return { text: value, format: 'passthrough', ref: null,
               charsBefore: value.length, charsAfter: value.length, ratio: 0 };
    }
    jsonText = value;
  } else {
    obj = value;
    jsonText = JSON.stringify(obj, null, 2);
  }

  // Only structured shapes benefit; a bare scalar gains nothing.
  if (obj === null || typeof obj !== 'object') {
    return { text: jsonText, format: 'json', ref: null,
             charsBefore: jsonText.length, charsAfter: jsonText.length, ratio: 0 };
  }

  let toon: string;
  try {
    toon = encode(obj);
  } catch {
    return { text: jsonText, format: 'json', ref: null,
             charsBefore: jsonText.length, charsAfter: jsonText.length, ratio: 0 };
  }

  const before = jsonText.length;
  const after = toon.length;

  // Reject if it doesn't round-trip exactly, or the saving isn't worth it.
  if (!roundTrips(obj, toon) || before - after < minSaving) {
    return { text: jsonText, format: 'json', ref: null,
             charsBefore: before, charsAfter: before, ratio: 0 };
  }

  const ref = stash(jsonText);
  return { text: toon, format: 'toon', ref,
           charsBefore: before, charsAfter: after, ratio: 1 - after / before };
}
