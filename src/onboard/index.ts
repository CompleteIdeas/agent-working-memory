// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * `awm onboard` — warm-start a cold memory store from a project's own knowledge.
 *
 * The cold-start problem: a fresh AWM store knows nothing, so recall returns
 * nothing until enough interactions accumulate. Onboarding derives a seed set of
 * memories up front — from documentation, the repository, and a short interview —
 * so an agent can be useful on a project from the first turn.
 *
 * Design decisions (what makes this good vs. a vector-DB doc-dump):
 *  - It emits an **`awm import`-compatible file**, not direct writes — so it reuses
 *    the importer, and the file is the human review/edit surface ("make changes
 *    based on what's needed"). Flow: onboard -> review/edit -> `awm import`.
 *  - It extracts **atomic, recall-shaped memories** (concept = the fact/heading,
 *    content = the supporting text, tags = proj/topic/origin), not raw chunks.
 *  - Seed facts from the owner's own docs are **canonical** — they bypass the
 *    salience filter (which is designed to reject low-novelty observations and
 *    would otherwise silently drop half the seed).
 *  - It is **model-free** (this tier): deterministic Markdown/section + repo
 *    structure extraction, no API keys — preserving AWM's "everything local"
 *    property. An LLM-assisted extractor + live interview layer on top of this.
 *  - Ids are content-hashed, so re-running on changed docs is **idempotent**
 *    (import `--dedupe` drops unchanged rows; edited sections become new rows).
 *
 * The interview is emitted as questions in the review file (a model-free tier
 * can't converse); answering them and re-running folds the answers into the seed.
 * The anchor question is deliberately "What is the goal of this memory system?" —
 * the answer shapes what knowledge is worth keeping.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, extname, basename, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface OnboardMemory {
  id: string;
  agent_id: string;
  concept: string;
  content: string;
  tags: string[];
  confidence: number;
  salience: number;
  memory_class: 'canonical' | 'working';
}

export interface OnboardPack {
  version: string;
  kind: 'awm-onboard-pack';
  project: string;
  generated_for: string; // agent id
  purpose: string | null; // answer to "what is the goal of this memory system?"
  memories: OnboardMemory[];
  questions: string[];
}

export interface OnboardOptions {
  /** Files/dirs to scan for documentation (Markdown/text). */
  docs: string[];
  /** Repo root to derive structural memories from (package.json, README, layout). */
  repo?: string;
  project: string;
  /** Target agent id stamped on every seed memory. */
  agentId: string;
  /** The project/memory-system goal (the anchor interview answer), if provided. */
  purpose?: string;
}

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
const MAX_CONTENT = 1200; // cap a section; the lead usually carries the fact

/** The high-value intake — what a domain expert would want captured that docs miss. */
export const INTERVIEW_QUESTIONS: string[] = [
  'What is the goal of this memory system — what should the agent get better at over time?',
  'What is the one-sentence description of this project and who it is for?',
  'What is the tech stack and the non-obvious tools/services it depends on?',
  'What naming conventions, patterns, or house style must the agent follow?',
  'What decisions are settled (and should NOT be re-litigated)?',
  'Who are the key people/systems, and how are they referred to?',
  'What are the known gotchas, footguns, or "here be dragons" areas?',
  'What does "done right" look like here — the definition of quality?',
];

/**
 * The onboarding skill — a procedure stored AS a canonical memory so a host agent
 * (Codex, Claude Code, MWA) can *recall* it and run the interview itself. This is
 * how the "LLM-assisted" tier works without AWM ever calling a model: the agent
 * that's already there is the brain; AWM provides the procedure + the tools.
 * Seeded by `awm setup`; recalled on a cold store (see the restore nudge).
 */
export const ONBOARD_SKILL = {
  concept: 'Skill: onboard a new project (warm-start protocol)',
  content: [
    'When the memory store is empty or you are new to this project, warm-start it before doing other work:',
    '1. Call the `onboard_scan` tool with the docs dir + repo path to get candidate memories (a deterministic scan — real file contents, not guesses).',
    '2. Refine each candidate into an ATOMIC, recall-shaped memory: lead with the fact, keep it to one idea, and include concrete identifiers (file paths, table columns, function names, ticket IDs). Split fat sections into 2-3 crisp facts; drop noise.',
    '3. Run the interview: call `onboard_questions`, then ask the user ONE question at a time starting with "What is the goal of this memory system?". Ask follow-ups for clarity when an answer is vague.',
    '4. Propose the memory set you intend to save and get the user\'s confirmation (edit/drop as they direct).',
    '5. Save each with `memory_write`, memory_class="canonical", tagged with project + topic + source. Stamp facts from the owner\'s own docs as verified/observed; mark your own inferences lower.',
    'Result: recall is useful from the next turn on. Re-run when the docs change to keep the seed fresh (supersede, don\'t duplicate).',
  ].join('\n'),
  tags: ['topic=skill', 'name=onboard', 'src=onboarding', 'intent=context'],
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Deterministic short id from content → idempotent re-runs. */
function mkId(seed: string): string {
  return 'onb-' + createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function clean(text: string): string {
  const t = text
    .replace(/```[\s\S]*?```/g, (m) => m.length > 300 ? '[code block]' : m) // drop huge code fences
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > MAX_CONTENT ? t.slice(0, MAX_CONTENT).trimEnd() + ' …' : t;
}

function mkMemory(
  concept: string, content: string, topic: string, origin: string, opts: OnboardOptions,
): OnboardMemory | null {
  const c = clean(content);
  const title = concept.trim();
  // Skip empties and thin headings with no supporting prose.
  if (!title || c.length < 24) return null;
  return {
    id: mkId(`${opts.agentId}::${title}::${c}`),
    agent_id: opts.agentId,
    concept: title.slice(0, 120),
    content: c,
    tags: [`proj=${opts.project}`, `topic=${topic}`, 'src=onboarding', `origin=${origin}`, 'intent=context'],
    confidence: 0.7, // observed — derived from the owner's own docs
    salience: 0.7, // canonical floor
    memory_class: 'canonical',
  };
}

/**
 * Split a Markdown/text doc into atomic memories, one per heading section.
 * A section's memory is (heading, the prose under it up to the next heading).
 * Untitled preamble before the first heading is captured as an "Overview".
 */
export function scanMarkdown(text: string, origin: string, opts: OnboardOptions): OnboardMemory[] {
  const out: OnboardMemory[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    const concept = heading || `${basename(origin)} — overview`;
    const topic = slugify(heading || basename(origin, extname(origin)));
    const mem = mkMemory(concept, body, topic || 'doc', origin, opts);
    if (mem) out.push(mem);
    buf = [];
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); heading = h[2].trim(); }
    else buf.push(line);
  }
  flush();
  return out;
}

/** Recursively collect documentation files under the given paths. */
function collectDocs(paths: string[]): string[] {
  const files: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      if (/node_modules|\.git|dist|build/.test(p)) return;
      for (const e of readdirSync(p)) walk(join(p, e));
    } else if (DOC_EXT.has(extname(p).toLowerCase())) {
      files.push(p);
    }
  };
  for (const p of paths) walk(resolve(p));
  return files;
}

