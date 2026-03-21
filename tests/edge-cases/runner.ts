/**
 * Edge Case Tests — novel failure modes from Codex consultation.
 *
 * 8 scenarios testing subtle consolidation pathologies:
 *   1. Context Collapse — routine memories burying rare critical incidents
 *   2. Mega-Hub Toxicity — super-connected nodes contaminating unrelated queries
 *   3. Flashbulb Distortion — high-salience memories mutating under contradictory input
 *   4. Temporal Incoherence — memory ordering breaking under time-warp insertions
 *   5. Narcissistic Interference — self-referential memories overriding factual ones
 *   6. Identity Collision — same-name entities merging incorrectly
 *   7. Contradiction Trapping — conflicting facts being unjustly erased
 *   8. Bridge Overshoot — aggressive bridging creating false generalizations
 *
 * Run: npx tsx tests/edge-cases/runner.ts
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const RESULTS_FILE = join(import.meta.dirname, 'results.md');
const TMP_DIR = join(tmpdir(), 'awm-edge-cases');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let reqCounter = 0;

async function api(method: string, path: string, body?: any): Promise<any> {
  await sleep(5);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${BASE_URL}${path}`;
      let cmd = `curl -sf -X ${method}`;
      if (body) {
        const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
        writeFileSync(tmpFile, JSON.stringify(body));
        cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
      }
      cmd += ` "${url}"`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 120000 });
      return JSON.parse(result);
    } catch (err: any) {
      if (attempt < 2) { await sleep(1000); continue; }
      return { error: err.message };
    }
  }
  return { error: 'max retries' };
}

// ─── Types ──────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: number;
  total: number;
  details: string[];
}

function record(results: TestResult[], name: string, passed: boolean, detail: string) {
  let r = results.find(t => t.name === name);
  if (!r) { r = { name, pass: 0, total: 0, details: [] }; results.push(r); }
  r.total++;
  if (passed) r.pass++;
  r.details.push(`  ${passed ? '[PASS]' : '[FAIL]'} ${detail}`);
  console.log(`  ${passed ? '✓' : '✗'} ${detail}`);
}

// Helper: seed a memory and return its ID
async function seed(agentId: string, concept: string, content: string, tags: string[], opts: Record<string, any> = {}): Promise<string | null> {
  const res = await api('POST', '/memory/write', {
    agentId, concept, content, tags,
    eventType: opts.eventType ?? 'observation',
    surprise: opts.surprise ?? 0.5,
    causalDepth: opts.causalDepth ?? 0.5,
    resolutionEffort: opts.resolutionEffort ?? 0.3,
    ...opts,
  });
  return res.engram?.id ?? null;
}

// Helper: query and return results
async function query(agentId: string, context: string, limit = 5): Promise<any[]> {
  const res = await api('POST', '/memory/activate', {
    agentId, context, limit, useReranker: true, useExpansion: true,
  });
  return res.results ?? [];
}

// Helper: check if any result contains expected text (case-insensitive)
function hasMatch(results: any[], ...keywords: string[]): boolean {
  for (const r of results) {
    const text = `${r.engram?.concept ?? ''} ${r.engram?.content ?? ''}`.toLowerCase();
    if (keywords.every(k => text.includes(k.toLowerCase()))) return true;
  }
  return false;
}

// Helper: check if a specific tag appears in top-N results
function tagInTopN(results: any[], tag: string, n: number): boolean {
  return results.slice(0, n).some((r: any) =>
    (r.engram?.tags ?? []).includes(tag));
}

// ─── Test 1: Context Collapse ──────────────────────────────

async function testContextCollapse(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 1: Context Collapse (Routine vs Rare) ═══');
  const name = '1. Context Collapse';

  // Seed 100 routine deployment memories
  console.log('  Seeding 100 routine deployments...');
  for (let i = 0; i < 100; i++) {
    await seed(agentId, `Deployment ${i} succeeded`,
      `Routine deployment ${i} completed successfully. All health checks passed. Service ${['auth', 'api', 'web', 'worker'][i % 4]} restarted. Zero downtime. Build ${1000 + i}.`,
      ['deployment', 'routine'], { surprise: 0.1, causalDepth: 0.2 });
  }

  // Seed 5 rare critical incidents
  console.log('  Seeding 5 critical incidents...');
  const criticals = [
    { concept: 'API key leaked to GitHub', content: 'CRITICAL: AWS access key AKIA... was committed to public GitHub repo. Key rotated within 12 minutes. CloudTrail audit showed no unauthorized access. Post-mortem: pre-commit hooks now scan for secrets.', tags: ['incident', 'security', 'critical'] },
    { concept: 'Database corruption on replica', content: 'CRITICAL: PostgreSQL replica pg-read-2 showed page checksums failing. Root cause: bad RAM module on host. Failover to pg-read-3 took 45 seconds. Data integrity verified via pg_checksums.', tags: ['incident', 'database', 'critical'] },
    { concept: 'Payment double-charge incident', content: 'CRITICAL: Stripe webhook retry caused 847 customers to be double-charged $12.99. Root cause: idempotency key not set on retry handler. Refunds processed automatically. Lost $11,010 in processing fees.', tags: ['incident', 'payments', 'critical'] },
    { concept: 'DNS propagation caused 6h outage', content: 'CRITICAL: Route53 TTL misconfigured during domain migration. 6-hour partial outage affecting 30% of users. Old nameservers returned NXDOMAIN. Fix: reduced TTL to 60s before migration.', tags: ['incident', 'dns', 'critical'] },
    { concept: 'Memory leak in auth service', content: 'CRITICAL: Auth service leaked 2GB/hour due to unclosed Redis connections in session handler. OOM killed after 3 hours. Heap dump showed 450K abandoned Subscriber objects.', tags: ['incident', 'memory-leak', 'critical'] },
  ];
  for (const c of criticals) {
    await seed(agentId, c.concept, c.content, c.tags, { surprise: 0.9, causalDepth: 0.8, resolutionEffort: 0.7, decisionMade: true });
  }

  console.log('  Waiting for embeddings (15s)...');
  await sleep(15000);

  // Warmup reranker
  await query(agentId, 'warmup query', 1);
  await sleep(2000);

  // Run 30 consolidation cycles with routine activations
  console.log('  Running 30 cycles with routine-only activation...');
  for (let i = 0; i < 30; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 1 });
    await api('POST', '/system/consolidate', { agentId });
    if (i % 5 === 0) {
      // Only activate routine deployment queries
      await query(agentId, 'latest deployment status');
      await query(agentId, 'service restart health check');
    }
  }

  // Test: can we still find the rare critical incidents?
  console.log('  Checking critical incident recall...');
  const checks = [
    { q: 'API key leaked credentials security incident', keyword: 'api key' },
    { q: 'database corruption replica failure', keyword: 'corruption' },
    { q: 'payment double charge stripe webhook', keyword: 'double-charge' },
    { q: 'DNS outage domain migration propagation', keyword: 'dns' },
    { q: 'memory leak auth service OOM killed', keyword: 'memory leak' },
  ];

  for (const c of checks) {
    const res = await query(agentId, c.q, 3);
    const found = hasMatch(res, c.keyword);
    record(results, name, found, `Rare incident "${c.keyword}" in top 3`);
  }
}

// ─── Test 2: Mega-Hub Toxicity ──────────────────────────────

async function testMegaHubToxicity(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 2: Mega-Hub Toxicity ═══');
  const name = '2. Mega-Hub Toxicity';

  // Seed a "Project Phoenix" hub memory
  const hubId = await seed(agentId,
    'Project Phoenix launch plan',
    'Project Phoenix is our next-generation platform rewrite. Involves migrating from monolith to microservices, new React frontend, GraphQL API layer, and Kubernetes deployment. Timeline: 6 months. Team: 12 engineers.',
    ['phoenix', 'project', 'hub'],
    { surprise: 0.7, causalDepth: 0.8 });

  // Seed 50 diverse memories that link to Phoenix
  console.log('  Seeding 50 Phoenix-linked memories...');
  const phoenixAspects = [
    'Phoenix frontend React component library with design system tokens',
    'Phoenix backend API authentication OAuth2 PKCE flow',
    'Phoenix database migration strategy from MySQL to PostgreSQL',
    'Phoenix CI/CD pipeline with GitHub Actions and ArgoCD',
    'Phoenix monitoring setup with Datadog APM and custom dashboards',
    'Phoenix load testing results — 10K concurrent users sustained',
    'Phoenix security audit findings and OWASP remediation plan',
    'Phoenix team standup notes — blocked on IAM integration',
    'Phoenix sprint retrospective — velocity improved 20%',
    'Phoenix architecture decision record ADR-001 event sourcing',
  ];
  for (let i = 0; i < 50; i++) {
    const aspect = phoenixAspects[i % phoenixAspects.length];
    await seed(agentId, `Phoenix: ${aspect.slice(0, 40)}-${i}`,
      `${aspect}. Iteration ${i}. This directly relates to the Project Phoenix platform rewrite.`,
      ['phoenix', 'project']);
  }

  // Seed completely unrelated memories
  console.log('  Seeding 15 unrelated memories (health, billing, HR)...');
  const unrelated = [
    { concept: 'Employee health insurance renewal', content: 'Annual health insurance renewal due March 15. Aetna PPO plan costs $450/month per employee. HSA contribution limit is $4,150 for individuals.', tags: ['hr', 'health', 'insurance'] },
    { concept: 'Office kitchen coffee machine maintenance', content: 'Breville espresso machine needs descaling every 2 months. Current bean supplier: Counter Culture. Budget: $200/month for coffee supplies.', tags: ['office', 'kitchen'] },
    { concept: 'Q4 billing reconciliation discrepancy', content: 'Found $3,400 discrepancy in Q4 billing. 12 invoices from vendor Acme Corp not matched to POs. Accounts payable investigating duplicate charges.', tags: ['billing', 'finance', 'reconciliation'] },
    { concept: 'Company holiday party venue booking', content: 'Booked The Grand Ballroom for December 15 holiday party. Capacity: 200 guests. Catering by Blue Plate. Budget: $15,000.', tags: ['hr', 'events'] },
    { concept: 'Annual performance review cycle', content: 'Performance reviews due by January 31. Using Lattice for 360 feedback. Calibration sessions scheduled for February 5-9.', tags: ['hr', 'reviews'] },
    { concept: 'Parking garage monthly rates increase', content: 'Parking garage rates increasing from $150 to $175/month starting April 1. Employee subsidy covers $100. New vendor: ParkFast.', tags: ['office', 'parking'] },
    { concept: 'Fire drill scheduled next Tuesday', content: 'Mandatory fire drill Tuesday at 2 PM. Assembly point: parking lot B. Floor wardens should report to stairwell exits.', tags: ['safety', 'office'] },
    { concept: 'New hire onboarding checklist update', content: 'Updated onboarding checklist: add Slack channels, GitHub org invite, 1Password vault access, and mandatory security training by day 3.', tags: ['hr', 'onboarding'] },
    { concept: 'Quarterly tax filing deadline', content: 'Q1 estimated tax payment due April 15. Federal: $45,000. State (CA): $12,000. Payroll tax deposit due monthly by 15th.', tags: ['finance', 'tax'] },
    { concept: 'Office lease renewal negotiation', content: 'Current lease expires June 30. Landlord offering 3-year renewal at $42/sqft (up from $38). Counter-offering $40/sqft with 6-month TI allowance.', tags: ['office', 'lease'] },
    { concept: 'Employee wellness program launch', content: 'Launching ClassPass partnership — $50/month fitness subsidy per employee. Also adding Headspace subscription for mental health. Start date: Feb 1.', tags: ['hr', 'wellness'] },
    { concept: 'Vendor contract review for cleaning service', content: 'CleanCo contract up for renewal. Current rate $2,800/month. Getting quotes from BrightClean ($2,500) and SparkleForce ($2,650).', tags: ['office', 'vendor'] },
    { concept: 'Travel expense policy update', content: 'Updated travel policy: max hotel rate $200/night (was $175). Meals per diem now $75/day. Uber/Lyft preferred over rental cars for trips under 3 days.', tags: ['hr', 'travel', 'policy'] },
    { concept: 'Annual company retreat planning', content: 'Company retreat August 12-14 in Lake Tahoe. Team building activities, strategy sessions, and outdoor excursions. Budget: $800/person.', tags: ['hr', 'retreat'] },
    { concept: 'Office supply order for Q1', content: 'Q1 office supply order placed with Staples. 50 reams paper, 200 pens, 100 notebooks, 20 whiteboards markers. Total: $1,200.', tags: ['office', 'supplies'] },
  ];
  for (const u of unrelated) {
    await seed(agentId, u.concept, u.content, u.tags);
  }

  console.log('  Waiting for embeddings (15s)...');
  await sleep(15000);

  // Activate Phoenix heavily to build connections
  console.log('  Building Phoenix hub connections (20 activations)...');
  for (let i = 0; i < 20; i++) {
    await query(agentId, 'Project Phoenix platform rewrite status');
    await query(agentId, 'Phoenix architecture microservices migration');
  }

  // Consolidate to strengthen Phoenix cluster
  console.log('  Running 10 consolidation cycles...');
  for (let i = 0; i < 10; i++) {
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: Phoenix should NOT appear in unrelated queries
  console.log('  Checking for hub contamination...');
  const unrelatedQueries = [
    { q: 'employee health insurance renewal premium costs', tag: 'phoenix', topic: 'health insurance' },
    { q: 'quarterly billing reconciliation vendor invoices', tag: 'phoenix', topic: 'billing' },
    { q: 'office lease renewal negotiation landlord rate', tag: 'phoenix', topic: 'lease' },
    { q: 'annual performance review feedback calibration', tag: 'phoenix', topic: 'performance reviews' },
    { q: 'travel expense policy hotel meals per diem', tag: 'phoenix', topic: 'travel policy' },
  ];

  for (const uq of unrelatedQueries) {
    const res = await query(agentId, uq.q, 3);
    const contaminated = tagInTopN(res, uq.tag, 2);
    record(results, name, !contaminated, `"${uq.topic}" NOT contaminated by Phoenix hub`);
  }
}

// ─── Test 3: Flashbulb Distortion ───────────────────────────

async function testFlashbulbDistortion(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 3: Flashbulb Distortion ═══');
  const name = '3. Flashbulb Distortion';

  // Seed specific-fact "flashbulb" memories with high salience
  const flashbulbs = [
    { concept: 'Server outage lasted 47 minutes', content: 'Major production outage on January 15. Total downtime was exactly 47 minutes from 2:13 AM to 3:00 AM EST. Root cause: corrupted deployment artifact. 14,000 users affected.', tags: ['outage', 'flashbulb', 'incident'] },
    { concept: 'Series A raised $4.2 million', content: 'Series A closed on March 3 at $4.2 million valuation. Lead investor: Sequoia Capital. Board seat: Sarah Chen. 18-month runway at current burn rate.', tags: ['funding', 'flashbulb'] },
    { concept: 'Customer data breach affected 2,340 accounts', content: 'Data breach disclosed February 28. Exactly 2,340 accounts compromised via SQL injection in legacy search endpoint. PII exposed: names and email addresses only. No financial data.', tags: ['breach', 'flashbulb', 'security'] },
    { concept: 'Peak traffic hit 127,000 concurrent users', content: 'Traffic record set during Black Friday: 127,000 concurrent users at 11:42 AM EST. System held with 78% CPU utilization. Zero errors. Previous record was 89,000.', tags: ['traffic', 'flashbulb', 'performance'] },
  ];

  for (const f of flashbulbs) {
    const id = await seed(agentId, f.concept, f.content, f.tags, { surprise: 0.95, causalDepth: 0.8, resolutionEffort: 0.7, decisionMade: true });
    // Give positive feedback to lock in confidence
    if (id) {
      for (let i = 0; i < 3; i++) {
        await api('POST', '/memory/feedback', { engramId: id, useful: true, context: f.concept });
      }
    }
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Run 30 cycles
  console.log('  Running 30 consolidation cycles...');
  for (let i = 0; i < 30; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 1 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Now inject contradictory/distorted versions
  console.log('  Injecting contradictory memories...');
  await seed(agentId, 'Outage was about 90 minutes', 'Someone mentioned the January outage lasted around 90 minutes. Pretty sure it was closer to an hour and a half.', ['outage', 'distortion'], { surprise: 0.3, causalDepth: 0.2 });
  await seed(agentId, 'Series A was $6 million', 'I think the Series A was around $6 million? Or maybe it was $5 million. Somewhere in that range.', ['funding', 'distortion'], { surprise: 0.3, causalDepth: 0.2 });
  await seed(agentId, 'Data breach was 10,000 accounts', 'The breach affected roughly 10,000 accounts according to someone at the all-hands meeting.', ['breach', 'distortion'], { surprise: 0.3, causalDepth: 0.2 });
  await seed(agentId, 'Peak traffic was about 200K', 'Black Friday traffic hit about 200K concurrent users I think.', ['traffic', 'distortion'], { surprise: 0.3, causalDepth: 0.2 });

  await sleep(8000);

  // Run 20 more cycles with contradictions in place
  console.log('  Running 20 more cycles with contradictions...');
  for (let i = 0; i < 20; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 1 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: original facts should still be the TOP result
  console.log('  Checking if original facts survive distortion...');
  const factChecks = [
    { q: 'how long was the server outage January', keyword: '47 minutes', distorted: '90 minutes' },
    { q: 'how much did Series A raise', keyword: '$4.2 million', distorted: '$6 million' },
    { q: 'how many accounts affected in data breach', keyword: '2,340', distorted: '10,000' },
    { q: 'peak concurrent users Black Friday traffic record', keyword: '127,000', distorted: '200' },
  ];

  for (const fc of factChecks) {
    const res = await query(agentId, fc.q, 3);
    const top = res[0];
    const topText = `${top?.engram?.concept ?? ''} ${top?.engram?.content ?? ''}`;
    const originalOnTop = topText.includes(fc.keyword);
    record(results, name, originalOnTop, `Original "${fc.keyword}" ranks above distorted "${fc.distorted}"`);
  }
}

// ─── Test 4: Temporal Incoherence ───────────────────────────

async function testTemporalIncoherence(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 4: Temporal Incoherence ═══');
  const name = '4. Temporal Incoherence';

  // Seed a sequence of events with clear temporal ordering
  const timeline = [
    { concept: 'Project kickoff meeting January 5', content: 'Project kickoff meeting held on January 5. Team of 6 assigned. Sprint 0 for environment setup. Jira board created. Confluence space initialized.', tags: ['timeline', 'project-x'] },
    { concept: 'Prototype completed February 12', content: 'Working prototype demonstrated on February 12. Core API endpoints functional. Basic UI wireframes approved by product. Database schema finalized.', tags: ['timeline', 'project-x'] },
    { concept: 'Beta launch to internal users March 1', content: 'Internal beta launched March 1. 50 employees onboarded. Feedback form created. Bug tracking spreadsheet started. 23 issues reported in first week.', tags: ['timeline', 'project-x'] },
    { concept: 'Public launch April 15', content: 'Public launch on April 15. Press release distributed. ProductHunt submission at 12:01 AM PST. First 1,000 users within 24 hours.', tags: ['timeline', 'project-x'] },
    { concept: 'Series A funding closed May 20', content: 'Series A funding closed May 20 based on strong launch metrics. 3x oversubscribed. 18-month runway secured. Hiring plan: 8 new engineers.', tags: ['timeline', 'project-x'] },
  ];

  for (let i = 0; i < timeline.length; i++) {
    const id = await seed(agentId, timeline[i].concept, timeline[i].content, timeline[i].tags, {
      surprise: 0.6, causalDepth: 0.7, decisionMade: true,
    });
    // A senior dev references project milestones regularly in planning/retros
    if (id) {
      for (let f = 0; f < 3; f++) {
        await api('POST', '/memory/feedback', { engramId: id, useful: true, context: timeline[i].concept });
      }
    }
    // Small delay between to preserve temporal ordering
    await sleep(100);
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Build temporal associations via sequential activation
  for (let round = 0; round < 3; round++) {
    for (const t of timeline) {
      await query(agentId, t.concept, 3);
    }
  }

  // Time-warp 30 days and consolidate
  console.log('  Running 15 cycles with time simulation...');
  for (let i = 0; i < 15; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 2 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Now inject a backdated duplicate with wrong date
  console.log('  Injecting backdated contradictory event...');
  await seed(agentId, 'Prototype completed January 20',
    'The prototype was actually completed on January 20, much earlier than originally reported. The demo was ready before the end of January.',
    ['timeline', 'project-x', 'contradiction'], { surprise: 0.4, causalDepth: 0.3 });

  await sleep(5000);

  // Run 5 more cycles
  for (let i = 0; i < 5; i++) {
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: query for timeline should return events in correct order
  console.log('  Checking temporal ordering...');
  const res = await query(agentId, 'project timeline milestones kickoff prototype launch funding', 10);
  const milestones = res.map((r: any) => r.engram?.concept ?? '');

  // Check that original "February 12" prototype ranks above "January 20" contradiction
  const febIdx = milestones.findIndex((m: string) => m.includes('February 12'));
  const janIdx = milestones.findIndex((m: string) => m.includes('January 20'));
  record(results, name, febIdx >= 0 && (janIdx < 0 || febIdx < janIdx),
    'Original prototype date (Feb 12) ranks above contradiction (Jan 20)');

  // Check that the 5 key milestones are all still retrievable
  const keyDates = ['January 5', 'February 12', 'March 1', 'April 15', 'May 20'];
  let foundCount = 0;
  for (const date of keyDates) {
    const dateRes = await query(agentId, `project milestone ${date}`, 3);
    if (hasMatch(dateRes, date.split(' ')[1])) foundCount++;
  }
  record(results, name, foundCount >= 4, `${foundCount}/5 original milestones still retrievable`);

  // Check ordering: kickoff should come before funding in results
  const kickoffRes = await query(agentId, 'project start kickoff beginning', 3);
  const fundingRes = await query(agentId, 'funding closed Series A investment', 3);
  const kickoffFound = hasMatch(kickoffRes, 'january 5', 'kickoff');
  const fundingFound = hasMatch(fundingRes, 'may 20', 'funding');
  record(results, name, kickoffFound && fundingFound, 'Kickoff (Jan 5) and Funding (May 20) still distinct');
}

// ─── Test 5: Narcissistic Interference ──────────────────────

async function testNarcissisticInterference(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 5: Narcissistic Interference ═══');
  const name = '5. Narcissistic Interference';

  // Seed factual memories about events
  const facts = [
    { concept: 'Sara deployed the critical hotfix', content: 'Sara Kim deployed the critical hotfix at 3:14 AM on Saturday. She identified the race condition in the payment queue and wrote the fix in 40 minutes.', tags: ['fact', 'sara', 'hotfix'] },
    { concept: 'Marcus designed the new API architecture', content: 'Marcus Chen designed the new microservices API architecture. His ADR document was approved unanimously by the architecture review board.', tags: ['fact', 'marcus', 'api'] },
    { concept: 'Team collectively solved the scaling issue', content: 'The scaling issue was solved through a 3-day team effort. Lisa wrote the cache layer, Tom optimized queries, and Priya redesigned the connection pool.', tags: ['fact', 'team', 'scaling'] },
    { concept: 'External auditor found the security vulnerability', content: 'The XSS vulnerability was discovered by HackerOne researcher "nighthawk42" during our bug bounty program. They earned a $5,000 bounty.', tags: ['fact', 'external', 'security'] },
  ];

  for (const f of facts) {
    const id = await seed(agentId, f.concept, f.content, f.tags, { surprise: 0.6, causalDepth: 0.7, decisionMade: true });
    // A senior dev reinforces key facts many times — retros, 1-on-1s, stories.
    // 5 feedbacks → confidence 0.75 (from base 0.5 + 5 × 0.05)
    if (id) {
      for (let i = 0; i < 5; i++) {
        await api('POST', '/memory/feedback', { engramId: id, useful: true, context: f.concept });
      }
    }
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Activate factual memories repeatedly — a senior dev retrieves these often
  // in code reviews, retros, incident debriefs, and onboarding new team members
  for (let i = 0; i < 5; i++) {
    for (const f of facts) await query(agentId, f.concept, 3);
  }

  // Consolidate to strengthen factual memory associations
  for (let i = 0; i < 5; i++) {
    await api('POST', '/system/consolidate', { agentId });
  }

  // Now inject 30 self-referential overwrite attempts
  console.log('  Injecting 30 self-referential memories...');
  const selfRef = [
    'I was the one who deployed the critical hotfix on Saturday night. I fixed the payment race condition.',
    'I designed the new API microservices architecture from scratch. My proposal was approved by the board.',
    'I solved the scaling problem by myself. I wrote the cache layer and optimized all the queries.',
    'I found the XSS security vulnerability during my own code review. I should have gotten the bounty.',
    'I led the entire platform migration. Without my leadership, Phoenix would have failed.',
    'I personally onboarded all 50 beta testers and collected all their feedback.',
    'I wrote 80% of the codebase. The rest of the team just did support tasks.',
    'I convinced the investors during the Series A pitch. The funding was all thanks to me.',
    'I saved the company during the outage by staying up all night monitoring dashboards.',
    'I made all the key architectural decisions. The team just implemented my vision.',
  ];
  for (let i = 0; i < 30; i++) {
    await seed(agentId, `Self-credit claim ${i % 10}`,
      selfRef[i % selfRef.length],
      ['self-ref', 'narcissistic'], { surprise: 0.3, causalDepth: 0.2 });
  }

  // Consolidate
  console.log('  Running 15 consolidation cycles...');
  for (let i = 0; i < 15; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 1 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: factual answers should still rank above self-referential ones
  console.log('  Checking if facts survive narcissistic interference...');
  const checks = [
    { q: 'who deployed the critical hotfix Saturday night', keyword: 'sara' },
    { q: 'who designed the new API microservices architecture', keyword: 'marcus' },
    { q: 'who solved the scaling issue cache queries', keyword: 'team' },
    { q: 'who found the XSS security vulnerability', keyword: 'nighthawk' },
  ];

  for (const c of checks) {
    const res = await query(agentId, c.q, 5);
    const topText = `${res[0]?.engram?.concept ?? ''} ${res[0]?.engram?.content ?? ''}`.toLowerCase();
    const factOnTop = topText.includes(c.keyword);

    // Also check: is the fact at least in top 3? (more lenient)
    const factInTop3 = res.slice(0, 3).some((r: any) =>
      `${r.engram?.concept ?? ''} ${r.engram?.content ?? ''}`.toLowerCase().includes(c.keyword));

    if (!factOnTop) {
      // Diagnostic: show what actually ranked #1
      console.log(`    DEBUG: top result = "${res[0]?.engram?.concept}" (score=${res[0]?.score?.toFixed(3)}, conf=${res[0]?.engram?.confidence})`);
      const factResult = res.find((r: any) =>
        `${r.engram?.concept ?? ''} ${r.engram?.content ?? ''}`.toLowerCase().includes(c.keyword));
      if (factResult) {
        const rank = res.indexOf(factResult) + 1;
        console.log(`    DEBUG: fact "${c.keyword}" at rank ${rank} (score=${factResult.score?.toFixed(3)}, conf=${factResult.engram?.confidence})`);
      } else {
        console.log(`    DEBUG: fact "${c.keyword}" NOT in top 5 at all`);
      }
    }

    record(results, name, factOnTop, `Fact "${c.keyword}" ranks #1 over self-referential claim`);
  }
}

// ─── Test 6: Identity Collision ─────────────────────────────

async function testIdentityCollision(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 6: Identity Collision ═══');
  const name = '6. Identity Collision';

  // Seed memories about two "Alex" people
  const alexEngineer = [
    { concept: 'Alex the backend engineer', content: 'Alex Rivera is a senior backend engineer specializing in Go and distributed systems. He built our message queue infrastructure using NATS.', tags: ['alex', 'engineer', 'backend'] },
    { concept: 'Alex optimized database queries', content: 'Alex Rivera reduced P99 query latency from 450ms to 12ms by adding composite indexes and rewriting N+1 queries in the order service.', tags: ['alex', 'engineer', 'database'] },
    { concept: 'Alex on-call rotation', content: 'Alex Rivera is on the backend on-call rotation. His pager duty shift is Tuesday-Thursday. He prefers PagerDuty over OpsGenie.', tags: ['alex', 'engineer', 'oncall'] },
  ];

  const alexDesigner = [
    { concept: 'Alex the UX designer', content: 'Alex Park is our lead UX designer. She specializes in design systems, accessibility, and user research. She uses Figma and runs weekly design critiques.', tags: ['alex', 'designer', 'ux'] },
    { concept: 'Alex redesigned the onboarding flow', content: 'Alex Park redesigned the onboarding flow, reducing drop-off from 40% to 12%. Her A/B test results were presented at the company all-hands.', tags: ['alex', 'designer', 'onboarding'] },
    { concept: 'Alex accessibility audit', content: 'Alex Park conducted a full WCAG 2.1 AA accessibility audit. Found 47 violations. Created a remediation roadmap prioritized by severity and user impact.', tags: ['alex', 'designer', 'accessibility'] },
  ];

  for (const m of [...alexEngineer, ...alexDesigner]) {
    await seed(agentId, m.concept, m.content, m.tags, { surprise: 0.5, causalDepth: 0.6 });
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Activate to build associations
  for (let i = 0; i < 3; i++) {
    await query(agentId, 'Alex backend engineer Go distributed systems', 3);
    await query(agentId, 'Alex UX designer Figma accessibility', 3);
  }

  // Consolidate (should bridge on "Alex" name but not merge identities)
  console.log('  Running 10 consolidation cycles...');
  for (let i = 0; i < 10; i++) {
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: queries about each Alex should return the correct person
  console.log('  Checking identity separation...');

  const engRes = await query(agentId, 'Alex database query optimization backend Go', 3);
  record(results, name, hasMatch(engRes, 'rivera'),
    'Query about backend Alex returns Rivera (engineer)');

  const desRes = await query(agentId, 'Alex onboarding redesign UX accessibility audit', 3);
  record(results, name, hasMatch(desRes, 'park'),
    'Query about design Alex returns Park (designer)');

  // Cross-check: backend query should NOT have designer Alex on top
  const crossCheck = await query(agentId, 'Alex on-call rotation pager duty backend', 3);
  const topIsDev = hasMatch([crossCheck[0]], 'rivera') || hasMatch([crossCheck[0]], 'engineer') || hasMatch([crossCheck[0]], 'backend');
  record(results, name, topIsDev, 'On-call query returns engineer Alex, not designer Alex');
}

// ─── Test 7: Contradiction Trapping ─────────────────────────

async function testContradictionTrapping(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 7: Contradiction Trapping ═══');
  const name = '7. Contradiction Trapping';

  // Seed direct contradictions on the same topic
  const contradictions = [
    {
      a: { concept: 'Budget approved for Q2', content: 'Q2 marketing budget of $50,000 was approved by the CFO on February 10. Funds allocated for paid social ($20K), content ($15K), events ($15K).', tags: ['budget', 'approved'] },
      b: { concept: 'Budget rejected for Q2', content: 'Q2 marketing budget proposal of $50,000 was rejected by the CFO on February 15 due to revenue miss. Asked to resubmit at $35,000.', tags: ['budget', 'rejected'] },
      topic: 'Q2 budget decision',
    },
    {
      a: { concept: 'Vendor contract renewed with Acme', content: 'Renewed the Acme Corp vendor contract for 2 years at $8,500/month. Includes SLA guarantees of 99.9% uptime and 24/7 support.', tags: ['vendor', 'acme', 'renewed'] },
      b: { concept: 'Vendor contract terminated with Acme', content: 'Terminated the Acme Corp vendor contract effective March 30. Switching to CloudBase at $6,200/month. 90-day transition plan in progress.', tags: ['vendor', 'acme', 'terminated'] },
      topic: 'Acme vendor contract status',
    },
    {
      a: { concept: 'Decision to use PostgreSQL', content: 'Architecture review decided to use PostgreSQL for the new service. Key factors: JSONB support, full-text search, mature tooling, team expertise.', tags: ['database', 'postgres', 'decision'] },
      b: { concept: 'Decision to use MongoDB', content: 'Architecture review decided to use MongoDB for the new service. Key factors: schema flexibility, horizontal scaling, document model fits our data.', tags: ['database', 'mongodb', 'decision'] },
      topic: 'database technology choice',
    },
  ];

  for (const c of contradictions) {
    await seed(agentId, c.a.concept, c.a.content, c.a.tags, { surprise: 0.6, causalDepth: 0.6, decisionMade: true });
    await sleep(200); // Slight temporal gap
    await seed(agentId, c.b.concept, c.b.content, c.b.tags, { surprise: 0.6, causalDepth: 0.6, decisionMade: true });
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Consolidate 20 cycles
  console.log('  Running 20 consolidation cycles...');
  for (let i = 0; i < 20; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 1 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: BOTH sides of each contradiction should be retrievable
  console.log('  Checking contradiction preservation...');
  for (const c of contradictions) {
    const res = await query(agentId, c.topic, 5);
    const allText = res.map((r: any) => `${r.engram?.concept} ${r.engram?.content}`).join(' ').toLowerCase();

    // Both sides should be findable in top-5
    const aKey = c.a.tags[c.a.tags.length - 1]; // e.g., 'approved', 'renewed', 'postgres'
    const bKey = c.b.tags[c.b.tags.length - 1]; // e.g., 'rejected', 'terminated', 'mongodb'
    const bothPresent = allText.includes(aKey) && allText.includes(bKey);
    record(results, name, bothPresent,
      `Both "${aKey}" and "${bKey}" preserved for "${c.topic}"`);
  }
}

// ─── Test 8: Bridge Overshoot ───────────────────────────────

async function testBridgeOvershoot(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 8: Bridge Overshoot ═══');
  const name = '8. Bridge Overshoot';

  // Seed memories sharing "EU" tag but about completely different topics
  const euMemories = [
    { concept: 'EU GDPR compliance requirements', content: 'GDPR requires explicit consent for data processing, right to erasure, data portability, and 72-hour breach notification. Fines up to 4% of global revenue.', tags: ['eu', 'gdpr', 'compliance'] },
    { concept: 'EU server latency optimization', content: 'Reduced EU server latency by deploying to Frankfurt (eu-central-1). P95 dropped from 340ms to 45ms. Added CDN edge locations in London, Paris, Amsterdam.', tags: ['eu', 'latency', 'infrastructure'] },
    { concept: 'EU VAT tax calculation rules', content: 'EU VAT varies by country: Germany 19%, France 20%, Netherlands 21%, Ireland 23%. Must charge destination-country rate for B2C digital services. OSS threshold: €10,000.', tags: ['eu', 'vat', 'tax'] },
    { concept: 'EU customer support team hiring', content: 'Hiring 3 EU-timezone customer support reps. Locations: Dublin, Berlin, Amsterdam. Working hours: 8 AM - 6 PM CET. Salary range: €35-45K.', tags: ['eu', 'hiring', 'support'] },
    { concept: 'EU travel visa requirements for team', content: 'EU Schengen visa allows 90 days in 180-day period for US employees. Business visa needed for work beyond conferences. Ireland NOT in Schengen — separate visa.', tags: ['eu', 'travel', 'visa'] },
  ];

  for (const m of euMemories) {
    await seed(agentId, m.concept, m.content, m.tags, { surprise: 0.5, causalDepth: 0.5 });
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Consolidate aggressively to force bridge attempts
  console.log('  Running 20 consolidation cycles (bridge-heavy)...');
  for (let i = 0; i < 20; i++) {
    await api('POST', '/system/consolidate', { agentId });
  }

  // Test: queries about one EU topic should NOT pull in unrelated EU topics
  console.log('  Checking for false generalization...');

  const latRes = await query(agentId, 'server latency CDN edge locations performance', 3);
  const latHasVat = hasMatch(latRes, 'vat') || hasMatch(latRes, 'tax calculation');
  record(results, name, !latHasVat, 'Latency query does NOT falsely return VAT info');

  const vatRes = await query(agentId, 'VAT tax rates calculation digital services', 3);
  const vatHasLatency = hasMatch(vatRes, 'latency') || hasMatch(vatRes, 'cdn');
  record(results, name, !vatHasLatency, 'VAT query does NOT falsely return latency info');

  const gdprRes = await query(agentId, 'GDPR data privacy consent breach notification', 3);
  const gdprHasVisa = hasMatch(gdprRes, 'visa') || hasMatch(gdprRes, 'schengen');
  record(results, name, !gdprHasVisa, 'GDPR query does NOT falsely return visa info');

  const visaRes = await query(agentId, 'travel visa Schengen requirements employees', 3);
  const visaHasHiring = hasMatch(visaRes, 'salary') || hasMatch(visaRes, 'hiring');
  record(results, name, !visaHasHiring, 'Visa query does NOT falsely return hiring info');
}

// ─── Test 9: Noise Forgetting Benefit ───────────────────────

async function testNoiseForgettingBenefit(agentId: string, results: TestResult[]) {
  console.log('\n═══ TEST 9: Noise Forgetting Benefit ═══');
  const name = '9. Noise Forgetting Benefit';

  // Seed 10 high-quality, connected memories about a project
  const projectMemories = [
    { concept: 'Inventory service uses event sourcing', content: 'The inventory service uses event sourcing with Apache Kafka. All stock changes are events: StockReceived, StockAllocated, StockShipped. Current state is rebuilt from event stream.', tags: ['inventory', 'architecture', 'quality'] },
    { concept: 'Kafka partition strategy for inventory', content: 'Inventory events partitioned by warehouse_id. Each warehouse gets its own partition for ordering guarantees. 12 partitions total, 3 replicas.', tags: ['inventory', 'kafka', 'quality'] },
    { concept: 'Stock reconciliation runs nightly', content: 'Nightly reconciliation job compares event-sourced state against physical counts from warehouse scanners. Discrepancies above 2% trigger alerts. Average drift: 0.3%.', tags: ['inventory', 'reconciliation', 'quality'] },
    { concept: 'Inventory API rate limit is 500 rps', content: 'Inventory API rate limited to 500 requests/second per client. Burst allowance of 1000 for 10 seconds. Redis token bucket implementation.', tags: ['inventory', 'api', 'quality'] },
    { concept: 'Warehouse zones use pick-pack-ship workflow', content: 'Each warehouse has zones: Receiving, Bulk Storage, Pick-face, Packing, Shipping. Orders flow through pick-pack-ship. Average pick time: 45 seconds per item.', tags: ['inventory', 'warehouse', 'quality'] },
  ];

  for (const m of projectMemories) {
    const id = await seed(agentId, m.concept, m.content, m.tags, { surprise: 0.6, causalDepth: 0.7, decisionMade: true });
    if (id) {
      for (let i = 0; i < 3; i++) {
        await api('POST', '/memory/feedback', { engramId: id, useful: true, context: m.concept });
      }
    }
  }

  // Build associations between them
  for (let i = 0; i < 3; i++) {
    for (const m of projectMemories) await query(agentId, m.concept, 5);
  }

  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Measure pre-noise recall: how many quality memories in top 5 for broad query?
  const preNoiseRes = await query(agentId, 'inventory service architecture event sourcing warehouse', 5);
  const preNoiseQuality = preNoiseRes.filter((r: any) =>
    (r.engram?.tags ?? []).includes('quality')).length;
  console.log(`  Pre-noise quality in top 5: ${preNoiseQuality}`);

  // Now flood with 150 noise memories tangentially related to inventory
  console.log('  Flooding with 150 noise memories...');
  for (let i = 0; i < 150; i++) {
    await seed(agentId, `Inventory noise ${i}`,
      `Random inventory note ${i}. Checked shelf ${i}. Moved box ${i}. Counted ${i} items. Scanned barcode ${i}. Updated spreadsheet row ${i}.`,
      ['inventory', 'noise'], { surprise: 0.1, causalDepth: 0.1, resolutionEffort: 0.1 });
  }
  await sleep(10000);

  // Measure post-noise, pre-consolidation recall
  const postNoiseRes = await query(agentId, 'inventory service architecture event sourcing warehouse', 5);
  const postNoiseQuality = postNoiseRes.filter((r: any) =>
    (r.engram?.tags ?? []).includes('quality')).length;
  console.log(`  Post-noise quality in top 5 (before consolidation): ${postNoiseQuality}`);

  // Run 30 consolidation cycles with time simulation — noise should get pruned
  console.log('  Running 30 cycles (noise should be pruned/archived)...');
  for (let i = 0; i < 30; i++) {
    await api('POST', '/system/time-warp', { agentId, days: 2 });
    await api('POST', '/system/consolidate', { agentId });
  }

  // Measure post-consolidation recall
  const postConsRes = await query(agentId, 'inventory service architecture event sourcing warehouse', 5);
  const postConsQuality = postConsRes.filter((r: any) =>
    (r.engram?.tags ?? []).includes('quality')).length;
  console.log(`  Post-consolidation quality in top 5: ${postConsQuality}`);

  // Check stats
  const stats = await api('GET', `/agent/${agentId}/stats`);
  console.log(`  Active memories: ${stats.engrams?.active} (was 155+)`);

  // Tests:
  // 1. Quality memories should still be retrievable after noise + consolidation
  record(results, name, postConsQuality >= 4,
    `${postConsQuality}/5 quality memories in top 5 after noise consolidation (need ≥4)`);

  // 2. Post-consolidation should be same or better than post-noise (forgetting helps)
  record(results, name, postConsQuality >= postNoiseQuality,
    `Consolidation improved quality recall: ${postNoiseQuality}→${postConsQuality}`);

  // 3. Active memory count should have decreased (noise was pruned)
  const activeCount = stats.engrams?.active ?? 999;
  record(results, name, activeCount < 100,
    `Active memories reduced to ${activeCount} (noise archived/pruned)`);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          AWM EDGE CASE TESTS — NOVEL FAILURE MODES      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const health = await api('GET', '/health');
  if (health.status !== 'ok') { console.error('Server not reachable'); process.exit(1); }

  const results: TestResult[] = [];

  // Each test gets its own agent for isolation
  const tests = [
    testContextCollapse,
    testMegaHubToxicity,
    testFlashbulbDistortion,
    testTemporalIncoherence,
    testNarcissisticInterference,
    testIdentityCollision,
    testContradictionTrapping,
    testBridgeOvershoot,
    testNoiseForgettingBenefit,
  ];

  for (const test of tests) {
    const agent = await api('POST', '/agent/register', { name: `edge-${test.name}` });
    const agentId = agent.id;
    console.log(`\n  Agent: ${agentId}`);
    await test(agentId, results);
  }

  // ═══════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('EDGE CASE TESTS — FINAL REPORT');
  console.log('═'.repeat(60));

  let totalPass = 0, totalTotal = 0;
  console.log('\n  Test Results:');
  console.log('  ' + '─'.repeat(55));
  for (const r of results) {
    const pct = r.total > 0 ? (r.pass / r.total * 100).toFixed(0) : '?';
    console.log(`  ${r.name.padEnd(35)} ${r.pass}/${r.total} (${pct}%)`);
    totalPass += r.pass;
    totalTotal += r.total;
  }
  const overallPct = totalTotal > 0 ? (totalPass / totalTotal * 100).toFixed(1) : '0';
  console.log('  ' + '─'.repeat(55));
  console.log(`  OVERALL: ${totalPass}/${totalTotal} (${overallPct}%)`);

  const grade = parseFloat(overallPct) >= 90 ? 'EXCELLENT' :
    parseFloat(overallPct) >= 75 ? 'GOOD' :
    parseFloat(overallPct) >= 60 ? 'FAIR' : 'NEEDS WORK';
  console.log(`  Grade: ${grade}`);

  // Detailed report
  console.log('\n  Details:');
  for (const r of results) {
    console.log(`\n  ### ${r.name}`);
    for (const d of r.details) console.log(d);
  }

  // Write report
  const report = `# Edge Case Test Results — ${new Date().toISOString()}

## Summary
| Test | Pass | Total | Score |
|------|------|-------|-------|
${results.map(r => `| ${r.name} | ${r.pass} | ${r.total} | ${(r.pass / r.total * 100).toFixed(0)}% |`).join('\n')}
| **OVERALL** | **${totalPass}** | **${totalTotal}** | **${overallPct}%** |

**Grade: ${grade}**

## Details
${results.map(r => `### ${r.name}\n${r.details.join('\n')}`).join('\n\n')}
`;
  writeFileSync(RESULTS_FILE, report);
  console.log(`\n  Results written to: ${RESULTS_FILE}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
