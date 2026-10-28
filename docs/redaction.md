# Write-time redaction

A memory store is read back into every later session. A credential that lands in one write is
replayed into every transcript that recalls it, and into anything exported from the store.
So AWM masks secrets **before** a write is stored, indexed, embedded or logged.

This is item S1 of [`decision-gap-closure-2026-10-10.md`](decision-gap-closure-2026-10-10.md).

**Want AWM to keep the secret instead of forgetting it?** Turn on the vault (`AWM_VAULT=on`):
the value is sealed and the memory keeps a handle it can use. See [`vault.md`](vault.md).

## The policy

| Tier | What | Default | Switch |
|---|---|---|---|
| secret | Provider keys with a known shape, PEM private keys, JWTs, passwords in connection URLs, `Bearer` tokens, labelled values (`password=`, `API_KEY:`, `"client_secret": …`, `\| Password \| … \|`, `` password `…` ``) | **masked** | `AWM_REDACT=mask\|report\|off` |
| pii | US SSNs, payment cards | **masked** | `AWM_REDACT` |
| pii | Email addresses, phone numbers | **reported only** | `AWM_REDACT_PII=report\|mask\|off` |
| — | Names | not detected | — |

**Why secrets are masked, not stored in a side field.** The plan's first instinct was "redact
into a side field, never destroy the original". For credentials that defeats the purpose: the
value would still be at rest in the store. A secret has no legitimate reason to be remembered
verbatim. The useful memory is the pointer ("the Stripe key is in `CIDEAS_STRIPE_SECRET_KEY`"),
and that survives masking because labels are kept. The false-positive risk the side field was
meant to cover is handled instead by precision-first rules, a labelled fixture in CI, a
real-store scan, and a write response that says exactly what was masked.

**Why email and phone are only reported.** In a personal or team store, "the host contact is
jen@…" is often the whole point of the memory. Masking it by default would destroy the value
the store exists for. Operators who need it masked set `AWM_REDACT_PII=mask`.

**Why names are not detected.** Telling a person from a product, place or project needs a
model this layer does not have, and "Robert decided X" *is* the memory.

## What a mask looks like

`[REDACTED:stripe_key …0dWz]`: the rule name and, for long keys and cards, the last four
characters, so "which key was rotated" stays answerable. Labelled values keep their label:
`MEDICAL_ENCRYPTION_KEY=[REDACTED:labelled_secret]`. Redaction is idempotent, and masked text
never matches again.

`memory_write` says what happened:

```
Stored (active) "Stripe payout setup" [0.72]
🔒 Redacted before storing: stripe_key. Store a pointer (where the value lives) instead of the value itself.
```

## Where it runs

1. **`performWrite`** (`src/core/write-pipeline.ts`) redacts concept, content and tags first,
   so novelty matching and the embedding never see the value, and returns the findings.
2. **The store wrapper** (`src/storage/redacting-store.ts`), applied in `openStore()` to
   every backend, masks the nine methods that persist free text:
   - `createEngram`, `updateContent`, `updateTags`;
   - `saveCheckpoint`, `saveSessionCheckpoint`;
   - `logActivationEvent`, `logRetrievalFeedback`, `updateAutoCheckpointRecall`;
   - `createEpisode`.

   Paths that bypass the pipeline (HTTP batch writes, tasks, consolidation, retraction,
   recall-query logs) are covered without remembering to.
3. **`awm.log`** (`src/core/logger.ts`) masks every line.

## How it is measured

- **Labelled fixture:** `tests/core/redact-fixture.ts` holds positives and hard negatives
  (commit hashes, UUIDs, env-var names, placeholders, floats, Stripe's public test cards,
  file paths, code). `tests/core/redact.test.ts` turns it into per-rule false positives and
  false negatives, and any one fails CI.
- **End to end:** `tests/core/redact-store.test.ts` reads the SQLite file and WAL back after
  each kind of write and asserts the credential is gone. With `AWM_REDACT=off`, all six
  checks fail.
- **Real store:** `npx tsx scripts/redact-scan.ts [db]` scans read-only and prints per-rule
  counts.
  - `--samples N` adds masked context windows for false-positive review. Long letter-and-digit
    tokens in those windows are blanked too, so a credential the rules *missed* is not printed.
  - Review samples where seeing a secret would be acceptable anyway.

## Limits

- **Memories written before this release are not rewritten.** A backfill is its own decision
  (see the plan's risk table). The scan shows what one would change.
- **Shape-based only.** A credential with no recognisable prefix and no label (a bare random
  string in prose) is not caught. Rules are tuned for precision, because a false positive
  destroys content and a false negative is the status quo.
- **Embeddings of pre-release memories** were computed from the raw text.
