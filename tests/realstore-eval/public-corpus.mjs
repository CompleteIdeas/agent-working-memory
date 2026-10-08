/**
 * Public corpus generator — makes the real-store benchmark reproducible by
 * strangers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The headline retrieval numbers in docs/benchmarks-current.md are measured
 * against `snapshot/store.db`, a frozen copy of a real 30k-memory work store.
 * That snapshot cannot be published — it is a private corpus containing real
 * identifiers, real colleagues and real internal decisions — so it is
 * gitignored, and every artifact derived from it is too.
 *
 * The honest consequence was that nobody outside could reproduce anything,
 * while the README said "reproducible from this repository". This generator
 * closes that gap: it synthesises a corpus SHAPED like the real store, from a
 * seeded PRNG, so anyone can build the snapshot and run the identical runner
 * and the identical ground-truth derivation.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * Numbers from this corpus are NOT the numbers in benchmarks-current.md and
 * must never be quoted as them. A synthetic corpus cannot reproduce a real
 * one: it has no genuine supersession history, no months of real co-recall
 * edges, no human inconsistency in how the same thing got written down three
 * times. It scores LOWER, not higher — generated prose is more self-similar
 * than real prose, so same-domain neighbours are harder to tell apart than
 * they would be in a real store. What it reproduces is the METHOD — the same hold-out, the same
 * scoring, the same abstention accounting — plus a stable public baseline that
 * a change can be measured against. Treat a delta here as signal and an
 * absolute here as a floor.
 *
 * SHAPED LIKE WHAT, EXACTLY
 * -------------------------
 * Matched to the properties the real store was measured to have (the same ones
 * that retired LoCoMo — see tests/longmem-eval/corpus.ts):
 *   - long bodies: target median ~1,900 chars, nearly all over 400
 *   - identifier-dense, in the shapes AWM's writing guidance asks for
 *   - the answer-bearing identifier planted at a CONTROLLED offset, straddling
 *     the 400-char reranker window so the truncation cliff is measurable
 *   - same-domain neighbours sharing vocabulary, so ranking is discrimination
 *     rather than lookup
 *   - two agent scopes, because agent isolation is a product feature that a
 *     benchmark must not score as a ranking defect
 *
 * EVERY NAME HERE IS INVENTED. The domain is a fictional freight company, and
 * hostnames use the RFC 2606 reserved `.test` TLD so they can never resolve to
 * anything real.
 *
 * Deterministic: same seed in, byte-identical corpus out.
 */

/** mulberry32 — small, fast, and stable across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Filler in the register of a real engineering memory.
 *
 * Deliberately free of dotted and snake_case tokens: the ground-truth builder
 * harvests those shapes as candidate identifiers, so a stray `config.yaml` in
 * filler would become a second "unique identifier" in the engram and pollute
 * the hold-out.
 */
const FILLER = [
  'The behaviour was confirmed against the staging replica before anything was changed in production, because the previous attempt at this was reverted for exactly that reason.',
  'Rollout followed the staged pattern the team settled on last quarter: staging first, soak for one business day, then production inside the low-traffic window with on-call paged in.',
  'Observability was widened in the same change so the next occurrence shows up on a dashboard instead of requiring somebody to bisect a week of request logs by hand.',
  'There was a long argument about whether to gate this behind a flag; the decision was not to, on the grounds that a partial rollout leaves two inconsistent paths live at once.',
  'The runbook was updated alongside the code so the written procedure does not drift from what the system actually does, which has caught this team out twice before.',
  'Throughput was measured either side of the change and moved within noise; the ninety-fifth percentile shifted by well under a millisecond, which nobody can perceive.',
  'A follow-up was filed to revisit the retry policy once the upstream carrier publishes the revised rate limits they have been promising since the spring.',
  'The backfill ran in batches against a checkpoint table, so an interrupted run resumes cleanly rather than double-processing rows it had already finished.',
  'This logic predates the current service boundaries, which is why it lived in the wrong module and was easy for three reviewers in a row to skim past.',
  'Coverage was added for the boundary case specifically; the existing suite only walked the happy path and would not have caught the regression at all.',
  'Support were told ahead of the change so inbound tickets quoting the old behaviour could be triaged correctly through the transition rather than bounced.',
  'Cost impact is negligible: the extra storage is bounded by the retention window already enforced on the parent records, so it cannot grow without limit.',
  'Two earlier tickets describe the same symptom with a different cause, so the search terms overlap heavily and the wrong one surfaces first about half the time.',
  'The vendor confirmed the behaviour is intentional and documented, in a page that is not linked from anywhere a person would reasonably look for it.',
  'Timing matters here: the job and the nightly export contend for the same advisory lock, and whichever starts second waits rather than failing loudly.',
];

