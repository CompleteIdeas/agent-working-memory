// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Sentence-transformers scoring head for cross-encoders whose ONNX file is only the backbone.
 *
 * Some current cross-encoders (the Ettin rerankers, `cross-encoder/ettin-reranker-*-v1`) ship
 * ONNX for the transformer alone and keep the scoring layers as sentence-transformers modules
 * beside it: Pooling -> Dense (+activation) -> LayerNorm -> Dense -> one logit. transformers.js
 * runs the ONNX file and returns hidden states, so without this head every pair scored the same
 * and recall ran effectively unranked (found 2026-10-30).
 *
 * Supported, because it is what those models use: CLS or mean pooling, Dense with GELU / Tanh /
 * Identity, LayerNorm, safetensors weights in F32, F16 or BF16. Anything else -> null, and the
 * caller keeps the plain sequence-classification path.
 */

import { env } from '@huggingface/transformers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Layer =
  | { kind: 'dense'; w: Float32Array; b: Float32Array | null; out: number; in: number; act: (x: number) => number }
  | { kind: 'layernorm'; w: Float32Array; b: Float32Array; eps: number };

export interface StHead {
  pooling: 'cls' | 'mean';
  /** Score one sequence from its token states (seq x dim, row-major) and attention mask. */
  score(states: Float32Array, seq: number, dim: number, mask?: ArrayLike<number | bigint>): number;
}

async function fetchFile(modelId: string, file: string): Promise<Buffer | null> {
  const local = join(env.cacheDir ?? '.', modelId, file);
  if (existsSync(local)) return readFileSync(local);
  if (env.allowRemoteModels === false) return null;
  const res = await fetch(`${env.remoteHost ?? 'https://huggingface.co/'}${modelId}/resolve/main/${file}`);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  try { mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, buf); } catch { /* cache is best-effort */ }
  return buf;
}

/** Parse a safetensors file into named Float32Arrays. */
export function parseSafetensors(buf: Buffer): Record<string, { shape: number[]; data: Float32Array }> {
  const n = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + n).toString('utf8')) as Record<string, any>;
  const base = 8 + n;
  const out: Record<string, { shape: number[]; data: Float32Array }> = {};
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const [s, e] = t.data_offsets as [number, number];
    const raw = buf.subarray(base + s, base + e);
    const count = (t.shape as number[]).reduce((a, b) => a * b, 1);
    const data = new Float32Array(count);
    if (t.dtype === 'F32') for (let i = 0; i < count; i++) data[i] = raw.readFloatLE(i * 4);
    else if (t.dtype === 'BF16') {
      const tmp = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < count; i++) { tmp.setUint32(0, raw.readUInt16LE(i * 2) << 16, true); data[i] = tmp.getFloat32(0, true); }
    } else if (t.dtype === 'F16') for (let i = 0; i < count; i++) data[i] = half(raw.readUInt16LE(i * 2));
    else throw new Error(`unsupported safetensors dtype ${t.dtype}`);
    out[name] = { shape: t.shape, data };
  }
  return out;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

// Exact (erf) GELU, as torch.nn.GELU() computes by default. erf by Abramowitz & Stegun 7.1.26
// (max error 1.5e-7).
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const ACTS: Record<string, (x: number) => number> = {
  'torch.nn.modules.activation.GELU': (x) => 0.5 * x * (1 + erf(x / Math.SQRT2)),
  'torch.nn.modules.activation.Tanh': Math.tanh,
  'torch.nn.modules.linear.Identity': (x) => x,
};

/** Load the head for `modelId`, or null when it has none this module can run. */
export async function loadStHead(modelId: string): Promise<StHead | null> {
  const modules = await fetchFile(modelId, 'modules.json');
  if (!modules) return null;
  const list = JSON.parse(modules.toString('utf8')) as Array<{ path: string; type: string }>;
  let pooling: 'cls' | 'mean' | null = null;
  const layers: Layer[] = [];
  for (const m of list) {
    if (!m.path) continue; // the transformer itself
    const cfgBuf = await fetchFile(modelId, `${m.path}/config.json`);
    if (!cfgBuf) return null;
    const cfg = JSON.parse(cfgBuf.toString('utf8'));
    if (/pooling\.Pooling$/.test(m.type)) {
      if (cfg.pooling_mode !== 'cls' && cfg.pooling_mode !== 'mean') return null;
      pooling = cfg.pooling_mode;
      continue;
    }
    const wBuf = await fetchFile(modelId, `${m.path}/model.safetensors`);
    if (!wBuf) return null;
    const ts = parseSafetensors(wBuf);
    const find = (suffix: string) => Object.entries(ts).find(([k]) => k.endsWith(suffix))?.[1];
    if (/dense\.Dense$/.test(m.type)) {
      const w = find('weight'); const act = ACTS[cfg.activation_function ?? 'torch.nn.modules.activation.Tanh'];
      if (!w || !act || w.shape.length !== 2) return null;
      layers.push({ kind: 'dense', w: w.data, b: cfg.bias === false ? null : (find('bias')?.data ?? null), out: w.shape[0]!, in: w.shape[1]!, act });
    } else if (/layer_norm\.LayerNorm$/.test(m.type)) {
      const w = find('weight'), b = find('bias');
      if (!w || !b) return null;
      layers.push({ kind: 'layernorm', w: w.data, b: b.data, eps: 1e-5 });
    } else return null;
  }
  if (!pooling || layers.length === 0) return null;
  const last = layers[layers.length - 1]!;
  if (last.kind !== 'dense' || last.out !== 1) return null;
  const pool = pooling;

  return {
    pooling: pool,
    score(states, seq, dim, mask) {
      let x = new Float32Array(dim);
      if (pool === 'cls') x.set(states.subarray(0, dim));
      else {
        let n = 0;
        for (let t = 0; t < seq; t++) {
          if (mask && !Number(mask[t])) continue;
          n++; for (let j = 0; j < dim; j++) x[j]! += states[t * dim + j]!;
        }
        for (let j = 0; j < dim; j++) x[j]! /= n || 1;
      }
      for (const l of layers) {
        if (l.kind === 'dense') {
          const y = new Float32Array(l.out);
          for (let o = 0; o < l.out; o++) {
            let s = l.b ? l.b[o]! : 0;
            const row = o * l.in;
            for (let i = 0; i < l.in; i++) s += l.w[row + i]! * x[i]!;
            y[o] = l.act(s);
          }
          x = y;
        } else {
          let mean = 0; for (const v of x) mean += v; mean /= x.length;
          let vr = 0; for (const v of x) vr += (v - mean) ** 2; vr /= x.length;
          const inv = 1 / Math.sqrt(vr + l.eps);
          for (let j = 0; j < x.length; j++) x[j] = (x[j]! - mean) * inv * l.w[j]! + l.b[j]!;
        }
      }
      return x[0]!;
    },
  };
}
