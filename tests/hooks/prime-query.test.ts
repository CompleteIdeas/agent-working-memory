/**
 * Prime-hook query shaping (2026-10-16): recall against the prompt's question, not
 * its paste. Pure function, no model or store needed.
 *
 * Run: npx vitest run tests/hooks/prime-query.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { shapePrimeQuery, isMachineLine } from '../../src/hooks/prime-query.js';

const Q = 'Pipeline requires_horse missing from division mock d.requires_horse';
const LOG = Array.from({ length: 40 }, (_, i) =>
  `2026-10-16T13:${String(i).padStart(2, '0')}:07Z INFO worker[${i % 4}] heartbeat ok queue=${i * 7}`).join('\n');
const CODE = Array.from({ length: 20 }, (_, i) =>
  `function handler${i}(req, res) { const id = req.params.id; return service.load(id); }`).join('\n');
const NOTES = Array.from({ length: 20 }, (_, i) =>
  `Section ${i + 1}. The notes cover scheduling, retries and how the pool applies backpressure.`).join(' ');

describe('shapePrimeQuery — prompts that need no shaping', () => {
  it('returns a prompt at or under the budget unchanged, byte for byte', () => {
    const p = 'commit and push the sweep evidence\r\n  with <b>tags</b> ```kept```';
    expect(shapePrimeQuery(p, 400)).toBe(p);
    const exact = 'x'.repeat(400);
    expect(shapePrimeQuery(exact, 400)).toBe(exact);
  });

  it('0 disables shaping', () => {
    const p = `${Q}\n\n${LOG}`;
    expect(shapePrimeQuery(p, 0)).toBe(p);
  });
});

describe('shapePrimeQuery — machine pastes are dropped', () => {
  it.each([
    ['log, question first', `${Q}\n\n${LOG}`],
    ['log, question last', `${LOG}\n\n${Q}`],
    ['code, question first', `${Q}\n\n${CODE}`],
    ['code, question last', `${CODE}\n\n${Q}`],
    ['fenced block', `${Q}\n\`\`\`\n${'plain words that would read as prose\n'.repeat(20)}\`\`\``],
    ['json', `${JSON.stringify({ rows: Array.from({ length: 12 }, (_, i) => ({ id: i, tags: ['a', 'b'] })) }, null, 2)}\n${Q}`],
    ['diff', `diff --git a/x.ts b/x.ts\nindex 3f2a1b0..9c8d7e6 100644\n--- a/x.ts\n+++ b/x.ts\n${Array.from({ length: 12 }, (_, i) => `@@ -${i},7 +${i},8 @@\n-  const v${i} = compute(${i});\n+  const v${i} = computeSafe(${i}) ?? 0;`).join('\n')}\n${Q}`],
  ])('%s → exactly the question', (_name, prompt) => {
    expect(prompt.length).toBeGreaterThan(400);
    expect(shapePrimeQuery(prompt, 400)).toBe(Q);
  });

  it('keeps an error line out of a log, because the error is what a fix-this prompt is about', () => {
    const prompt = `why does the worker die?\n${LOG}\n2026-10-16T14:00:00Z ERROR pool exhausted: connect ECONNREFUSED 127.0.0.1:5432\n${LOG}`;
    const q = shapePrimeQuery(prompt, 400);
    expect(q).toMatch(/^why does the worker die\?/);
    expect(q).toContain('ECONNREFUSED');
    expect(q).not.toContain('heartbeat');
  });

  it('keeps at most two error lines', () => {
    const errs = Array.from({ length: 6 }, (_, i) => `2026-10-16T14:0${i}:00Z ERROR failure number ${i}`).join('\n');
    const q = shapePrimeQuery(`what broke overnight?\n${errs}\n${LOG}`, 400);
    expect(q.match(/ERROR/g)).toHaveLength(2);
  });
});

describe('shapePrimeQuery — pointers, buried questions, error codes', () => {
  it('when the prose is only a pointer ("explain this:"), the paste becomes the query', () => {
    const q = shapePrimeQuery(`explain this:\n${CODE}`, 400);
    expect(q).toMatch(/^explain this:\nfunction handler0/);
    expect(q).toContain(' … ');
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it('puts a question from the middle of long prose back between head and tail', () => {
    const buried = 'Which hosting platform does the PostRoom app deploy to?';
    const prompt = `${NOTES}\n${buried}\n${NOTES}`;
    const q = shapePrimeQuery(prompt, 400);
    expect(q).toContain(buried);
    expect(q.length).toBeLessThanOrEqual(400);
    expect(shapePrimeQuery(`${NOTES}\n${NOTES}`, 400)).not.toContain('?');   // nothing to rescue
  });

  it('keeps coded errors (errno, compiler, vendor) and does not mistake "every" for one', () => {
    const lines = ['2026-10-16T14:00:00Z write EPIPE on socket 7', '2026-10-16T14:00:01Z tsc TS2304 at build step'];
    const q = shapePrimeQuery(`what went wrong in the build?\n${lines.join('\n')}\n${LOG}`, 400);
    expect(q).toContain('EPIPE');
    expect(q).toContain('TS2304');
    const quiet = shapePrimeQuery(`what happened overnight?\n2026-10-16T14:00:00Z INFO every worker checked in\n${LOG}`, 400);
    expect(quiet).toBe('what happened overnight?');
  });
});

describe('shapePrimeQuery — the likeliest question leads (the cross-encoder reads the start)', () => {
  it('moves a short last line in front of the long prose it follows', () => {
    const q = shapePrimeQuery(`${NOTES}\n\n${Q}`, 400);
    expect(q.startsWith(Q)).toBe(true);
  });

  it('keeps a short first line first', () => {
    expect(shapePrimeQuery(`${Q}\n\n${NOTES}`, 400).startsWith(Q)).toBe(true);
  });

  it('leads with a question line wherever it sits, including one followed by another sentence', () => {
    const asked = 'Why is the import slow? I tried restarting it.';
    const q = shapePrimeQuery(`${NOTES}\n${asked}\n${NOTES}`, 400);
    expect(q.startsWith(asked)).toBe(true);
  });

  it('leads a task notification with its summary', () => {
    const prompt = ['<task-notification>', '<task-id>a1</task-id>', '<summary>Agent "Review the migration" finished</summary>',
      `<result>${'The migration renames a column that two reports still read. '.repeat(8)}`, 'No migration.</result>', '</task-notification>'].join('\n');
    expect(shapePrimeQuery(prompt, 400).startsWith('Agent "Review the migration" finished')).toBe(true);
  });

  it('leads with the typed block when a paste leaks lines that read as prose', () => {
    // These lines read as prose to every line rule; the blank-line block structure and
    // the block's prose share are what put the question first.
    const leaky = Array.from({ length: 12 }, (_, i) => `Card ${i} body text ${i} open the card to read more`).join('\n');
    expect(shapePrimeQuery(`${leaky}\n\n${Q}`, 400).startsWith(Q)).toBe(true);
    expect(shapePrimeQuery(`${Q}\n\n${leaky}`, 400).startsWith(Q)).toBe(true);
  });

  it('a long email thread (prose in both blocks) still leads with the shorter typed block', () => {
    const thread = Array.from({ length: 6 }, (_, i) => `On Tue, Oct ${7 + i}, 2026 at 9:10 AM, Jordan wrote:\n> Thanks for the update, the team is comfortable with the plan as long as the timeline holds.`).join('\n\n');
    expect(shapePrimeQuery(`${thread}\n\n${Q}`, 400).startsWith(Q)).toBe(true);
    expect(shapePrimeQuery(`${Q}\n\n${thread}`, 400).startsWith(Q)).toBe(true);
  });

  it('leads with the pointer when the prose only points at the paste', () => {
    const q = shapePrimeQuery(`${CODE}\nexplain this`, 400);
    expect(q.startsWith('explain this\nfunction handler0')).toBe(true);
  });
});

describe('shapePrimeQuery — review findings (2026-10-16)', () => {
  it('stays fast on pathological pastes (was 10-40 s on a 100 KB dotted run)', () => {
    for (const paste of ['a.'.repeat(50_000), 'a-'.repeat(50_000), `const${' '.repeat(20_000)}x`,
      '<note>'.repeat(20_000), `<task-notification>\n${'<note>'.repeat(20_000)}`, 'x=y '.repeat(25_000)]) {
      const t0 = performance.now();
      shapePrimeQuery(`why is this slow?\n${paste}`, 400);
      isMachineLine(paste);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('a one-line fence is inline code in a sentence, not the start of a block', () => {
    const asked = '```npm run build``` fails on CI with the new lockfile, why?';
    const q = shapePrimeQuery(`${asked}\n${LOG}`, 400);
    expect(q).toBe(asked);
  });

  it('long prose cannot crowd out an error line', () => {
    const prose = 'The nightly import has been flaky since the move to the new host. '.repeat(9);
    const q = shapePrimeQuery(`${prose}\n2026-10-16T14:00:00Z ERROR pool exhausted: connect ECONNREFUSED 127.0.0.1:5432\n${LOG}`, 400);
    expect(q).toContain('ECONNREFUSED');
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it.each([
    ['YAML', `services:\n${Array.from({ length: 12 }, (_, i) => `  svc${i}:\n    image: registry.example.com/svc${i}:1.${i}.0\n    restart: unless-stopped`).join('\n')}`],
    ['CSV', `name,region,orders,revenue\n${Array.from({ length: 30 }, (_, i) => `store-${i},north,${120 + i},${1000 + i}.50`).join('\n')}`],
    ['psql table', ` id  | email               | plan\n-----+---------------------+------\n${Array.from({ length: 22 }, (_, i) => ` ${200 + i} | user${i}@example.com | pro`).join('\n')}\n(22 rows)`],
    ['Python', `Traceback (most recent call last):\n${Array.from({ length: 10 }, (_, i) => `  File "/srv/app/w${i}.py", line ${100 + i}, in run\n    result = self.client.fetch(batch_id=${i}, retries=3)`).join('\n')}`],
    ['PowerShell', Array.from({ length: 8 }, () => 'At line:1 char:1\n+ Get-Item C:\\nope\n+ ~~~~~~~~~~~~~~~~\n    + CategoryInfo          : ObjectNotFound: (C:\\nope:String) [Get-Item], ItemNotFoundException\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand').join('\n')],
    ['HTML', `<div class="grid">\n${Array.from({ length: 16 }, (_, i) => `  <div class="card" data-id="${i}"><h3 class="t">Card ${i}</h3><a href="/c/${i}" class="btn">Open</a></div>`).join('\n')}\n</div>`],
    ['kubectl columns', `NAME                  READY   STATUS    RESTARTS   AGE\n${Array.from({ length: 12 }, (_, i) => `api-${i}-7d9f8c6b5-x${i}   1/1     Running   ${i}          ${i + 2}d`).join('\n')}`],
    ['Rust compiler', Array.from({ length: 6 }, (_, i) => `error[E0308]: mismatched types\n  --> src/stage_${i}.rs:${40 + i}:9\n   |\n${40 + i} |     let total: u32 = items.len();\n   |                ^^^^^^^^^^^ expected \`u32\`, found \`usize\``).join('\n')],
    ['Go panic', `panic: runtime error: nil pointer dereference\ngoroutine 1 [running]:\n${Array.from({ length: 12 }, (_, i) => `main.(*Server).handle${i}(0xc000${i}a2000, {0x7f3c40, 0xc0001b6000})\n\t/home/build/src/handler_${i}.go:${80 + i} +0x1${i}4`).join('\n')}`],
    ['multi-line SQL',Array.from({ length: 10 }, (_, i) => `SELECT m.id, m.email\nFROM members m\nJOIN plans p ON p.id = m.plan_id\nWHERE m.id = ${i}`).join('\n')],
  ])('%s paste → the question (plus any error line)', (_name, paste) => {
    const q = shapePrimeQuery(`${Q}\n${paste}`, 400);
    expect(q.split('\n')[0]).toBe(Q);
    expect(q.length).toBeLessThan(Q.length + 2 + 0.3 * 400);
  });

  it('never exceeds tiny budgets', () => {
    for (const budget of [1, 2, 3, 5, 11, 12, 20]) {
      expect(shapePrimeQuery(`${Q}\n${NOTES}`, budget).length).toBeLessThanOrEqual(budget);
      expect(shapePrimeQuery(LOG, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it('returns empty for a prompt that is only envelope', () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `<task-id>t${i}</task-id>`).join('\n');
    expect(shapePrimeQuery(prompt, 400)).toBe('');
  });

  it('strips boilerplate elements only from task notifications', () => {
    const typed = `Explain the difference between <note> and <aside> in the doc template, they render the same </note> but not sure why. ${NOTES}`;
    // The span between <note> and </note> used to be deleted; only the tags go now.
    const q = shapePrimeQuery(typed, 400);
    expect(q).toContain('in the doc template, they render the same');
  });

  it('keeps generics a person typed', () => {
    const typed = `Why does Map<String, List<Integer>> fail to deserialise here? ${NOTES}`;
    expect(shapePrimeQuery(typed, 400)).toContain('Map<String, List<Integer>>');
  });

  it('never splits a surrogate pair', () => {
    const emoji = '🎉'.repeat(300);
    for (const budget of [101, 150, 399]) {
      const q = shapePrimeQuery(`${emoji}\n${emoji}`, budget);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(q)).toBe(false);
    }
  });

  it('a CJK question is a question, not a pointer', () => {
    const asked = '为什么夜间导入任务在新主机上一直失败，应该检查哪个配置？';
    expect(shapePrimeQuery(`${asked}\n${LOG}`, 400)).toBe(asked);
  });
});

describe('shapePrimeQuery — second review (2026-10-16)', () => {
  it('stays fast on the inputs that were quadratic (8-37 s at 100-200 KB)', () => {
    const roster = `Here are the members on the roster, ${Array.from({ length: 12_000 }, (_, i) => `member${i}`).join(', ')}. Who is missing from the export?`;
    const lines = Array.from({ length: 40_000 }, (_, i) => `short prose line number ${i} here`).join('\n');
    for (const prompt of [roster, `<td>${' '.repeat(100_000)}value`, `why?\n${'HTTP/'.repeat(40_000)}`, `which one is it?\n${lines}`]) {
      const t0 = performance.now();
      shapePrimeQuery(prompt, 400);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it('a fence with an info string opens and closes a block', () => {
    const prompt = `I have this handler that keeps failing\n\`\`\` js title="routes.js"\n${CODE}\n\`\`\`\nwhy does the members query return an empty array for valid ids`;
    const q = shapePrimeQuery(prompt, 400);
    expect(q).toContain('I have this handler that keeps failing');
    expect(q).toContain('why does the members query return an empty array');
    expect(q).not.toContain('function handler');
  });

  it('an unclosed fence does not swallow what is typed after it', () => {
    const prompt = `${LOG}\n\`\`\`\nwhy does the nightly import keep timing out on the new host`;
    expect(shapePrimeQuery(prompt, 400)).toContain('why does the nightly import keep timing out');
  });

  it.each([
    ['a heading', `## Meeting notes\n\n${Array.from({ length: 12 }, (_, i) => `- Item ${i}: the team discussed the roadmap and asked for a written proposal.`).join('\n')}\n\n${Q}`],
    ['an introducer', `Terraform will perform the following actions:\n\n${Array.from({ length: 6 }, (_, i) => `  + resource "aws_instance" "web" {\n      + ami = "ami-${i}"\n    }`).join('\n')}\n\nPlan: 6 to add, 0 to change, 0 to destroy.\n\n${Q}`],
  ])('a paste that starts with %s still lets the question at the end lead', (_n, prompt) => {
    expect(shapePrimeQuery(prompt, 400).startsWith(Q)).toBe(true);
  });

  it.each([
    ['a tool trailer', `${Q}\n\n${LOG}\n\nProcess finished with exit code 1`],
    ['an email signature', `${Q}\n\n${'On Tue, Jordan wrote:\n> Thanks for the update, the team is comfortable with the plan as long as the timeline holds.\n'.repeat(4)}\nJordan Lee\nDirector of Operations`],
    ['a sign-off', `${Q}\n\n${NOTES}\n\nThanks so much for the help!`],
    ['chained Python exceptions', `${Q}\n\nTraceback (most recent call last):\n  File "/srv/a.py", line 3, in run\n    x = load(1)\nKeyError: 'id'\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n  File "/srv/b.py", line 9, in main\n    run()\nRuntimeError: load failed`],
  ])('the typed question first keeps the lead over %s at the end', (_n, prompt) => {
    expect(shapePrimeQuery(prompt, 400).startsWith(Q)).toBe(true);
  });

  it('a typed line that starts with a flag is prose', () => {
    const prompt = `AWM_RERANK2=1 didn't change anything (I measured it)\n${LOG}`;
    expect(shapePrimeQuery(prompt, 400)).toBe("AWM_RERANK2=1 didn't change anything (I measured it)");
  });

  it('keeps tag names a person typed (tags are only stripped from task notifications)', () => {
    expect(shapePrimeQuery(`What does <summary> do vs <details>?\n${LOG}`, 400)).toBe('What does <summary> do vs <details>?');
  });

  it('does not repeat an error line to fill both reserved slots', () => {
    const errs = Array.from({ length: 5 }, () => "TypeError: Cannot read properties of undefined (reading 'id')").join('\n');
    const q = shapePrimeQuery(`why does the page crash?\n${errs}\n${LOG}`, 400);
    expect(q.match(/TypeError/g)).toHaveLength(1);
  });
});

describe('shapePrimeQuery — background-task notifications', () => {
  it('drops id/path/status envelope lines and keeps the summary and result text', () => {
    const prompt = [
      '<task-notification>', '<task-id>b43drliev</task-id>', '<tool-use-id>toolu_01ABCdef234</tool-use-id>',
      '<output-file>C:\\Users\\me\\AppData\\Local\\Temp\\tasks\\b43drliev.output</output-file>', '<status>completed</status>',
      '<summary>Background command "Run the full test suite" completed (exit code 0)</summary>',
      `<result>${'The reviewer found the scheduling change safe for existing callers. '.repeat(8)}</result>`,
      '</task-notification>',
    ].join('\n');
    const q = shapePrimeQuery(prompt, 400);
    expect(q).toMatch(/^Background command "Run the full test suite" completed/);
    expect(q).not.toMatch(/b43drliev|toolu_|<\/?\w|completed<\//);
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it('drops the harness note, the token usage and attribution trailers', () => {
    const prompt = [
      '<task-notification>', '<task-id>a1</task-id>', '<summary>Agent "Build the invoice export batch" finished</summary>',
      '<note>A task-notification fires each time this agent stops with no live background children of its own.',
      'The user can send it another message and resume it.</note>',
      `<result>${'The invoice export now writes one row per line item. '.repeat(6)}`,
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)', 'Co-Authored-By: Claude <noreply@anthropic.com></result>',
      '<usage><total_tokens>81234</total_tokens><tool_uses>40</tool_uses><duration_ms>912345</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');
    const q = shapePrimeQuery(prompt, 400);
    expect(q).toMatch(/^Agent "Build the invoice export batch" finished\nThe invoice export now/);
    expect(q).not.toMatch(/task-notification fires|Generated with|Co-Authored-By|81234/);
  });
});

describe('shapePrimeQuery — prose that cannot be told from the question', () => {
  it('keeps the head and the tail, so a question at either end survives', () => {
    for (const prompt of [`${Q}\n\n${NOTES}`, `${NOTES}\n\n${Q}`]) {
      const q = shapePrimeQuery(prompt, 400);
      expect(q).toContain(Q);
      expect(q).toContain(' … ');
      expect(q.length).toBeLessThanOrEqual(400);
    }
  });

  it('cuts on word boundaries', () => {
    const q = shapePrimeQuery(`${Q}\n\n${NOTES}`, 400);
    const [h, t] = q.split(' … ');
    expect(NOTES.includes(t)).toBe(true);
    expect(/\s/.test(NOTES[NOTES.indexOf(t) - 1])).toBe(true);   // tail starts at a word
    expect(`${Q}\n${NOTES}`.startsWith(h)).toBe(true);           // blank lines are dropped
    expect(/\s/.test(`${Q}\n${NOTES}`[h.length])).toBe(true);      // head ends at a word
  });
});

describe('shapePrimeQuery — bounds', () => {
  it('never returns more than the budget, whatever the prompt', () => {
    const parts = [Q, LOG, CODE, NOTES, '<status>x</status>', '2026-10-16T14:00:00Z ERROR boom: cannot connect', '```', '- a bullet a person wrote'];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let n = 0; n < 200; n++) {
      const prompt = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => parts[Math.floor(rnd() * parts.length)]).join('\n');
      for (const budget of [50, 250, 400, 600]) {
        const q = shapePrimeQuery(prompt, budget);
        expect(q.length).toBeLessThanOrEqual(Math.max(budget, prompt.length <= budget ? prompt.length : 0));
      }
    }
  });

  it('a pure paste still yields a bounded query', () => {
    const q = shapePrimeQuery(LOG, 400);
    expect(q.length).toBeGreaterThan(0);
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it('treats CRLF like LF', () => {
    expect(shapePrimeQuery(`${Q}\r\n\r\n${LOG.replace(/\n/g, '\r\n')}`, 400)).toBe(Q);
  });
});

describe('isMachineLine — prose a person types is not machine output', () => {
  it.each([
    'for the record (see above) this was already fixed',
    'if you can, export the CSV: all rows please',
    'set AWM_RERANK2=1 and AWM_RERANK_TAGS=1 then rerun',
    '- Item 3: the team agreed to revisit the hiring plan',
    '+1 to the second option',
    '- raise the cap to $30;',
    '- Three retrieval flags: `AWM_RERANK2=1`, `AWM_RERANK_WINDOW=query`, `AWM_RERANK_TAGS=1`.',
    '- **src/core/reranker.ts:**',
    '- push to GitHub (resolved via the push-protection unblock);',
    'Read C:\\Users\\dev\\project\\_recovery-2026-10-15\\app-logs.txt and summarise it',
    'Signs FINAL state cleaned middle-tightened 011w cleanup2.py',
    '2026-10-15 10:30 call with the client: they want the export by Friday',
    'import members from the 2025 spreadsheet into the new tenant',
    'export data from the billing table to CSV',
    'class notes: the coaches want a second session',
    'at 10:30 tomorrow we meet the board',
    'let me know if x = y holds for every row',
    '"We need this done by Friday, no exceptions"',
    'Shipped it 🎉🎉🎉 thanks everyone 🙏🙏🙏 great job!!',
    'Note: the coaches will confirm the roster later',
    'note: the coaches will confirm the roster later',
    'src/hooks/prime.ts:42 throws when the prompt is empty',
    '- Sweep: "LOCAL ONLY. Never touch production"',
    'error handling in the import is too loose, can we tighten it',
    'the template uses {name}',
    'export type information to the CSV file',
    'for (most of) the team this is fine (I think)',
    "AWM_RERANK2=1 didn't change anything (I measured it)",
    '为什么夜间导入任务在新主机上一直失败，应该检查哪个配置？'.repeat(8),
  ])('%s', line => expect(isMachineLine(line)).toBe(false));

  it.each([
    '2026-10-16T13:00:07Z INFO worker[0] heartbeat ok',
    '[ERROR] connection lost',
    "TypeError: Cannot read properties of undefined (reading 'id')",
    'requests.exceptions.ConnectionError: Max retries exceeded',
    'Traceback (most recent call last):',
    '    at Object.handler (C:\\app\\src\\api\\routes.ts:42:17)',
    'File "/srv/app/worker.py", line 101, in run',
    'const id = req.params.id;',
    'res.status(400).end();',
    'return service.load(id);',
    'if (!id) {',
    '"updatedAt": "2026-10-01T08:00:00Z",',
    '"beta"',
    '@@ -10,7 +10,8 @@',
    'host=a port=5432 user=b',
    'SELECT id, name FROM users WHERE active = 1',
    'at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
    'Process finished with exit code 1',
    'npm ERR! code ERESOLVE',
    'export type Foo = { id: string }',
  ])('%s', line => expect(isMachineLine(line)).toBe(true));
});

describe('AWM_PRIME_QUERY_CHARS', () => {
  it('an invalid value falls back to the default instead of disabling shaping', async () => {
    const prev = process.env.AWM_PRIME_QUERY_CHARS;
    process.env.AWM_PRIME_QUERY_CHARS = 'off';
    try {
      vi.resetModules();
      const fresh = await import('../../src/hooks/prime-query.js');
      expect(fresh.PRIME_QUERY_CHARS).toBe(400);
      expect(fresh.shapePrimeQuery(`${Q}\n\n${LOG}`)).toBe(Q);
    } finally {
      if (prev === undefined) delete process.env.AWM_PRIME_QUERY_CHARS; else process.env.AWM_PRIME_QUERY_CHARS = prev;
    }
  });
});
