/**
 * Long-memory corpus generator — the eval LoCoMo cannot be.
 *
 * WHY THIS EXISTS
 * ---------------
 * LoCoMo passages are conversational turns: median 115 chars, p99 363, only
 * 0.5% over 400. The reranker truncates passages at 400 chars
 * (activation.ts:867), so on LoCoMo that truncation is a no-op and the
 * benchmark is structurally incapable of detecting harm from it.
 *
 * The live store looks nothing like that. Measured on the real 29.8k-engram
 * store (11,294 active):
 *   - canonical memories: median 1,965 chars, 98.7% exceed 400
 *   - 52.1% of ALL stored characters sit past the truncation point
 *   - the reranker cannot see 78.8% of each canonical memory's distinct vocabulary
 *   - 99.9% of long canonical memories carry identifiers (hostnames, table
 *     names, function names, ticket ids) that exist ONLY past char 400
 *
 * So this corpus is shaped like the real store, not like a chat log: long,
 * structured, identifier-dense project findings. The answer-bearing fact is
 * planted at a CONTROLLED OFFSET so the truncation cliff can be measured
 * directly rather than inferred.
 *
 * DESIGN NOTES
 * ------------
 * - Distractors are same-domain and share vocabulary, so ranking is a real
 *   discrimination task, not a lookup. A corpus of unrelated memories would
 *   make everything rank 1 and measure nothing.
 * - Each planted fact uses a DISTINCTIVE identifier (a hostname, a table
 *   column, a job name) of the kind AWM's own writing guidance tells authors
 *   to include: "the literal terms a future query will use".
 * - Offsets straddle the 400-char boundary so the control (visible) and
 *   treatment (hidden) conditions differ ONLY in position, not in content.
 */

export interface LongMemory {
  id: string;
  concept: string;
  content: string;
  /** char offset where the answer sentence was planted */
  offset: number;
  /** the offset bucket this memory belongs to */
  bucket: string;
  /** query that should retrieve it */
  query: string;
  /** the distinctive identifier the query hinges on */
  identifier: string;
}

/** Realistic filler in the register of a real engineering memory. */
const FILLER = [
  'The change was reviewed against the existing migration ordering and no conflicts were found with the pending schema work already queued for this sprint.',
  'Rollout followed the standard staged pattern: staging first, soak for one business day, then production during the low-traffic window with the on-call engineer paged in.',
  'Observability was extended at the same time so the failure mode would be visible next time rather than requiring a manual bisect through the request logs.',
  'The team debated whether to gate this behind a feature flag and decided against it, on the grounds that a partial rollout would leave two inconsistent code paths live.',
  'Documentation was updated in the same change set so the runbook does not drift from the implementation, which has bitten this area twice before.',
  'Load characteristics were measured before and after; throughput was unchanged within noise and p95 latency moved by less than a millisecond.',
  'A follow-up was filed to revisit the retry policy once the upstream provider publishes their revised rate-limit guidance later in the quarter.',
  'Backfill was run in batches with a checkpoint table so an interrupted run could resume without double-processing any rows.',
  'The original implementation predates the current service boundaries, which is why the logic lived in the wrong module and was easy to miss during review.',
  'Test coverage was added for the boundary condition specifically, since the existing suite only exercised the happy path and would not have caught a regression.',
  'Support was notified ahead of the change so inbound tickets referencing the old behaviour could be triaged correctly during the transition period.',
  'Cost impact was estimated as negligible; the additional storage is bounded by the retention policy already enforced on the parent table.',
];

