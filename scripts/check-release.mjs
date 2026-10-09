#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-release drift check.  `npm run check:release`
 *
 * WHY THIS EXISTS
 * ---------------
 * Every release so far has shipped, then needed a follow-up "bump" commit for one thing
 * that was forgotten: a version string in a doc, a test count, a benchmark figure that
 * lives in six files, the setup adapter that never caught up with four releases of engine
 * changes. A checklist a human reads gets skimmed. This is the half of the checklist a
 * machine can verify, so the human half stays short enough to actually do.
 *
 * ERRORS block a publish (wired into prepublishOnly). They are objective contradictions:
 * two places stating a different version of the same fact.
 *
 * WARNINGS never block. They are the places that need a human to look, most importantly
 * the blast radius of a number you may have just changed.
 *
 * Nothing here is clever. If a check starts crying wolf, delete it — a gate nobody
 * believes is worse than no gate.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf-8'); } catch { return null; } };
const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

const errors = [];
const warnings = [];
const notes = [];
const err = (check, msg, fix) => errors.push({ check, msg, fix });
const warn = (check, msg, fix) => warnings.push({ check, msg, fix });
const note = (check, msg) => notes.push({ check, msg });

const pkg = JSON.parse(read('package.json'));
const VERSION = pkg.version;

// ─────────────────────────────────────────────────────────────────────────────
// 1. One version, stated in many places. They must agree.
// ─────────────────────────────────────────────────────────────────────────────
{
  const changelog = read('CHANGELOG.md') ?? '';
  const top = changelog.match(/^##\s+\[?(\d+\.\d+\.\d+)\]?/m)?.[1];
  if (!top) err('changelog', 'No `## X.Y.Z` heading found in CHANGELOG.md');
  else if (top !== VERSION) {
    err('changelog', `CHANGELOG's newest entry is ${top}, package.json is ${VERSION}`,
      `Add a ## ${VERSION} entry at the top of CHANGELOG.md, or fix the version`);
  }

  const readme = read('README.md') ?? '';
  const whatsNew = readme.match(/##\s+What's new\s+[-—–]\s+v?(\d+\.\d+\.\d+)/i)?.[1];
  if (whatsNew && whatsNew !== VERSION) {
    err('readme', `README "What's new" says v${whatsNew}, package.json is ${VERSION}`,
      `Update the "What's new — v${VERSION}" heading and its bullets`);
  }
  const status = readme.match(/Active development,\s*v?(\d+\.\d+\.\d+)/i)?.[1];
  // Both markers are optional, so deleting them would silently disable the version check
  // rather than fail it. Say so instead.
  if (!whatsNew && !status) {
    warn('readme', 'README carries no version marker, so nothing here verifies it matches package.json',
      `Keep an "Active development, vX.Y.Z" line in Status, or a "## What's new — vX.Y.Z" heading`);
  }
  if (status && status !== VERSION) {
    err('readme', `README Status line says v${status}, package.json is ${VERSION}`,
      `Update "Active development, v${VERSION}" in the Status section`);
  }

  // The hook scripts carry their own stamp so `awm doctor` can spot a stale install.
  const hookSrc = read('src/adapters/hook-scripts.ts') ?? '';
  const hooksVer = hookSrc.match(/AWM_HOOKS_VERSION\s*=\s*'([^']+)'/)?.[1];
  if (hooksVer && hooksVer !== VERSION) {
    // Only an error when the shipped scripts actually changed in this release.
    const lastTag = git('describe --tags --abbrev=0');
    const changed = lastTag ? git(`diff --name-only ${lastTag}..HEAD -- src/adapters/hook-scripts.ts`) : '';
    const level = changed ? err : warn;
    level('hooks-version', `AWM_HOOKS_VERSION is ${hooksVer}, package.json is ${VERSION}`,
      `Bump AWM_HOOKS_VERSION in src/adapters/hook-scripts.ts whenever a shipped hook script changes`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Counts the docs assert about the code. These go stale silently.
// ─────────────────────────────────────────────────────────────────────────────
{
  // MCP tools
  const mcp = read('src/mcp.ts') ?? '';
  const actualTools = new Set([...mcp.matchAll(/['"](memory_[a-z_]+|onboard_[a-z_]+|compress_output|retrieve_original)['"]/g)].map(m => m[1])).size;
  const claims = [];
  for (const f of ['README.md', 'docs/architecture.md', 'docs/claude-code-setup.md', 'docs/product-overview.md', 'docs/quickstart.md']) {
    const t = read(f); if (!t) continue;
    for (const m of t.matchAll(/(\d+)\s+(?:MCP\s+)?tools\b/g)) claims.push({ f, n: Number(m[1]) });
  }
  const wrong = claims.filter(c => c.n !== actualTools);
  if (wrong.length) {
    err('tool-count', `${actualTools} tools are registered, but ${[...new Set(wrong.map(w => w.n))].join('/')} is claimed in: ${[...new Set(wrong.map(w => w.f))].join(', ')}`,
      `Update the count in those files, or check src/mcp.ts`);
  } else if (claims.length) {
    note('tool-count', `${actualTools} tools, consistent across ${new Set(claims.map(c => c.f)).size} files`);
  }

  // Test count. A static scan can only ever be a LOWER BOUND — `it.each` and
  // table-driven tests expand at run time — so comparing it to the README with a
  // tolerance produces false alarms in the honest direction. Instead use the bound
  // for what it is: if the README claims FEWER tests than are literally written in
  // the files, it is definitely stale. That is the real failure (737 for three
  // releases). Claiming more than the bound is expected and says nothing.
  const countTests = (dir) => {
    let n = 0;
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) n += countTests(p);
      else if (/\.test\.ts$/.test(e.name)) {
        const src = readFileSync(join(ROOT, p), 'utf-8');
        n += (src.match(/^\s*it(?:\.\w+)?\s*\(/gm) ?? []).length
           + (src.match(/^\s*test(?:\.\w+)?\s*\(/gm) ?? []).length;
      }
    }
    return n;
  };
  const actualTests = existsSync(join(ROOT, 'tests')) ? countTests('tests') : 0;
  const readme = read('README.md') ?? '';
  const claimed = readme.match(/#\s*(\d+)\s+tests/)?.[1];
  if (claimed && actualTests) {
    const n = Number(claimed);
    if (n < actualTests) {
      err('test-count', `README claims ${claimed} tests; at least ${actualTests} are written in tests/`,
        `Run \`npx vitest run\` and put the real number in README.md`);
    } else if (n > actualTests * 1.3) {
      warn('test-count', `README claims ${claimed} tests but only ~${actualTests} are written — suspiciously high`,
        `Re-run \`npx vitest run\` and confirm`);
    } else {
      note('test-count', `README claims ${claimed}; ${actualTests} written statically (it.each expands at run time)`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The setup adapter is the thing that gets forgotten. (0.14.6's whole reason.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const lastTag = git('describe --tags --abbrev=0');
  if (!lastTag) {
    note('adapter-drift', 'No git tag found — skipping the since-last-release checks');
  } else {
    const changed = git(`diff --name-only ${lastTag}..HEAD`).split('\n').filter(Boolean);
    const touched = (re) => changed.some(f => re.test(f));

    const behaviourChanged = touched(/^src\/(engine|hooks|core|storage)\//);
    const adapterChanged = touched(/^src\/adapters\//);
    if (behaviourChanged && !adapterChanged) {
      warn('adapter-drift',
        `Engine/hook code changed since ${lastTag} but src/adapters/ did not`,
        `Ask: does a FRESH \`awm setup --global\` still install the right hooks, env and CLAUDE.md guidance? This is exactly what 0.14.2-0.14.5 missed.`);
    }
    if (touched(/^src\/adapters\/hook-scripts\.ts$/) && !touched(/^tests\/adapters\//)) {
      warn('adapter-drift', 'Shipped hook scripts changed but no adapter test changed',
        'The hooks run as real child processes in tests/adapters/hook-scripts.test.ts — extend it');
    }
    if (changed.length) note('scope', `${changed.length} files changed since ${lastTag}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stale version labels inside the guidance we INSTALL on user machines.
// ─────────────────────────────────────────────────────────────────────────────
{
  const common = read('src/adapters/common.ts') ?? '';
  const [major, minor] = VERSION.split('.').map(Number);
  const stale = [...common.matchAll(/\((\d+\.\d+)\.x[^)]*\)|\b(\d+\.\d+)\.x\b/g)]
    .map(m => m[1] ?? m[2])
    .filter(v => { const [a, b] = v.split('.').map(Number); return a < major || (a === major && b < minor - 1); });
  if (stale.length) {
    warn('guidance-labels',
      `The generated CLAUDE.md guidance still carries version labels: ${[...new Set(stale)].join(', ')}`,
      'These are installed verbatim on user machines. Drop the label unless the version genuinely matters.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Blast radius of the headline numbers. Informational, but this is the one
//    that bit us: a corrected benchmark has to be corrected in every doc at once.
// ─────────────────────────────────────────────────────────────────────────────
{
  const DOCS = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = join(dir, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) { if (!/archive|node_modules/.test(e.name)) walk(p); }
      // RELEASE.md is process documentation: it quotes figures as examples of the
      // problem, so counting it would make this check noisier every time it is read.
      else if (/\.(md|html)$/.test(e.name) && !/\.bak/.test(e.name) && e.name !== 'RELEASE.md') DOCS.push(p);
    }
  };
  walk('docs');
  DOCS.push('README.md');

  // Which figures to chase, derived from the generated page on BOTH sides of this
  // release — never written down as literals here.
  //
  // Deriving only the CURRENT figures inverts this check at the one moment it
  // exists for. RELEASE.md's order is: run `npm run bench`, which rewrites
  // docs/benchmarks-current.md, THEN run this to find every doc still carrying the
  // old numbers. Grep for the NEW figures at that moment and you find only the page
  // bench just wrote — the stale docs are precisely the ones that do NOT match, so
  // the check reports a short list of coincidences and reads like a clean sync.
  // (Measured 2026-10-09: with figures nudged and docs untouched, a current-only
  // derivation named 2 files, both coincidental matches on unrelated ablation cells,
  // while the seven genuinely-stale docs went unnamed.)
  //
  // So: HEAD's generated page is the "before", the working tree's is the "after",
  // and the figure worth hunting for a metric that moved is the OLD one.
  const SUITE_METRICS = ['s@1', 's@5', 'mrr', 'abstention'];
  const metricsFrom = (text) => {
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    const header = lines.find(l => /^\|\s*Suite\s*\|/i.test(l));
    if (!header) return null;
    // Locate columns by NAME. With fixed indices, inserting or reordering a column
    // in the generator silently files one metric's value under another's label —
    // e.g. MRR reported as the abstention rate.
    const cols = header.split('|').map(s => s.trim().toLowerCase());
    const idx = {};
    for (const m of SUITE_METRICS) { const i = cols.indexOf(m); if (i > 0) idx[m] = i; }
    if (Object.keys(idx).length !== SUITE_METRICS.length) return null;
    const out = new Map();
    for (const line of lines) {
      if (line === header || !/^\|/.test(line) || /^\|\s*-/.test(line)) continue;
      const f = line.split('|').map(s => s.trim().replace(/\*/g, '').replace('%', ''));
      const suite = f[1];
      if (!suite || !/quer/i.test(suite)) continue;       // skip provenance/other tables
      for (const m of SUITE_METRICS) {
        const v = f[idx[m]];
        if (/^\d+\.\d+$/.test(v)) out.set(`${suite} · ${m}`, v);
      }
    }
    return out.size ? out : null;
  };

  const nowM = metricsFrom(read('docs/benchmarks-current.md'));
  const prevM = metricsFrom(git('show HEAD:docs/benchmarks-current.md'));

  if (!nowM) {
    // A silent self-disabled gate is worse than a loud one: warn, don't note.
    warn('benchmark-spread',
      'Could not read the retrieval table in docs/benchmarks-current.md — this check is INERT.',
      'The parser locates the "| Suite |" header and its s@1/s@5/MRR/abstention columns by name. If bench-current.mjs renamed or dropped one, fix scripts/check-release.mjs section 5 to match.');
  } else {
    const expected = SUITE_METRICS.length * 2;            // identifier + topic
    if (nowM.size < expected) {
      warn('benchmark-spread',
        `Only ${nowM.size} of ${expected} headline figures could be read from docs/benchmarks-current.md — a suite row may have failed or be missing a metric, so this check covers less than it appears to.`,
        'Check the retrieval table for a "_run failed_" row or an em-dash cell, and re-run the affected suite.');
    }

    // The generated page is the SOURCE of these figures, so counting it inflates
    // every total by one and makes "appears in 2 docs" mean "one real doc".
    const HAND = DOCS.filter(f => f !== 'docs/benchmarks-current.md');
    const carriers = (value) => {
      const re = new RegExp(`\\b${value.replace('.', '\\.')}\\b`);
      return HAND.filter(f => { const t = read(f); return t && re.test(t); });
    };

    let reported = 0;
    for (const [label, nowV] of nowM) {
      const prevV = prevM?.get(label);
      if (prevV && prevV !== nowV) {
        // This metric moved. The actionable list is whoever still says the OLD value.
        const stale = carriers(prevV);
        reported++;
        note('benchmark-spread', stale.length
          ? `${label} moved ${prevV}% -> ${nowV}% — ${stale.length} doc(s) still carry ${prevV}%: ${stale.join(', ')}`
          : `${label} moved ${prevV}% -> ${nowV}% — no doc still carries ${prevV}%, propagation looks complete`);
      } else {
        // Unmoved: fall back to plain blast radius, which is what this check did
        // before and is still the right informational answer between benchmarks.
        const files = carriers(nowV);
        if (files.length > 1) { reported++; note('benchmark-spread', `${label} ${nowV}% appears in ${files.length} docs: ${files.join(', ')}`); }
      }
    }
    if (!prevM) note('benchmark-spread', 'No previous docs/benchmarks-current.md at HEAD to diff against — reporting blast radius only, not what moved.');
    if (reported) note('benchmark-spread', 'If any of these changed this release, every listed file must change together.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Publish surface + working-tree state.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const f of pkg.files ?? []) {
    const p = f.replace(/\/$/, '');
    if (!existsSync(join(ROOT, p))) err('publish-surface', `package.json files[] lists "${f}" but it does not exist`, p === 'dist' ? 'Run: npm run build' : undefined);
  }
  if (!(pkg.files ?? []).some(f => f.startsWith('docs'))) {
    note('publish-surface', 'docs/ is not shipped to npm — the docs site only updates on a git push');
  }

  const dirty = git('status --porcelain').split('\n').filter(l => l && !/^\?\?/.test(l));
  if (dirty.length) note('git', `${dirty.length} tracked file(s) modified and uncommitted`);
  if (git(`tag -l v${VERSION}`)) note('git', `Tag v${VERSION} already exists`);

  // Has THIS version actually been through Linux? `npm run test:linux` stamps
  // .release-checks/linux-<version>.json on a green run. Never blocking — it is a local
  // artifact and a fresh clone has none — but the 0.13.3 images are the standing proof that
  // an unrecorded check is one that silently stops happening.
  const linuxStamp = join(ROOT, '.release-checks', `linux-${VERSION}.json`);
  if (existsSync(linuxStamp)) {
    try {
      const st = JSON.parse(readFileSync(linuxStamp, 'utf-8'));
      const age = Math.floor((Date.now() - Date.parse(st.when)) / 86400000);
      note('linux-suite', `v${VERSION} passed on Linux: ${st.files} files / ${st.tests} tests, ${st.os} ${st.arch}, ${st.commit}, ${age === 0 ? 'today' : age + 'd ago'}`);
      const head = git('rev-parse --short HEAD');
      if (st.commit.endsWith('-dirty')) note('linux-suite', `that run was over uncommitted changes (${st.commit}) — re-run against the committed tree before tagging`);
      else if (head && st.commit !== head) note('linux-suite', `that run was at ${st.commit}, HEAD is now ${head} — re-run if the change touches src/`);
    } catch { note('linux-suite', `.release-checks/linux-${VERSION}.json is unreadable — re-run: npm run test:linux`); }
  } else {
    // No stamp for THIS version. That is only a real gap if src/ actually moved: a
    // docs-only release cannot behave differently on Linux, and a gate that demands a
    // six-minute container run to prove a README change is a gate people learn to skip.
    const prior = existsSync(join(ROOT, '.release-checks'))
      ? readdirSync(join(ROOT, '.release-checks')).filter(f => f.startsWith('linux-')).sort().pop()
      : null;
    let carried = false;
    if (prior) {
      try {
        const st = JSON.parse(readFileSync(join(ROOT, '.release-checks', prior), 'utf-8'));
        const moved = git(`diff --name-only ${st.commit}..HEAD -- src/`);
        if (st.commit && !st.commit.endsWith('-dirty') && !moved) {
          note('linux-suite', `no run for v${VERSION}, but src/ is unchanged since v${st.version} (${st.commit}) which passed ${st.files} files / ${st.tests} tests on Linux`);
          carried = true;
        }
      } catch { /* fall through to the plain warning */ }
    }
    if (!carried) note('linux-suite', `No Linux run recorded for v${VERSION} — run: npm run test:linux`);
  }


  // The plugin is generated from the same modules `awm setup` uses. If it has drifted it is
  // a third copy of the hook wiring going stale — the exact failure 0.14.6 was about.
  if (existsSync(join(ROOT, 'plugin'))) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-plugin.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf-8' });
    if (r.status === 0) {
      note('plugin', (r.stdout || '').trim() || 'plugin/ is in sync');
    } else {
      const detail = ((r.stdout || '') + (r.stderr || '')).split('\n').map(s => s.trim()).filter(Boolean).slice(1, 4).join('; ');
      err('plugin', `plugin/ has drifted from src/: ${detail}`,
        'Run: npm run build && npm run build:plugin, then commit plugin/');
    }
  }


  // The Desktop bundle is generated from the same source as the plugin; same drift risk.
  if (existsSync(join(ROOT, 'mcpb'))) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-mcpb.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf-8' });
    if (r.status === 0) note('mcpb', (r.stdout || '').trim() || 'mcpb/ is in sync');
    else err('mcpb', 'mcpb/ has drifted from src/',
      'Run: npm run build && npm run build:mcpb, then commit mcpb/');
  }


  // Sibling checkout that vendors this package.
  const sibling = join(ROOT, '..', 'AgentSynapse', 'packages', 'awm', 'package.json');
  if (existsSync(sibling)) {
    try {
      const sv = JSON.parse(readFileSync(sibling, 'utf-8')).version;
      if (sv !== VERSION) note('submodule', `AgentSynapse packages/awm is at ${sv} (this repo: ${VERSION}) — bump it after tagging if that consumer should follow`);
    } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
// docs/traceability.md claims a symbol lives in a file. It drifted for months
// without anyone noticing, because nothing checked it: all 42 symbols still
// resolved while every cited line number was wrong by 2-4x. Line numbers are
// gone; this verifies what is left.
{
  const tr = read('docs/traceability.md');
  if (!tr) {
    warn('traceability', 'docs/traceability.md is missing', 'restore it or drop the check');
  } else {
    const rows = [...tr.matchAll(/\|\s*`([A-Za-z0-9_.\/-]+\.(?:ts|mjs|js))`\s*\|\s*`([^`]+?)`\s*\|/g)];
    const bad = [];
    for (const [, path, sym] of rows) {
      const src = read(path);
      if (src === null) { bad.push(`${path} (file missing)`); continue; }
      let needle = sym.split('(')[0].trim();
      const verb = needle.match(/^(?:POST|GET|PUT|DELETE)\s+(.*)$/);
      if (verb) needle = verb[1];
      if (!src.includes(needle)) bad.push(`${path} -> ${sym}`);
    }
    if (rows.length === 0) warn('traceability', 'no file:symbol rows parsed — did the table format change?', 'check the regex in check-release.mjs');
    else if (bad.length) err('traceability', `${bad.length} stale row(s): ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ' ...' : ''}`, 'update docs/traceability.md to name the symbol that exists now');
    else note('traceability', `${rows.length} file:symbol rows all resolve`);
  }
}

// llms.txt is the LLM-facing entry point. GitHub Pages publishes from /docs, so
// the conventional <site>/llms.txt URL needs a copy there; the root copy is what
// anyone reading the repository finds. Two files, one source of truth — so guard
// the drift rather than trusting whoever edits next to remember.
{
  const a = read('llms.txt');
  const b = read('docs/llms.txt');
  if (!a) err('llms.txt', 'llms.txt is missing from the repository root', 'restore it — the README links to it');
  else if (!b) err('llms.txt', 'docs/llms.txt is missing, so <site>/llms.txt will 404', 'cp llms.txt docs/llms.txt');
  else if (a !== b) err('llms.txt', 'llms.txt and docs/llms.txt have drifted', 'cp llms.txt docs/llms.txt  (root is the source of truth)');
  else note('llms.txt', `present and in sync (${a.length} chars)`);
}

const pad = (s) => String(s).padEnd(18);
console.log(`\nRelease check — v${VERSION}\n`);
for (const n of notes)    console.log(`  ·  ${pad(n.check)} ${n.msg}`);
if (notes.length) console.log('');
for (const w of warnings) { console.log(`  ~  ${pad(w.check)} ${w.msg}`); if (w.fix) console.log(`     ${' '.repeat(18)} → ${w.fix}`); }
if (warnings.length) console.log('');
for (const e of errors)   { console.log(`  x  ${pad(e.check)} ${e.msg}`); if (e.fix) console.log(`     ${' '.repeat(18)} → ${e.fix}`); }

console.log('');
if (errors.length) {
  console.log(`${errors.length} blocking issue${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);
  console.log('The human half of the list is in docs/RELEASE.md.\n');
  process.exit(1);
}
console.log(`No blocking issues. ${warnings.length} warning${warnings.length === 1 ? '' : 's'} to read.`);
console.log('Now do the human half: docs/RELEASE.md\n');