/**
 * Give each filler sentence an engram-specific, DOMAIN-NEUTRAL tail.
 *
 * WHY NEUTRAL: the first attempt injected the engram's own domain vocabulary
 * here, on the theory that distinctive tails help the reranker discriminate.
 * It did the opposite — measured, s@1 fell from 48.3% to 37.7% — because every
 * memory in a domain then repeated that domain's six words many times over,
 * making same-domain neighbours harder to tell apart, not easier. What
 * separates two memories is the unique identifier and the specific concept, so
 * the filler must vary WITHOUT adding topical signal.
 */
function flavor(sentence, i, r) {
  const tails = [
    `The figure quoted at the time was ${100 + ((i * 7) % 900)}, which nobody has re-checked since.`,
    `This was raised again on the ${1 + (i % 28)}th and closed the same afternoon.`,
    `Two people reviewed it; the second had reservations that were not written down.`,
    `It reproduces about ${10 + (i % 80)}% of the time, which made it slow to pin down.`,
    `The earlier attempt was reverted after ${2 + (i % 9)} days for an unrelated reason.`,
  ];
  return `${sentence} ${tails[Math.floor(r() * tails.length)]}`;
}

/** Subsystems of the fictional platform. Neighbours within one share vocabulary. */
const DOMAINS = [
  {
    key: 'billing',
    words: ['consignment', 'invoice', 'reconciliation', 'surcharge', 'settlement', 'accrual'],
    concepts: [
      'Consignment invoice reconciliation drifts when a surcharge is backdated',
      'Settlement accrual double-counts partial consignment credits',
      'Surcharge rounding disagrees between the invoice and the settlement export',
      'Invoice reconciliation misses consignments cancelled mid-cycle',
    ],
  },
  {
    key: 'scheduling',
    words: ['dispatch', 'window', 'slot', 'depot', 'driver', 'rostering'],
    concepts: [
      'Dispatch slot allocation starves the smaller depots at peak',
      'Driver rostering ignores the window a depot actually opens',
      'Depot dispatch windows overlap across a daylight-saving boundary',
      'Slot reservation leaks when a dispatch is reassigned twice',
    ],
  },
  {
    key: 'ingest',
    words: ['manifest', 'customs', 'declaration', 'validation', 'carrier', 'feed'],
    concepts: [
      'Carrier manifest feed rejects declarations with a trailing customs field',
      'Manifest validation accepts a declaration with no customs code at all',
      'Customs declaration parsing drops the second consignee on multi-leg feeds',
      'Carrier feed retries replay manifests that already validated cleanly',
    ],
  },
  {
    key: 'auth',
    words: ['tenant', 'scope', 'principal', 'session', 'delegation', 'audit'],
    concepts: [
      'Tenant scope check runs client-side only on the delegation screen',
      'Principal delegation survives a session revocation it should not',
      'Audit trail omits the acting principal when a scope is inherited',
      'Session fixation possible when a tenant switches mid-flow',
    ],
  },
  {
    key: 'notify',
    words: ['template', 'digest', 'bounce', 'suppression', 'delivery', 'webhook'],
    concepts: [
      'Bounce suppression list is not consulted by the nightly digest',
      'Delivery webhook retries overwrite a later status with an earlier one',
      'Template rendering drops the digest footer for single-item sends',
      'Suppression entries expire silently and delivery resumes unannounced',
    ],
  },
  {
    key: 'reporting',
    words: ['extract', 'aggregate', 'snapshot', 'lineage', 'partition', 'refresh'],
    concepts: [
      'Aggregate refresh reads a partition the extract has not finished writing',
      'Snapshot lineage breaks when a partition is rebuilt out of order',
      'Extract partitioning splits a consignment across two reporting days',
      'Refresh ordering lets a stale aggregate win over a newer snapshot',
    ],
  },
];

