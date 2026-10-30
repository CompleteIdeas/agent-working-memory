/**
 * Absent-fact probes for the real-store snapshot: realistic work questions about things the
 * store has never recorded. Replaces the 10 adversarial probes, too few to measure abstention.
 *
 * Each candidate names the DISTINCTIVE terms that would have to appear in a memory for it
 * to be answerable. A candidate is kept only if none of those terms occurs anywhere in the
 * snapshot (FTS over concept, content and tags, every agent), so "absent" is verified, not
 * assumed. Two registers, because they fail differently:
 *   near   — in the store's own domains (dev tooling, the projects, equestrian sport,
 *            nonprofit work) — the hard case: plenty of related vocabulary nearby
 *   far    — unrelated to anything the store is about
 *
 *   npx tsx tests/realstore-eval/absent-probes.ts   → writes fixture-absent.json
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Cand = { q: string; must: string[]; register: 'near' | 'far' };
const C: Cand[] = [
  // near — the store's own domains, specific facts it does not hold
  { q: 'Kafka consumer lag alert threshold for the entries pipeline', must: ['kafka'], register: 'near' },
  { q: 'Terraform state lock table for the Azure resources', must: ['terraform'], register: 'near' },
  { q: 'Datadog APM trace sampling rate on the API', must: ['datadog'], register: 'near' },
  { q: 'Sentry DSN rotation for the web app', must: ['sentry'], register: 'near' },
  { q: 'Elasticsearch index mapping for horse search', must: ['elasticsearch'], register: 'near' },
  { q: 'GraphQL federation gateway for the member service', must: ['graphql'], register: 'near' },
  { q: 'Kubernetes horizontal pod autoscaler settings', must: ['kubernetes', 'autoscaler'], register: 'near' },
  { q: 'Twilio SMS reminder template for ride times', must: ['twilio'], register: 'near' },
  { q: 'Plaid bank link for club treasurer reconciliation', must: ['plaid'], register: 'near' },
  { q: 'QuickBooks Online sync mapping for event fees', must: ['quickbooks'], register: 'near' },
  { q: 'Salesforce NPSP donor import for Wellness Loudoun', must: ['salesforce', 'npsp'], register: 'near' },
  { q: 'Mailchimp audience segment for lapsed members', must: ['mailchimp'], register: 'near' },
  { q: 'HubSpot deal pipeline stages for sponsorships', must: ['hubspot'], register: 'near' },
  { q: 'Okta SAML app for staff single sign-on', must: ['okta'], register: 'near' },
  { q: 'Auth0 rule for refreshing member roles', must: ['auth0'], register: 'near' },
  { q: 'Firebase Cloud Messaging push for the rowing app', must: ['firebase'], register: 'near' },
  { q: 'Flutter build flavor for the RosterKeep mobile app', must: ['flutter'], register: 'near' },
  { q: 'Swift UI widget for practice countdown', must: ['swiftui', 'widgetkit'], register: 'near' },
  { q: 'Kotlin coroutine scope for the scoring sync', must: ['kotlin', 'coroutine'], register: 'near' },
  { q: 'Rust axum handler for the timing board feed', must: ['axum'], register: 'near' },
  { q: 'Go gRPC service for results export', must: ['grpc'], register: 'near' },
  { q: 'Django admin action to merge duplicate riders', must: ['django'], register: 'near' },
  { q: 'Laravel queue worker for the newsletter', must: ['laravel'], register: 'near' },
  { q: 'Ruby on Rails migration for the officials table', must: ['rails'], register: 'near' },
  { q: 'Svelte store for the scorecard UI', must: ['svelte'], register: 'near' },
  { q: 'Angular module for the board portal', must: ['angular'], register: 'near' },
  { q: 'Vue composable for the entry wizard', must: ['vue', 'composable'], register: 'near' },
  { q: 'Snowflake warehouse size for membership analytics', must: ['snowflake'], register: 'near' },
  { q: 'BigQuery export of competition starts', must: ['bigquery'], register: 'near' },
  { q: 'Redshift cluster for historical results', must: ['redshift'], register: 'near' },
  { q: 'MongoDB Atlas cluster for the horse registry', must: ['mongodb', 'atlas'], register: 'near' },
  { q: 'DynamoDB table for session tokens', must: ['dynamodb'], register: 'near' },
  { q: 'Cassandra keyspace for timing data', must: ['cassandra'], register: 'near' },
  { q: 'Neo4j graph of rider and horse relationships', must: ['neo4j'], register: 'near' },
  { q: 'Pinecone index for document search', must: ['pinecone'], register: 'near' },
  { q: 'Weaviate schema for the knowledge base', must: ['weaviate'], register: 'near' },
  { q: 'LangChain agent for member support', must: ['langchain'], register: 'near' },
  { q: 'LlamaIndex ingestion for the rulebook', must: ['llamaindex'], register: 'near' },
  { q: 'Jenkins pipeline for the legacy deploy', must: ['jenkins'], register: 'near' },
  { q: 'CircleCI config for the mobile build', must: ['circleci'], register: 'near' },
  { q: 'Bitbucket Pipelines cache for node modules', must: ['bitbucket'], register: 'near' },
  { q: 'GitLab runner registration token', must: ['gitlab'], register: 'near' },
  { q: 'Heroku dyno sizing for the scoring service', must: ['heroku'], register: 'near' },
  { q: 'Netlify redirect rules for the landing page', must: ['netlify'], register: 'near' },
  { q: 'Vercel edge config for feature flags', must: ['vercel'], register: 'near' },
  { q: 'Fly.io machine region for the API', must: ['fly.io', 'flyctl'], register: 'near' },
  { q: 'DigitalOcean droplet for the staging server', must: ['digitalocean', 'droplet'], register: 'near' },
  { q: 'Linode backup schedule', must: ['linode'], register: 'near' },
  { q: 'Zendesk macro for refund requests', must: ['zendesk'], register: 'near' },
  { q: 'Intercom chat routing for new members', must: ['intercom'], register: 'near' },
  { q: 'Jira epic for the scoring rewrite', must: ['jira'], register: 'near' },
  { q: 'Asana project template for event setup', must: ['asana'], register: 'near' },
  { q: 'Trello board for board meeting actions', must: ['trello'], register: 'near' },
  { q: 'Monday.com automation for sponsor follow-ups', must: ['monday.com'], register: 'near' },
  { q: 'Airtable base for volunteer shifts', must: ['airtable'], register: 'near' },
  { q: 'Zapier zap that posts results to Slack', must: ['zapier'], register: 'near' },
  { q: 'Calendly link for coach office hours', must: ['calendly'], register: 'near' },
  { q: 'DocuSign template for the liability waiver', must: ['docusign'], register: 'near' },
  { q: 'Square terminal for on-site entry payments', must: ['square terminal', 'squareup'], register: 'near' },
  { q: 'Venmo business account for club dues', must: ['venmo business'], register: 'near' },
  { q: 'dressage freestyle music licensing for the championships', must: ['freestyle music'], register: 'near' },
  { q: 'farrier schedule for the lesson horses', must: ['farrier schedule'], register: 'near' },
  { q: 'coggins test expiry reminder for stabling', must: ['coggins'], register: 'near' },
  { q: 'regatta lane draw for the head race', must: ['lane draw'], register: 'near' },
  { q: 'erg test standards for the novice boys', must: ['erg test', 'ergometer test'], register: 'near' },
  { q: 'oar rigging pitch settings for the eight', must: ['rigging pitch'], register: 'near' },
  { q: 'scout troop popcorn sale totals', must: ['popcorn'], register: 'near' },
  { q: 'Eagle board of review date for the troop', must: ['board of review'], register: 'near' },
  { q: 'grant budget for the Loudoun Youth Initiative', must: ['loudoun youth initiative'], register: 'near' },
  { q: 'LearnAI workshop catering order for the library', must: ['catering order'], register: 'near' },
  // far — nothing to do with the store
  { q: 'sourdough starter feeding ratio in winter', must: ['sourdough'], register: 'far' },
  { q: 'best time to prune hydrangeas', must: ['hydrangea'], register: 'far' },
  { q: 'tire pressure for the minivan in cold weather', must: ['tire pressure'], register: 'far' },
  { q: 'how long to brine a turkey', must: ['brine', 'turkey'], register: 'far' },
  { q: 'guitar string gauge for drop D tuning', must: ['drop d', 'string gauge'], register: 'far' },
  { q: 'marathon taper plan three weeks out', must: ['taper plan', 'marathon'], register: 'far' },
  { q: 'chess opening repertoire against the Sicilian', must: ['sicilian'], register: 'far' },
  { q: 'aquarium nitrate levels for neon tetras', must: ['nitrate', 'tetra'], register: 'far' },
  { q: 'knitting gauge swatch for a wool sweater', must: ['knitting', 'swatch'], register: 'far' },
  { q: 'espresso grind size for a single basket', must: ['espresso'], register: 'far' },
  { q: 'birdhouse hole size for bluebirds', must: ['bluebird'], register: 'far' },
  { q: 'sunscreen SPF for a beach day', must: ['sunscreen'], register: 'far' },
  { q: 'snow chain size for the truck', must: ['snow chain'], register: 'far' },
  { q: 'wine pairing for grilled salmon', must: ['wine pairing'], register: 'far' },
  { q: 'piano practice routine for scales', must: ['piano'], register: 'far' },
  { q: 'camping stove fuel canister type', must: ['fuel canister'], register: 'far' },
  { q: 'dog vaccine schedule for a puppy', must: ['puppy'], register: 'far' },
  { q: 'lawn aeration timing in the fall', must: ['aeration'], register: 'far' },
  { q: 'fishing license renewal fee', must: ['fishing license'], register: 'far' },
  { q: 'bike chain lubricant for wet weather', must: ['chain lube', 'chain lubricant'], register: 'far' },
  { q: 'home furnace filter MERV rating', must: ['merv'], register: 'far' },
  { q: 'tomato plant spacing in raised beds', must: ['tomato plant', 'raised bed'], register: 'far' },
  { q: 'solar panel inverter warranty terms', must: ['inverter warranty', 'solar panel'], register: 'far' },
  { q: 'passport photo size requirements', must: ['passport photo'], register: 'far' },
  { q: 'babysitter hourly rate in Ashburn', must: ['babysitter'], register: 'far' },
  { q: 'yoga poses for lower back pain', must: ['yoga'], register: 'far' },
  { q: 'refrigerator water filter model number', must: ['water filter'], register: 'far' },
  { q: 'mortgage refinance break-even point', must: ['refinance'], register: 'far' },
  { q: 'wedding toast length guidelines', must: ['wedding toast'], register: 'far' },
  { q: 'ski wax temperature range', must: ['ski wax'], register: 'far' },
  { q: 'pizza dough hydration percentage', must: ['pizza dough'], register: 'far' },
  { q: 'how to descale a kettle', must: ['descale', 'kettle'], register: 'far' },
  { q: 'telescope eyepiece for planets', must: ['telescope', 'eyepiece'], register: 'far' },
  { q: 'beekeeping hive inspection checklist', must: ['beekeeping', 'hive inspection'], register: 'far' },
  { q: 'origami crane folding steps', must: ['origami'], register: 'far' },
];

const db = new Database(join(import.meta.dirname, 'snapshot', 'store.db'), { readonly: true });
const present = (term: string): boolean => {
  // Phrase match through FTS, plus a LIKE fallback for terms FTS tokenizes apart (fly.io).
  const fts = (() => {
    try {
      return (db.prepare(`SELECT 1 FROM engrams_fts WHERE engrams_fts MATCH ? LIMIT 1`).get(`"${term.replace(/"/g, '')}"`)) != null;
    } catch { return false; }
  })();
  if (fts) return true;
  return (db.prepare(`SELECT 1 FROM engrams WHERE lower(concept || ' ' || content || ' ' || tags) LIKE ? LIMIT 1`).get(`%${term.toLowerCase()}%`)) != null;
};

const kept: Array<{ query: string; register: string }> = [];
const dropped: string[] = [];
for (const c of C) {
  if (c.must.some(present)) dropped.push(`${c.register}: ${c.q}`);
  else kept.push({ query: c.q, register: c.register });
}
db.close();
writeFileSync(join(import.meta.dirname, 'fixture-absent.json'), JSON.stringify({
  note: 'Absent-fact probes: each one\'s distinctive terms occur nowhere in snapshot/store.db (verified by FTS phrase + LIKE). Correct behaviour is silence.',
  generated: new Date().toISOString(), items: kept,
}, null, 1));
console.log(`kept ${kept.length} (near ${kept.filter((k) => k.register === 'near').length}, far ${kept.filter((k) => k.register === 'far').length}); dropped ${dropped.length} because the store DOES mention them:`);
for (const d of dropped) console.log(`  - ${d}`);