/** Derive structural memories from a repository (package.json, README, layout). */
export function scanRepo(root: string, opts: OnboardOptions): OnboardMemory[] {
  const out: OnboardMemory[] = [];
  const r = resolve(root);
  // package.json → stack + scripts
  const pkgPath = join(r, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 25);
      const scripts = Object.keys(pkg.scripts ?? {});
      const parts = [
        pkg.description ? `${pkg.name}: ${pkg.description}.` : `Project package: ${pkg.name} (v${pkg.version ?? '?'}).`,
        deps.length ? `Key dependencies: ${deps.join(', ')}.` : '',
        scripts.length ? `npm scripts: ${scripts.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      const m = mkMemory(`Project stack — ${pkg.name}`, parts, 'stack', 'package.json', opts);
      if (m) out.push(m);
    } catch { /* malformed package.json — skip */ }
  }
  // Top-level layout → a structure memory
  try {
    const entries = readdirSync(r)
      .filter((e) => !/^\.|node_modules|dist|build/.test(e))
      .filter((e) => { try { return statSync(join(r, e)).isDirectory(); } catch { return false; } });
    if (entries.length) {
      const m = mkMemory(
        `Repository layout — ${opts.project}`,
        `Top-level directories: ${entries.map((e) => `${e}/`).join(', ')}.`,
        'layout', 'repo-structure', opts,
      );
      if (m) out.push(m);
    }
  } catch { /* unreadable root — skip */ }
  return out;
}

/** Assemble a reviewable, `awm import`-compatible pack from the sources. */
export function buildPack(opts: OnboardOptions): OnboardPack {
  const memories: OnboardMemory[] = [];

  // The anchor: the goal of the memory system, if the owner supplied it.
  if (opts.purpose && opts.purpose.trim()) {
    const g = mkMemory(
      `Goal of this memory system — ${opts.project}`, opts.purpose.trim(), 'goal', 'interview', opts,
    );
    if (g) memories.push(g);
  }

  for (const file of collectDocs(opts.docs)) {
    const rel = opts.repo ? relative(resolve(opts.repo), file) : basename(file);
    try {
      memories.push(...scanMarkdown(readFileSync(file, 'utf-8'), rel.replace(/\\/g, '/'), opts));
    } catch { /* unreadable file — skip */ }
  }
  if (opts.repo) memories.push(...scanRepo(opts.repo, opts));

  // Dedup by content-hash id (idempotent across re-runs and overlapping sources).
  const seen = new Set<string>();
  const deduped = memories.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

  return {
    version: '1',
    kind: 'awm-onboard-pack',
    project: opts.project,
    generated_for: opts.agentId,
    purpose: opts.purpose?.trim() || null,
    memories: deduped,
    questions: INTERVIEW_QUESTIONS,
  };
}

/** A human-readable review surface: the owner edits this understanding, then imports the JSON. */
export function renderReview(pack: OnboardPack): string {
  const lines: string[] = [];
  lines.push(`# Onboarding review — ${pack.project}`);
  lines.push('');
  lines.push(`Generated ${pack.memories.length} candidate memories for agent \`${pack.generated_for}\`.`);
  lines.push('Edit/delete below as needed, then import the JSON pack:');
  lines.push('');
  lines.push('```');
  lines.push(`awm import <pack>.json --db <path> --dedupe`);
  lines.push('```');
  lines.push('');
  lines.push('## Interview — answer these and re-run to enrich the seed');
  lines.push('');
  for (const q of pack.questions) lines.push(`- [ ] ${q}`);
  lines.push('');
  lines.push('## Candidate memories');
  lines.push('');
  for (const m of pack.memories) {
    lines.push(`### ${m.concept}`);
    lines.push(`*${m.tags.join(' · ')}* — class=${m.memory_class}`);
    lines.push('');
    lines.push(m.content);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * CLI entry: scan → write the import pack (JSON) + a review file (Markdown).
 * Does not touch a store — the produced JSON is fed to `awm import`.
 */
export function runOnboard(opts: OnboardOptions & { outDir: string }): { packPath: string; reviewPath: string; count: number } {
  const pack = buildPack(opts);
  mkdirSync(opts.outDir, { recursive: true });
  const base = `onboard-${slugify(opts.project) || 'project'}`;
  const packPath = join(opts.outDir, `${base}.pack.json`);
  const reviewPath = join(opts.outDir, `${base}.review.md`);
  writeFileSync(packPath, JSON.stringify(pack, null, 2), 'utf-8');
  writeFileSync(reviewPath, renderReview(pack), 'utf-8');
  return { packPath, reviewPath, count: pack.memories.length };
}