// --- Identifier vocabularies. Each shape has its own space, so uniqueness
//     across shapes is automatic and within a shape is index-guaranteed. ---

const TABLES = [
  'manifest_lines', 'consignment_legs', 'depot_windows', 'driver_shifts',
  'invoice_items', 'settlement_runs', 'customs_entries', 'carrier_feeds',
  'tenant_scopes', 'principal_grants', 'audit_entries', 'session_tokens',
  'digest_batches', 'bounce_records', 'delivery_attempts', 'template_blocks',
  'extract_windows', 'aggregate_states', 'lineage_edges', 'partition_maps',
];

const COLUMNS = [
  'consignee_ref', 'surcharge_basis', 'settled_at', 'accrual_bucket',
  'window_opens', 'roster_version', 'slot_hold_until', 'depot_code',
  'customs_code', 'declaration_kind', 'leg_sequence', 'feed_checksum',
  'scope_path', 'granted_by', 'revoked_at', 'acting_principal',
  'suppressed_until', 'bounce_class', 'attempt_ordinal', 'render_variant',
  'partition_key', 'refreshed_through', 'lineage_depth', 'stale_after',
  'rebuild_token',
];

const PROC_VERBS = [
  'rebuild', 'reconcile', 'settle', 'allocate', 'validate', 'replay',
  'expire', 'suppress', 'refresh', 'repartition', 'backfill', 'reassign',
  'revoke', 'delegate', 'aggregate', 'snapshot', 'dispatch', 'roster',
  'declare', 'checksum',
];

const PROC_NOUNS = [
  'manifest', 'consignment', 'surcharge', 'settlement', 'depot_window',
  'driver_shift', 'customs_entry', 'carrier_feed', 'tenant_scope',
  'principal_grant', 'audit_entry', 'session_token', 'digest_batch',
  'bounce_record', 'delivery_attempt', 'template_block', 'extract_window',
  'aggregate_state', 'lineage_edge', 'partition_map',
];

const SERVICES = [
  'apigw', 'ingestd', 'billingd', 'dispatchd', 'notifyd', 'reportd',
  'authd', 'auditd', 'schedd', 'feedproxy', 'settled', 'customsd',
  'digestd', 'extractd', 'lineaged',
];

const REGIONS = [
  'eu1', 'eu2', 'us1', 'us2', 'ap1', 'ap2', 'sa1', 'af1', 'me1', 'ca1',
];

/**
 * The four identifier shapes the ground-truth harvester recognises.
 *
 * Each shape gets its own sequence index `n = floor(i / 4)`, 0..N/4, so the
 * table/column (and service/region) pairs walk a 2-D grid without repeating.
 * Indexing on `i` directly looked fine but collided: `i % 20` over a stride of
 * 4 only ever visits five of the twenty tables, and the service shape produced
 * 25 duplicate identifiers across 400 memories. A duplicate is not a harmless
 * near-miss here — the hold-out requires an identifier to appear in exactly one
 * memory, verified through FTS, so every collision silently deletes a probe.
 */
function identifierFor(i) {
  const n = Math.floor(i / 4);
  switch (i % 4) {
    case 0:
      return `${TABLES[n % TABLES.length]}.${COLUMNS[Math.floor(n / TABLES.length) % COLUMNS.length]}`;
    case 1:
      return `sp_${PROC_VERBS[n % PROC_VERBS.length]}_${PROC_NOUNS[Math.floor(n / PROC_VERBS.length) % PROC_NOUNS.length]}`;
    case 2:
      return `${SERVICES[n % SERVICES.length]}.${REGIONS[Math.floor(n / SERVICES.length) % REGIONS.length]}.harborview.test`;
    default:
      // Four or more leading uppercase letters, or the harvester skips it.
      return `HVFR${1000 + n}`;
  }
}

