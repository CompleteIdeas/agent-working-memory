// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * `awm vault` — use what AWM knows without saying it (S1b, docs/vault.md).
 *
 *   awm vault list                              what is sealed (never the values)
 *   awm vault run <id> [--env NAME] -- <cmd>    run <cmd> with the value in $NAME (default AWM_SECRET)
 *   awm vault allow <id> "<command prefix>"     let `run` use this value for commands starting so
 *   awm vault disallow <id> "<command prefix>"
 *   awm vault reveal <id>                       print the value — interactive terminal only
 *   awm vault forget <id>                       delete a sealed value (memories keep a dead handle)
 *   awm vault status                            where the vault and its key live
 *
 * The rules that make this safe for an agent to call through its shell tool:
 *   - nothing that runs non-interactively ever prints a value: an agent's shell is not a
 *     TTY, so `reveal` refuses it and `run` scrubs the value from everything it relays;
 *   - `run` injects only into a command whose prefix the user allowed, and never into a
 *     command that chains or redirects (`;`, `&&`, `|`, `>`, backticks, `$(`), where a
 *     prefix check would mean nothing. Anything else needs a human at a terminal to say yes.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Vault, scrub, handleText, hasShellChaining, vaultPathFor } from '../core/vault.js';

function openVault(): Vault {
  const storePath = process.env.AWM_DB_PATH ?? join(homedir(), '.awm', 'memory.db');
  return new Vault(vaultPathFor(resolve(storePath)));
}

/** Interpreters, shells and network tools: allowing one hands the value to arbitrary code. */
const RISKY_PREFIX = /^(?:node|python3?|py|bash|sh|zsh|cmd|powershell|pwsh|perl|ruby|deno|bun|npx|curl|wget|nc|ssh|scp|env)(?:\.exe)?(?:\s|$)/i;

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

function usage(): void {
  console.log(`awm vault — sealed values AWM knows but does not tell

  awm vault list
  awm vault run <id> [--env NAME] -- <command ...>
  awm vault allow <id> "<command prefix>"
  awm vault disallow <id> "<command prefix>"
  awm vault reveal <id>          (interactive terminal only)
  awm vault forget <id>
  awm vault status
  awm vault migrate [--apply] [--db <memory.db>]
                                 seal secrets already in the store (dry run unless --apply)`);
}

/**
 * Bring a store written before the vault up to the same standard as new writes: secrets in
 * memory text are sealed (the memory keeps a handle, so nothing it knew is lost); secrets in
 * recall-query logs, checkpoints and awm.log are masked. Then the old bytes are actually
 * removed — an UPDATE leaves the previous text in free pages and old FTS segments until the
 * index is optimized and the file vacuumed.
 *
 * SQLite stores only. Dry run by default; --apply copies memory.db aside first.
 */
