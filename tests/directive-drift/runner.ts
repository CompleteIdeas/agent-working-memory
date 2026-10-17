/**
 * P-0 — does directive compliance decay as context grows, and is SELECTION worth
 * anything over REPETITION?
 *
 * This is the measurement that governs whether procedural memory / bound guidance is
 * worth building (docs/plan-gaps-and-procedural-memory-2026-10-12.md, Part 2). The
 * premise — "directives stated once lose force as context grows" — was a claim in that
 * document, including in the parts arguing for the feature. This measures it.
 *
 * THREE ARMS. The middle one is the control the first draft of the plan was missing:
 *
 *   A0  stated-once      directives in the system prompt at turn 0, never repeated.
 *                        Tests the premise itself.
 *   A1  restate-all      ALL directives re-injected every RESTATE_EVERY turns.
 *                        Tests whether plain repetition is sufficient — a loop in the
 *                        prime hook, a fraction of the cost of the real feature.
 *   A2  bound-guidance   only the directive bound to THIS turn's topic is injected,
 *                        chosen by an oracle. This is the CEILING for bound guidance:
 *                        no retrieval system can select better than knowing the answer.
 *
 * Without A1, a positive result cannot distinguish "rules bound to memories help" from
 * "rules repeated help". If A1 matches A2, the right build is the loop, not the binding.
 * A2 is deliberately given a SMALLER injection budget than A1 — selection's whole claim
 * is that it buys compliance per token, so it must not win by spending more.
 *
 * WHAT IS MEASURED. Four per-turn obligations, each mechanically checkable, so scoring
 * is deterministic and free. They are shaped like real CLAUDE.md rules — a format
 * suffix, a confidence label, US spelling, and a length cap — rather than a synthetic
 * token, because the question is about instruction retention under load, not recall of
 * a needle.
 *
 * CONFOUND THAT WOULD INVALIDATE THIS. A host that re-injects its instruction file on
 * compaction resets the decay curve, which is why this runs as one continuous context
 * with no compaction and asserts it never truncates. Claude Code does re-inject on
 * compaction; that is a property of the harness, not of the model, and it is exactly
 * why A0 is a floor rather than a prediction about any particular product.
 *
 * COST. Context grows every turn, so input tokens grow quadratically: roughly
 * TURNS^2/2 * per-turn tokens per run, times ARMS times TRIALS. Prompt caching is used
 * on the growing prefix. The run prints its measured token spend at the end — read it
 * before scaling TURNS up.
 *
 * Run:  ANTHROPIC_API_KEY=... npx tsx tests/directive-drift/runner.ts
 *       TURNS=40 TRIALS=2 MODEL=claude-haiku-5-5 npx tsx tests/directive-drift/runner.ts
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5';
const TURNS = Number(process.env.TURNS ?? 40);
const TRIALS = Number(process.env.TRIALS ?? 2);
const RESTATE_EVERY = Number(process.env.RESTATE_EVERY ?? 10);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 1000);
const ONLY_ARM = process.env.ARM ?? '';

/** The thinking parameter this model will actually accept (see the note in send()). */
const THINKING: Record<string, unknown> =
  process.env.THINKING_TYPE ? { type: process.env.THINKING_TYPE }
  : /haiku/.test(MODEL) ? { type: 'disabled' }
  : /sonnet/.test(MODEL) ? { type: 'between_tools' }
  : { type: 'adaptive' };

if (!API_KEY) {
  console.error('No API key. Set ANTHROPIC_API_KEY.');
  process.exit(1);
}

// ─── The directives under test ──────────────────────────────────────────────
// Each has an id, the text as stated to the model, a topic it is "bound" to for
// arm A2, and a checker returning true when the reply COMPLIES.

interface Directive {
  id: string;
  topic: string;
  text: string;
  /** null = not applicable to this reply (not counted), true/false = complied or not. */
  check: (reply: string) => boolean | null;
}

const BRITISH = /\b(organise[ds]?|organisation|colour|behaviour|centre|realise[ds]?|analyse[ds]?|labelled|cancelled|modelling|defence|whilst|programme|optimise[ds]?|prioritise[ds]?|summarise[ds]?|licence)\b/i;

