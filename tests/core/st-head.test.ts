/**
 * The sentence-transformers scoring head (src/core/st-head.ts): safetensors parsing and the
 * head maths, against values computed by hand. No network: the model files are written into a
 * temporary cache directory first.
 *
 * Run: npx vitest run tests/core/st-head.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '@huggingface/transformers';
import { loadStHead, parseSafetensors } from '../../src/core/st-head.js';

function safetensors(tensors: Record<string, { shape: number[]; data: number[]; dtype?: 'F32' | 'BF16' }>): Buffer {
  const header: Record<string, unknown> = {};
  const parts: Buffer[] = [];
  let off = 0;
  for (const [name, t] of Object.entries(tensors)) {
    const dtype = t.dtype ?? 'F32';
    const b = Buffer.alloc(t.data.length * (dtype === 'F32' ? 4 : 2));
    t.data.forEach((v, i) => {
      if (dtype === 'F32') b.writeFloatLE(v, i * 4);
      else { const f = Buffer.alloc(4); f.writeFloatLE(v); b.writeUInt16LE(f.readUInt16LE(2), i * 2); }
    });
    header[name] = { dtype, shape: t.shape, data_offsets: [off, off + b.length] };
    off += b.length; parts.push(b);
  }
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(h.length));
  return Buffer.concat([len, h, ...parts]);
}

describe('st-head', () => {
  const MODEL = 'test-org/tiny-head';
  let cache: string;
  let saved: { cacheDir: any; allowRemoteModels: any };

  beforeAll(() => {
    saved = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels };
    cache = mkdtempSync(join(tmpdir(), 'awm-sthead-'));
    env.cacheDir = cache; env.allowRemoteModels = false;
    const root = join(cache, MODEL);
    const put = (p: string, body: string | Buffer) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); };
    put('modules.json', JSON.stringify([
      { path: '', type: 'sentence_transformers.base.modules.transformer.Transformer' },
      { path: '1_Pooling', type: 'sentence_transformers.sentence_transformer.modules.pooling.Pooling' },
      { path: '2_Dense', type: 'sentence_transformers.base.modules.dense.Dense' },
      { path: '3_LayerNorm', type: 'sentence_transformers.sentence_transformer.modules.layer_norm.LayerNorm' },
      { path: '4_Dense', type: 'sentence_transformers.base.modules.dense.Dense' },
    ]));
    put('1_Pooling/config.json', JSON.stringify({ pooling_mode: 'cls' }));
    // Dense 2->2, no bias, Identity so the arithmetic is checkable: swaps the two features.
    put('2_Dense/config.json', JSON.stringify({ bias: false, activation_function: 'torch.nn.modules.linear.Identity' }));
    put('2_Dense/model.safetensors', safetensors({ 'linear.weight': { shape: [2, 2], data: [0, 1, 1, 0] } }));
    put('3_LayerNorm/config.json', JSON.stringify({ dimension: 2 }));
    put('3_LayerNorm/model.safetensors', safetensors({ 'norm.weight': { shape: [2], data: [1, 1] }, 'norm.bias': { shape: [2], data: [0, 0] } }));
    put('4_Dense/config.json', JSON.stringify({ bias: true, activation_function: 'torch.nn.modules.linear.Identity' }));
    put('4_Dense/model.safetensors', safetensors({ 'linear.weight': { shape: [1, 2], data: [2, -1] }, 'linear.bias': { shape: [1], data: [0.5] } }));
  });
  afterAll(() => {
    env.cacheDir = saved.cacheDir; env.allowRemoteModels = saved.allowRemoteModels;
    rmSync(cache, { recursive: true, force: true });
  });

  it('parses F32 and BF16 tensors', () => {
    const t = parseSafetensors(safetensors({ a: { shape: [2], data: [1.5, -2] }, b: { shape: [1], data: [3], dtype: 'BF16' } }));
    expect(Array.from(t.a!.data)).toEqual([1.5, -2]);
    expect(t.b!.data[0]).toBe(3);
  });

  it('applies CLS pooling, Dense, LayerNorm and the scoring Dense in order', async () => {
    const head = await loadStHead(MODEL);
    expect(head?.pooling).toBe('cls');
    // Two tokens; CLS = [3, 1]. Dense swaps -> [1, 3]. LayerNorm -> [-1, 1] (to 1e-5 eps).
    // Score = 2*(-1) + (-1)*(1) + 0.5 = -2.5.
    const states = Float32Array.from([3, 1, 100, 100]);
    expect(head!.score(states, 2, 2)).toBeCloseTo(-2.5, 3);
  });

  it('returns null for a model without modules.json (the plain classifier path)', async () => {
    expect(await loadStHead('test-org/no-such-model')).toBeNull();
  });
});