/**
 * Offset buckets for the planted identifier, straddling the 400-char reranker
 * window. Weighted long, because the real store is: 79% of its ground-truth
 * identifiers sit past the truncation point.
 */
const OFFSET_BUCKETS = [150, 250, 330, 450, 700, 1100, 1700, 2400];
// Weighted so roughly four in five identifiers land past the 400-char rerank
// window, which is where the real store sits (79%).
const OFFSET_WEIGHTS = [1, 1, 1, 2, 3, 3, 2, 2];

function pickOffset(r) {
  const total = OFFSET_WEIGHTS.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < OFFSET_BUCKETS.length; i++) {
    x -= OFFSET_WEIGHTS[i];
    if (x <= 0) return OFFSET_BUCKETS[i];
  }
  return OFFSET_BUCKETS[OFFSET_BUCKETS.length - 1];
}

/**
 * Build the corpus.
 *
 * @param {number} n     how many memories (default 400 — about 70s to seed,
 *                       since each write pays one real ONNX embedding)
 * @param {number} seed  PRNG seed; the same seed always yields the same corpus
 */
export function buildPublicCorpus(n = 400, seed = 20261008) {
  const r = rng(seed);
  const out = [];

  for (let i = 0; i < n; i++) {
    const d = DOMAINS[i % DOMAINS.length];
    const concept = `${d.concepts[Math.floor(i / DOMAINS.length) % d.concepts.length]} (${d.key} ${100 + i})`;
    const ident = identifierFor(i);
    const targetOffset = pickOffset(r);

    // Opening lines share the domain's vocabulary so same-domain neighbours are
    // genuinely confusable, then filler pads until the planted identifier can
    // sit at its target offset.
    // Build the filler pool first, then choose how many go BEFORE the planted
    // sentence so its offset lands as close to the target as possible. Padding
    // blindly until the target is passed overshoots badly on small targets —
    // a filler is ~200 chars, so a target of 260 landed past 400 and the
    // "visible" arm collapsed to 22 probes out of 350.
    const opening = `A ${d.words[0]} issue in the ${d.key} path, found while tracing a ${d.words[1]} that did not match the ${d.words[2]} the operator expected.`;
    const pool = [];
    for (let k = 0; k < 14; k++) pool.push(flavor(FILLER[Math.floor(r() * FILLER.length)], i, r));

    const planted = `The deciding detail is ${ident}, which is where the ${d.words[3]} is actually resolved and the only place the mismatch is visible.`;

    // Search against the SHIFTED target, since `cum` tracks head length while
    // the bucket is expressed as a final identifier offset.
    const shift = (concept.length + 1) + planted.indexOf(ident);
    const wanted = Math.max(targetOffset - shift, 0);
    let best = 0, bestDelta = Infinity, cum = opening.length + 1;
    for (let k = 0; k <= pool.length; k++) {
      const delta = Math.abs(cum - wanted);
      if (delta < bestDelta) { bestDelta = delta; best = k; }
      if (k < pool.length) cum += pool[k].length + 1;
    }

    const head = [opening, ...pool.slice(0, best)];
    // Measure the offset the way build-fixture.mjs will: it harvests from
    // the concept line joined to the content, then indexOf(identifier), so the real
    // offset is the concept line, plus the head, plus the identifier's position
    // inside the planted sentence. Reporting the head length alone understated
    // it by ~93 chars and the generator claimed 80% beyond-window where the
    // benchmark then measured 96% — same corpus, two different quantities.
    const offset = (concept.length + 1) + head.join(' ').length + 1 + planted.indexOf(ident);
    const trail = pool.slice(best, best + 2 + (i % 4));
    const parts = [...head, planted, ...trail];

    out.push({
      localId: `${d.key}-${i}`,
      concept,
      content: parts.join(' '),
      identifier: ident,
      offset,
      // Two scopes: agent isolation is a feature, and the runner queries each
      // gold as its own agent. Roughly the 75/25 split the real fixture has.
      agent: i % 4 === 3 ? 'personal' : 'work',
      domain: d.key,
      topic: `${d.key}-${d.words[(i >> 1) % d.words.length]}`,
    });
  }

  return out;
}

export { DOMAINS };