const DIRECTIVES: Directive[] = [
  {
    id: 'suffix',
    topic: 'formatting',
    text: 'End every single reply with the marker <<AWM-ACK>> on its own final line, with nothing after it.',
    check: (r) => /<<AWM-ACK>>\s*$/.test(r.trim()),
  },
  {
    id: 'confidence',
    topic: 'evidence',
    text: 'Begin every single reply with a bracketed confidence label — exactly [confidence: verified] if you ran or read something, or [confidence: assumed] if you are reasoning.',
    check: (r) => /^\[confidence:\s*(verified|assumed)\]/i.test(r.trim()),
  },
  {
    id: 'us-spelling',
    topic: 'writing',
    text: 'Write US English, never British: -ize not -ise, -or not -our, -er not -re, single-l past tense (labeled, canceled, modeled), defense, toward, while, program.',
    // Only counted when the reply gave the rule a chance to be broken — a reply with
    // no candidate word is not evidence either way, and counting it as compliance
    // would inflate every arm equally and hide the effect.
    check: (r) => (/\b(organiz|organis|color|colour|behavior|behaviour|center|centre|realiz|realis|analyz|analys|label|cancel|model|defens|defenc|toward|towards|while|whilst|program|programme|optimiz|optimis|prioritiz|prioritis|summariz|summaris|licens|licenc)/i.test(r)
      ? !BRITISH.test(r)
      : null),
  },
  {
    id: 'brevity',
    topic: 'brevity',
    text: 'Keep every reply under 120 words. Answer, then stop.',
    // An empty reply is not brevity. The first version of this check passed on one,
    // which is how an all-empty run scored 100% on this rule.
    check: (r) => {
      const n = r.trim().split(/\s+/).filter(Boolean).length;
      // 120, not 80: at 80 this rule scored 33% from turn 1 because the mandated
      // 'Next:' line pushed nearly every reply over, i.e. the directive set I wrote was
      // self-contradictory. A rule that cannot be satisfied measures nothing.
      return n > 0 && n < 120;
    },
  },
];

DIRECTIVES.push({
  id: 'next-step',
  topic: 'structure',
  text: "Include a line starting with 'Next:' giving one concrete next step, placed immediately before the final marker line.",
  // Chosen after a rejected candidate: "exactly two paragraphs" scored 0% from turn 1,
  // because it is in direct conflict with the under-80-words cap — the model obeyed
  // brevity and wrote one paragraph. A rule that is never satisfied cannot decay, so it
  // measures nothing. This one starts high and interacts with the suffix rule on
  // ORDERING, which is a real multi-directive interaction rather than an impossibility.
  check: (r) => {
    const t = r.trim();
    if (!t) return false;
    return /^\s*Next:/mi.test(t);
  },
});

const DIRECTIVE_BLOCK = DIRECTIVES.map((d, i) => `${i + 1}. ${d.text}`).join('\n');

const SYSTEM = `You are a senior engineer helping maintain a membership platform.

STANDING DIRECTIVES — these apply to EVERY reply for the rest of this conversation:
${DIRECTIVE_BLOCK}

Answer the questions you are asked, briefly and concretely.`;

// ─── The filler workload ────────────────────────────────────────────────────
// Each turn is a small self-contained engineering question with a chunk of context
// attached, so the conversation grows at a realistic rate. `at` names the directive
// most at risk on that turn, which is what arm A2's oracle gets to see.

const TOPICS = ['formatting', 'evidence', 'writing', 'brevity', 'structure'] as const;