async function migrate(vault: Vault, args: string[]): Promise<number> {
  const apply = args.includes('--apply');
  const dbIdx = args.indexOf('--db');
  const dbPath = resolve(dbIdx >= 0 ? args[dbIdx + 1]! : (process.env.AWM_DB_PATH ?? join(homedir(), '.awm', 'memory.db')));
  if (!existsSync(dbPath) || statSync(dbPath).isDirectory()) {
    console.error(`migrate works on a SQLite memory.db; not found or not a file: ${dbPath}`);
    return 1;
  }
  const { default: Database } = await import('better-sqlite3');
  const { redactText } = await import('../core/redact.js');
  const { setActiveVault } = await import('../core/vault.js');
  // redactText seals through the process-wide vault; point it at this one for the run.
  setActiveVault(vault);
  process.env.AWM_VAULT = 'on';

  const db = new Database(dbPath);
  const counts = new Map<string, number>();
  const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);

  type Change = { sql: string; params: unknown[] };
  const changes: Change[] = [];
  const seal = (s: string | null) => {
    if (!s) return { text: s, n: 0 };
    // Dry run must not write to the vault either: detect with sealing off.
    const r = redactText(s, { seal: apply });
    for (const f of r.findings) if (f.masked) bump(f.type);
    return { text: r.text, n: r.findings.filter((f) => f.masked).length };
  };
  const mask = (s: string | null) => {
    if (!s) return { text: s, n: 0 };
    const r = redactText(s);
    return { text: r.text, n: r.findings.filter((f) => f.masked).length };
  };

  let engrams = 0;
  for (const row of db.prepare('SELECT id, concept, content, tags FROM engrams').all() as Array<{ id: string; concept: string; content: string; tags: string }>) {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags ?? '[]'); } catch { /* leave tags alone */ }
    const c = seal(row.concept), b = seal(row.content);
    const t = tags.map((x) => seal(x));
    if (c.n + b.n + t.reduce((a, x) => a + x.n, 0) === 0) continue;
    engrams++;
    changes.push({ sql: 'UPDATE engrams SET concept = ?, content = ?, tags = ? WHERE id = ?',
      params: [c.text, b.text, JSON.stringify(t.map((x) => x.text)), row.id] });
  }

  /**
   * Pass 2 — every text column in every table, engrams included: the shape rules plus every
   * value the vault now knows. The rehearsal on a copy of the live store found secrets in
   * coordination tasks, events and mailbox rows, entity mentions and recall logs, and the
   * same passwords repeated without a label in 20-40 later memories. A fixed list of tables
   * missed all of that; sweeping every column does not.
   */
  const sweep = (): Change[] => {
    const out: Change[] = [];
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((t) => t.name)
      .filter((t) => !t.startsWith('sqlite_') && !t.startsWith('engrams_fts'));
    for (const table of tables) {
      let cols: Array<{ name: string; type: string }> = [];
      try { cols = db.prepare(`PRAGMA table_info("${table}")`).all() as any; } catch { continue; }
      for (const col of cols) {
        if (/BLOB|INT|REAL|NUM/i.test(col.type)) continue;
        let rows: Array<{ rid: number; v: unknown }> = [];
        try { rows = db.prepare(`SELECT rowid AS rid, "${col.name}" AS v FROM "${table}" WHERE typeof("${col.name}") = 'text'`).all() as any; }
        catch { continue; } // WITHOUT ROWID tables: none of AWM's hold free text
        for (const row of rows) {
          const m = mask(row.v as string);
          if (m.n === 0) continue;
          out.push({ sql: `UPDATE "${table}" SET "${col.name}" = ? WHERE rowid = ?`, params: [m.text, row.rid] });
        }
      }
    }
    return out;
  };

  const logPath = join(dirname(dbPath), 'awm.log');
  const sweepLog = (): { lines: number; text: string | null } => {
    if (!existsSync(logPath)) return { lines: 0, text: null };
    let lines = 0;
    const out = readFileSync(logPath, 'utf8').split('\n').map((l) => { const m = mask(l); if (m.n) lines++; return m.text ?? l; });
    return { lines, text: lines ? out.join('\n') : null };
  };

  console.log(`${apply ? 'Migrating' : 'Dry run —'} ${dbPath}`);
  console.log(`  memories with secrets the rules can see: ${engrams} (sealed into the vault, handle left in place)`);
  for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${type.padEnd(22)} ${n}`);

  if (!apply) {
    const pre = sweep();
    console.log(`  other rows the rules can see (logs, checkpoints, coordination, entities): ${pre.length}`);
    console.log(`  awm.log lines: ${sweepLog().lines}`);
    console.log('  + every later occurrence of a sealed value, anywhere, found once pass 1 has sealed it.');
    console.log('\nNothing changed. Stop AWM (close the sessions using it), then run again with --apply.');
    db.close();
    return 0;
  }

  // Back up first. The copy still holds the plaintext — say so, loudly.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbPath}.pre-vault-${stamp}`;
  copyFileSync(dbPath, backup);

  // Pass 1: seal what the rules can see in memory text.
  db.transaction(() => { for (const ch of changes) db.prepare(ch.sql).run(...ch.params); })();
  // Pass 2: now that the vault knows those values, sweep everything for them and the rules.
  const swept = sweep();
  db.transaction(() => { for (const ch of swept) db.prepare(ch.sql).run(...ch.params); })();
  const log = sweepLog();
  if (log.text !== null) writeFileSync(logPath, log.text);
  console.log(`  pass 2: ${swept.length} more rows across all tables; awm.log lines: ${log.lines}`);

  // Remove the old bytes: FTS keeps superseded segments and SQLite keeps freed pages.
  try { db.exec(`INSERT INTO engrams_fts(engrams_fts) VALUES('optimize')`); } catch (e) { console.error(`FTS optimize failed: ${(e as Error).message}`); }
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); } catch (e) {
    console.error(`VACUUM failed (${(e as Error).message}). Old text may remain in free pages until it runs — close every AWM session and run migrate again.`);
  }
  db.close();

  console.log(`\nDone. ${vault.list().length} value(s) now in the vault (${vault.path}).`);
  console.log(`BACKUP: ${backup}`);
  console.log('  ⚠ The backup still contains every secret in plaintext. Check the store works, then delete it.');
  console.log('  Restart AWM sessions (/mcp) so they stop serving cached text.');
  return 0;
}

