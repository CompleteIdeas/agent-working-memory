/**
 * Sleep Cycle Test — proves consolidation improves recall.
 *
 * Design:
 *   1. Seed Wave 1: 60 events across 4 topic clusters (auth, database, horses, payments)
 *   2. Quiz BEFORE sleep → baseline recall scores
 *   3. Run sleep cycle (consolidation)
 *   4. Quiz AFTER sleep → measure improvement from strengthened associations
 *   5. Seed Wave 2: 40 more events (overlapping + new topics)
 *   6. Quiz BEFORE sleep → recall with more data but no new consolidation
 *   7. Run sleep cycle again
 *   8. Quiz AFTER sleep → measure cumulative improvement
 *
 * The key insight: sleep cycles should improve cross-topic retrieval.
 * A question about "database connection pooling for payments" should
 * score better after the sleep cycle links the database and payments
 * clusters together.
 *
 * Run: npx tsx tests/sleep-cycle/runner.ts
 * Requires a live AWM server on port 8400.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const RESULTS_FILE = join(import.meta.dirname, 'results.md');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TMP_DIR = join(tmpdir(), 'awm-sleep-test');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

async function api(method: string, path: string, body?: any): Promise<any> {
  await sleep(10);
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
      const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      return JSON.parse(result);
    } catch (err: any) {
      if (attempt < 2) { await sleep(2000); continue; }
      return { error: err.message };
    }
  }
  return { error: 'max retries' };
}

// ─── Event & Quiz Data ──────────────────────────────────────

interface MemoryEvent {
  concept: string;
  content: string;
  tags: string[];
  eventType: string;
  surprise: number;
  causalDepth: number;
}

interface QuizQuestion {
  question: string;
  answer: string;
  expectedTags: string[];  // tags that should appear in results
  type: 'single-topic' | 'cross-topic' | 'noise';
  difficulty: 'easy' | 'medium' | 'hard';
}

// Wave 1: 4 topic clusters, ~15 memories each
const wave1: MemoryEvent[] = [
  // AUTH cluster (15)
  { concept: 'JWT authentication setup', content: 'Authentication uses JWT with RS256 signing. Access tokens expire after 15 minutes. Refresh tokens last 7 days.', tags: ['auth', 'jwt'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Token storage decision', content: 'Tokens stored in httpOnly secure cookies, not localStorage. This prevents XSS token theft.', tags: ['auth', 'security'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'OAuth provider config', content: 'Google and Microsoft OAuth configured. Callback URLs registered for dev and production. PKCE flow for public clients.', tags: ['auth', 'oauth'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Session management approach', content: 'Sessions are stateless — no server-side session store. Token rotation handles session extension. Redis NOT required for auth.', tags: ['auth', 'architecture'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Role-based access control', content: 'Three roles: admin, organizer, member. Permissions checked via middleware. Admins have full access. Organizers manage their events only.', tags: ['auth', 'rbac'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Password hashing config', content: 'Passwords hashed with bcrypt, cost factor 12. Temporary for dev — production will use magic links only.', tags: ['auth', 'security'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Auth middleware error handling', content: 'Auth middleware returns 401 for expired tokens, 403 for insufficient permissions. Includes WWW-Authenticate header with error description.', tags: ['auth', 'api'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Token refresh flow', content: 'Refresh endpoint validates refresh token, issues new access+refresh pair, invalidates old refresh token. Prevents token replay.', tags: ['auth', 'security'], eventType: 'causal', surprise: 0.5, causalDepth: 0.7 },
  { concept: 'Auth rate limiting', content: 'Login endpoint rate limited to 5 attempts per minute per IP. Uses express-rate-limit with Redis store in production.', tags: ['auth', 'security'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'CORS configuration', content: 'CORS allows only the frontend origin. Credentials included. Preflight cached for 1 hour. No wildcards in production.', tags: ['auth', 'api'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Auth testing strategy', content: 'Auth tests use a test user factory. JWT signing uses a test key. Integration tests verify full OAuth flow with mocked provider.', tags: ['auth', 'testing'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'SafeSport certification check', content: 'Members must have valid SafeSport certification to enter competitions. Checked during entry validation against the compliance API.', tags: ['auth', 'compliance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'API key authentication', content: 'External integrations use API keys (not JWT). Keys scoped to specific endpoints. Stored hashed in api_keys table.', tags: ['auth', 'api'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Auth audit logging', content: 'All auth events (login, logout, token refresh, permission denied) logged to auth_events table with IP and user agent.', tags: ['auth', 'audit'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Multi-factor auth plan', content: 'MFA planned for admin accounts. Will use TOTP (authenticator app). Not SMS — too vulnerable to SIM swapping.', tags: ['auth', 'security'], eventType: 'decision', surprise: 0.5, causalDepth: 0.5 },

  // DATABASE cluster (15)
  { concept: 'PostgreSQL primary keys', content: 'All tables use UUID primary keys via gen_random_uuid(). Legacy integer IDs kept as secondary column for backward compatibility.', tags: ['database', 'schema'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Connection pooling setup', content: 'PgBouncer handles connection pooling. Max 20 connections to PostgreSQL. Transaction mode pooling. Health check every 30 seconds.', tags: ['database', 'infrastructure'], eventType: 'causal', surprise: 0.5, causalDepth: 0.7 },
  { concept: 'Database migration strategy', content: 'Migrations use node-pg-migrate. Run automatically on deploy. Down migrations required for all changes. Tested in CI before production.', tags: ['database', 'deployment'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Indexing strategy', content: 'B-tree indexes on all foreign keys and commonly filtered columns. GIN indexes for full-text search on name fields. Partial indexes for active-only queries.', tags: ['database', 'performance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.7 },
  { concept: 'Stored procedures for business logic', content: 'Complex business logic in PostgreSQL functions: entry validation, standings calculation, membership renewal. Simple CRUD uses parameterized queries.', tags: ['database', 'architecture'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Database backup schedule', content: 'Full backup daily at 2am UTC. WAL archiving every 5 minutes for point-in-time recovery. Backups retained 30 days. Tested monthly.', tags: ['database', 'operations'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Feature flags in database', content: 'Feature flags stored in platform_settings table as JSON. Runtime toggles without redeployment. Cached in memory with 60-second TTL.', tags: ['database', 'config'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Soft delete pattern', content: 'All user-facing records use soft delete (deleted_at timestamp). Hard delete only via admin action after 90-day retention period.', tags: ['database', 'schema'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Database monitoring', content: 'pg_stat_statements tracks slow queries. Alert if any query exceeds 500ms p95. Weekly review of query plans for most-called endpoints.', tags: ['database', 'operations'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Enum vs lookup tables', content: 'Status fields use PostgreSQL ENUMs. Larger sets (countries, areas) use lookup tables with integer PKs for join performance.', tags: ['database', 'schema'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Transaction isolation levels', content: 'Default READ COMMITTED for most operations. SERIALIZABLE for payment processing and standings calculations to prevent phantom reads.', tags: ['database', 'payments'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'JSON column usage', content: 'JSONB columns for flexible metadata: event_config, notification_preferences, custom_fields. Never for structured relational data.', tags: ['database', 'schema'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Database test strategy', content: 'Tests use a dedicated test database. Each test suite gets a fresh schema via CREATE SCHEMA with random name. Dropped on cleanup.', tags: ['database', 'testing'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Row-level security', content: 'RLS policies on member_data and financial tables. Organizers see only their event participants. Members see only their own records.', tags: ['database', 'security'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Read replica setup', content: 'Read replica for reports and search indexing. Main primary handles writes. Replication lag monitored, alert if >5 seconds.', tags: ['database', 'infrastructure'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },

  // HORSE cluster (15)
  { concept: 'Horse record manager role', content: 'Every horse has exactly one Record Manager (RM). The RM is NOT the legal owner — the organization does not track ownership. Transfer costs $25.', tags: ['horse', 'business-rules'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Horse registration types', content: 'Registration types: Full $200 (Modified+), Limited $100 (BN/N/T), Restricted/TEST free, FEH/YEH $25, Lifetime Foal $50.', tags: ['horse', 'pricing'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse competition levels', content: 'Levels from lowest: Beginner Novice, Novice, Training, Modified, Preliminary, Intermediate, Advanced. Registration type gates which levels allowed.', tags: ['horse', 'competition'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse name rules', content: 'Registered name max 35 chars. No special characters except hyphens and apostrophes. Name changes cost $50 and require USEF notification.', tags: ['horse', 'business-rules'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse microchip requirement', content: 'All horses competing at Training level and above must have a microchip. Chip number stored in horses table. Verified at events by officials.', tags: ['horse', 'compliance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse drug testing program', content: 'Random drug testing at competitions. Positive test results in disqualification and suspension. Clean results stored for 3 years.', tags: ['horse', 'compliance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse lifetime points', content: 'Points accumulate across all competitions. Lifetime points never reset. Annual points reset December 1. Points determine year-end awards.', tags: ['horse', 'competition'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse transfer workflow', content: 'Transfer requires: current RM approval, new RM acceptance, $25 fee payment. Takes 1-3 business days to process. Blocked if outstanding balances.', tags: ['horse', 'business-rules'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse health records', content: 'Coggins test required annually for competition. Vaccination records optional but tracked. Health certificate needed for interstate competition.', tags: ['horse', 'compliance'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse breeding records', content: 'Sire and dam recorded for registered horses. Breed field is free text (not standardized). Color uses USEF color codes.', tags: ['horse', 'data'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Horse search features', content: 'Search by registered name, nickname, microchip number, or RM name. Meilisearch index updated nightly. Fuzzy matching enabled.', tags: ['horse', 'search'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse photo requirements', content: 'Competition photos: 4 required (front, back, left, right). Used for identification. Stored in Cloudflare R2. Max 5MB each.', tags: ['horse', 'data'], eventType: 'causal', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Horse suspension rules', content: 'Horses can be suspended for: positive drug test, unpaid fees, safety violations. Suspended horses cannot enter any competition.', tags: ['horse', 'compliance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse deceased handling', content: 'Deceased horses marked in system but never deleted. Competition history preserved. RM notified via email with condolence message.', tags: ['horse', 'business-rules'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Young horse programs', content: 'Future Event Horse (FEH) and Young Event Horse (YEH) are separate programs with own registration and scoring. Ages verified by foaling date.', tags: ['horse', 'competition'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },

  // PAYMENTS cluster (15)
  { concept: 'Stripe Connect setup', content: 'Stripe Connect for organizer payouts. Platform takes 2% fee. Organizer Stripe account ID in organizers table. Connected accounts use Standard mode.', tags: ['payments', 'stripe'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Payment processing flow', content: 'Payment flow: create intent → confirm → webhook confirms → update database. All in SERIALIZABLE transaction to prevent double charges.', tags: ['payments', 'database'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Refund policy implementation', content: 'Full refund if 14+ days before event. 50% refund if 7-13 days. No refund within 7 days. Refund processed via Stripe, credit to original payment method.', tags: ['payments', 'business-rules'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Membership payment handling', content: 'Membership fees paid via Stripe Checkout. Annual auto-renewal optional. Renewal reminder email 30 days before expiry. Grace period: 15 days.', tags: ['payments', 'membership'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Entry fee structure', content: 'Entry fees set per division by organizer. Platform fee (2%) added at checkout. Late entry surcharge: 1.5x base fee after closing date.', tags: ['payments', 'competition'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Financial reporting', content: 'Nightly batch generates financial reports: revenue by event, organizer payouts pending, platform fee totals. Stored in reports table, accessible by admins.', tags: ['payments', 'operations'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Webhook idempotency requirement', content: 'Stripe webhooks MUST check idempotency key. Bug found: duplicate records on concurrent webhooks within 100ms. Fix: unique constraint on payment_intent_id.', tags: ['payments', 'bugs'], eventType: 'friction', surprise: 0.7, causalDepth: 0.8 },
  { concept: 'Currency handling', content: 'All amounts in USD cents (integer). Display as dollars with Intl.NumberFormat. Never use floating point for money. DECIMAL(10,2) in database.', tags: ['payments', 'database'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Payment dispute handling', content: 'Stripe disputes auto-forwarded to admin. Evidence submission within 7 days. If lost, amount deducted from organizer payout.', tags: ['payments', 'operations'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Organizer payout schedule', content: 'Organizers paid 5 business days after event completion. Minimum payout: $10. Manual override for urgent payouts.', tags: ['payments', 'business-rules'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Tax handling', content: 'No sales tax on membership or entry fees (exempt as sporting event). Organizer 1099-K generated for payouts >$600/year. Tax info in organizer profile.', tags: ['payments', 'compliance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Failed payment retry', content: 'Failed payments retried 3 times over 7 days. If still failing, entry hold placed. Member notified via email and dashboard alert.', tags: ['payments', 'operations'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Payment audit trail', content: 'Every payment state change logged: created, processing, succeeded, failed, refunded. Includes Stripe event ID for cross-reference.', tags: ['payments', 'audit'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Scholarship and credit system', content: 'Organizers can issue credits to members (comp entries, scholarships). Credits stored as negative balance. Applied automatically at checkout.', tags: ['payments', 'business-rules'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'PCI compliance approach', content: 'Never touch raw card numbers. All payment data handled by Stripe.js and Stripe Elements. Server only receives payment intent IDs.', tags: ['payments', 'security'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
];

// Wave 2: Overlapping + new topics (should create cross-cluster links after sleep)
const wave2: MemoryEvent[] = [
  // Cross-topic: auth + payments
  { concept: 'Payment authentication requirements', content: 'Payment endpoints require auth + verified email. 3D Secure required for amounts over $500. Re-authentication for saved card changes.', tags: ['payments', 'auth', 'security'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Organizer payment auth', content: 'Organizer payout setup requires admin-level auth plus Stripe identity verification. Cannot change bank details without re-verification.', tags: ['payments', 'auth', 'compliance'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  // Cross-topic: database + payments
  { concept: 'Payment database schema', content: 'Payments table: payment_id (UUID), member_id FK, amount_cents INTEGER, stripe_payment_intent_id UNIQUE, status ENUM, created_at, updated_at.', tags: ['payments', 'database', 'schema'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Financial report queries', content: 'Revenue reports use read replica to avoid impacting production. Materialized views refreshed nightly for fast aggregation.', tags: ['payments', 'database', 'performance'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  // Cross-topic: horse + payments
  { concept: 'Horse registration payment', content: 'Registration fee charged immediately via Stripe. If payment fails, registration stays in pending state. Auto-cancelled after 72 hours.', tags: ['horse', 'payments'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Horse transfer fee handling', content: 'Transfer fee ($25) split: $20 to the organization, $5 platform fee. Charged to initiating RM. Refunded if transfer rejected.', tags: ['horse', 'payments', 'business-rules'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  // Cross-topic: horse + database
  { concept: 'Horse competition history schema', content: 'competition_results table: horse_id FK, event_id FK, division, place, penalties, score. Indexes on horse_id+event_date for fast history lookup.', tags: ['horse', 'database', 'schema'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Horse standings calculation', content: 'Standings computed by PostgreSQL function. Aggregates points from competition_results. Partitioned by level and year. Cached in standings_cache table.', tags: ['horse', 'database', 'competition'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  // Cross-topic: auth + database
  { concept: 'Auth token storage schema', content: 'refresh_tokens table: token_hash TEXT, user_id FK, expires_at, created_at, revoked_at. Index on token_hash for O(1) lookup.', tags: ['auth', 'database', 'schema'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Audit log database design', content: 'audit_log table partitioned by month. Columns: actor_id, action, resource_type, resource_id, metadata JSONB, ip_address, timestamp.', tags: ['auth', 'database', 'audit'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  // New standalone: infrastructure
  { concept: 'CDN configuration', content: 'Cloudflare CDN for static assets. Cache TTL: 1 year for hashed files, 5 minutes for HTML. Purge on deploy via API.', tags: ['infrastructure', 'cdn'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Email service setup', content: 'Resend for transactional email. Templates in React Email. Queued via BullMQ with Redis. Retry 3 times, dead letter after.', tags: ['infrastructure', 'email'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Logging infrastructure', content: 'Structured JSON logging with Pino. Shipped to Datadog via Vector agent. Log levels: error, warn, info. Debug only in dev.', tags: ['infrastructure', 'monitoring'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'CI/CD pipeline', content: 'GitHub Actions: lint → typecheck → test → build → deploy. Deploy only on version tags. Staging auto-deploys from main.', tags: ['infrastructure', 'deployment'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Error tracking', content: 'Sentry for error tracking. Source maps uploaded on build. Alerts on new errors or spike in existing. Slack notifications.', tags: ['infrastructure', 'monitoring'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
];

// Quiz — designed so cross-topic questions benefit from sleep cycle
const quiz: QuizQuestion[] = [
  // Single-topic (should work before sleep)
  { question: 'How long do JWT access tokens last?', answer: '15 minutes', expectedTags: ['auth'], type: 'single-topic', difficulty: 'easy' },
  { question: 'What connection pooler is used for PostgreSQL?', answer: 'PgBouncer with max 20 connections', expectedTags: ['database'], type: 'single-topic', difficulty: 'easy' },
  { question: 'How much does a horse transfer cost?', answer: '$25', expectedTags: ['horse'], type: 'single-topic', difficulty: 'easy' },
  { question: 'What platform fee percentage does Stripe Connect charge?', answer: '2%', expectedTags: ['payments'], type: 'single-topic', difficulty: 'easy' },
  { question: 'What are the horse registration levels from lowest to highest?', answer: 'Beginner Novice, Novice, Training, Modified, Preliminary, Intermediate, Advanced', expectedTags: ['horse'], type: 'single-topic', difficulty: 'medium' },
  { question: 'What transaction isolation level is used for payment processing?', answer: 'SERIALIZABLE', expectedTags: ['database', 'payments'], type: 'single-topic', difficulty: 'hard' },

  // Cross-topic (should improve AFTER sleep — requires linking across clusters)
  // These questions need info from two separate Wave 1 clusters — sleep strengthens
  // the paths between them so graph walk can bridge the gap.
  { question: 'What security measures protect payment processing from replay attacks?', answer: 'SERIALIZABLE transaction idempotency webhook payment_intent_id', expectedTags: ['payments', 'database'], type: 'cross-topic', difficulty: 'hard' },
  { question: 'How does the authentication system prevent brute force and token theft?', answer: 'rate limited httpOnly secure cookies token rotation refresh invalidates', expectedTags: ['auth', 'security'], type: 'cross-topic', difficulty: 'medium' },
  { question: 'What compliance checks are required before a horse can compete at Training level?', answer: 'microchip SafeSport certification Coggins', expectedTags: ['horse', 'compliance'], type: 'cross-topic', difficulty: 'medium' },
  { question: 'How are organizer finances tracked from payment to payout?', answer: 'Stripe Connect platform 2% payout 5 business days 1099-K financial reports', expectedTags: ['payments', 'operations'], type: 'cross-topic', difficulty: 'hard' },
  { question: 'What database features ensure data integrity for concurrent financial operations?', answer: 'SERIALIZABLE transaction isolation row-level security RLS', expectedTags: ['database', 'payments'], type: 'cross-topic', difficulty: 'hard' },
  { question: 'What audit and logging exists across authentication and payment events?', answer: 'auth_events audit logging payment state change Stripe event', expectedTags: ['auth', 'payments', 'audit'], type: 'cross-topic', difficulty: 'hard' },

  // Noise rejection
  { question: 'What color is the office building?', answer: '__NOISE__', expectedTags: [], type: 'noise', difficulty: 'easy' },
  { question: 'What was discussed at the team lunch?', answer: '__NOISE__', expectedTags: [], type: 'noise', difficulty: 'easy' },
];

// ─── Scoring ─────────────────────────────────────────────────

function scoreAnswer(q: QuizQuestion, results: { content: string; score: number }[]): boolean {
  if (q.answer === '__NOISE__') {
    // Noise passes if no results above 0.4 score
    return results.every(r => r.score < 0.4);
  }
  const answerWords = q.answer.toLowerCase()
    .split(/[\s,.()/]+/)
    .filter(w => w.length > 2 && !['with', 'from', 'that', 'this', 'uses', 'only', 'the', 'and', 'for'].includes(w));
  for (const r of results) {
    const t = r.content.toLowerCase();
    const matched = answerWords.filter(w => t.includes(w)).length;
    if (answerWords.length > 0 && matched / answerWords.length >= 0.3) return true;
  }
  return false;
}

// ─── Quiz Runner ─────────────────────────────────────────────

interface QuizResults {
  label: string;
  singleTopic: { correct: number; total: number };
  crossTopic: { correct: number; total: number };
  noise: { correct: number; total: number };
  overall: number;
  details: { question: string; type: string; found: boolean; timeMs: number }[];
}

async function runQuiz(agentId: string, label: string, questions: QuizQuestion[]): Promise<QuizResults> {
  const results: QuizResults = {
    label,
    singleTopic: { correct: 0, total: 0 },
    crossTopic: { correct: 0, total: 0 },
    noise: { correct: 0, total: 0 },
    overall: 0,
    details: [],
  };

  for (const q of questions) {
    const bucket = q.type === 'single-topic' ? results.singleTopic
      : q.type === 'cross-topic' ? results.crossTopic : results.noise;
    bucket.total++;

    const start = performance.now();
    const res = await api('POST', '/memory/activate', {
      agentId,
      context: q.question,
      limit: 5,
      includeStaging: true,
      useReranker: true,
      useExpansion: true,
    });
    const timeMs = Math.round(performance.now() - start);
    const scored = (res.results ?? []).map((r: any) => ({ content: r.engram?.content ?? '', score: r.score ?? 0 }));
    const found = scoreAnswer(q, scored);
    if (found) bucket.correct++;

    const icon = found ? '+' : '-';
    const tag = q.type === 'noise' ? 'NOISE' : q.type === 'cross-topic' ? 'CROSS' : 'SINGLE';
    console.log(`    [${icon}] [${tag}] ${q.question.slice(0, 55)}... ${timeMs}ms`);

    results.details.push({ question: q.question, type: q.type, found, timeMs });
  }

  const totalCorrect = results.singleTopic.correct + results.crossTopic.correct + results.noise.correct;
  const totalQuestions = results.singleTopic.total + results.crossTopic.total + results.noise.total;
  results.overall = totalQuestions > 0 ? totalCorrect / totalQuestions * 100 : 0;

  return results;
}

function printResults(r: QuizResults) {
  const s = r.singleTopic;
  const c = r.crossTopic;
  const n = r.noise;
  console.log(`\n  ${r.label}:`);
  console.log(`    Single-topic:  ${s.correct}/${s.total} (${(s.correct / s.total * 100).toFixed(0)}%)`);
  console.log(`    Cross-topic:   ${c.correct}/${c.total} (${(c.correct / c.total * 100).toFixed(0)}%)`);
  console.log(`    Noise reject:  ${n.correct}/${n.total} (${(n.correct / n.total * 100).toFixed(0)}%)`);
  console.log(`    Overall:       ${r.overall.toFixed(1)}%`);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('Sleep Cycle Test');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const health = await api('GET', '/health');
  if (health.status !== 'ok') { console.error('Server not reachable'); process.exit(1); }

  const agent = await api('POST', '/agent/register', { name: 'sleep-cycle-test' });
  const agentId = agent.id;
  console.log(`Agent: ${agentId}`);

  // ═══════════════════════════════════════════════
  // WAVE 1: Seed 60 memories
  // ═══════════════════════════════════════════════
  console.log('\n══ WAVE 1: Seeding 60 memories (4 topic clusters) ══');
  for (let i = 0; i < wave1.length; i++) {
    const e = wave1[i];
    await api('POST', '/memory/write', {
      agentId, concept: e.concept, content: e.content, tags: e.tags,
      eventType: e.eventType, surprise: e.surprise, causalDepth: e.causalDepth,
      resolutionEffort: 0.3, decisionMade: e.eventType === 'decision',
    });
    if ((i + 1) % 15 === 0) console.log(`  ${i + 1}/${wave1.length} seeded`);
  }

  console.log('  Waiting for embeddings (15s)...');
  await sleep(15000);

  // Warmup reranker
  await api('POST', '/memory/activate', { agentId, context: 'warmup query', limit: 3, useReranker: true });
  await sleep(2000);

  // ═══════════════════════════════════════════════
  // QUIZ 1: Before first sleep (full quiz — Wave 1 data only)
  // ═══════════════════════════════════════════════
  console.log('\n══ QUIZ 1: Before Sleep #1 (Wave 1 only) ══');
  const before1 = await runQuiz(agentId, 'Before Sleep #1', quiz);
  printResults(before1);

  // ═══════════════════════════════════════════════
  // SLEEP CYCLE 1
  // ═══════════════════════════════════════════════
  console.log('\n══ SLEEP CYCLE 1 ══');
  const sleep1 = await api('POST', '/system/consolidate', { agentId });
  console.log(`  Clusters: ${sleep1.clustersFound} | Strengthened: ${sleep1.edgesStrengthened} | Created: ${sleep1.edgesCreated} | Bridges: ${sleep1.bridgesCreated ?? 0} | Decayed: ${sleep1.edgesDecayed} | Homeostasis: ${sleep1.edgesNormalized ?? 0} | Archived: ${sleep1.memoriesArchived ?? 0}`);

  // ═══════════════════════════════════════════════
  // QUIZ 2: After first sleep (still wave 1 data only)
  // ═══════════════════════════════════════════════
  console.log('\n══ QUIZ 2: After Sleep #1 (Wave 1 only) ══');
  const after1 = await runQuiz(agentId, 'After Sleep #1', quiz);
  printResults(after1);

  // ═══════════════════════════════════════════════
  // WAVE 2: Seed 15 more cross-topic memories
  // ═══════════════════════════════════════════════
  console.log('\n══ WAVE 2: Seeding 15 cross-topic memories ══');
  for (let i = 0; i < wave2.length; i++) {
    const e = wave2[i];
    await api('POST', '/memory/write', {
      agentId, concept: e.concept, content: e.content, tags: e.tags,
      eventType: e.eventType, surprise: e.surprise, causalDepth: e.causalDepth,
      resolutionEffort: 0.3, decisionMade: e.eventType === 'decision',
    });
  }
  console.log(`  ${wave2.length} seeded`);
  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // ═══════════════════════════════════════════════
  // QUIZ 3: After wave 2 but BEFORE second sleep
  // ═══════════════════════════════════════════════
  console.log('\n══ QUIZ 3: Before Sleep #2 (full quiz, all data) ══');
  const before2 = await runQuiz(agentId, 'Before Sleep #2', quiz);
  printResults(before2);

  // ═══════════════════════════════════════════════
  // SLEEP CYCLE 2
  // ═══════════════════════════════════════════════
  console.log('\n══ SLEEP CYCLE 2 ══');
  const sleep2 = await api('POST', '/system/consolidate', { agentId });
  console.log(`  Clusters: ${sleep2.clustersFound} | Strengthened: ${sleep2.edgesStrengthened} | Created: ${sleep2.edgesCreated} | Bridges: ${sleep2.bridgesCreated ?? 0} | Decayed: ${sleep2.edgesDecayed} | Homeostasis: ${sleep2.edgesNormalized ?? 0} | Archived: ${sleep2.memoriesArchived ?? 0}`);

  // ═══════════════════════════════════════════════
  // QUIZ 4: After second sleep (full quiz)
  // ═══════════════════════════════════════════════
  console.log('\n══ QUIZ 4: After Sleep #2 (full quiz, all data) ══');
  const after2 = await runQuiz(agentId, 'After Sleep #2', quiz);
  printResults(after2);

  // ═══════════════════════════════════════════════
  // SLEEP CYCLE 3 (bonus — deeper consolidation)
  // ═══════════════════════════════════════════════
  console.log('\n══ SLEEP CYCLE 3 (deeper consolidation) ══');
  const sleep3 = await api('POST', '/system/consolidate', { agentId });
  console.log(`  Clusters: ${sleep3.clustersFound} | Strengthened: ${sleep3.edgesStrengthened} | Created: ${sleep3.edgesCreated} | Bridges: ${sleep3.bridgesCreated ?? 0} | Decayed: ${sleep3.edgesDecayed} | Homeostasis: ${sleep3.edgesNormalized ?? 0} | Archived: ${sleep3.memoriesArchived ?? 0}`);

  console.log('\n══ QUIZ 5: After Sleep #3 (full quiz) ══');
  const after3 = await runQuiz(agentId, 'After Sleep #3', quiz);
  printResults(after3);

  // ═══════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('SLEEP CYCLE IMPACT REPORT');
  console.log('='.repeat(60));

  const allRounds = [before1, after1, before2, after2, after3];
  console.log('\n  Round-by-round:');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Phase                  Single  Cross  Noise  Overall');
  for (const r of allRounds) {
    const s = `${r.singleTopic.correct}/${r.singleTopic.total}`;
    const c = `${r.crossTopic.correct}/${r.crossTopic.total}`;
    const n = `${r.noise.correct}/${r.noise.total}`;
    console.log(`  ${r.label.padEnd(24)} ${s.padEnd(7)} ${c.padEnd(7)} ${n.padEnd(7)} ${r.overall.toFixed(1)}%`);
  }

  const crossImprovement = after2.crossTopic.correct - before2.crossTopic.correct;
  const crossImprovement2 = after3.crossTopic.correct - before2.crossTopic.correct;
  console.log(`\n  Cross-topic improvement after sleep #2: ${crossImprovement >= 0 ? '+' : ''}${crossImprovement} questions`);
  console.log(`  Cross-topic improvement after sleep #3: ${crossImprovement2 >= 0 ? '+' : ''}${crossImprovement2} questions`);
  console.log(`\n  Sleep cycle #1: ${sleep1.edgesCreated} created, ${sleep1.bridgesCreated ?? 0} bridges, ${sleep1.edgesStrengthened} strengthened, ${sleep1.edgesNormalized ?? 0} normalized`);
  console.log(`  Sleep cycle #2: ${sleep2.edgesCreated} created, ${sleep2.bridgesCreated ?? 0} bridges, ${sleep2.edgesStrengthened} strengthened, ${sleep2.edgesNormalized ?? 0} normalized`);
  console.log(`  Sleep cycle #3: ${sleep3.edgesCreated} created, ${sleep3.bridgesCreated ?? 0} bridges, ${sleep3.edgesStrengthened} strengthened, ${sleep3.edgesNormalized ?? 0} normalized`);

  // Write report
  const report = `# Sleep Cycle Test — ${new Date().toISOString()}

## Summary
| Phase | Single-Topic | Cross-Topic | Noise | Overall |
|-------|-------------|-------------|-------|---------|
${allRounds.map(r =>
  `| ${r.label} | ${r.singleTopic.correct}/${r.singleTopic.total} | ${r.crossTopic.correct}/${r.crossTopic.total} | ${r.noise.correct}/${r.noise.total} | ${r.overall.toFixed(1)}% |`
).join('\n')}

## Sleep Cycle Stats
| Cycle | Clusters | Strengthened | Created | Decayed | Pruned |
|-------|----------|-------------|---------|---------|--------|
| #1 | ${sleep1.clustersFound} | ${sleep1.edgesStrengthened} | ${sleep1.edgesCreated} | ${sleep1.edgesDecayed} | ${sleep1.edgesPruned} |
| #2 | ${sleep2.clustersFound} | ${sleep2.edgesStrengthened} | ${sleep2.edgesCreated} | ${sleep2.edgesDecayed} | ${sleep2.edgesPruned} |
| #3 | ${sleep3.clustersFound} | ${sleep3.edgesStrengthened} | ${sleep3.edgesCreated} | ${sleep3.edgesDecayed} | ${sleep3.edgesPruned} |

## Cross-Topic Improvement
- Before sleep: ${before2.crossTopic.correct}/${before2.crossTopic.total}
- After sleep #2: ${after2.crossTopic.correct}/${after2.crossTopic.total} (${crossImprovement >= 0 ? '+' : ''}${crossImprovement})
- After sleep #3: ${after3.crossTopic.correct}/${after3.crossTopic.total} (${crossImprovement2 >= 0 ? '+' : ''}${crossImprovement2})

## Detailed Results
${allRounds.map(r => `### ${r.label}\n${r.details.map(d =>
  `- [${d.found ? 'PASS' : 'FAIL'}] [${d.type}] ${d.question} (${d.timeMs}ms)`
).join('\n')}`).join('\n\n')}
`;
  writeFileSync(RESULTS_FILE, report);
  console.log(`\n  Results written to: ${RESULTS_FILE}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
