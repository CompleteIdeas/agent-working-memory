// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for CLI adapters.
 *
 * Extracted from the original setup() in cli.ts — path resolution, secrets,
 * environment variables, MCP command building, and the AWM instruction snippet.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SetupContext } from './types.js';
import { deriveAgentFromDir } from '../core/agent-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the AWM package root (where src/ and dist/ live). */
export function resolvePackageRoot(): string {
  // __dirname is src/adapters/ at dev time, dist/adapters/ at build time
  return resolve(__dirname, '..', '..');
}

/** A store inside the installed package is destroyed by the next `npm install -g`. */
export function isInsidePackage(dbPath: string): boolean {
  return /[\\/]node_modules[\\/]/.test(dbPath);
}

/**
 * Resolve the database path — default `~/.awm/memory.db`.
 *
 * It used to default to `<packageRoot>/data/memory.db`, i.e. INSIDE the installed npm
 * package. That is a data-loss bug, not an untidiness: `npm install -g
 * agent-working-memory@latest` renames the package directory aside and deletes it, so an
 * upgrade takes every memory with it, and `npm uninstall -g` does the same silently.
 *
 * Reported from a real machine: the upgrade failed with EBUSY because a running AWM
 * process held memory.db open. That failure was the LUCKY outcome — with Claude Code
 * closed, the upgrade would have succeeded and the store would have gone with it.
 *
 * `~/.awm/memory.db` is what the plugin and Desktop launchers already used, so until now
 * the same product had two different defaults depending on how it was installed.
 */
