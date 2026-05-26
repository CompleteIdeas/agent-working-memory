/**
 * Trace the test:tokens Auth-JWT failure end-to-end on both backends.
 *
 * Seeds the same conversation corpus into SQLite and PGlite, runs the
 * Auth-JWT recall query, and prints the disposition + top-5 results on
 * each backend so we can see WHERE the divergence is.
 *
 * Run: npx tsx scripts/trace-pglite-gap.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';

const AGENT = 'trace';

// Subset of the test:tokens conversation history — just the auth + db turns
// so we can see why Auth-JWT recall fails on PGlite. Full corpus is in
// tests/token-savings/runner.ts at the top.
const TURNS: Array<{ role: string; content: string; task: string }> = [
  { role: 'user',      content: 'How should we handle JWT for the API?', task: 'auth' },
  { role: 'assistant', content: 'For JWT, use HS256 algorithm. Access tokens expire in 15 minutes, refresh tokens in 7 days. Store refresh tokens in HttpOnly cookies with sameSite=strict. Validate signature on every request via middleware.', task: 'auth' },
  { role: 'user',      content: 'Should we add rate limiting to the auth endpoints?', task: 'auth' },
  { role: 'assistant', content: 'Yes, critical for auth endpoints. Use express-rate-limit with these limits: /auth/login: 5 attempts per 15 minutes per IP, /auth/refresh: 10 per minute, /auth/register: 3 per hour. Store rate limit data in Redis for distributed deployments, or in-memory for single instance.', task: 'auth' },
  { role: 'user',      content: 'What about RBAC for the admin panel?', task: 'auth' },
  { role: 'assistant', content: 'Implement role-based access control with these roles: admin (full access), editor (CRUD on content), viewer (read-only). Use authorize() middleware that checks JWT claims for role. Permissions stored in DB table user_roles. Add ABAC for fine-grained checks beyond roles.', task: 'auth' },
  { role: 'user',      content: 'Database queries are slow on the orders table. What can we do?', task: 'db-opt' },
  { role: 'assistant', content: 'Add composite indexes. For orders table: CREATE INDEX idx_orders_customer_date ON orders(customer_id, created_at DESC) for filtered date queries. Also add partial index for active orders only: CREATE INDEX idx_orders_active ON orders(status) WHERE status = active. Use GIN indexes for JSONB columns. Run EXPLAIN ANALYZE to verify index usage.', task: 'db-opt' },
  { role: 'user',      content: 'Should we use connection pooling for postgres?', task: 'db-opt' },
  { role: 'assistant', content: 'Yes. Use PgBouncer in transaction mode for connection pooling. Configure with pool_size=25 (matches CPU cores x 4), max_client_conn=1000, listen on port 6432. App connects to 6432 instead of 5432. Use SCRAM auth. Monitor pool saturation via SHOW POOLS command.', task: 'db-opt' },
  // Non-auth padding to make staging decisions meaningful
  { role: 'user',      content: 'The React bundle is too large.', task: 'react' },
  { role: 'assistant', content: 'Use code splitting and lazy loading with React.lazy + Suspense for routes. Split vendor bundle with manual chunks. Enable tree shaking. Compress with brotli. Target <200KB initial bundle.', task: 'react' },
  { role: 'user',      content: 'CI builds are slow.', task: 'ci' },
  { role: 'assistant', content: 'Parallelize tests with GitHub Actions matrix. Cache node_modules and Docker layers. Use buildx for multi-stage builds. Target <8 min total.', task: 'ci' },
  { role: 'user',      content: 'Need structured logging.', task: 'observability' },
  { role: 'assistant', content: 'Use pino with correlation IDs propagated via AsyncLocalStorage. Ship logs to Loki or CloudWatch.', task: 'observability' },
];

const QUERY = 'What JWT algorithm and token strategy did we decide on for authentication?';
const EXPECTED_KEYWORDS = ['HS256', 'refresh', 'access', '15 min', '7 day'];

async function runBackend(label: string, factory: () => Promise<{ store: any; close: () => Promise<void> | void }>) {
  console.log('\n======================================================================');
  console.log('Backend: ' + label);
  console.log('======================================================================');

  const { store, close } = await factory();
  const activation = new ActivationEngine(store);
  const connection = new ConnectionEngine(store, activation);

  // Seed corpus via the write pipeline (same code path as test:tokens uses).
  const dispositions = { active: 0, staging: 0, discard: 0, reinforce: 0 };
  const seededByTask: Record<string, Array<{ concept: string; disposition: string; salience: number; engramId: string }>> = {};
  for (const t of TURNS) {
    const concept = (t.role + ': ' + t.content).slice(0, 80);
    const tags = [`task=${t.task}`, `role=${t.role}`];
    const res = await performWrite(
      { store, connectionEngine: connection },
      { agentId: AGENT, concept, content: t.content, tags },
    );
    const disp = res.salience?.disposition ?? 'reinforce';
    dispositions[disp as keyof typeof dispositions] = (dispositions[disp as keyof typeof dispositions] ?? 0) + 1;
    if (!seededByTask[t.task]) seededByTask[t.task] = [];
    seededByTask[t.task].push({ concept: concept.slice(0, 50), disposition: disp, salience: res.salience?.score ?? 0, engramId: res.engram.id });
  }
  console.log('\nDispositions: ' + JSON.stringify(dispositions));
  console.log('\nAuth writes (the ones we expect to be recalled):');
  for (const w of seededByTask['auth'] ?? []) {
    console.log('  [' + w.disposition.padEnd(8) + '] sal=' + w.salience.toFixed(2) + ' ' + w.concept);
  }

  // Wait for async embeds to settle
  await new Promise(r => setTimeout(r, 2000));

  // Run the Auth-JWT recall (with includeStaging=true like test:tokens does)
  const results = await activation.activate({
    agentId: AGENT,
    context: QUERY,
    limit: 5,
    includeStaging: true,
    useReranker: true,
    useExpansion: true,
    internal: true,
  });

  console.log('\nTop-5 recall for "' + QUERY.slice(0, 60) + '..."');
  console.log('Confidence: ' + (results[0]?.confidence?.toFixed(3) ?? 'n/a'));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ps = r.phaseScores;
    const stage = r.engram.stage;
    const keywordHits = EXPECTED_KEYWORDS.filter(k => r.engram.content.toLowerCase().includes(k.toLowerCase())).length;
    console.log('  ' + (i + 1) + '. [' + r.score.toFixed(3) + '] [' + stage.padEnd(7) + '] kw=' + keywordHits + '/' + EXPECTED_KEYWORDS.length + ' txt=' + ps.textMatch.toFixed(2) + ' vec=' + ps.vectorMatch.toFixed(2) + ' rerank=' + ps.rerankerScore.toFixed(2) + ' :: ' + r.engram.content.slice(0, 80));
  }

  const allRetrieved = results.map(r => r.engram.content).join(' ').toLowerCase();
  const totalKw = EXPECTED_KEYWORDS.filter(k => allRetrieved.includes(k.toLowerCase())).length;
  console.log('\nKEYWORD COVERAGE: ' + totalKw + '/' + EXPECTED_KEYWORDS.length + ' (' + ((totalKw / EXPECTED_KEYWORDS.length) * 100).toFixed(0) + '%)');

  await close();
}

async function main() {
  // SQLite
  await runBackend('SQLite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-trace-sq-'));
    const store = new EngramStore(join(tmp, 'test.db'));
    return {
      store, close: () => {
        store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });

  // PGlite
  await runBackend('PGlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-trace-pg-'));
    const store = new PGliteEngramStore(join(tmp, 'pg'));
    await store.ready();
    return {
      store, close: async () => {
        await store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });
}

main().catch(err => { console.error(err); process.exit(1); });
