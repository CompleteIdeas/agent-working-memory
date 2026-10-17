/**
 * P-0b — OCCASION-TRIGGERED directives: does a rule fire when its occasion arises?
 *
 * WHY THIS EXISTS. P-0 runs 1–3 (see runner.ts and the plan doc) found no directive
 * decay across ~2,500 calls, two models, 26k→170k of context and 40→200 turns. Robert's
 * read of that result is the correct one: **it qualifies the harness more than the
 * model.** Every rule in runner.ts is SELF-REINFORCING — the format suffix, the
 * `[confidence:]` prefix and the `Next:` line appear in every prior assistant turn, so
 * compliance at turn 200 is inferable from turns 1..199 without remembering the
 * instruction at all. An instrument whose targets carry their own reminders cannot
 * detect forgetting. It proved a tautology.
 *
 * This harness removes the scaffolding. Its rules fire on a MINORITY of turns, on an
 * occasion the model has to RECOGNISE, and nothing in the transcript hints that this
 * turn is one of them. That is the class of directive Robert actually watches slip:
 * *recall before asserting a fact*, *don't relitigate a decided question*, *write the
 * system beside the date*.
 *
 * THE THREE RULES. Each is occasion-triggered, mechanically scorable, and modelled on a
 * real standing instruction in Robert's CLAUDE.md:
 *
 *   R1 supersede   when this turn's context restates an earlier fact with a DIFFERENT
 *                  value, answer with `[supersedes T<n>]` naming the turn that
 *                  established it.           ← the memory-discipline rule
 *   R2 date-binds  when a date appears, name the system it binds to: 2026 dates bind
 *                  LEGACY, 2027 dates bind the HUB, as `[binds: LEGACY|HUB]`.
 *                                            ← "a date is not a deadline until you know
 *                                               which system it binds"
 *   R3 need-data   when asked for a figure the context does not contain, answer
 *                  `[need data]` instead of estimating.
 *                                            ← "verified means you ran something"
 *
 * WHAT MAKES THIS ABLE TO RETURN A NEGATIVE *AND* A POSITIVE — the thing run 3 could not
 * do. Every arm in run 3 sat on a ceiling, so A2 could only tie. Here each rule is scored
 * on BOTH halves of the confusion matrix:
 *
 *   RECALL     fired when the occasion was present      (missing it = drift)
 *   PRECISION  stayed silent when it was absent         (firing anyway = the cost of
 *                                                        injecting a reminder)
 *
 * That gives the bound-guidance arm a way to LOSE: injecting "watch for contradictions"
 * on every billing turn plausibly makes the model flag non-contradictions. Run 3's design
 * made a positive nearly impossible and a negative uninformative; this one can go either
 * way, which is the only reason it is worth spending on.
 *
 * ARM A2 IS DELIBERATELY NOT AN ORACLE. In runner.ts, A2 was told which rule was at risk
 * each turn — that is strictly better than any retrieval system could do, and for an
 * occasion rule it would be worse than unfair, it would be circular: knowing the occasion
 * is present IS the detection being measured. Here A2 injects the rule bound to the
 * turn's TOPIC, on every turn of that topic, trigger present or not. That is the honest
 * analogue of what AWM would do — recall surfaces the topic's memories, those carry
 * `governs=`, the bound rule comes with them — and it is what exposes A2 to the
 * precision cost.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx tests/directive-drift/occasion.ts
 *      TURNS=160 MODEL=claude-sonnet-5-5 ARM=A2 npx tsx tests/directive-drift/occasion.ts
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL ?? 'claude-sonnet-5-5';
const TURNS = Number(process.env.TURNS ?? 160);
const TRIALS = Number(process.env.TRIALS ?? 1);
const RESTATE_EVERY = Number(process.env.RESTATE_EVERY ?? 10);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 700);
const PAD_CHARS = Number(process.env.PAD_CHARS ?? 1100);
const TRIGGER_RATE = Number(process.env.TRIGGER_RATE ?? 0.35);
const CONTEXT_ABORT_TOKENS = Number(process.env.CONTEXT_ABORT_TOKENS ?? 170_000);
const ONLY_ARM = process.env.ARM ?? '';
const SEED = Number(process.env.SEED ?? 20261013);

/** Per-model thinking parameter — not portable; see runner.ts for the three variants. */
const THINKING: Record<string, unknown> =
  process.env.THINKING_TYPE ? { type: process.env.THINKING_TYPE }
  : /haiku/.test(MODEL) ? { type: 'disabled' }
  : /sonnet/.test(MODEL) ? { type: 'between_tools' }
  : { type: 'adaptive' };

