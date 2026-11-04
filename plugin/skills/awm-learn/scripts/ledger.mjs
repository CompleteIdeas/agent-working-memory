#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * awm learn — the work ledger. Deterministic and model-free: it never reads meaning, only files.
 *
 *   node ledger.mjs plan    <path> [--project NAME] [--budget 400000] [--exclude "glob,glob"] [--unit-kb 48] [--include-generated] [--force]
 *   node ledger.mjs next    [--project NAME] [--n 1] [--agent ID]   claim the next unit(s), most important first
 *   node ledger.mjs done    <unitId> [--project NAME] [--memories N] [--note "..."]
 *   node ledger.mjs skip    <unitId> [--project NAME] --note "why"
 *   node ledger.mjs release <unitId> [--project NAME]              hand a claimed unit back to the queue
 *   node ledger.mjs deepen  <unitId> [--project NAME]              promote a skimmed unit to a full read
 *   node ledger.mjs status  [--project NAME] [--json]
 *   node ledger.mjs refresh [--project NAME]                        re-hash: changed units -> stale, new -> pending, gone -> removed
 *   node ledger.mjs list                                            the projects that have a ledger
 *
 * Depth tiers, chosen at plan time against --budget (tokens):
 *   deep   - read every file in full (the most important units, while the budget lasts)
 *   skim   - read each file's head (~3 KB: imports, exports, signatures, headings, opening pages)
 *   sample - data files: the first lines only, for their shape
 * Exclusions: a .awmlearnignore file in the target (one glob per line, # comments) and --exclude.
 *
 * The ledger lives OUTSIDE the target, in $AWM_LEARN_DIR (default ~/.awm/learn/<project>/ledger.json),
 * so learning never writes into the repo or manuscript being learned.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative, extname, basename, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0];
const BOOL_FLAGS = new Set(['json', 'include-generated', 'force']);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); if (i < 0) return dflt; if (BOOL_FLAGS.has(name)) return true; return args[i + 1] ?? dflt; };
const positional = [];
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (!BOOL_FLAGS.has(args[i].slice(2))) i++; continue; }
  positional.push(args[i]);
}
const ROOT_DIR = process.env.AWM_LEARN_DIR || join(homedir(), '.awm', 'learn');

// ---------- classification ----------
const CODE = new Set('.ts .tsx .js .jsx .mjs .cjs .py .rb .go .rs .java .kt .kts .cs .fs .vb .php .swift .m .mm .c .h .cc .cpp .hpp .scala .clj .ex .exs .erl .hs .lua .dart .r .jl .sh .bash .zsh .ps1 .psm1 .sql .vue .svelte .astro .tf .hcl .gradle'.split(' '));
const PROSE = new Set('.md .mdx .markdown .txt .rst .adoc .org .tex .fountain .rtf'.split(' '));
const CONFIG = new Set('.json .jsonc .yaml .yml .toml .ini .cfg .conf .env.example .xml .properties .editorconfig'.split(' '));
const MARKUP = new Set('.html .htm .css .scss .sass .less'.split(' '));
const DATA = new Set('.csv .tsv .parquet .ndjson .jsonl'.split(' '));
const BINARY = new Set('.png .jpg .jpeg .gif .webp .ico .bmp .tiff .psd .ai .sketch .fig .pdf .zip .gz .tgz .7z .rar .jar .war .exe .dll .so .dylib .bin .o .a .class .pyc .wasm .onnx .pt .pth .safetensors .ckpt .mp3 .mp4 .mov .avi .wav .flac .ogg .woff .woff2 .ttf .otf .eot .db .sqlite .sqlite3 .mdb .docx .xlsx .pptx .doc .xls .ppt .key .pages .numbers .epub .mobi'.split(' '));
// Never read: secrets. Matched on the file name.
const SECRET = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_(rsa|ed25519|ecdsa)/i, /credentials/i, /secrets?\./i, /\.kdbx$/i, /^\.npmrc$/i, /^\.netrc$/i];
const ALLOWED_ENV = /\.env\.(example|sample|template)$/i;
// Skipped as noise unless --include-generated.
const NOISE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', '.tox', 'target', 'bin', 'obj', 'vendor', 'bower_components', '.idea', '.vscode', '.gradle', 'Pods', '.terraform', '.pytest_cache', '.mypy_cache', 'tmp', '.tmp']);
const NOISE_FILES = [/\.min\.(js|css)$/i, /\.map$/i, /^package-lock\.json$/i, /^yarn\.lock$/i, /^pnpm-lock\.yaml$/i, /^Cargo\.lock$/i, /^poetry\.lock$/i, /^composer\.lock$/i, /^Gemfile\.lock$/i, /\.lock$/i, /\.snap$/i, /\.generated\./i, /_pb2\.py$/i, /\.d\.ts$/i];
const ENTRY = [/^readme/i, /^package\.json$/i, /^pyproject\.toml$/i, /^cargo\.toml$/i, /^go\.mod$/i, /^(index|main|app|server|cli)\.[a-z]+$/i, /^dockerfile$/i, /^makefile$/i, /^claude\.md$/i, /^agents\.md$/i, /^contributing/i, /^architecture/i, /^outline/i, /^synopsis/i, /^bible/i];

