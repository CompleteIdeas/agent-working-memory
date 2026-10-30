# How-To Recipes

## 1. Store a high-importance memory

Set `eventType: "decision"` or `"causal"` with high `surprise` and `causalDepth` to ensure the memory lands in `active` (not staging or discarded).

```bash
curl -X POST http://localhost:8400/memory/write \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "concept": "Database migration strategy",
    "content": "Decided to use Prisma migrate instead of raw SQL files because it handles rollbacks and generates typed client automatically",
    "tags": ["database", "prisma", "decision"],
    "eventType": "decision",
    "surprise": 0.4,
    "decisionMade": true,
    "causalDepth": 0.7,
    "resolutionEffort": 0.5
  }'
```

See [Salience Scoring Formula](reference.md#salience-scoring-formula) for how these values determine disposition.

## 2. Recall memories for a current task

Describe what you're working on in natural language. The activation pipeline handles the rest.

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "Setting up database migrations for a new service",
    "limit": 5,
    "includeStaging": false
  }'
```

## 3. Recall with maximum quality (reranker + expansion)

Both are on by default, but you can explicitly control them:

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "error handling patterns",
    "useReranker": true,
    "useExpansion": true,
    "limit": 10
  }'
```

## 4. Fast recall without ML overhead

Disable the reranker and query expander for faster responses (~10ms vs ~200ms):

```bash
curl -X POST http://localhost:8400/memory/activate \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "context": "error handling patterns",
    "useReranker": false,
    "useExpansion": false
  }'
```

## 5. Correct a wrong memory

```bash
curl -X POST http://localhost:8400/memory/retract \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "targetEngramId": "abc-123",
    "reason": "The port number was wrong",
    "counterContent": "The service runs on port 3000, not 8080"
  }'
```

This marks the original as retracted, creates a correction memory, and reduces confidence in associated memories.

## 6. Give feedback on a recalled memory

After using a memory from activation results, report whether it was helpful:

```bash
curl -X POST http://localhost:8400/memory/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "engramId": "abc-123",
    "useful": true,
    "context": "Applied the migration strategy to the new service"
  }'
```

## 7. Search memories deterministically

Unlike activation (cognitive/associative), search is a direct SQL query:

```bash
curl -X POST http://localhost:8400/memory/search \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "tags": ["database"],
    "stage": "active",
    "limit": 20
  }'
```

## 8. Check memory health

```bash
curl http://localhost:8400/agent/my-agent/stats
curl http://localhost:8400/agent/my-agent/metrics?window=24
```

Healthy indicators:

- Average confidence between 0.3-0.8
- Retraction rate < 5%
- Edge utility rate > 50%
- P95 latency < 100ms

## 9. Run capacity enforcement manually

```bash
curl -X POST http://localhost:8400/system/evict \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "my-agent" }'
```

## 10. Decay unused associations

Run periodically (e.g., daily) to clean up stale edges:

```bash
curl -X POST http://localhost:8400/system/decay \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "my-agent", "halfLifeDays": 7 }'
```

## 11. Isolate memories per project

Use different `agentId` values per project. Memories are fully isolated by agent:

```bash
# Project A memories
curl -X POST http://localhost:8400/memory/write \
  -d '{ "agentId": "project-a", "concept": "...", "content": "..." }'

# Project B memories (completely separate)
curl -X POST http://localhost:8400/memory/write \
  -d '{ "agentId": "project-b", "concept": "...", "content": "..." }'
```

## 12. Run the full test suite

```bash
# Start server
npx tsx src/index.ts &

# Unit tests (no server needed)
npx vitest run

# Self-test (scored report, 31 dimensions)
npm run test:self

# Workday eval (14 coding recall challenges)
npm run test:workday

# LOCOMO benchmark (199 QA pairs, industry standard)
npm run test:locomo
```

## 13. Keep secrets out of memory

Nothing to turn on. Write-time redaction is on by default: provider keys, private keys, JWTs,
connection-URL passwords, `Bearer` tokens and labelled values (`password=`, `API_KEY:`) are
masked before the write is stored, indexed, embedded or logged. The write response says what was
masked:

```
🔒 Redacted before storing: stripe_key. Store a pointer (where the value lives) instead of the value itself.
```

Write the pointer, not the value: "the Stripe key is in `STRIPE_SECRET_KEY` on Railway". The label
survives masking, so the memory stays findable.

- Email addresses and phone numbers are reported, not masked. Set `AWM_REDACT_PII=mask` to mask
  them too.
- `AWM_REDACT=report` reports secrets without masking them; `off` disables redaction.
- Memories written before redaction shipped are not rewritten. To see what an existing store
  holds, scan it read-only from a repository checkout:

```bash
npx tsx scripts/redact-scan.ts ~/.awm/memory.db
```

Detection is shape-based: a bare random string with no label is not caught. See
[redaction.md](redaction.md).

## 14. Let AWM keep a secret it can use

Masking forgets the value. If the agent needs to use a credential later (to deploy, say), turn on
the vault instead. Set `AWM_VAULT=on` in the AWM server's environment and restart the session.

A secret in a write is then sealed in `vault.db`, with the key in the OS credential store, and the
memory keeps a handle such as `RAILWAY_API_TOKEN=[VAULT:labelled_secret #3f9c2e71b0d4]`. Recall still finds the
memory and knows what the secret is for, without showing it.

Allow the commands the value may be used with, then the agent can run them:

```bash
awm vault allow 3f9c2e71b0d4 "railway up"
awm vault run 3f9c2e71b0d4 --env RAILWAY_API_TOKEN -- railway up --service my-app --ci
```

The value goes into that one command's environment, and the command's output has it replaced by
the handle. Chained or redirected commands are never allowed by prefix. Anything not allowed is
refused when there is no terminal, which is always the case for an agent.

To seal the secrets already in a store, stop AWM sessions and run `awm vault migrate` (dry run),
then `awm vault migrate --apply`. The backup it makes holds every secret in plaintext; delete it
once the store checks out.

`awm vault list`, `status`, `forget` and `reveal` (interactive terminal only) cover the rest. See
[vault.md](vault.md).

## 15. Make AWM say when it doesn't know

By default AWM returns the closest matches even when the store does not hold the answer. To have
it say so, set `AWM_ABSTAIN_GATE=calibrated` in the AWM server's environment, then fit the gate:

```bash
awm calibrate                    # the default agent
awm calibrate --agent personal   # another pool
```

The gate learns a noise floor from the store itself, with no labels, and is refitted after
consolidation when it goes stale (`AWM_ABSTAIN_RECALIBRATE_DAYS`, default 7, or the store has
grown by 20%). Each recall then lands in one of three bands:

- **Answer:** results as usual.
- **Low signal:** results, flagged `⚠ LOW SIGNAL`. Verify before relying on them.
- **Withhold:** no results, and the reply says `RECALL ABSTAINED — this store most likely does not
  hold this`.

If you have reason to think the fact is stored, pass `require_confidence: 0` on `memory_recall` to
open the gate for that call.

Measured on one real store with keyword-style questions, it withheld 66 of 73 questions about
facts never stored and none of 694 correct answers. See [abstention.md](abstention.md).
