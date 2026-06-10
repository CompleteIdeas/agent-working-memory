// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for CLI adapters.
 *
 * Extracted from the original setup() in cli.ts — path resolution, secrets,
 * environment variables, MCP command building, and the AWM instruction snippet.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SetupContext } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the AWM package root (where src/ and dist/ live). */
export function resolvePackageRoot(): string {
  // __dirname is src/adapters/ at dev time, dist/adapters/ at build time
  return resolve(__dirname, '..', '..');
}

/** Resolve the database path — default to <packageRoot>/data/memory.db. */
export function resolveDbPath(packageRoot: string, explicit?: string | null): string {
  const dbPath = explicit ?? join(packageRoot, 'data', 'memory.db');
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  return dbPath;
}

/** Read or generate the hook secret token. */
export function resolveHookSecret(dbPath: string): string {
  const secretPath = join(dirname(dbPath), '.awm-hook-secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret + '\n');
  return secret;
}

/** Build environment variables for the MCP server process. */
export function buildEnvVars(
  dbPath: string,
  agentId: string,
  hookPort: string,
  hookSecret: string,
  isWindows: boolean,
): Record<string, string> {
  return {
    AWM_DB_PATH: isWindows ? dbPath.replace(/\\/g, '/') : dbPath,
    AWM_AGENT_ID: agentId,
    AWM_HOOK_PORT: hookPort,
    AWM_HOOK_SECRET: hookSecret,
  };
}

/**
 * Resolve the MCP server command + args.
 *
 * Prefers absolute path to dist/mcp.js (works from any cwd).
 * Falls back to npx tsx src/mcp.ts for dev mode.
 */
export function resolveMcpCommand(ctx: SetupContext): {
  command: string;
  args: string[];
} {
  if (ctx.hasDist) {
    return {
      command: 'node',
      args: [ctx.mcpDist.replace(/\\/g, '/')],
    };
  }
  // Dev fallback
  if (ctx.isWindows) {
    return {
      command: 'cmd',
      args: ['/c', 'npx', 'tsx', ctx.mcpScript.replace(/\\/g, '/')],
    };
  }
  return {
    command: 'npx',
    args: ['tsx', ctx.mcpScript],
  };
}

/** Build a full SetupContext from parsed CLI flags. */
export function buildSetupContext(opts: {
  agentId?: string;
  dbPath?: string | null;
  isGlobal: boolean;
  hookPort: string;
}): SetupContext {
  const cwd = process.cwd();
  const projectName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const packageRoot = resolvePackageRoot();
  const mcpScript = join(packageRoot, 'src', 'mcp.ts');
  const mcpDist = join(packageRoot, 'dist', 'mcp.js');
  const hasDist = existsSync(mcpDist);
  const isWindows = process.platform === 'win32';

  const agentId = opts.agentId ?? (opts.isGlobal ? 'claude' : projectName);
  const dbPath = resolveDbPath(packageRoot, opts.dbPath);
  const hookSecret = resolveHookSecret(dbPath);
  const envVars = buildEnvVars(dbPath, agentId, opts.hookPort, hookSecret, isWindows);

  return {
    cwd,
    projectName,
    agentId,
    dbPath,
    packageRoot,
    mcpDist,
    mcpScript,
    hasDist,
    hookSecret,
    hookPort: opts.hookPort,
    isGlobal: opts.isGlobal,
    isWindows,
    envVars,
  };
}

/** Home directory. */
export function homedir(): string {
  return osHomedir();
}

// ─── Instruction content ────────────────────────────────

/**
 * Core AWM instruction snippet — shared across all adapters.
 * Each adapter wraps this in the appropriate file format.
 */
/**
 * Upsert the AWM section into an instruction file (CLAUDE.md, AGENTS.md, .cursorrules).
 *
 * Behavior:
 *   - File doesn't exist  -> create with title + AWM_INSTRUCTION_CONTENT
 *   - Section absent      -> append
 *   - Section present + identical  -> skip
 *   - Section present + stale      -> REPLACE in place, preserve content above/below
 *
 * Section is bounded by `## Memory (AWM)` (with optional trailing modifier) at the
 * start, and the next `## ` heading or EOF at the end.
 *
 * Returns a short human-readable status string for the setup command output.
 */
export function upsertAwmSection(
  filePath: string,
  newContent: string,
  options: { titleIfNew?: string; suffix?: string } = {},
): string {
  const fname = basename(filePath);
  const suffix = options.suffix ?? '';

  if (!existsSync(filePath)) {
    const title = options.titleIfNew ?? `# ${basename(dirname(filePath))}`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${title}\n\n${newContent}${suffix}`);
    return `${fname}: created with AWM workflow section`;
  }

  const existing = readFileSync(filePath, 'utf-8');

  // Find section bounds: `## Memory (AWM)` (possibly with ` — MANDATORY` etc.) until next `## ` or EOF
  const startRegex = /^## Memory \(AWM\)[^\n]*$/m;
  const startMatch = startRegex.exec(existing);

  if (!startMatch) {
    // Section not present — append
    writeFileSync(filePath, existing.trimEnd() + '\n\n' + newContent + suffix);
    return `${fname}: appended AWM workflow section`;
  }

  // Find end: next `## ` heading after the section start, or EOF
  const afterStart = startMatch.index + startMatch[0].length;
  const nextHeadingRegex = /^## (?!Memory \(AWM\))/m;
  nextHeadingRegex.lastIndex = afterStart;
  const tail = existing.slice(afterStart);
  const nextMatch = nextHeadingRegex.exec(tail);
  const sectionEnd = nextMatch ? afterStart + nextMatch.index : existing.length;

  const currentSection = existing.slice(startMatch.index, sectionEnd).trimEnd();
  const desiredSection = (newContent + suffix).trimEnd();

  if (currentSection === desiredSection) {
    return `${fname}: AWM section already up-to-date (skipped)`;
  }

  const before = existing.slice(0, startMatch.index).trimEnd();
  const after = existing.slice(sectionEnd).replace(/^\s*\n/, '');
  const rebuilt =
    (before ? before + '\n\n' : '') +
    desiredSection +
    (after ? '\n\n' + after : '\n');
  writeFileSync(filePath, rebuilt);
  return `${fname}: AWM section updated (preserved surrounding content)`;
}

export const AWM_INSTRUCTION_CONTENT = `
## Memory (AWM) — MANDATORY

**AWM is THE memory system.** Use it via the \`agent-working-memory\` MCP server
(preferred) or HTTP at \`http://127.0.0.1:8400\` (fallback). The file-based
auto-memory at \`~/.claude/projects/.../memory/*.md\` is a LEGACY bootstrap path —
**do not write new memories to it.** All persistent knowledge goes through AWM.

If MCP tools aren't loaded at session start, use ToolSearch with
\`select:mcp__agent-working-memory__memory_recall,mcp__agent-working-memory__memory_write\`
to load them. If the MCP server isn't responsive, restart with \`/mcp\` or use
the HTTP endpoints (\`POST /memory/write-batch\`, \`POST /memory/activate\`)
directly — but **DO NOT fall back to markdown files**. Files drift the moment
you write them; AWM stays current because every agent reads + writes the same store.

### Lifecycle (always do these, in this order)
1. **Session start**: call \`memory_restore\` to recover previous context.
2. **Starting a task**: call \`memory_task_begin\` (checkpoints + recalls relevant memories).
3. **During work**: call \`memory_recall\` BEFORE stating any fact, BEFORE searching
   the filesystem, BEFORE making architectural decisions. Recall is ~300ms — cheaper
   than one filesystem search.
4. **As you learn things**: call \`memory_write\` proactively. Don't batch.
5. **Finishing a task**: call \`memory_task_end\` with a summary.
6. **Auto-checkpoint** is handled by hooks (compaction, session-end, 15-min timer). No action needed.

### Write memory when:
- A project decision is made or changed
- A root cause is discovered after debugging
- A reusable implementation pattern is established
- A user preference, constraint, or requirement is clarified
- A prior assumption is found to be wrong
- A significant piece of work is completed

### Writing for recall (the highest-leverage section)
A memory's recall quality is set the moment you write it. AWM is fast at
finding what's findable — but if the write is shaped wrong, no retriever
can rescue it. Be slightly more verbose at the front than feels natural:
the first 1-2 sentences are what BM25, the embedding model, and concept
extraction all see most strongly.

- **Lead with the rule or fact.** Don't open with context or backstory.
  "Don't mock the database in integration tests." comes first; the reason
  comes second. Recall scans the head of the body, not the tail.
- **Pick the most specific topic.** Not \`auth\` — \`auth-magic-link-rate-limit\`.
  Topic is a hard filter at recall time. Generic topics hide the memory in
  a noisy bucket where it competes with everything else in the area.
- **Include 2+ retrievable identifiers.** File paths, function names, table
  columns, ticket IDs, exact error strings, the literal terms a future query
  will use. \`AccountingService.closePeriod()\` beats "the accounting code."
  \`tblMemberDetails.activation_date\` beats "the activation column."
  \`schema/072-period-close.sql\` beats "the migration."
- **Write in the vocabulary of the future question.** When you imagine asking
  this in three months, what nouns will you use? Use those nouns. Don't
  paraphrase the user's domain language into your own neutral summary.
- **Reserve canonical for stable invariants.** Decisions, requirements,
  hard facts, cross-agent shared context. Working class (default) is correct
  for findings, observations, and progress notes. The canonical floor is
  0.7 salience — overusing it pollutes the canonical layer and the floor
  loses meaning.
- **Include the why for feedback memories.** A rule without a reason can't
  be applied to edge cases. "Don't mock the database" is brittle. "Don't
  mock the database — last quarter mocked tests masked a broken migration"
  is portable to new situations.

### Tagging rules (REQUIRED — AWM's prefix-tag retrieval boost depends on these)

Every \`memory_write\` should pass these structured fields. AWM stores each as a
prefix-tag like \`proj=\`, \`topic=\`, \`intent=\`, etc. and uses them for BM25
and entity-bridge boosts at recall time.

| Field | Required? | Format | Example |
|---|---|---|---|
| \`project\` | **YES** | one short word matching the current project | \`"EquiHub"\`, \`"AWM"\`, \`"USEA-Agent"\` |
| \`topic\` | **YES** | one or more lowercase area words | \`"database-migration"\`, \`"benchmarks"\` |
| \`intent\` | **YES** | one of: \`decision\` / \`finding\` / \`todo\` / \`question\` / \`context\` | \`"finding"\` |
| \`confidence_level\` | **YES** | \`verified\` (tested) / \`observed\` (read in code) / \`assumed\` (reasoning) | \`"verified"\` |
| \`source\` | recommended | \`code-reading\` / \`debugging\` / \`discussion\` / \`research\` / \`testing\` / \`observation\` | \`"testing"\` |
| \`memory_class\` | when stable | \`canonical\` (source-of-truth, 0.7 floor, never staged) / \`working\` (default) / \`ephemeral\` | \`"canonical"\` |
| \`session_id\` | recommended | current conversation ID for entity-bridge boost | autogenerated |
| \`tags\` | when applicable | extra prefix-tags for IDs and dates | \`["ticket=18360", "date=2026-05-11"]\` |

**Always add identifier tags when present in the content:**
- \`ticket=<id>\` for Freshdesk tickets
- \`member=<id>\` for member IDs
- \`horse=<id>\` for horse_member_id
- \`usef=<id>\` for USEF lookups
- \`date=YYYY-MM-DD\` for temporal anchoring (ISO format)
- \`person=<Name>\` for stakeholder quotes / decisions
- \`version=<X.Y.Z>\` for release-specific findings

### Memory classes (controls how strictly the salience filter gates the write)
- \`memory_class: canonical\` — source-of-truth memories. Floor 0.7 salience, never staged.
  Use for: user-stated decisions, project requirements, verified architectural facts,
  cross-agent shared context. **In a hive (multi-agent) setup, always use \`canonical\`
  for writes that other agents must be able to recall** — the default \`working\` class
  may get filtered.
- \`memory_class: working\` (default) — observations and findings. Salience-gated.
- \`memory_class: ephemeral\` — short-lived context that should decay quickly.

### Salience auto-promotion (defense in depth)
The salience filter automatically promotes certain content patterns even if you forget
to set \`memory_class\` explicitly:
- **User feedback** — content starting with "Robert said…", "Katherine directed…",
  "Nancy decided…" etc. auto-promotes to canonical. So quoting the user verbatim
  always preserves the decision.
- **Verified operational records** — content with an action verb (Submitted, Finalized,
  Completed, Reconciled, Triaged, Posted, Resolved, Stamped, Pushed, Deployed, Migrated,
  Imported, Exported, Backfilled) plus 2+ concrete identifiers (ISO date \`YYYY-MM-DD\`,
  or contextual numeric IDs like "event 18969", "ticket #18330", "USEF 341980") gets
  a 0.45 salience floor. So batch summaries with real IDs survive even when topic
  terms repeat.

If neither pattern applies and you want a memory to definitely survive, set
\`memory_class: canonical\` explicitly. Don't rely on auto-promotion for important writes.

### Recall memory when:
- **BEFORE stating ANY fact about how a system works** — recall first; if AWM doesn't
  have it, read the code. Never guess and present it as fact.
- **BEFORE searching the filesystem** — recall first; AWM is faster and has cross-session
  knowledge that file search doesn't.
- Starting work on a new task or subsystem
- Re-entering code you haven't touched recently
- After a failed attempt — check if there's prior knowledge
- Before refactoring or making architectural changes
- When a topic comes up that you might have prior context on

Recall is fast (~300ms typical). Use it freely.

### Recall strategy (when one query isn't enough)
AWM's adaptive retrieval handles most query variations natively — synonym
expansion, multi-channel scoring, embedding + BM25 + reranker agreement.
A single recall is usually enough.

When it isn't:
- **If the first recall returns nothing or returns the wrong things, reformulate.**
  Try a second query with different phrasing — synonyms, more specific nouns,
  the exact identifier from the code rather than the conceptual name. Two or
  three recalls cost less than one filesystem search.
- **Use the words a domain expert would use, not generic English.** "Period
  close lock" not "accounting feature"; "magic link rate limit" not "auth issue."
- **For broad exploration, pass \`mode: "exploratory"\`** — wider candidate
  pool, lower precision floor. For specific lookups, leave mode unset (auto).
- **Don't ensemble more than 3 reformulations.** If three different phrasings
  return nothing, the memory probably isn't there — read the code instead of
  burning more recalls.

### Recall tuning (0.8.x — opt-in parameters for higher-quality recall)
Default \`memory_recall\` is tuned for the common case. The 0.8.x recall pipeline
exposes four opt-in parameters that change the cost/quality tradeoff. Use them
when the default doesn't match what you actually need.

- **\`granularity: 'compact'\`** — every result carries a 200-char \`summary\`
  field with a query-aware snippet (the densest window of query terms in the
  content). Use this when you expect to scan 5+ results to find one — saves
  ~70% of recall output tokens. The full content stays available in
  \`engram.content\` if you want to drill into a specific result.
- **\`granularity: 'auto'\`** — confidence-adaptive. If the top result is a clear
  winner, it gets a longer summary while the rest are compact. If confidence
  is uniform across results, everything is compact. Use when you don't know
  in advance whether one result will dominate.
- **\`require_confidence: 0.10 | 0.25 | 0.40\`** — opt-in abstention. AWM
  returns \`[]\` instead of low-confidence noise. Use when you're about to ACT
  on the recalled fact (grounding a decision, citing the memory verbatim,
  contradicting a prior assumption). Thresholds: \`0.10\` strict — only abstain
  on garbage; \`0.25\` balanced; \`0.40\` aggressive — prefer "I don't know"
  over "best of bad." When abstention fires (empty result), treat it as a
  signal — either the memory genuinely isn't there (read the code) or your
  query missed (reformulate). Don't retry without the threshold.
- **\`workspace: "<name>"\`** — hive-mode recall across all agents in the
  workspace. Use when other agents may have written canonical knowledge you
  need. Default is agent-scoped (your own memories only). Can also be set
  globally via the \`AWM_WORKSPACE\` env var.

### Keep memory fresh
- After recalling a memory, if you observe the real state is different → call
  \`memory_supersede\` immediately with the corrected version.
- After using a recalled memory: call \`memory_feedback\` (useful/not-useful) so the
  activation engine learns what's valuable.
- If you discover a memory is factually wrong: \`memory_retract\` to remove it.
- **If you bypass AWM (file-memory, in-context notes, "I'll just remember"), the memory
  drifts out of date. The system relies on you to keep it current. This is the #1
  failure mode.**

### Content fade — write-and-forget is safe (0.8.x)
Un-recalled engrams gradually fade their content while preserving cue pathways
(concept + tags + embedding stay intact). This is Paper 1 — storage
degradation. Practical implications:

- **Don't manually purge memories** to "save space." The system already
  compresses unused content. Old memories stay findable via cue match even
  when their body has decayed.
- **Don't over-pin with \`memory_class: canonical\`** to fight fade. Canonical
  only changes salience gating at write time, not fade behavior. Fade
  affects un-recalled engrams of any class.
- **Recall keeps content alive.** Every recall touches the engram and resets
  its fade clock. Frequently-recalled memories stay full-fidelity automatically.
- **Supersede is the right tool for stale facts.** When you observe a memory
  is outdated, call \`memory_supersede\` — the new version inherits the old
  one's coherent associations (counter-narrative replacement, 0.8.x) so cue
  pathways carry forward to the replacement.

### Example — good vs bad memory_write

**BAD** (no prefix tags, vague concept, can't be recalled by future queries):
\`\`\`
memory_write(
  concept="found a bug",
  content="The thing I was looking at was broken so I fixed it."
)
\`\`\`

**GOOD** (rich identifiers, structured metadata, prefix tags):
\`\`\`
memory_write(
  concept="EquiHub period-close BLOCKED check missing server-side",
  content="apps/web/app/(accounting)/accounting/period-close/page.tsx had client-only BLOCKED enforcement. Fixed by adding server-side check in AccountingService.closePeriod() per schema/072-period-close.sql. Without server-side check a malicious request could bypass via direct API call.",
  project="EquiHub",
  topic="accounting",
  intent="finding",
  confidence_level="verified",
  source="debugging",
  memory_class="canonical",
  tags=["ticket=18360", "person=Robert", "date=2026-05-11", "topic=period-close", "topic=security"]
)
\`\`\`

### Also:
- To track work items: memory_task_add, memory_task_update, memory_task_list, memory_task_next
- AWM is shared across all agents in real time. When any agent writes or supersedes a
  memory, every other agent can recall it immediately.

### Output compression (token efficiency, output-only)
When a tool returns a LARGE STRUCTURED result you need to keep in context — a JSON
array of records, query rows, a log dump, an API response — pass it through
\`compress_output\` first. It re-encodes the data as TOON (a compact, lossless,
schema-aware tabular form of JSON), cutting ~50-65% of the tokens at no
comprehension cost. This is output-only: it never changes the data or your memories.
- Use it on big STRUCTURED outputs, not on prose. Prose is returned unchanged —
  for trimming memory prose, use recall \`granularity: 'compact'\` instead.
- It returns a \`ref\`; call \`retrieve_original(ref)\` if you later need the exact
  verbatim source (e.g. to hand it to another tool unchanged).
- Don't bother for small outputs — it only compresses when the saving is worthwhile
  and falls back to plain JSON if TOON wouldn't reproduce the data exactly.

### Backend (SQLite vs PGlite, 0.8.x)
AWM ships two storage backends. The installer picks SQLite by default; both
are functionally equivalent for cognitive workloads, but differ in operational
guarantees:

- **SQLite** (default) — embedded, **multi-process safe** via WAL mode. Best
  for single-machine setups and MCP scenarios where multiple Claude Code
  sessions may open the same database concurrently.
- **PGlite** — embedded Postgres (WASM) with pgvector. **Single-process only**
  — two MCP processes against the same \`memory-pglite/\` directory will
  abort the second. Pick via \`AWM_STORE_BACKEND=pglite\` and
  \`AWM_DB_PATH=path/to/memory-pglite\`.
- **Auto-detect** — if \`AWM_DB_PATH\` points to a directory that already
  exists, AWM detects PGlite; a file → SQLite. No explicit
  \`AWM_STORE_BACKEND\` needed when an existing DB is present.

For the comparison table (recall quality parity, BM25 vs \`ts_rank_cd\`,
multi-process guarantees), see \`docs/pglite-feature-parity.md\`.

### Diagnostics / escape hatches (env vars, only if you know why)
The 0.7.6→0.7.14 work cut recall latency from 11s to ~300ms. The 0.8.x work
added the write-path rewrite (per-write 300+ ms → under 10ms) and PGlite
parity tuning. Each optimization is gated by an env-var so it can be disabled
for A/B testing if a regression appears in your workload:

Recall pipeline (0.7.x):
- \`AWM_DISABLE_POOL_FILTER=1\` — disables the candidate pool reduction
  pre-filter in recall. Reverts to scoring all active candidates.
- \`AWM_DISABLE_SLIM_CACHE=1\` — disables the in-memory slim cache.
  Reverts to per-recall SQL fetch + Buffer→Float32Array conversion.
- \`AWM_DISABLE_RERANK_SKIP=1\` — disables the cross-encoder skip on
  clear-winner queries. Forces every recall through the reranker.
- \`AWM_DISABLE_EXPANSION_CACHE=1\` — disables the query expansion skip
  heuristic + LRU cache. Forces every recall through flan-t5-small.

Write pipeline + lifecycle (0.8.x):
- \`AWM_REINFORCE_MAX_CONTENT_LEN=1500\` — max chars an engram's content
  can grow to via merge-on-reinforce (drop-oldest on overflow). Higher =
  preserves more reinforced detail; lower = leaner recall output.
- \`AWM_REINFORCE_MERGE_CONTENT=0\` — disable content merge on reinforce.
  Reverts to pre-0.8.5 behavior (discard new content, only bump confidence).
- \`AWM_NOVELTY_EMBED=0\` — disable the cosine channel in novelty
  computation. BM25-only fallback. Reverts to pre-0.8.5 novelty.
- \`AWM_GRANULARITY_COMPACT_LEN=200\` — char budget for query-aware snippet
  in \`granularity: 'compact'\` mode.
- \`AWM_GRANULARITY_FULL_LEN=1000\` — char budget for the top result in
  \`granularity: 'auto'\` mode when there's a clear winner.

PGlite backend (0.8.x):
- \`AWM_PGLITE_BM25_M=1\` — multiplier on PGlite \`ts_rank_cd\` to calibrate
  against SQLite FTS5 BM25 distribution. M=1 (default) is passthrough;
  higher M boosts PGlite scores at the cost of recall-ranking precision
  (see CHANGELOG 0.8.5 follow-up).
- \`AWM_IVFFLAT_PROBES=5\` — pgvector ivfflat probes per query. Higher =
  more accurate, slower.

In production, leave these all unset. Use only when diagnosing a suspected
recall-quality regression.
`.trimStart();