const TASKS: { q: string; at: typeof TOPICS[number] }[] = [
  { q: 'The members table has 96,925 rows and 96,683 have no login. What does that imply for a payment flow that requires an account?', at: 'brevity' },
  { q: 'Describe how you would organize a migration that adds a nullable column to a 4 million row table.', at: 'writing' },
  { q: 'A report says renewals opened 1 Oct. Which system does that date bind to, and how would you check?', at: 'evidence' },
  { q: 'Summarize the tradeoff between a composite index and two single-column indexes here.', at: 'writing' },
  { q: 'Our webhook points at the production domain from a test account. What breaks first?', at: 'brevity' },
  { q: 'How would you verify that a backfill script is idempotent before running it on real data?', at: 'evidence' },
  { q: 'What is the smallest change that makes an archived record reachable by search again?', at: 'formatting' },
  { q: 'A nightly job silently skipped 400 rows. Where do you look, in order?', at: 'evidence' },
  { q: 'Give the color scheme implications of a dark-mode switch on a report that prints.', at: 'writing' },
  { q: 'When is it correct to cancel a queued job rather than let it fail and retry?', at: 'writing' },
  { q: 'A staff user sees stale totals after a refund. Name the likely cache layers.', at: 'structure' },
  { q: 'How do you tell an index is unused rather than merely rarely used?', at: 'structure' },
  { q: 'The deadlock is on an upsert into the ledger. What ordering change removes it?', at: 'evidence' },
  { q: 'Should the audit write share the settle transaction? Argue one way.', at: 'brevity' },
  { q: 'A fee is computed as a percentage of a nullable base. Where does that go wrong?', at: 'evidence' },
  { q: 'What is the cheapest way to prove the inline ledger creation is safe under concurrency?', at: 'evidence' },
  { q: 'Name the failure you would see if two settles raced on the same order.', at: 'brevity' },
  { q: 'How would you organize a rollback plan for a settlement bug found in production?', at: 'writing' },
  { q: 'The log shows ledger_missing and created_inline with equal counts. What does that tell you?', at: 'structure' },
  { q: 'When is a VOID short-circuit the wrong behavior?', at: 'brevity' },
  { q: 'Summarize what you would instrument to catch a silent fee miscalculation.', at: 'writing' },
  { q: 'Would you model the fee as a stored column or compute it on read? One reason each.', at: 'writing' },
  { q: 'A reviewer says the tx is too wide. What is the narrowest correct boundary?', at: 'structure' },
  { q: 'How do you distinguish a deadlock from a lock timeout in the logs above?', at: 'evidence' },
  { q: 'What single test would have caught the null ledger row before release?', at: 'brevity' },
  { q: 'The settle function returns skipped:true. How should the caller treat that?', at: 'structure' },
  { q: 'Give one argument for canceling in-flight settles during a deploy.', at: 'writing' },
];

/**
 * One turn's attached context. Sized to ~500 tokens, not the ~90 of run 1.
 *
 * Run 1 grew at a measured 405 tokens/turn, so 40 turns reached only ~26k and 150 would
 * have reached ~61k — well short of the long-session regime the drift premise is about,
 * and the reason run 1 could not speak to it. A real agent turn carries a file excerpt
 * or a tool result, so this is both more realistic and a cheaper way to reach 100k than
 * tripling the turn count.
 */
const PAD_CHARS = Number(process.env.PAD_CHARS ?? 2000);

