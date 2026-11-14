// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * A memory must never supersede itself. A write close to an existing memory is merged into it
 * (reinforced) and returns that memory's id; a caller that then supersedes old -> returned id
 * used to mark the memory superseded by itself, which hid it from recall. Found in the
 * 2026-11-04 awm-learn re-run (16 memories in a real store carried superseded_by = own id).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EngramStore } from '../../src/storage/sqlite.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `awm-supersede-self-${Date.now()}.db`);
let store: EngramStore;

afterEach(() => {
  store.close();
  for (const s of ['', '-shm', '-wal']) try { unlinkSync(TEST_DB + s); } catch {}
});

describe('supersedeEngram', () => {
  it('ignores a request to supersede a memory with itself', () => {
    store = new EngramStore(TEST_DB);
    const e = store.createEngram({ agentId: 'a', concept: 'Club rollover copies fees', content: 'Rolling a season forward copies each program fee.', salience: 0.7, confidence: 0.6 });
    store.supersedeEngram(e.id, e.id);
    const after = store.getEngram(e.id)!;
    expect(after.supersededBy ?? null).toBeNull();
    expect(after.supersedes ?? null).toBeNull();
  });

  it('still links two different memories', () => {
    store = new EngramStore(TEST_DB);
    const a = store.createEngram({ agentId: 'a', concept: 'Old fee rule', content: 'Rollover resets fees to zero.', salience: 0.7, confidence: 0.6 });
    const b = store.createEngram({ agentId: 'a', concept: 'New fee rule', content: 'Rollover copies fees.', salience: 0.7, confidence: 0.6 });
    store.supersedeEngram(a.id, b.id);
    expect(store.getEngram(a.id)!.supersededBy).toBe(b.id);
    expect(store.getEngram(b.id)!.supersedes).toBe(a.id);
  });
});
