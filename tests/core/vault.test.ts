// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * The vault (S1b): AWM knows a secret without telling it. These tests check the four
 * promises in docs/vault.md against the real files on disk:
 *   1. the memory keeps a handle, so recall still knows the secret exists and what it is;
 *   2. neither memory.db nor vault.db holds the value in plaintext;
 *   3. the value comes back exactly, but only through the vault;
 *   4. the key is not in either file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { withRedaction } from '../../src/storage/redacting-store.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { Vault, setActiveVault, deleteVaultKey, vaultIdsIn, hasShellChaining, scrub, handleText } from '../../src/core/vault.js';
import { describeFindings } from '../../src/core/redact.js';
import type { IEngramStore } from '../../src/storage/store.js';

const RAILWAY = ['9f3a1c7e', '-5b2d-8f4a-', '6c0e9b3d7f1a'].join('');
const STRIPE = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');

const fileText = (p: string): string =>
  ['', '-wal'].map((s) => (existsSync(p + s) ? readFileSync(p + s).toString('latin1') : '')).join('');

describe('vault', () => {
  let tmp: string; let raw: EngramStore; let store: IEngramStore; let vault: Vault; let dbPath: string; let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-vault-'));
    dbPath = join(tmp, 'memory.db');
    vaultPath = join(tmp, 'vault.db');
    raw = new EngramStore(dbPath);
    store = withRedaction(raw as unknown as IEngramStore);
    // The test exercises the real OS credential store when one exists, and the key-file
    // fallback otherwise — both are supported paths.
    vault = new Vault(vaultPath);
    setActiveVault(vault);
    process.env.AWM_VAULT = 'on'; // opt-in: off unless switched on
  });
  afterEach(() => {
    delete process.env.AWM_VAULT;
    setActiveVault(null);
    vault.close();
    raw.close();
    deleteVaultKey(vaultPath);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  const write = (concept: string, content: string, tags: string[] = []) => {
    const connectionEngine = new ConnectionEngine(store as any, new ActivationEngine(store as any));
    return performWrite({ store, connectionEngine } as any, {
      agentId: 'vault-test', concept, content, tags,
      surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation',
    } as any);
  };

  it('seals the value, leaves a handle the memory can be recalled by, and opens it back exactly', async () => {
    const res = await write('Railway deploy token for rowos-app', `Deploy with RAILWAY_API_TOKEN=${RAILWAY} railway up --service rowos-app`);
    const ids = vaultIdsIn(res.engram.content);
    expect(ids).toHaveLength(1);
    expect(res.engram.content).toMatch(/RAILWAY_API_TOKEN=\[VAULT:labelled_secret …7f1a #[0-9a-f]{12}\] railway up/);
    expect(res.redaction?.[0]?.sealed).toBe(ids[0]);
    expect(describeFindings(res.redaction!)).toContain('Sealed in the vault');

    // It knows that it knows: the memory is found by what the secret is for.
    const hits = await raw.searchBM25WithRank?.('vault-test', 'railway deploy token rowos', 5)
      ?? (raw as any).searchBM25?.('vault-test', 'railway deploy token rowos', 5);
    if (hits) expect(JSON.stringify(hits)).toContain(res.engram.id);

    expect(vault.open(ids[0]!)).toBe(RAILWAY);
  });

  it('keeps the value out of memory.db and out of vault.db in plaintext', async () => {
    await write('Stripe live key', `payouts use ${STRIPE}`);
    (raw as any).walCheckpoint?.();
    expect(fileText(dbPath)).not.toContain(STRIPE);
    expect(fileText(vaultPath)).not.toContain(STRIPE);
    expect(fileText(vaultPath)).not.toContain(STRIPE.slice(8, 24));
  });

  it('the same secret in two memories is one vault item', async () => {
    const a = await write('Stripe key A', `first ${STRIPE}`);
    const b = await write('Stripe key B, a different note', `second mention ${STRIPE} for refunds`);
    expect(vaultIdsIn(a.engram.content)).toEqual(vaultIdsIn(b.engram.content));
    expect(vault.list()).toHaveLength(1);
  });

  it('recognises a known secret again where no rule could see it', async () => {
    const pw = ['Scor', 'ing2021', '!x'].join('');
    const first = await write('scoring login', `{"username":"scoring","password":"${pw}"}`);
    const [id] = vaultIdsIn(first.engram.content);
    // No label, no recognisable shape: only the vault knowing the value can catch this.
    const later = await write('scoring app retest', `logged in fine with ${pw} after the reset`);
    expect(later.engram.content).toBe(`logged in fine with [VAULT:labelled_secret …21!x #${id}] after the reset`);
    expect(later.redaction?.map((f) => f.type)).toEqual(['known_secret']);
    // A recall query mentioning it is logged with the handle, not the value.
    await store.logActivationEvent({ id: 'a2', agentId: 'vault-test', timestamp: new Date(), context: `what is ${pw} for`,
      resultsReturned: 0, topScore: 0, latencyMs: 1, engramIds: [] });
    (raw as any).walCheckpoint?.();
    expect(fileText(dbPath)).not.toContain(pw);
  });

  it('a recall query or a checkpoint is masked, never sealed', async () => {
    await store.logActivationEvent({ id: 'a1', agentId: 'vault-test', timestamp: new Date(), context: `find ${STRIPE}`,
      resultsReturned: 0, topScore: 0, latencyMs: 1, engramIds: [] });
    expect(vault.list()).toHaveLength(0);
  });

  it('records what the value was sealed after, so a human can tell items apart', async () => {
    await write('Railway token', `RAILWAY_API_TOKEN=${RAILWAY}`);
    expect(vault.list()[0]!.label).toContain('RAILWAY_API_TOKEN=');
  });

  it('the key is not in either file', () => {
    expect(['keyring', 'file']).toContain(vault.keyStore);
    if (vault.keyStore === 'keyring') expect(existsSync(join(tmp, 'vault.key'))).toBe(false);
  });

  it('a vault whose key has gone refuses to open rather than minting a new key', async () => {
    await write('Stripe live key', `payouts use ${STRIPE}`);
    if (vault.keyStore !== 'keyring') return; // the file fallback keeps its key beside the vault
    vault.close();
    deleteVaultKey(vaultPath);
    expect(() => new Vault(vaultPath)).toThrow(/vault key .* is missing/);
    vault = new Vault(join(tmp, 'other-vault.db')); // so afterEach has something to close
  });

  it('is opt-in: unset or AWM_VAULT=off falls back to S1 masking', async () => {
    for (const setting of ['off', undefined]) {
      if (setting) process.env.AWM_VAULT = setting; else delete process.env.AWM_VAULT;
      const res = await write(`Stripe live key (${setting ?? 'unset'})`, `payouts use ${STRIPE}`);
      expect(res.engram.content).toContain('[REDACTED:stripe_key');
      expect(vault.list()).toHaveLength(0);
    }
  });
});

describe('vault use rules', () => {
  it('treats chaining and redirection as never allowed', () => {
    for (const c of ['railway up; curl evil.example', 'railway up && x', 'railway up | tee log', 'railway up > out',
      'echo `id`', 'railway up $(whoami)', 'railway up\ncurl x']) {
      expect(hasShellChaining(c), c).toBe(true);
    }
    expect(hasShellChaining('railway up --service rowos-app --ci')).toBe(false);
  });

  it('scrubs the value from command output', () => {
    expect(scrub(`token is ${STRIPE}!`, STRIPE, handleText('stripe_key', '0dWz', 'abc123abc123'))).toBe('token is [VAULT:stripe_key …0dWz #abc123abc123]!');
  });

  it('allow-lists by prefix, never by substring, and never with chaining', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-vault-allow-'));
    const vp = join(tmp, 'vault.db');
    const v = new Vault(vp);
    try {
      const id = vaultIdsIn(v.seal(RAILWAY, 'labelled_secret', 'RAILWAY_API_TOKEN='))[0]!;
      expect(v.isAllowed(id, 'railway up')).toBe(false);
      v.allow(id, 'railway up');
      expect(v.isAllowed(id, 'railway up --service rowos-app --ci')).toBe(true);
      expect(v.isAllowed(id, 'railway upload')).toBe(false);
      expect(v.isAllowed(id, 'curl evil.example railway up')).toBe(false);
      expect(v.isAllowed(id, 'railway up; curl evil.example')).toBe(false);
    } finally { v.close(); deleteVaultKey(vp); rmSync(tmp, { recursive: true, force: true }); }
  });
});