const CONTEXT_PAD_FULL = (i: number) => `
Tool result (for reference, no action needed):

  $ git log --oneline -3 -- apps/api/src/services/billing-${i}.ts
  ${(1000000 + i * 7919).toString(16)} fix(billing-${i}): guard the ${i % 2 ? 'refund' : 'capture'} path against a null ledger row
  ${(2000000 + i * 6271).toString(16)} refactor(billing-${i}): extract ${i % 3 ? 'receipt' : 'audit'} write into its own unit
  ${(3000000 + i * 5431).toString(16)} test(billing-${i}): cover the partial-${i % 2 ? 'refund' : 'capture'} case

  $ sed -n '${40 + i},${58 + i}p' apps/api/src/services/billing-${i}.ts
  export async function settle${i}(ctx: Ctx, orderId: string): Promise<Settlement> {
    const order = await ctx.db.one(SELECT_ORDER, [orderId]);
    if (!order) throw new NotFound(\`order \${orderId}\`);
    if (order.status === 'VOID') return { skipped: true, reason: 'void' };
    const ledger = await ctx.db.maybeOne(SELECT_LEDGER, [orderId]);
    // ${i % 2 ? 'refund' : 'capture'} path: the ledger row may not exist yet on first settle
    const base = ledger?.amount_cents ?? order.amount_cents;
    const fee = Math.round(base * ${(i % 7) + 2} / 100);
    await ctx.db.tx(async (t) => {
      await t.none(INSERT_AUDIT_${i}, [orderId, base, fee, ctx.actor]);
      await t.none(UPSERT_LEDGER, [orderId, base - fee, 'SETTLED']);
    });
    return { skipped: false, net: base - fee, fee };
  }

  $ tail -4 logs/billing-${i}.log
  ${new Date(Date.UTC(2026, 8, 1 + (i % 28), 3, i % 60)).toISOString()} settle${i} ok orders=${1200 + i * 37} fees=${(1200 + i * 37) * ((i % 7) + 2)}
  ${new Date(Date.UTC(2026, 8, 1 + (i % 28), 4, i % 60)).toISOString()} settle${i} warn ledger_missing=${i % 11} created_inline=${i % 11}
  ${new Date(Date.UTC(2026, 8, 1 + (i % 28), 5, i % 60)).toISOString()} settle${i} ok orders=${1300 + i * 29} fees=${(1300 + i * 29) * ((i % 7) + 2)}
  ${new Date(Date.UTC(2026, 8, 1 + (i % 28), 6, i % 60)).toISOString()} settle${i} error tx_rollback=${i % 3} reason=deadlock_on_upsert_ledger

  open question: whether the ${i % 3 ? 'ledger' : 'receipt'} write should share settle${i}'s transaction
  owner: platform team · rows touched last week: ${1200 + i * 37} · hourly job writes tbl_audit_${i}
`.trim();

/**
 * Turn count and token distance are DIFFERENT variables, and run 2 confounded them:
 * 130 turns at ~975 tokens each reached 133k, so "no decay at 130 turns" and "no decay
 * at 133k" were the same observation. PAD_CHARS lets one be held while the other moves —
 * run 3 raises turns to 200 while trimming the pad to hold peak context near run 2's
 * ceiling, which asks whether the number of intervening exchanges matters on its own.
 * Measured: ~2.86 chars of pad per token, plus ~275 tokens/turn of question and reply.
 */
const CONTEXT_PAD = (i: number) => CONTEXT_PAD_FULL(i).slice(0, PAD_CHARS);

// ─── API ────────────────────────────────────────────────────────────────────

interface Msg { role: 'user' | 'assistant'; content: any }

let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
let emptyReplies = 0;