export async function vaultCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') { usage(); return 0; }
  const vault = openVault();
  try {
    switch (sub) {
      case 'status': {
        console.log(`Vault: ${vault.path}`);
        console.log(`Key:   ${vault.keyStore === 'keyring' ? 'OS credential store (unlocked by your login)' : `key file beside the vault — weaker; anyone who can read both files can open it`}`);
        console.log(`Items: ${vault.list().length}`);
        return 0;
      }
      case 'list': {
        const items = vault.list();
        if (items.length === 0) { console.log('The vault is empty.'); return 0; }
        for (const it of items) {
          console.log(`${handleText(it.type, it.last4, it.id)}  used ${it.useCount}×${it.lastUsedAt ? `, last ${it.lastUsedAt}` : ''}`);
          if (it.label) console.log(`    sealed after: "${it.label.slice(-70)}"`);
          console.log(`    allowed: ${it.allow.length ? it.allow.map((p) => `"${p}"`).join(', ') : '(none — run asks first)'}`);
        }
        return 0;
      }
      case 'allow':
      case 'disallow': {
        const [id, prefix] = rest;
        if (!id || !prefix) { usage(); return 2; }
        if (hasShellChaining(prefix)) { console.error('A prefix cannot contain ; & | ` < > or $( .'); return 2; }
        if (sub === 'allow' && RISKY_PREFIX.test(prefix)) {
          // An interpreter or a network tool can do anything with the value, including send it elsewhere.
          console.error(`Warning: "${prefix}" can run arbitrary code or reach the network, so allowing it lets `
            + 'any command it runs read and send the value. Prefer the specific tool (e.g. "railway up").');
        }
        if (sub === 'allow') vault.allow(id, prefix); else vault.disallow(id, prefix);
        console.log(`${sub === 'allow' ? 'Allowed' : 'Removed'}: #${id} for "${prefix}"`);
        return 0;
      }
      case 'forget': {
        const [id] = rest;
        if (!id) { usage(); return 2; }
        console.log(vault.forget(id) ? `Forgotten: #${id}. Memories that mention it keep the handle, which now opens nothing.` : `No vault item ${id}`);
        return 0;
      }
      case 'reveal': {
        const [id] = rest;
        if (!id) { usage(); return 2; }
        const item = vault.get(id);
        if (!item) { console.error(`No vault item ${id}`); return 1; }
        if (!interactive()) {
          console.error('reveal prints a secret, so it only runs at an interactive terminal (not from an agent\'s shell). '
            + 'To USE the value without showing it: awm vault run <id> --env NAME -- <command>');
          return 3;
        }
        const typed = await ask(`Reveal ${handleText(item.type, item.last4, item.id)}? Type the id to confirm: `);
        if (typed.replace(/^#/, '') !== item.id) { console.error('Not confirmed.'); return 1; }
        console.log(vault.open(item.id));
        vault.recordUse(item.id);
        return 0;
      }
      case 'run': {
        const dash = rest.indexOf('--');
        if (dash < 1 || dash === rest.length - 1) { usage(); return 2; }
        const head = rest.slice(0, dash);
        const cmdParts = rest.slice(dash + 1);
        const id = head[0]!.replace(/^#/, '');
        const envIdx = head.indexOf('--env');
        const envName = envIdx >= 0 ? head[envIdx + 1] : 'AWM_SECRET';
        if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) { console.error('--env needs a variable name'); return 2; }
        const item = vault.get(id);
        if (!item) { console.error(`No vault item ${id}`); return 1; }
        const command = cmdParts.join(' ');

        if (!vault.isAllowed(id, command)) {
          const why = hasShellChaining(command)
            ? 'the command chains or redirects (; & | ` < > $( ), so no allow-list can vouch for it'
            : `no allowed prefix matches (allowed: ${item.allow.length ? item.allow.map((p) => `"${p}"`).join(', ') : 'none'})`;
          if (!interactive()) {
            console.error(`Refused: ${why}.\nA person can allow it once at a terminal, or always with: awm vault allow ${id} "<prefix>"`);
            return 3;
          }
          const yes = await ask(`${why}.\nRun "${command}" with ${handleText(item.type, item.last4, item.id)} in $${envName}? [y/N] `);
          if (!/^y(es)?$/i.test(yes)) { console.error('Not run.'); return 1; }
        }

        const value = vault.open(id);
        const handle = handleText(item.type, item.last4, item.id);
        const res = spawnSync(command, { shell: true, env: { ...process.env, [envName]: value }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        vault.recordUse(id);
        // Whatever the command printed goes to the agent's transcript: scrub the value first.
        if (res.stdout) process.stdout.write(scrub(res.stdout, value, handle));
        if (res.stderr) process.stderr.write(scrub(res.stderr, value, handle));
        if (res.error) { console.error(scrub(res.error.message, value, handle)); return 1; }
        return res.status ?? 1;
      }
      case 'migrate':
        return await migrate(vault, rest); // await: the finally below closes the vault
      default:
        usage();
        return 2;
    }
  } finally {
    vault.close();
  }
}