export function resolveDbPath(packageRoot: string, explicit?: string | null): string {
  const dbPath = explicit ?? join(homedir(), '.awm', 'memory.db');
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

/**
 * Retrieval settings `awm setup` turns on for a new install (0.14.6).
 *
 * All three ship default-off in the engine so an existing process never changes
 * behaviour on upgrade, but the README has recommended them together since 0.14.0:
 * second-stage rerank by the cross-encoder's own score, a 400-char rerank window
 * on the densest query-term region (25% → 87.5% on long memories), and tags in the
 * rerank passage (+7.4pp). A value the user already has in their config wins.
 */
export const RECOMMENDED_ENV: Readonly<Record<string, string>> = {
  AWM_RERANK2: '1',
  AWM_RERANK_WINDOW: 'query',
  AWM_RERANK_TAGS: '1',
};

/** Keys `awm setup` owns outright; everything else in an existing env block is the user's. */
export const OWNED_ENV_KEYS = ['AWM_DB_PATH', 'AWM_AGENT_ID', 'AWM_HOOK_PORT', 'AWM_HOOK_PORT_RANGE', 'AWM_HOOK_SECRET', 'AWM_CLIENT'] as const;

/**
 * Build environment variables for the MCP server process.
 *
 * Layering, lowest to highest: recommended defaults → whatever the user's current
 * entry already carries (rerank flags they tuned, AWM_WORKSPACE, backend choice…)
 * → the keys setup owns. Before 0.14.6 the entry was replaced wholesale, which
 * dropped hand-set flags on every re-run.
 */
export function buildEnvVars(
  dbPath: string,
  agentId: string,
  hookPort: string,
  hookSecret: string,
  isWindows: boolean,
  opts: { hookPortRange?: string; existing?: Record<string, string> | null; client?: string } = {},
): Record<string, string> {
  const owned: Record<string, string> = {
    AWM_DB_PATH: isWindows ? dbPath.split('\\').join('/') : dbPath,
    AWM_AGENT_ID: agentId,
    AWM_HOOK_PORT: hookPort,
    AWM_HOOK_SECRET: hookSecret,
  };
  if (opts.hookPortRange && opts.hookPortRange !== '10') owned.AWM_HOOK_PORT_RANGE = opts.hookPortRange;
  return { ...RECOMMENDED_ENV, ...(opts.existing ?? {}), ...owned };
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

/**
 * Build a full SetupContext from parsed CLI flags.
 *
 * Precedence for every owned value: an explicit flag → the value in the entry a
 * previous `awm setup` wrote (`existingEnv`) → the default. So re-running setup to
 * pick up new hooks or guidance never repoints the database, renames the agent or
 * moves the sidecar port underneath a working install.
 *
 * Global default agent id is `work` (was `claude` before 0.14.6): it matches what
 * the server itself resolves to when AWM_AGENT_ID is unset (see core/agent-id.ts),
 * so a config with and without the key name the same pool.
 */
export function buildSetupContext(opts: {
  agentId?: string;
  dbPath?: string | null;
  isGlobal: boolean;
  hookPort?: string;
  hookPortRange?: string;
  installPrime?: boolean;
  /** `--force`: replace a legacy unmarked instruction section rather than refusing. */
  forceInstructions?: boolean;
  existingEnv?: Record<string, string> | null;
  /** Which surface this install is for — stamped onto every write as a `client=` tag. */
  client?: string;
}): SetupContext {
  const cwd = process.cwd();
  const projectName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const packageRoot = resolvePackageRoot();
  const mcpScript = join(packageRoot, 'src', 'mcp.ts');
  const mcpDist = join(packageRoot, 'dist', 'mcp.js');
  const hasDist = existsSync(mcpDist);
  const isWindows = process.platform === 'win32';
  const existing = opts.existingEnv ?? null;

  const agentId = opts.agentId
    ?? existing?.AWM_AGENT_ID
    ?? (opts.isGlobal ? deriveAgentFromDir('') : projectName);
  // An existing AWM_DB_PATH is normally preserved — that is what makes re-running setup an
  // upgrade rather than a reset. There is one exception: a store INSIDE the installed
  // package is deleted by the next `npm install -g`, so preserving it would be preserving a
  // data-loss bug. Move it to the safe default, copying the file rather than pointing at an
  // empty one, and leave the original where it is so nothing is destroyed by the rescue.
  const requested = opts.dbPath ?? existing?.AWM_DB_PATH ?? null;
  let dbPath: string;
  let rescuedFrom: string | null = null;
  if (!opts.dbPath && requested && isInsidePackage(requested)) {
    const safe = resolveDbPath(packageRoot, null);
    if (existsSync(requested) && !existsSync(safe)) {
      mkdirSync(dirname(safe), { recursive: true });
      copyFileSync(requested, safe);
      for (const side of ['-wal', '-shm']) {
        if (existsSync(requested + side)) copyFileSync(requested + side, safe + side);
      }
      rescuedFrom = requested;
    }
    dbPath = safe;
  } else {
    dbPath = resolveDbPath(packageRoot, requested);
  }
  const hookPort = opts.hookPort ?? existing?.AWM_HOOK_PORT ?? '8401';
  const hookPortRange = opts.hookPortRange ?? existing?.AWM_HOOK_PORT_RANGE ?? '10';
  const hookSecret = resolveHookSecret(dbPath);
  const envVars = buildEnvVars(dbPath, agentId, hookPort, hookSecret, isWindows, { hookPortRange, existing, client: opts.client });

  return {
    rescuedDbFrom: rescuedFrom,
    cwd,
    projectName,
    agentId,
    dbPath,
    packageRoot,
    mcpDist,
    mcpScript,
    hasDist,
    hookSecret,
    hookPort,
    hookPortRange,
    installPrime: opts.installPrime ?? true,
    forceInstructions: opts.forceInstructions ?? false,
    isGlobal: opts.isGlobal,
    isWindows,
    envVars,
  };
}

/**
 * Home directory. `AWM_SETUP_HOME` overrides it so `awm setup` / `awm doctor` can be
 * exercised against a scratch tree (tests do this; so does a cautious upgrade).
 */
export function homedir(): string {
  return process.env.AWM_SETUP_HOME || osHomedir();
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
/** Opening marker for the generated block. Everything between the markers is replaced
 *  on upgrade; anything outside them is preserved. The text is deliberately addressed to
 *  whoever opens the file, because that is who needs to know. */
export const AWM_GEN_BEGIN =
  '<!-- AWM:GENERATED:BEGIN — this block is REPLACED by `awm setup`. ' +
  'Put your own notes OUTSIDE these markers and they will survive upgrades. -->';
export const AWM_GEN_END = '<!-- AWM:GENERATED:END -->';

/** Wrap generated content in the markers. */
function wrapGenerated(content: string): string {
  return `${AWM_GEN_BEGIN}\n${content.trim()}\n${AWM_GEN_END}`;
}

export function upsertAwmSection(
  filePath: string,
  newContent: string,
  options: { titleIfNew?: string; suffix?: string; force?: boolean } = {},
): string {
  const fname = basename(filePath);
  const suffix = options.suffix ?? '';
  const force = options.force ?? false;

  if (!existsSync(filePath)) {
    const title = options.titleIfNew ?? `# ${basename(dirname(filePath))}`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${title}\n\n${wrapGenerated(newContent)}${suffix}`);
    return `${fname}: created with AWM workflow section`;
  }

  const existing = readFileSync(filePath, 'utf-8');

  // ---- Preferred path: the file already carries generated markers, so the boundary
  // between "ours" and "theirs" is explicit and only our block is touched.
  const gb = existing.indexOf(AWM_GEN_BEGIN);
  const ge = existing.indexOf(AWM_GEN_END);
  if (gb !== -1 && ge > gb) {
    const current = existing.slice(gb, ge + AWM_GEN_END.length);
    const desired = wrapGenerated(newContent);
    if (current.trimEnd() === desired.trimEnd()) {
      return `${fname}: AWM section already up-to-date (skipped)`;
    }
    writeFileSync(filePath, existing.slice(0, gb) + desired + existing.slice(ge + AWM_GEN_END.length));
    return `${fname}: AWM generated block updated (content outside the markers preserved)`;
  }

  // Find section bounds: `## Memory (AWM)` (possibly with ` — MANDATORY` etc.) until next `## ` or EOF
  const startRegex = /^## Memory \(AWM\)[^\n]*$/m;
  const startMatch = startRegex.exec(existing);

  if (!startMatch) {
    // Section not present — append
    writeFileSync(filePath, existing.trimEnd() + '\n\n' + wrapGenerated(newContent) + suffix);
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

  // ---- LEGACY, UNMARKED SECTION.
  // Written before generated markers existed, so hand-added notes inside it are
  // indistinguishable from generated text. Replacing would silently delete them — on a
  // real install this measured 169 of 381 lines (44%), every one an operational finding
  // that cost real debugging. Back up and refuse; the caller opts in explicitly.
  if (!force) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const backup = `${filePath}.awm-backup-${stamp}`;
    try {
      writeFileSync(backup, existing);
    } catch {
      return `${fname}: AWM section is out of date, but it has no generated markers and the ` +
             `backup could not be written — REFUSING to touch it. Copy the file yourself, then re-run.`;
    }
    return `${fname}: NOT updated — the AWM section predates generated markers, so your own ` +
           `notes inside it cannot be told apart from generated text and would be lost. ` +
           `Backup written to ${basename(backup)}. To upgrade: move any notes you want to keep ` +
           `ABOVE the '## Memory (AWM)' heading (content outside the section is always preserved), ` +
           `then re-run with --force. Nothing has been changed.`;
  }

  const before = existing.slice(0, startMatch.index).trimEnd();
  const after = existing.slice(sectionEnd).replace(/^\s*\n/, '');
  const rebuilt =
    (before ? before + '\n\n' : '') +
    wrapGenerated(newContent) + suffix +
    (after ? '\n\n' + after : '\n');
  writeFileSync(filePath, rebuilt);
  return `${fname}: AWM section replaced with a marked generated block (force)`;
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
1. **Session start**: call \`memory_restore\` to recover previous context. If it reports the
   store is empty/new (or recall keeps returning nothing), **warm-start first**: recall the
   \`onboard a new project\` skill and follow it — or call \`onboard_scan\` on the project's
   docs/repo, refine the candidates, run \`onboard_questions\`, and save the good ones with
   \`memory_write\` (canonical). A cold store is nearly useless until it's seeded.
2. **Starting a task**: call \`memory_task_begin\` (checkpoints + recalls relevant memories).
3. **During work**: call \`memory_recall\` BEFORE stating any fact, BEFORE searching
   the filesystem, BEFORE making architectural decisions. Recall is ~300ms — cheaper
   than one filesystem search.
4. **As you learn things**: call \`memory_write\` proactively. Don't batch.
5. **Finishing a task**: call \`memory_task_end\` with a summary.
6. **Hooks do the rest.** \`awm setup\` installs three: a **prime** hook that recalls against
   each prompt and injects what clears confidence (or nothing), and checkpoint hooks on
   compaction and session end (plus a 15-min timer). Primed context arrives labelled
   \`[class · age]\` — treat it by the volatility rubric, not as user input. If a turn
   arrives with no primed context, that is a signal too: recall explicitly before
   asserting anything.

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
- **Name the CATEGORY as well as the specifics — both, always.** Specifics
  make a memory precise; category words make it *reachable*. A memory that
  says "private plan memory peaked 88%, scale P1v3 -> P2v3" never says
  "Azure" or "App Service Plan", so a question asked in those words cannot
  find it — measured on a real store, that memory was not in the top 40
  candidates for "azure app service plan capacity increase". Write the
  system / product / domain nouns (Azure App Service Plan, Freshdesk ticket,
  MySQL connection pool, ShowConnect scoring) NEXT TO the identifiers.
  Note this cuts against "pick the most specific topic" above: that rule is
  about the \`topic\` TAG, not a licence to omit the category from the body.
  Measured on an 11k-engram store: 94% of tagged memories are missing at
  least one of their own topical terms from the body, and 66% of those
  terms never appear in the text at all.
- **Tags are NOT a substitute for body text.** Only BM25 indexes tags. The
  embedding is built from \`concept + content\` and the cross-encoder rerank
  passage is built from \`concept + content\` — neither sees tags. So a word
  that exists only as a tag is invisible to two of the three retrieval
  channels, including the one that decides final ordering. Tag it *and*
  write it.
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

### Entity index — exact-match recall for named things (default off)
Structured identifier tags (\`ticket=\`, \`person=\`, \`horse=\`, \`member=\`, bare 4+ digit
ids, etc.) feed a dedicated entity inverted index, separate from BM25/embedding scoring.
A query naming an entity ("ticket 19252", "Kaleigh Collett") can reach the memory through
this index even when the wording doesn't lexically match — it's a deterministic exact
lookup, immune to vocabulary mismatch. Keep identifier tags exact and consistent for
this reason, not just for the BM25 boost described above.

Off by default; opt in with \`AWM_ENTITY_INDEX_FETCH=1\` (bounded by
\`AWM_ENTITY_INDEX_CAP\`, default 12). Matched entities get no score boost — they're
guaranteed a reranker audition instead, so the cross-encoder alone decides whether they
surface. Worth trialing on identifier-heavy workloads (ticket/event numbers, named
people/things you refer to by name often); not yet the default pending evaluation.

### Temporal validity — memories that expire or start in the future
\`memory_write\` accepts \`valid_from\` / \`valid_to\` (ISO dates). Use \`valid_to\` on
**operational** facts with a real shelf life — a deploy state, "waiting on X's reply",
a ticket status — so the memory expires instead of relying on you to remember it's
stale. Recall renders \`[valid until …]\` on results carrying this field. Use
\`valid_from\` for a fact that becomes true on a known future date (a policy change, a
season that hasn't started yet). Don't set either for durable facts — most memories
don't need them.

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

### Chain recalls — one hop per call

AWM returns what matches your query. It does **not** walk from that answer to the next
fact, and it is not meant to: it is active memory, holding what you need right now.
Following a chain to the next thing is **your** job — recall, read, recall again, each
result becoming the cue for the next query.

So when a question refers to something **by its role instead of its name**, you have a
chain, not a query:

> *"What is the codename of the project owned by my scheduler?"*

That is three lookups, not one:

1. recall \`who is my scheduler\` → a name
2. recall \`what project does <that name> own\` → a project
3. recall \`<that project> codename\` → the answer

**The failure mode is answering from the first recall.** A single query blending all
three terms returns the most *salient* related memory, not the correct one — measured,
that returns the main project's codename with complete confidence, and it is wrong.
Each hop on its own is an ordinary, reliable recall; the chain only breaks when you stop
asking.

Tells that you are looking at a chain: a possessive or relative clause naming an entity
by role rather than identity (\`my scheduler\`, \`the owner of X\`, \`whoever signed
off on Y\`), or a rule that operates on an attribute you have not looked up yet (\`the
release tag of the project we discussed\` needs that project's codename first). If
resolving the question requires a fact you would have to *derive*, recall the fact
instead.

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

### Recall tuning — opt-in parameters
Default \`memory_recall\` is tuned for the common case. Four opt-in parameters change
the cost/quality tradeoff. Use them when the default doesn't match what you need.

- **\`granularity: 'compact'\`** — every result carries a 200-char \`summary\`
  field with a query-aware snippet (the densest window of query terms in the
  content). Use this when you expect to scan 5+ results to find one — saves
  ~70% of recall output tokens. The full content stays available in
  \`engram.content\` if you want to drill into a specific result.
- **\`granularity: 'auto'\`** — confidence-adaptive. If the top result is a clear
  winner, it gets a longer summary while the rest are compact. If confidence
  is uniform across results, everything is compact. Use when you don't know
  in advance whether one result will dominate.
- **\`require_confidence\`** — abstention. The default (0.05) is already a light
  gate: when the top results don't stand out from the rest, recall returns
  nothing and the reply says **\`RECALL ABSTAINED\`** with the count it withheld.
  An empty result *without* that line is genuine absence. The gate is on the
  SHAPE of the score distribution, not relevance — so raising it silences
  specific questions with one clear winner first (measured: 0.25 abstained on
  two identifier queries scoring 0.26–0.38 while passing a vague one at 0.92).
  Leave it alone for ordinary recall; \`0.10\` is the ceiling that still helps for
  push-style use where nobody asked. When abstention fires, reformulate once
  with the exact identifier, then read the code — don't retry with a lower
  threshold to force an answer.
- **\`workspace: "<name>"\`** — hive-mode recall across all agents in the
  workspace. Use when other agents may have written canonical knowledge you
  need. Default is agent-scoped (your own memories only). Can also be set
  globally via the \`AWM_WORKSPACE\` env var. Memories live in the agent pool
  they were written to; if a session lands in an unexpected pool, \`memory_whoami\`
  says which one before you conclude the memory is missing.

### Keep memory fresh
- After recalling a memory, if you observe the real state is different → call
  \`memory_supersede\` immediately with the corrected version.
- After using a recalled memory: call \`memory_feedback\` (useful/not-useful) **with the
  \`recall_id\`** printed at the end of the recall output (\`[recall_id: …]\`). That id
  joins the feedback to the recall that produced it, which is what lets AWM learn
  which recalls were worth their tokens; feedback without it is a bare vote.
- If you discover a memory is factually wrong: \`memory_retract\` to remove it.
- **If you bypass AWM (file-memory, in-context notes, "I'll just remember"), the memory
  drifts out of date. The system relies on you to keep it current. This is the #1
  failure mode.**

### Cognition recipes — YOU do the thinking, AWM keeps the result
AWM contains no LLM. When memory needs real thinking — distilling a repeatable
procedure, reflecting on a failure — AWM hands YOU a versioned recipe (prompt +
strict output shape) and you run it as a SEPARATE focused pass, then write the
result back as an ordinary memory with provenance.

- \`memory_task_end\` responses include the recipe invitations. Honor the gates:
  skill-derivation only after a genuinely procedural task (3+ tool calls or a
  delegated sub-task); friction-lesson only after a failure/retry/wrong assumption.
- Run each recipe as its own focused pass — do NOT bundle it with other
  reasoning; bundled passes reliably drop the output.
- Write back exactly per the recipe's contract: \`origin_class: 'recipe'\` +
  \`recipe_id\` (e.g. \`skill-derivation@1\`), concept prefixed \`skill: \` or
  \`lesson: \`. AWM validates the shape and rejects malformed or unknown-recipe
  writes with the contract echoed back — fix and retry, don't drop the insight.
- Re-deriving the same skill name reinforces the existing memory instead of
  duplicating it, so don't fear writing a skill you may have written before.

### Content fade — write-and-forget is safe
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
  one's coherent associations (counter-narrative replacement) so cue
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
- \`memory_whoami\` (MCP tool) / \`GET /whoami\` — identify the instance you're actually
  talking to: agent id, workspace, mode, backend, store path, code provenance, sibling
  agent spaces sharing the store. Call this FIRST whenever you're unsure which store,
  which agent identity, or which running code you're dealing with — before reasoning
  about AWM's own state from a stale memory or an assumed port number.
- AWM is shared across all agents in real time. When any agent writes or supersedes a
  memory, every other agent can recall it immediately — but only within the same
  workspace and agent scope.

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

### Backend (SQLite vs PGlite)
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
Each optimisation is gated by an env var so it can be disabled for A/B testing if a
regression appears in your workload. \`memory_whoami\` prints the active fingerprint.

Retrieval (set ON by \`awm setup\` since 0.14.6 — the measured-good configuration):
- \`AWM_RERANK2=1\` — second-stage rerank by the cross-encoder's own score.
- \`AWM_RERANK_WINDOW=query\` — 400-char rerank window on the densest query-term
  region instead of the prefix (25% → 87.5% on long memories).
- \`AWM_RERANK_TAGS=1\` — tags fed into the rerank passage (+7.4pp s@1).

Hook sidecar (0.14.2):
- \`AWM_HOOK_PORT=8401\` / \`AWM_HOOK_PORT_RANGE=10\` — each MCP process binds the
  first free port in the range, so several sessions can run at once. The shipped
  hooks find their own session's sidecar by probing the range and matching
  \`agentId\` on \`/health\`; \`memory_whoami\` reports the port actually bound.

Recall pipeline:
- \`AWM_DISABLE_POOL_FILTER=1\` — disables the candidate pool reduction
  pre-filter in recall. Reverts to scoring all active candidates.
- \`AWM_ENTITY_INDEX_FETCH=1\` — see "Entity index" above (default off; measured
  no effect on the real-store benchmark, 0.14.5).
- \`AWM_DISABLE_SLIM_CACHE=1\` — disables the in-memory slim cache.
  Reverts to per-recall SQL fetch + Buffer→Float32Array conversion.
- \`AWM_DISABLE_RERANK_SKIP=1\` — disables the cross-encoder skip on
  clear-winner queries. Forces every recall through the reranker.
- \`AWM_DISABLE_EXPANSION_CACHE=1\` — disables the query expansion skip
  heuristic + LRU cache. Forces every recall through flan-t5-small.

Write pipeline + lifecycle:
- \`AWM_SLOW_WRITE_MS=250\` — any write slower than this logs one stderr
  line with a phase-time breakdown (embed/novelty/persist, event-loop lag,
  embed-model cold-load ms). \`0\` disables. Useful for diagnosing why a session's
  first write/recall feels slow.
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

PGlite backend:
- \`AWM_PGLITE_BM25_M=1\` — multiplier on PGlite \`ts_rank_cd\` to calibrate
  against SQLite FTS5 BM25 distribution. M=1 (default) is passthrough;
  higher M boosts PGlite scores at the cost of recall-ranking precision
  (see CHANGELOG 0.8.5 follow-up).
- \`AWM_IVFFLAT_PROBES=5\` — pgvector ivfflat probes per query. Higher =
  more accurate, slower.

In production, leave these all unset. Use only when diagnosing a suspected
recall-quality regression.
`.trimStart();
