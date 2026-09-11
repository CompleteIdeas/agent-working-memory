import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { startSidecar, type SidecarHandle } from '../src/hooks/sidecar.js';
import type { IEngramStore } from '../src/storage/store.js';

/**
 * 0.14.2: the sidecar walks upward from its preferred port instead of giving up.
 *
 * Every Claude Code session spawns its own MCP process, and each one used to ask
 * for exactly 8401. On EADDRINUSE the sidecar logged "hooks disabled" and stopped,
 * so with N concurrent sessions only the first had working hooks (observed
 * 2026-09-11: 4 of 5 live sessions had no sidecar). These tests pin the new
 * behaviour: bind the next free port, report it on /health, expose it via
 * boundPort(), and still fail soft when the whole range is busy.
 */

const BASE_PORT = 18461; // well clear of the real 8401.. range and the other sidecar test
const stubStore = { getCheckpoint: async () => null } as unknown as IEngramStore;

const opened: Array<SidecarHandle | Server> = [];
afterEach(async () => {
  for (const h of opened.splice(0)) {
    await new Promise<void>((resolve) => {
      if ('boundPort' in h) { h.close(); resolve(); } else { h.close(() => resolve()); }
    });
  }
});

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => { opened.push(s); resolve(s); });
  });
}

function waitForBind(h: SidecarHandle, timeoutMs = 3000): Promise<number | null> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const p = h.boundPort();
      if (p !== null || Date.now() - t0 > timeoutMs) return resolve(p);
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function health(port: number) {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

describe('sidecar port range', () => {
  it('binds the preferred port when it is free, and /health reports it', async () => {
    const h = startSidecar({ store: stubStore, agentId: 'range-a', secret: null, port: BASE_PORT, portRange: 3, version: '9.9.9' });
    opened.push(h);
    expect(await waitForBind(h)).toBe(BASE_PORT);
    const { status, body } = await health(BASE_PORT);
    expect(status).toBe(200);
    expect(body.agentId).toBe('range-a');
    expect(body.port).toBe(BASE_PORT);
    expect(body.pid).toBe(process.pid);
    expect(body.version).toBe('9.9.9');
  });

  it('walks to the next free port when the preferred one is busy', async () => {
    await occupy(BASE_PORT);
    const h = startSidecar({ store: stubStore, agentId: 'range-b', secret: null, port: BASE_PORT, portRange: 3 });
    opened.push(h);
    expect(await waitForBind(h)).toBe(BASE_PORT + 1);
    const { body } = await health(BASE_PORT + 1);
    expect(body.agentId).toBe('range-b');
    expect(body.port).toBe(BASE_PORT + 1);
  });

  it('two sidecars for the same agent land on two different ports — N sessions, N sidecars', async () => {
    const a = startSidecar({ store: stubStore, agentId: 'work', secret: null, port: BASE_PORT, portRange: 5 });
    opened.push(a);
    expect(await waitForBind(a)).toBe(BASE_PORT);
    const b = startSidecar({ store: stubStore, agentId: 'work', secret: null, port: BASE_PORT, portRange: 5 });
    opened.push(b);
    expect(await waitForBind(b)).toBe(BASE_PORT + 1);
    // both answer, both identify as the same agent — a hook probing the range can pick either
    expect((await health(BASE_PORT)).body.agentId).toBe('work');
    expect((await health(BASE_PORT + 1)).body.agentId).toBe('work');
  });

  it('fails soft when every port in the range is busy: unbound, no throw, close() is safe', async () => {
    await occupy(BASE_PORT);
    await occupy(BASE_PORT + 1);
    const h = startSidecar({ store: stubStore, agentId: 'range-d', secret: null, port: BASE_PORT, portRange: 2 });
    opened.push(h);
    expect(await waitForBind(h, 800)).toBeNull();
    expect(() => h.close()).not.toThrow();
  });

  it('portRange 1 preserves the pre-0.14.2 behaviour: preferred port or nothing', async () => {
    await occupy(BASE_PORT);
    const h = startSidecar({ store: stubStore, agentId: 'range-e', secret: null, port: BASE_PORT, portRange: 1 });
    opened.push(h);
    expect(await waitForBind(h, 800)).toBeNull();
  });
});