/** Domains give the corpus topical clustering, so distractors are genuinely confusable. */
const DOMAINS = [
  {
    name: 'deploy',
    conceptFmt: (i: number) => `Deployment pipeline finding ${i} — build and release path`,
    facts: [
      { id: 'psql-equihub-dev2.postgres.database.azure.com', sentence: (id: string) => `The dev database host is ${id} and it is the only host that accepts the migration runner's service principal.`, q: (id: string) => `which database host does the migration runner connect to` },
      { id: 'KUDU_DEPLOY_TOKEN', sentence: (id: string) => `Deployments authenticate with ${id}, which must be rotated manually because the pipeline does not refresh it.`, q: (id: string) => `what credential do deployments authenticate with` },
      { id: 'azure-pipelines-nightly.yml', sentence: (id: string) => `The nightly job is defined in ${id}, separate from the main pipeline definition.`, q: (id: string) => `where is the nightly build job defined` },
    ],
  },
  {
    name: 'scoring',
    conceptFmt: (i: number) => `Scoring subsystem finding ${i} — phase and results handling`,
    facts: [
      { id: 'tblMeeCompRes.dressage_penalties', sentence: (id: string) => `The establishment signal is ${id} being non-null, which is what marks a valid starter.`, q: (id: string) => `what marks an entry as a valid starter` },
      { id: 'sp_api_results_division_GET', sentence: (id: string) => `RunStatus is computed inside ${id}, not in the frontend, so the public view can disagree with the internal one.`, q: (id: string) => `where is RunStatus computed` },
      { id: 'schedule_slot', sentence: (id: string) => `Division reassignment updates the entry row but historically never released the ${id} records, leaving phantom slots behind.`, q: (id: string) => `what gets orphaned when a division is reassigned` },
    ],
  },
  {
    name: 'auth',
    conceptFmt: (i: number) => `Authentication finding ${i} — session and token handling`,
    facts: [
      { id: 'AuthService.requestMagicLink', sentence: (id: string) => `Rate limiting is enforced in ${id} at five requests per fifteen minutes per email address.`, q: (id: string) => `where is the magic link rate limit enforced` },
      { id: 'login_attempts', sentence: (id: string) => `Attempt counting is backed by the ${id} table, which is never pruned and has grown unbounded.`, q: (id: string) => `which table backs login attempt counting` },
      { id: 'AADSTS700082', sentence: (id: string) => `The refresh token failure surfaces as ${id}, an inactivity expiry rather than a revocation.`, q: (id: string) => `what error code indicates the refresh token expired` },
    ],
  },
  {
    name: 'billing',
    conceptFmt: (i: number) => `Billing finding ${i} — invoicing and fee assignment`,
    facts: [
      { id: 'fee_assignment', sentence: (id: string) => `Duplicate charges come from rows landing in both ${id} and the invoice item table during import.`, q: (id: string) => `where do duplicate charges come from` },
      { id: 'DUNNING', sentence: (id: string) => `After three failed attempts the invoice is parked in ${id} for manual review rather than retried further.`, q: (id: string) => `what state does an invoice enter after repeated failures` },
      { id: 'closePeriod', sentence: (id: string) => `The blocked-state check lives in ${id} server-side; a client-only check previously allowed a bypass.`, q: (id: string) => `where is the period close block enforced` },
    ],
  },
];

/**
 * Offset buckets. The control sits comfortably inside the 400-char window; the
 * treatments sit progressively further past it. Same content, same query, only
 * the POSITION differs — which is what makes the cliff attributable.
 */
export const BUCKETS = [
  { name: 'visible (<400)', target: 150 },
  { name: 'just past (~700)', target: 700 },
  { name: 'mid (~1600)', target: 1600 },
  { name: 'deep (~3000)', target: 3000 },
];

export function buildCorpus(perBucketPerDomain = 3): LongMemory[] {
  const out: LongMemory[] = [];
  let n = 0;

  for (const domain of DOMAINS) {
    for (const bucket of BUCKETS) {
      for (let rep = 0; rep < perBucketPerDomain; rep++) {
        const fact = domain.facts[rep % domain.facts.length];
        n++;
        // Unique per-memory identifier so each query has exactly one right answer.
        const uid = `${fact.id}`;
        const marker = `case-${domain.name}-${bucket.target}-${rep}`;
        const answer = ` For ${marker}: ${fact.sentence(uid)} `;

        // Grow filler until we reach the target offset, then plant the answer,
        // then pad out so length is not itself a cue.
        let head = '';
        let fi = n;
        while (head.length < bucket.target) head += FILLER[fi++ % FILLER.length] + ' ';
        let tail = '';
        while (tail.length < 900) tail += FILLER[fi++ % FILLER.length] + ' ';

        const content = head + answer + tail;
        out.push({
          id: `${domain.name}-${bucket.target}-${rep}`,
          concept: domain.conceptFmt(n),
          content,
          offset: head.length,
          bucket: bucket.name,
          query: `${fact.q(uid)} for ${marker}`,
          identifier: uid,
        });
      }
    }
  }
  return out;
}
