/**
 * Sweep AWM_PGLITE_BM25_M against the engram-count metric.
 *
 * For each M, spawn a child process that seeds the full test:tokens corpus
 * into a fresh PGlite store and reports the resulting active-engram count.
 * Target: match SQLite (~26 active engrams; PGlite at M=1 today is ~21).
 *
 * Run: npx tsx scripts/sweep-pglite-m.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const M_VALUES = [1, 2, 3, 5, 10, 20, 50];
const SCRIPT = join(import.meta.dirname, 'count-engrams-pglite.ts');

function runOne(M: number): Promise<{ M: number; count: number; meanLen: number; output: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AWM_PGLITE_BM25_M: String(M) };
    const child = spawn('npx', ['tsx', SCRIPT], { env, shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`M=${M} exited ${code}: ${stderr}`));
        return;
      }
      const countMatch = stdout.match(/COUNT=(\d+)/);
      const meanLenMatch = stdout.match(/MEANLEN=(\d+)/);
      const count = countMatch ? Number(countMatch[1]) : -1;
      const meanLen = meanLenMatch ? Number(meanLenMatch[1]) : -1;
      resolve({ M, count, meanLen, output: stdout });
    });
  });
}

async function main() {
  console.log('Sweeping AWM_PGLITE_BM25_M against post-seed engram count');
  console.log('Target: ~26 engrams (matches SQLite); current M=1 produces ~21\n');
  console.log('  M | engrams | mean len');
  console.log('----+---------+---------');
  for (const M of M_VALUES) {
    try {
      const { count, meanLen } = await runOne(M);
      console.log(`${String(M).padStart(3)} | ${String(count).padStart(7)} | ${String(meanLen).padStart(7)}`);
    } catch (err: any) {
      console.log(`${String(M).padStart(3)} | ERROR: ${err.message.split('\n')[0]}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
