# Feature: Output Compression (TOON)

## When You'd Use It

When a tool returns a large **structured** result (a JSON array of records, query
rows, log lines, an API response) that you need to keep in the context window,
compress it first. Encoding it as **TOON** (Token-Oriented Object Notation — a
compact, schema-aware tabular form of JSON) removes the repeated keys and
punctuation that dominate JSON, cutting **~50-65% of the tokens** on uniform
arrays.

This is **output-only**. It never touches stored memory content or the
write/recall paths — it is a transform you apply to *tool output* before it
enters context. It is orthogonal to AWM's main token savings, which come from
retrieval *precision* (pointing at the right memory instead of scanning).

## How It Works

### Steps (Happy Path)

1. Call MCP `compress_output` with the tool output (`output`, a JSON string or
   any text).
2. The router parses it. If it is structured JSON, it is encoded to TOON.
3. **Fidelity guard:** the TOON is decoded and compared to the input
   (`encode → decode → deep-equal`). TOON is emitted **only if it reproduces
   the input exactly** and clears a minimum-saving threshold.
4. On success you get the TOON text plus a `ref` (e.g. `awm_orig_12`) and a
   header line telling the model it is reading compact lossless data.
5. The verbatim original is stashed; call `retrieve_original(ref)` any time you
   need the exact source back (e.g. to pass it unchanged to another tool).

### Example

JSON in (4 records, 2-space indent) → TOON out:

```
[4]{id,service,region,status,latency_ms}:
  1001,auth,us-east,ok,42
  1002,billing,eu-west,FATAL,318
  1003,search,us-west,ok,77
  1004,media,ap-south,WARN,201
```

### What Gets Persisted

- **Nothing in the database.** Compression is a pure in-process transform.
- Verbatim originals live in a bounded in-memory FIFO (most-recent ~512), keyed
  by `ref`, for the lifetime of the MCP server process. A `ref` may expire once
  evicted — `retrieve_original` returns an error if so.

### Requirements

- `output` is required (string).
- Benefits only structured shapes; bare scalars and prose are returned unchanged.

### Limits

- **Prose / non-JSON is passed through untouched** — structural compression does
  not help free text; use recall `granularity: 'compact'` for memory prose.
- TOON (like CSV/YAML) can type-coerce ambiguous bare scalars (`"00123"` could
  decode as the number `123`). The fidelity guard catches this and falls back to
  plain JSON, so output is never silently corrupted.
- TOON is positional — for very wide/long tables the model maps values to columns
  by order. The `[N]` length and `{cols}` header let it self-check; validated at
  no accuracy cost on typical record sets (see below).
- No ML, no network — fast (single-digit ms).

### Accuracy (validated)

An A/B test fed the same 60-row dataset + 24 retrieval questions to
`claude-sonnet-4-6` and `claude-haiku-4-5` as JSON vs TOON. Both models scored
**identically** on the two encodings (95.8% / 83.3%), missing the *same*
questions — confirming the encoding is invisible to comprehension while saving
~67% of the tokens. Models read TOON at least as accurately as JSON.

## Code References

- Module: `src/core/lite-compress.ts` — `liteCompress()`, `retrieveOriginal()`
- MCP tools: `src/mcp.ts` — `compress_output`, `retrieve_original`
- Encoding library: `@toon-format/toon` (`encode` / `decode`)
- Tests: `tests/core/lite-compress.test.ts`
