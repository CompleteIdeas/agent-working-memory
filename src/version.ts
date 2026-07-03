import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The running package version, read from package.json at runtime so the number
 * reported by /health, the startup banner, and the MCP server always matches
 * the actually-deployed build. Hand-maintained version literals drifted across
 * releases (a 0.10.0 build was still reporting 0.8.5/0.8.8) — this removes them.
 */
function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts (dev) and dist/version.js (build) both sit one level below
  // the package root; the ../../ fallback covers a deeper output nesting.
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const v = JSON.parse(readFileSync(join(here, rel), 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch {
      /* try the next candidate path */
    }
  }
  return '0.0.0';
}

export const VERSION: string = resolveVersion();