function kindOf(name) {
  const lower = name.toLowerCase();
  if (SECRET.some(r => r.test(name)) && !ALLOWED_ENV.test(name)) return 'secret';
  const ext = lower.endsWith('.env.example') ? '.env.example' : extname(lower);
  if (BINARY.has(ext)) return 'binary';
  if (CODE.has(ext)) return 'code';
  if (PROSE.has(ext)) return 'prose';
  if (CONFIG.has(ext) || /^(dockerfile|makefile|procfile|\.gitignore|\.dockerignore)$/i.test(name)) return 'config';
  if (MARKUP.has(ext)) return 'markup';
  if (DATA.has(ext)) return 'data';
  return ext ? 'other' : 'config';
}

// ---------- file discovery ----------
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch { return null; }
}
function walk(root) {
  const files = [];
  const go = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!NOISE_DIRS.has(e.name)) go(p); }
      else if (e.isFile()) files.push(relative(root, p));
    }
  };
  go(root);
  return files;
}
function churn(root) {
  // How often each file changed in the last 500 commits: a proxy for "matters".
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-n', '500', '--name-only', '--pretty=format:'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new Map();
    for (const l of out.split('\n')) if (l.trim()) m.set(l.trim(), (m.get(l.trim()) || 0) + 1);
    return m;
  } catch { return new Map(); }
}
function headCommit(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12);

