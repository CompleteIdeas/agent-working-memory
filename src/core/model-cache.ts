// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Model cache directory — makes `HF_HOME` (and `AWM_CACHE_DIR`) actually work.
 *
 * ROOT CAUSE (found 2026-08-22 investigating flaky model loads in ephemeral Docker
 * containers): @huggingface/transformers has NO built-in environment-variable support
 * for its cache location — it reads only `env.cacheDir`, set in code, and nothing else.
 * Left unset, it defaults to `<install-dir-of-@huggingface/transformers>/.cache/` —
 * inside node_modules, wiped on every `npm install`/`npm ci`, i.e. every Docker build
 * and every global upgrade re-downloads all three models from scratch.
 *
 * `docs/deployment.md` has instructed `HF_HOME=/data/models` for Railway/Fly/Render
 * persistence since it was written — that variable was a silent no-op the whole time;
 * nothing in AWM ever read it. This module makes it real, so existing deployments start
 * working with ZERO config changes on the user's end. `AWM_CACHE_DIR` (referenced in
 * docs/architecture.md, also previously fictional) is honored as an AWM-specific
 * override, and the default is now genuinely persistent for a bare npm install too
 * (previously it was ephemeral there as well, just less obviously so).
 *
 * Precedence: AWM_CACHE_DIR > HF_HOME > <packageRoot>/data/models.
 *
 * MUST run before the first `pipeline()` / `AutoTokenizer.from_pretrained()` /
 * `AutoModel*.from_pretrained()` call in the process — `env.cacheDir` is read at
 * download/load time, not import time, but there's no reason to risk a race, so every
 * model-loading module in src/core/ calls `ensureModelCacheDir()` before its first
 * library call. Idempotent — safe to call from all three.
 */

import { env } from '@huggingface/transformers';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let configured = false;

function resolvePackageRoot(): string {
  // This file lives at src/core/model-cache.ts (dev, via tsx) or
  // dist/core/model-cache.js (built) — either way, two levels up is the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(here));
}

export function ensureModelCacheDir(): string {
  if (configured) return env.cacheDir!;
  const dir = process.env.AWM_CACHE_DIR || process.env.HF_HOME || join(resolvePackageRoot(), 'data', 'models');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  env.cacheDir = dir;
  configured = true;
  return dir;
}