async function send(messages: Msg[]): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Thinking kept out of the reply, deliberately — but the parameter is NOT
        // portable across models and a wrong value fails the whole run:
        //   haiku-5-5   accepts {type:'disabled'}
        //   sonnet-5-5  rejects it: "send thinking: {type:'between_tools'} instead"
        //   opus-5-5    rejects it: "use thinking.type.adaptive"
        // With thinking ON and a small budget, the entire allowance went to a thinking
        // block and the visible reply came back EMPTY — scoring 0% on the suffix rule
        // and 100% on brevity, because an empty reply is short. Run 1 of this harness
        // measured nothing and reported it confidently. What is under test is
        // instruction retention in the output the user actually receives.
        thinking: THINKING,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages,
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = 2000 * (attempt + 1);
      console.error(`  … ${res.status}, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = await res.json() as any;
    const u = body.usage ?? {};
    lastInputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    totalIn += u.input_tokens ?? 0;
    totalOut += u.output_tokens ?? 0;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
    totalCacheWrite += u.cache_creation_input_tokens ?? 0;
    return (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  }
  throw new Error('exhausted retries');
}

// ─── Arms ───────────────────────────────────────────────────────────────────

type Arm = 'A0-stated-once' | 'A1-restate-all' | 'A2-bound-guidance';

/** What, if anything, this arm injects before turn `t` (1-indexed). */
function injection(arm: Arm, t: number, at: typeof TOPICS[number]): string {
  if (arm === 'A0-stated-once') return '';
  if (arm === 'A1-restate-all') {
    return t % RESTATE_EVERY === 0
      ? `\n\nREMINDER — standing directives:\n${DIRECTIVE_BLOCK}`
      : '';
  }
  // A2: just the bound rule, every turn. Cheaper per turn than A1's full block.
  const d = DIRECTIVES.find(x => x.topic === at);
  return d ? `\n\nREMINDER — the directive governing this topic:\n- ${d.text}` : '';
}

interface TurnResult { turn: number; results: Record<string, boolean | null>; words: number; injectedChars: number; inputTokens: number }

/** Largest input seen on a single call — the run stops before the model's limit. */
const CONTEXT_ABORT_TOKENS = Number(process.env.CONTEXT_ABORT_TOKENS ?? 150_000);
let lastInputTokens = 0;

async function runArm(arm: Arm, trial: number): Promise<TurnResult[]> {
  const messages: Msg[] = [];
  const out: TurnResult[] = [];
  for (let t = 1; t <= TURNS; t++) {
    const task = TASKS[(t - 1) % TASKS.length];
    const inj = injection(arm, t, task.at);
    const userText = `${CONTEXT_PAD(t)}\n\nQuestion: ${task.q}${inj}`;
    // Cache the growing prefix: mark the newest user block, so the next turn reads it.
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userText, cache_control: { type: 'ephemeral' } }],
    });
    const reply = await send(messages);
    messages.push({ role: 'assistant', content: reply });
    // Drop the cache marker from the previous user block — only the newest carries one.
    for (let i = 0; i < messages.length - 2; i++) {
      const m = messages[i];
      if (Array.isArray(m.content)) m.content = m.content.map((c: any) => ({ type: c.type, text: c.text }));
    }
    if (!reply.trim()) emptyReplies++;
    const results: Record<string, boolean | null> = {};
    for (const d of DIRECTIVES) results[d.id] = d.check(reply);
    out.push({
      turn: t,
      results,
      words: reply.trim().split(/\s+/).filter(Boolean).length,
      injectedChars: inj.length,
      inputTokens: lastInputTokens,
    });
    if (lastInputTokens > CONTEXT_ABORT_TOKENS) {
      console.log(`  ${arm} trial ${trial}: stopping at turn ${t} — context reached ${lastInputTokens} tokens`);
      break;
    }
    if (t % 10 === 0) {
      const ok = out.slice(-10).reduce((s, r) =>
        s + DIRECTIVES.filter(d => r.results[d.id] === true).length, 0);
      const n = out.slice(-10).reduce((s, r) =>
        s + DIRECTIVES.filter(d => r.results[d.id] !== null).length, 0);
      console.log(`  ${arm} trial ${trial}  turns ${t - 9}-${t}: ${ok}/${n} obligations met`);
    }
  }
  return out;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function bucketStats(rows: TurnResult[], size = 10) {
  const buckets: { label: string; met: number; total: number; perRule: Record<string, [number, number]> }[] = [];
  for (let start = 0; start < TURNS; start += size) {
    const slice = rows.filter(r => r.turn > start && r.turn <= start + size);
    const perRule: Record<string, [number, number]> = {};
    let met = 0, total = 0;
    for (const d of DIRECTIVES) {
      const applicable = slice.filter(r => r.results[d.id] !== null);
      const ok = applicable.filter(r => r.results[d.id] === true).length;
      perRule[d.id] = [ok, applicable.length];
      met += ok; total += applicable.length;
    }
    buckets.push({ label: `${start + 1}-${Math.min(start + size, TURNS)}`, met, total, perRule });
  }
  return buckets;
}

async function main() {
  const arms: Arm[] = ['A0-stated-once', 'A1-restate-all', 'A2-bound-guidance'];
  const chosen = ONLY_ARM ? arms.filter(a => a.startsWith(ONLY_ARM)) : arms;
  console.log(`P-0 directive drift — model=${MODEL} turns=${TURNS} trials=${TRIALS} restate_every=${RESTATE_EVERY}`);
  console.log(`arms: ${chosen.join(', ')}`);
  console.log(`obligations per turn: ${DIRECTIVES.map(d => d.id).join(', ')}\n`);

  const all: Record<string, TurnResult[]> = {};
  for (const arm of chosen) {
    const merged: TurnResult[] = [];
    for (let trial = 1; trial <= TRIALS; trial++) {
      console.log(`${arm} — trial ${trial}/${TRIALS}`);
      merged.push(...await runArm(arm, trial));
    }
    all[arm] = merged;
  }

  console.log('\n=== compliance by turn bucket (all trials pooled) ===');
  const header = `arm`.padEnd(20) + bucketStats(all[chosen[0]])!.map(b => b.label.padStart(10)).join('');
  console.log(header);
  for (const arm of chosen) {
    const b = bucketStats(all[arm]);
    const cells = b.map(x => `${x.total ? (100 * x.met / x.total).toFixed(0) : '-'}%`.padStart(10)).join('');
    console.log(arm.padEnd(20) + cells);
  }

  console.log('\n=== per-directive, first bucket vs last ===');
  for (const arm of chosen) {
    const b = bucketStats(all[arm]);
    const first = b[0], last = b[b.length - 1];
    console.log(`\n${arm}`);
    for (const d of DIRECTIVES) {
      const [f, fn] = first.perRule[d.id], [l, ln] = last.perRule[d.id];
      const fp = fn ? (100 * f / fn).toFixed(0) + '%' : 'n/a';
      const lp = ln ? (100 * l / ln).toFixed(0) + '%' : 'n/a';
      console.log(`  ${d.id.padEnd(14)} ${fp.padStart(5)} (n=${String(fn).padStart(3)})  ->  ${lp.padStart(5)} (n=${String(ln).padStart(3)})`);
    }
  }

  console.log('\n=== first failure per directive (the statistic a long run needs) ===');
  // A bucket average smears the moment a rule breaks. "suffix first failed at turn 118,
  // then 9 more times" is the claim a decay argument actually rests on.
  for (const arm of chosen) {
    console.log(`\n${arm}`);
    for (const d of DIRECTIVES) {
      const perTrial: string[] = [];
      for (let trial = 0; trial < TRIALS; trial++) {
        const rows = all[arm].filter((_, idx) => Math.floor(idx / TURNS) === trial);
        const applicable = rows.filter(r => r.results[d.id] !== null);
        const firstFail = applicable.find(r => r.results[d.id] === false);
        const fails = applicable.filter(r => r.results[d.id] === false).length;
        perTrial.push(firstFail
          ? `turn ${String(firstFail.turn).padStart(3)} (${fails} total)`
          : `never (${applicable.length} chances)`);
      }
      console.log(`  ${d.id.padEnd(14)} ${perTrial.join('   |   ')}`);
    }
  }

  console.log('\n=== context size reached ===');
  for (const arm of chosen) {
    const peak = Math.max(...all[arm].map(r => r.inputTokens));
    const lastTurn = Math.max(...all[arm].map(r => r.turn));
    console.log(`${arm.padEnd(20)} peak input ${String(peak).padStart(7)} tokens, last turn ${lastTurn}`);
  }

  console.log('\n=== injection cost (what each arm spent to get that) ===');
  for (const arm of chosen) {
    const chars = all[arm].reduce((s, r) => s + r.injectedChars, 0) / TRIALS;
    console.log(`${arm.padEnd(20)} ${Math.round(chars).toString().padStart(7)} chars injected per run (~${Math.round(chars / 4)} tokens)`);
  }

  if (emptyReplies > 0) {
    console.log(`\n!! ${emptyReplies} EMPTY replies — this run is NOT measuring instruction following.`);
    console.log('   Raise MAX_TOKENS or confirm thinking is disabled before reading anything above.');
  }

  console.log('\n=== token spend ===');
  console.log(`input ${totalIn}  output ${totalOut}  cache_read ${totalCacheRead}  cache_write ${totalCacheWrite}`);
  console.log(`(cache_read is billed at a fraction of input; read this before raising TURNS)`);
}

main().catch(e => { console.error(e); process.exit(1); });