function globToRe(g) {
  g = g.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const anchored = g.startsWith('/'); if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/'); if (dirOnly) g = g.slice(0, -1);
  const body = g.split('**').map(s => s.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*');
  return new RegExp((anchored || g.includes('/') ? '^' : '(^|/)') + body + (dirOnly ? '/' : '(/|$)'), 'i');
}
function ignoreMatcher(root, extra = []) {
  const pats = [...extra];
  const f = join(root, '.awmlearnignore');
  if (existsSync(f)) pats.push(...readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  const res = pats.map(globToRe);
  return (rel) => res.some(re => re.test(rel));
}
// Reading cost by tier: ~4 characters per token in, plus ~1.5k tokens of writing per unit.
const SKIM_BYTES = 3000, SAMPLE_BYTES = 2000;
function readBytes(u, tier) {
  if (tier === 'deep') return u.bytes;
  const cap = tier === 'sample' ? SAMPLE_BYTES : SKIM_BYTES;
  return (u.fileBytes || [u.bytes]).reduce((s, b) => s + Math.min(b, cap), 0);
}
const WRITE_TOKENS = { deep: 1500, skim: 600, sample: 300 };
const unitTokens = (u, tier = u.tier) => Math.round(readBytes(u, tier) / 4 + WRITE_TOKENS[tier]);
function assignTiers(units, budget) {
  let spent = 0;
  for (const u of units) if (u.kind === 'data') { u.tier = 'sample'; spent += unitTokens(u, 'sample'); }
  const rest = units.filter(u => u.kind !== 'data').sort((a, b) => b.priority - a.priority);
  // Everything is at least skimmed; then the most important units are deepened while the budget lasts.
  for (const u of rest) { u.tier = 'skim'; spent += unitTokens(u, 'skim'); }
  for (const u of rest) {
    const extra = unitTokens(u, 'deep') - unitTokens(u, 'skim');
    if (spent + extra <= budget) { u.tier = 'deep'; spent += extra; }
  }
  return spent;
}
/** The least a plan can cost: every unit skimmed, data sampled. */
const floorTokens = (units) => units.reduce((s, u) => s + unitTokens(u, u.kind === 'data' ? 'sample' : 'skim'), 0);

function inventory(root, includeGenerated, exclude = [], sliceAt = 48000) {
  const rels = (gitFiles(root) ?? walk(root)).map(r => r.split('/').join(sep));
  const files = [];
  const skipped = { secret: 0, binary: 0, noise: 0, large: 0, missing: 0, ignored: 0 };
  const ignored = ignoreMatcher(root, exclude);
  for (const rel of rels) {
    const parts = rel.split(sep);
    const name = parts[parts.length - 1];
    if (!includeGenerated && (parts.slice(0, -1).some(p => NOISE_DIRS.has(p)) || NOISE_FILES.some(r => r.test(name)))) { skipped.noise++; continue; }
    const kind = kindOf(name);
    if (kind === 'secret') { skipped.secret++; continue; }
    if (kind === 'binary') { skipped.binary++; continue; }
    let st; try { st = statSync(join(root, rel)); } catch { skipped.missing++; continue; }
    if (st.size > 2_000_000) { skipped.large++; continue; } // generated dumps, data exports
    let buf; try { buf = readFileSync(join(root, rel)); } catch { skipped.missing++; continue; }
    if (buf.subarray(0, 8000).includes(0)) { skipped.binary++; continue; }
    const posix = rel.split(sep).join('/');
    if (resolve(root, rel).toLowerCase().startsWith(resolve(ROOT_DIR).toLowerCase() + sep)) { skipped.ignored++; continue; } // the ledgers themselves
    if (ignored(posix)) { skipped.ignored++; continue; }
    // A big JSON/YAML file is data (fixtures, exports), not configuration.
    const fk = kind === 'config' && st.size > 60_000 ? 'data' : kind;
    const rec = { path: posix, kind: fk, bytes: st.size, hash: sha(buf) };
    if (st.size > sliceAt && (fk === 'code' || fk === 'prose')) rec.slices = sliceFile(buf.toString('utf8'), sliceAt, fk);
    files.push(rec);
  }
  return { files, skipped };
}

// A file too big for one unit (a 17k-line route file, a whole manuscript in one document) is
// cut into slices at its own section boundaries, so each slice is a coherent part and refresh
// re-learns only the sections that changed. A slice is named after its first heading, which
// keeps its id stable when lines shift above it.
const BANNER = /^\s*(\/\/|#|--|;|\/\*+|\*)\s*[-=─━#*~]{3,}/;
const CODE_DECL = /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|def|module|namespace)\s+\w/;
const PROSE_HEAD = /^(#{1,3}\s+\S|(chapter|part|book|act|scene)\b[\s\d:.ivx-]+)/i;
function sliceFile(text, target, kind) {
  const lines = text.split('\n');
  const isBound = (l) => BANNER.test(l) || (kind === 'prose' ? PROSE_HEAD.test(l) : CODE_DECL.test(l));
  const isHeading = (l) => BANNER.test(l) || (kind === 'prose' && PROSE_HEAD.test(l));
  const out = []; let start = 0, acc = 0, lastBound = -1;
  const cut = (end) => {               // [start, end) in 0-based lines
    const body = lines.slice(start, end).join('\n');
    const head = lines.slice(start, end).find(isHeading);
    const slug = head ? head.replace(/[\/#*=\-─━~;]+/g, ' ').replace(/\(.*$/, '').trim().toLowerCase().split(/\s+/).slice(0, 4).join('-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') : '';
    out.push({ start: start + 1, end, bytes: Buffer.byteLength(body), hash: sha(body), label: slug || `L${start + 1}` });
    start = end; acc = 0; lastBound = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (i > start && isBound(lines[i])) lastBound = i;
    acc += Buffer.byteLength(lines[i]) + 1;
    if (acc >= target) {
      const before = lastBound > start ? Buffer.byteLength(lines.slice(start, lastBound).join('\n')) : 0;
      cut(lastBound > start && before >= target * 0.4 ? lastBound : i + 1);
      // Bytes already walked past the cut point belong to the new slice.
      for (let j = start; j <= i; j++) { acc += Buffer.byteLength(lines[j]) + 1; if (j > start && isBound(lines[j])) lastBound = j; }
    }
  }
  if (start < lines.length) cut(lines.length);
  const seen = new Map();
  for (const s of out) { const n = (seen.get(s.label) || 0) + 1; seen.set(s.label, n); if (n > 1) s.label += `#${n}`; }
  return out;
}

// ---------- units ----------
// A unit is what one agent reads in one sitting: a folder's direct files, split when over budget;
// a big prose file (a chapter, a long doc) is a unit of its own.
function buildUnits(files, budget, ch) {
  const byDir = new Map();
  for (const f of files) { const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
  const units = [];
  for (const [dir, fs] of [...byDir.entries()].sort()) {
    const isEntry = (f) => ENTRY.some(r => r.test(basename(f.path)));
    fs.sort((a, b) => (isEntry(b) - isEntry(a)) || a.path.localeCompare(b.path));
    const total = fs.reduce((s, f) => s + f.bytes, 0);
    if (total <= budget) { units.push(mkUnit(dir, fs, 1, ch)); continue; }
    // A folder too big for one unit: keep related files together instead of cutting the
    // alphabetical list at the budget. A module goes with its tests (foo.ts + foo.test.ts), and
    // files sharing a name prefix (clearance-eval.ts, clearance-scope.ts) form one family.
    const fam = new Map();
    for (const f of fs) {
      const k = isEntry(f) ? '' : familyKey(basename(f.path));
      if (!fam.has(k)) fam.set(k, []); fam.get(k).push(f);
    }
    let cur = [], names = [], size = 0;
    const flush = () => {
      if (!cur.length) return;
      const label = names.length === 1 ? names[0] || 'entry' : `${names[0] || 'entry'}..${names[names.length - 1]}`;
      units.push(mkUnit(dir, cur, 0, ch, null, label)); cur = []; names = []; size = 0;
    };
    for (const [k, ff] of [...fam.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))) {
      const fb = ff.reduce((s, f) => s + f.bytes, 0);
      if (fb > budget) {             // a family bigger than a unit: split it, still in name order
        flush();
        let sub = [], sb = 0, n = 1;
        const subFlush = () => { if (sub.length) { units.push(mkUnit(dir, sub, 0, ch, null, `${k || 'entry'}#${n++}`)); sub = []; sb = 0; } };
        for (const f of ff) {
          if (f.bytes > budget) { subFlush(); units.push(...bigFileUnits(dir, f, ch)); continue; }
          if (sb + f.bytes > budget) subFlush();
          sub.push(f); sb += f.bytes;
        }
        subFlush();
        continue;
      }
      if (size + fb > budget) flush();
      cur.push(...ff); names.push(k); size += fb;
    }
    flush();
  }
  // Collapse "part 1" suffixes on folders that never split.
  const counts = new Map(); for (const u of units) counts.set(u.base, (counts.get(u.base) || 0) + 1);
  for (const u of units) if (counts.get(u.base) === 1) u.id = u.base;
  return units;
}
/** The family a file belongs to in a big flat folder: its name without extension and test
 *  suffix, cut at the first separator ("clearance-eval.test.ts" -> "clearance"). */
function familyKey(name) {
  const stem = name.replace(/\.(test|spec|e2e|stories)(?=\.)/i, '').replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');
  const m = stem.match(/^[^-_.]+/);
  return (m ? m[0] : stem).toLowerCase();
}
function bigFileUnits(dir, f, ch) {
  if (!f.slices) return [mkUnit(dir, [f], 0, ch, basename(f.path))];
  return f.slices.map(s => {
    const u = mkUnit(dir, [{ ...f, bytes: s.bytes, hash: s.hash }], 0, ch, `${basename(f.path)}§${s.label}`);
    u.ranges = [{ path: f.path, start: s.start, end: s.end }];
    if (u.entry && s.start !== 1) { u.entry = false; u.priority -= 1000; }  // only the top of an entry file is the entry
    return u;
  });
}
function mkUnit(dir, fs, part, ch, single, family) {
  const d = dir === '.' ? '(root)' : dir;
  const base = single ? `${dir === '.' ? '' : dir + '/'}${single}` : family ? `${d}:${family}` : d;
  const kinds = {}; for (const f of fs) kinds[f.kind] = (kinds[f.kind] || 0) + f.bytes;
  const kind = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
  const bytes = fs.reduce((s, f) => s + f.bytes, 0);
  const names = fs.map(f => basename(f.path));
  const entry = names.some(n => ENTRY.some(r => r.test(n)));
  const changes = fs.reduce((s, f) => s + (ch.get(f.path) || 0), 0);
  const depth = dir === '.' ? 0 : dir.split('/').length;
  // Priority: entry points and the top of the tree first, then what changes most, then size.
  const priority = Math.round((entry ? 1000 : 0) + Math.max(0, 300 - depth * 60) + Math.min(400, changes * 8) + Math.min(200, bytes / 1000) + (kind === 'prose' ? 50 : 0) - (kind === 'data' ? 150 : 0));
  return {
    id: part > 1 ? `${base}#${part}` : base, base, kind, tier: 'deep', files: fs.map(f => f.path), fileBytes: fs.map(f => f.bytes), bytes,
    hash: sha(fs.map(f => f.path + ':' + f.hash).join('\n')), priority, entry, changes,
    status: 'pending', claimedBy: null, claimedAt: null, memories: 0, note: null, learnedAt: null, learnedCommit: null,
  };
}

// ---------- ledger io ----------
function ledgerPath(project) { return join(ROOT_DIR, project, 'ledger.json'); }
function findProject() {
  const p = flag('project');
  if (typeof p === 'string') return p;
  if (!existsSync(ROOT_DIR)) die('No ledgers yet. Run: node ledger.mjs plan <path> --project NAME');
  const all = readdirSync(ROOT_DIR).filter(d => existsSync(ledgerPath(d)));
  if (all.length === 1) return all[0];
  die(`Several ledgers exist (${all.join(', ')}). Pass --project NAME.`);
}
function load(project) { const f = ledgerPath(project); if (!existsSync(f)) die(`No ledger for "${project}". Run plan first.`); return JSON.parse(readFileSync(f, 'utf8')); }
function save(L) { const f = ledgerPath(L.project); mkdirSync(dirname(f), { recursive: true }); const tmp = f + '.tmp'; writeFileSync(tmp, JSON.stringify(L, null, 1)); renameSync(tmp, f); }
function die(m) { console.error(m); process.exit(1); }
const kb = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1000) + ' KB';

function summary(L) {
  const by = {}; for (const u of L.units) by[u.status] = (by[u.status] || 0) + 1;
  const done = L.units.filter(u => u.status === 'done');
  const left = L.units.filter(u => u.status === 'pending' || u.status === 'stale' || u.status === 'claimed');
  const leftBytes = left.reduce((s, u) => s + u.bytes, 0);
  const live = L.units.filter(u => u.status !== 'removed');
  const tiers = {}; for (const u of live) tiers[u.tier] = (tiers[u.tier] || 0) + 1;
  return { project: L.project, root: L.root, commit: L.commit, plannedAt: L.plannedAt, refreshedAt: L.refreshedAt ?? null,
    files: L.fileCount, units: L.units.length, byStatus: by,
    coverage: L.units.length ? Math.round(100 * done.length / L.units.length) : 0,
    memories: done.reduce((s, u) => s + (u.memories || 0), 0),
    tiers, budget: L.budget, fullReadTokens: live.reduce((s, u) => s + unitTokens(u, 'deep'), 0),
    remaining: { units: left.length, bytes: leftBytes, estTokens: left.reduce((s, u) => s + unitTokens(u), 0) }, skipped: L.skipped };
}
function printSummary(s) {
  console.log(`awm learn · ${s.project} · ${s.root}${s.commit ? ' @ ' + s.commit : ''}`);
  console.log(`${s.files} files in ${s.units} units · coverage ${s.coverage}% · ${s.memories} memories written`);
  console.log(`status: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`depth: ${Object.entries(s.tiers).map(([k, v]) => `${v} ${k}`).join(' · ')} · budget ${(s.budget / 1000).toFixed(0)}k tokens (reading everything in full: ~${(s.fullReadTokens / 1000).toFixed(0)}k)`);
  console.log(`remaining: ${s.remaining.units} units, ${kb(s.remaining.bytes)} on disk, ~${(s.remaining.estTokens / 1000).toFixed(0)}k tokens at the planned depth`);
  console.log(`not read: ${Object.entries(s.skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}`);
}

// ---------- commands ----------
const now = () => new Date().toISOString();
// Several agents share one ledger: every command that changes it holds a lock for its whole
// read-modify-write, so two agents can't claim the same unit or lose each other's "done".
if (['plan', 'next', 'done', 'skip', 'release', 'deepen', 'refresh'].includes(cmd)) {
  mkdirSync(ROOT_DIR, { recursive: true });
  const lock = join(ROOT_DIR, '.lock');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > deadline) die('The ledger is locked by another agent (remove ' + lock + ' if no agent is running).');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  process.on('exit', () => { try { rmSync(lock, { recursive: true, force: true }); } catch {} });
}

switch (cmd) {
  case 'plan': {
    const target = positional[0]; if (!target) die('Usage: plan <path> [--project NAME]');
    const root = resolve(target); if (!existsSync(root)) die('No such path: ' + root);
    const project = typeof flag('project') === 'string' ? flag('project') : basename(root);
    if (existsSync(ledgerPath(project)) && !flag('force')) die(`A ledger for "${project}" exists. Use refresh, or plan --force to start over.`);
    const budget = Number(flag('unit-kb', 48)) * 1000;
    const excl0 = typeof flag('exclude') === 'string' ? flag('exclude').split(',').map(s => s.trim()).filter(Boolean) : [];
    const { files, skipped } = inventory(root, !!flag('include-generated'), excl0, budget);
    const units = buildUnits(files, budget, churn(root));
    const exclude = typeof flag('exclude') === 'string' ? flag('exclude').split(',').map(s => s.trim()).filter(Boolean) : [];
    const floor = floorTokens(units);
    const tokenBudget = flag('budget') !== undefined ? Number(flag('budget')) : floor + 300000;
    if (tokenBudget < floor) console.error(`note: --budget ${tokenBudget} is below the ~${Math.round(floor / 1000)}k it takes to skim everything; every unit stays at skim depth. Narrow the scope with --exclude or a sub-folder, or raise --budget.`);
    assignTiers(units, tokenBudget);
    const kinds = {}; for (const f of files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    const L = { version: 1, project, root, commit: headCommit(root), plannedAt: now(), unitBudget: budget, budget: tokenBudget, exclude, includeGenerated: !!flag('include-generated'), fileCount: files.length, kinds, skipped, units };
    save(L);
    const s = summary(L);
    printSummary(s);
    console.log(`file kinds: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    console.log(`top units: ${[...units].sort((a, b) => b.priority - a.priority).slice(0, 8).map(u => u.id).join(' | ')}`);
    console.log(`ledger: ${ledgerPath(project)}`);
    break;
  }
  case 'next': {
    const L = load(findProject()); const n = Number(flag('n', 1)); const agent = typeof flag('agent') === 'string' ? flag('agent') : 'agent';
    // A claim older than 2 hours is treated as abandoned.
    const stale = Date.now() - 2 * 3600e3;
    const open = L.units.filter(u => u.status === 'stale' || u.status === 'pending' || (u.status === 'claimed' && Date.parse(u.claimedAt) < stale))
      .sort((a, b) => (a.status === 'stale' ? -1 : 0) - (b.status === 'stale' ? -1 : 0) || b.priority - a.priority);
    const picked = open.slice(0, n);
    for (const u of picked) { u.prevStatus = u.status === 'claimed' ? 'pending' : u.status; u.status = 'claimed'; u.claimedBy = agent; u.claimedAt = now(); }
    save(L);
    console.log(JSON.stringify(picked.map(u => ({ id: u.id, kind: u.kind, tier: u.tier, readBytesPerFile: u.tier === 'deep' ? 'all' : (u.tier === 'sample' ? SAMPLE_BYTES : SKIM_BYTES), files: u.files, ...(u.ranges ? { lines: u.ranges.map(r => `${r.path}:${r.start}-${r.end}`) } : {}), bytes: u.bytes, hash: u.hash, refresh: u.prevStatus === 'stale', previousMemories: u.memories || 0 })), null, 1));
    if (!picked.length) console.error('Nothing left: every unit is done or skipped. Run refresh to pick up changes.');
    break;
  }
  case 'deepen': {
    // The agent found a skimmed unit matters more than the plan guessed: read it in full.
    const id = positional[0]; if (!id) die('Usage: deepen <unitId>');
    const L = load(findProject()); const u = L.units.find(x => x.id === id); if (!u) die('No unit ' + id);
    u.tier = 'deep'; if (u.status === 'done') u.status = 'stale';
    save(L); console.log(`${id}: deep (${u.status})`); break;
  }
  case 'done': case 'skip': case 'release': {
    const id = positional[0]; if (!id) die(`Usage: ${cmd} <unitId>`);
    const L = load(findProject()); const u = L.units.find(x => x.id === id); if (!u) die('No unit ' + id);
    if (cmd === 'release') { u.status = u.prevStatus || 'pending'; u.claimedBy = null; u.claimedAt = null; }
    else if (cmd === 'skip') { u.status = 'skipped'; u.note = typeof flag('note') === 'string' ? flag('note') : null; }
    else { u.status = 'done'; u.memories = Number(flag('memories', 0)); u.note = typeof flag('note') === 'string' ? flag('note') : u.note; u.learnedAt = now(); u.learnedCommit = headCommit(L.root); u.learnedHash = u.hash; }
    save(L); console.log(`${id}: ${u.status}`); break;
  }
  case 'status': {
    const s = summary(load(findProject()));
    if (flag('json')) console.log(JSON.stringify(s, null, 1)); else printSummary(s);
    break;
  }
  case 'refresh': {
    const L = load(findProject());
    const { files, skipped } = inventory(L.root, !!L.includeGenerated, L.exclude || [], L.unitBudget);
    const fresh = buildUnits(files, L.unitBudget, churn(L.root));
    assignTiers(fresh, L.budget ?? 400000);
    const old = new Map(L.units.map(u => [u.id, u]));
    const changes = { stale: [], added: [], removed: [] };
    const units = fresh.map(f => {
      const o = old.get(f.id);
      if (!o) { changes.added.push(f.id); return f; }
      old.delete(f.id);
      if (o.hash === f.hash) return { ...o, files: f.files, fileBytes: f.fileBytes, bytes: f.bytes, priority: f.priority, ranges: f.ranges };
      const wasLearned = o.status === 'done' || o.status === 'stale';
      if (wasLearned) changes.stale.push(f.id);
      return { ...f, tier: o.tier ?? f.tier, status: wasLearned ? 'stale' : o.status === 'skipped' ? 'skipped' : 'pending', memories: o.memories, learnedAt: o.learnedAt, learnedCommit: o.learnedCommit, note: o.note };
    });
    for (const o of old.values()) { changes.removed.push(o.id); units.push({ ...o, status: 'removed' }); }
    Object.assign(L, { units, fileCount: files.length, skipped, commit: headCommit(L.root), refreshedAt: now() });
    save(L);
    printSummary(summary(L));
    console.log(JSON.stringify(changes, null, 1));
    break;
  }
  case 'list': {
    if (!existsSync(ROOT_DIR)) { console.log('none'); break; }
    for (const d of readdirSync(ROOT_DIR)) if (existsSync(ledgerPath(d))) { const s = summary(load(d)); console.log(`${d}: ${s.coverage}% of ${s.units} units · ${s.memories} memories · ${s.root}`); }
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(3, 25).map(l => l.replace(/^ \* ?/, '')).join('\n'));
}