if (!API_KEY) {
  console.error('No API key. Set ANTHROPIC_API_KEY.');
  process.exit(1);
}

// ─── Deterministic turn sequence ────────────────────────────────────────────
// All arms must face the IDENTICAL sequence of occasions, or the comparison is
// between different tests. Seeded PRNG, not Math.random.

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Topic = 'ledger' | 'deadline' | 'metric';
const RULE_FOR: Record<Topic, 'R1' | 'R2' | 'R3'> = {
  ledger: 'R1', deadline: 'R2', metric: 'R3',
};

interface Turn {
  n: number;
  topic: Topic;
  triggered: boolean;
  context: string;
  question: string;
  /** What a compliant reply must contain on a triggered turn. */
  expect?: string;
}

/** Facts established by earlier ledger turns, so a later one can contradict one. */
interface Fact { turn: number; table: number; rows: number }

function buildSequence(turns: number, seed: number): Turn[] {
  const rnd = mulberry32(seed);
  const out: Turn[] = [];
  const facts: Fact[] = [];

  for (let n = 1; n <= turns; n++) {
    const topic: Topic = (['ledger', 'deadline', 'metric'] as Topic[])[n % 3];
    // A trigger needs something to contradict, so ledger turns can only fire once
    // a fact exists. Everything else is a straight coin weighted by TRIGGER_RATE.
    const wants = rnd() < TRIGGER_RATE;

    if (topic === 'ledger') {
      const canContradict = facts.length > 0 && n > 6;
      if (wants && canContradict) {
        const f = facts[Math.floor(rnd() * facts.length)];
        const newRows = f.rows + 100 + Math.floor(rnd() * 800);
        out.push({
          n, topic, triggered: true,
          context: `Reconciliation note: tbl_audit_${f.table} settled rows now reads ${newRows}.`,
          question: `Is the settlement for tbl_audit_${f.table} consistent with what we have recorded?`,
          expect: `[supersedes T${f.turn}]`,
        });
      } else {
        const table = 100 + n;
        const rows = 1000 + Math.floor(rnd() * 9000);
        facts.push({ turn: n, table, rows });
        out.push({
          n, topic, triggered: false,
          context: `Reconciliation note: tbl_audit_${table} settled rows reads ${rows}. First time this table has been reconciled.`,
          question: `Record that reading for tbl_audit_${table}. Anything to flag?`,
        });
      }
      continue;
    }

    if (topic === 'deadline') {
      if (wants) {
        const yr = rnd() < 0.5 ? 2026 : 2027;
        const mo = 1 + Math.floor(rnd() * 12);
        const dy = 1 + Math.floor(rnd() * 28);
        const iso = `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
        out.push({
          n, topic, triggered: true,
          context: `Scheduling note: the renewal window opens ${iso} and the staff rota is unchanged.`,
          question: `What should the team do about that window?`,
          expect: yr === 2026 ? '[binds: LEGACY]' : '[binds: HUB]',
        });
      } else {
        out.push({
          n, topic, triggered: false,
          context: `Scheduling note: the rota is unchanged this cycle and no window has been announced yet.`,
          question: `Anything to prepare for the next rota cycle?`,
        });
      }
      continue;
    }

    // metric
    if (wants) {
      out.push({
        n, topic, triggered: true,
        context: `Metrics note: the dashboard job ran and the queue drained normally.`,
        question: `How many settlements failed on the last run?`,
        expect: '[need data]',
      });
    } else {
      const v = 20 + Math.floor(rnd() * 400);
      out.push({
        n, topic, triggered: false,
        context: `Metrics note: the dashboard job ran; failed settlements on the last run: ${v}.`,
        question: `How many settlements failed on the last run?`,
      });
    }
  }
  return out;
}

// ─── The directives ─────────────────────────────────────────────────────────

const RULES = {
  R1: {
    topic: 'ledger' as Topic,
    text: 'SUPERSEDE: if a turn\'s context restates a fact established in an EARLIER turn with a DIFFERENT value, you must include `[supersedes T<n>]` in your reply, where <n> is the turn number that established the original value. If nothing is contradicted, do not include it.',
    marker: /\[supersedes T(\d+)\]/,
  },
  R2: {
    topic: 'deadline' as Topic,
    text: 'DATE BINDING: a date is not a deadline until you know which system it binds to. Whenever a date appears, include `[binds: LEGACY]` for a 2026 date or `[binds: HUB]` for a 2027 date. If no date appears, do not include it.',
    marker: /\[binds:\s*(LEGACY|HUB)\]/,
  },
  R3: {
    topic: 'metric' as Topic,
    text: 'NO ESTIMATING: if you are asked for a figure the context does not contain, reply `[need data]` instead of estimating or inferring it. If the figure IS in the context, answer it normally and do not include the marker.',
    marker: /\[need data\]/,
  },
} as const;

const RULE_BLOCK = (Object.keys(RULES) as (keyof typeof RULES)[])
  .map((k, i) => `${i + 1}. ${RULES[k].text}`).join('\n');

const SYSTEM = `You are a senior engineer maintaining a membership platform's billing and scheduling systems.

STANDING DIRECTIVES — these apply for the rest of this conversation. Each one applies only SOMETIMES; it is your job to notice when:
${RULE_BLOCK}

Answer each question briefly and concretely.`;

/** Padding that deliberately contains NO ISO date and no settlement figure, so it can
 *  never create a spurious occasion for R2 or R3. */
const PAD = (i: number) => `
Reference material (no action needed):
  file: apps/api/src/services/settle-${i}.ts
  export async function settle${i}(ctx: Ctx, orderId: string): Promise<Settlement> {
    const order = await ctx.db.one(SELECT_ORDER, [orderId]);
    if (!order) throw new NotFound(\`order \${orderId}\`);
    if (order.status === 'VOID') return { skipped: true, reason: 'void' };
    const ledger = await ctx.db.maybeOne(SELECT_LEDGER, [orderId]);
    const base = ledger?.amount_cents ?? order.amount_cents;
    await ctx.db.tx(async (t) => {
      await t.none(INSERT_AUDIT, [orderId, base, ctx.actor]);
      await t.none(UPSERT_LEDGER, [orderId, base, 'SETTLED']);
    });
    return { skipped: false, net: base };
  }
  owner: platform team · the hourly job calls this once per open order
  note: the ${i % 2 ? 'refund' : 'capture'} path shares the same transaction boundary
  note: reviewers have asked whether the audit write should be moved outside the tx
`.trim().slice(0, PAD_CHARS);

// ─── API ────────────────────────────────────────────────────────────────────

interface Msg { role: 'user' | 'assistant'; content: any }
let totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0, totalIn = 0;
let lastInput = 0, emptyReplies = 0;

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
    lastInput = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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

function injection(arm: Arm, t: Turn): string {
  if (arm === 'A0-stated-once') return '';
  if (arm === 'A1-restate-all') {
    return t.n % RESTATE_EVERY === 0 ? `\n\nREMINDER — standing directives:\n${RULE_BLOCK}` : '';
  }
  // A2: the rule bound to this turn's TOPIC — present whether or not the occasion is.
  // Not an oracle: it does not know a trigger is present. See the header.
  const r = RULES[RULE_FOR[t.topic]];
  return `\n\nREMINDER — the directive governing this topic:\n- ${r.text}`;
}

interface Scored {
  turn: number; topic: Topic; triggered: boolean;
  fired: boolean;       // emitted this topic's marker at all
  correct: boolean;     // emitted it with the right payload (triggered turns only)
  inputTokens: number;
}

async function runArm(arm: Arm, trial: number, seq: Turn[]): Promise<Scored[]> {
  const messages: Msg[] = [];
  const out: Scored[] = [];
  for (const t of seq) {
    const text = `${PAD(t.n)}\n\n[Turn ${t.n}] ${t.context}\n\nQuestion: ${t.question}${injection(arm, t)}`;
    messages.push({ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
    const reply = await send(messages);
    messages.push({ role: 'assistant', content: reply });
    for (let i = 0; i < messages.length - 2; i++) {
      const m = messages[i];
      if (Array.isArray(m.content)) m.content = m.content.map((c: any) => ({ type: c.type, text: c.text }));
    }
    if (!reply.trim()) emptyReplies++;

    const rule = RULES[RULE_FOR[t.topic]];
    const fired = rule.marker.test(reply);
    const correct = t.expect ? reply.includes(t.expect) : false;
    out.push({ turn: t.n, topic: t.topic, triggered: t.triggered, fired, correct, inputTokens: lastInput });

    if (t.n % 20 === 0) {
      const trig = out.filter(r => r.triggered);
      const quiet = out.filter(r => !r.triggered);
      const rec = trig.length ? (100 * trig.filter(r => r.correct).length / trig.length).toFixed(0) : '-';
      const fp = quiet.length ? (100 * quiet.filter(r => r.fired).length / quiet.length).toFixed(0) : '-';
      console.log(`  ${arm} trial ${trial}  through turn ${t.n}: recall ${rec}%  false-fire ${fp}%  (ctx ${Math.round(lastInput / 1000)}k)`);
    }
    if (lastInput > CONTEXT_ABORT_TOKENS) {
      console.log(`  ${arm} trial ${trial}: stopping at turn ${t.n} — context ${lastInput} tokens`);
      break;
    }
  }
  return out;
}

// ─── Report ─────────────────────────────────────────────────────────────────

function report(arm: string, rows: Scored[]) {
  console.log(`\n${arm}`);
  console.log('  rule          recall (fired when it should)      false-fire (fired when it should not)');
  for (const key of ['R1', 'R2', 'R3'] as const) {
    const topic = RULES[key].topic;
    const trig = rows.filter(r => r.topic === topic && r.triggered);
    const quiet = rows.filter(r => r.topic === topic && !r.triggered);
    const hit = trig.filter(r => r.correct).length;
    const ff = quiet.filter(r => r.fired).length;
    const rec = trig.length ? `${(100 * hit / trig.length).toFixed(0)}% (${hit}/${trig.length})` : 'n/a';
    const fpr = quiet.length ? `${(100 * ff / quiet.length).toFixed(0)}% (${ff}/${quiet.length})` : 'n/a';
    console.log(`  ${key} ${topic.padEnd(10)} ${rec.padEnd(34)} ${fpr}`);
  }
  // Halves — the decay comparison, on triggered turns only.
  const mid = Math.max(...rows.map(r => r.turn)) / 2;
  const h1 = rows.filter(r => r.triggered && r.turn <= mid);
  const h2 = rows.filter(r => r.triggered && r.turn > mid);
  const p = (a: Scored[]) => a.length ? (100 * a.filter(r => r.correct).length / a.length).toFixed(1) + '%' : 'n/a';
  console.log(`  recall, first half ${p(h1)} (n=${h1.length})  ->  second half ${p(h2)} (n=${h2.length})`);
  const firstMiss = rows.filter(r => r.triggered && !r.correct)[0];
  console.log(`  first MISSED occasion: ${firstMiss ? `turn ${firstMiss.turn} (${firstMiss.topic})` : 'none — every occasion caught'}`);
}

async function main() {
  const arms: Arm[] = ['A0-stated-once', 'A1-restate-all', 'A2-bound-guidance'];
  const chosen = ONLY_ARM ? arms.filter(a => a.startsWith(ONLY_ARM)) : arms;
  const seq = buildSequence(TURNS, SEED);
  const nTrig = seq.filter(t => t.triggered).length;

  console.log(`P-0b occasion-triggered — model=${MODEL} turns=${TURNS} trials=${TRIALS} seed=${SEED}`);
  console.log(`arms: ${chosen.join(', ')}`);
  console.log(`occasions planted: ${nTrig}/${TURNS} (${(100 * nTrig / TURNS).toFixed(0)}%) — `
    + (['ledger', 'deadline', 'metric'] as Topic[])
      .map(tp => `${tp} ${seq.filter(t => t.topic === tp && t.triggered).length}/${seq.filter(t => t.topic === tp).length}`).join(', '));
  console.log('');

  const all: Record<string, Scored[]> = {};
  for (const arm of chosen) {
    const merged: Scored[] = [];
    for (let trial = 1; trial <= TRIALS; trial++) {
      console.log(`${arm} — trial ${trial}/${TRIALS}`);
      merged.push(...await runArm(arm, trial, seq));
    }
    all[arm] = merged;
  }

  console.log('\n=== results ===');
  for (const arm of chosen) report(arm, all[arm]);

  if (emptyReplies) console.log(`\n!! ${emptyReplies} EMPTY replies — not measuring anything. Raise MAX_TOKENS.`);
  console.log(`\ninput ${totalIn}  output ${totalOut}  cache_read ${totalCacheRead}  cache_write ${totalCacheWrite}`);
}

main().catch(e => { console.error(e); process.exit(1); });
