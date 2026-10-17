// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt-to-query shaping for the prime hook (2026-10-16).
 *
 * WHY THIS EXISTS
 * ---------------
 * /hooks/prime used to recall against the WHOLE prompt. A prompt that carries a
 * pasted log, a block of code or a background-task report is mostly paste, and
 * every retrieval signal then reads the paste instead of the question: BM25 scores
 * the paste's terms, the embedding becomes the paste's vector, and the cross-encoder
 * sees mostly paste even after its 128-token query cap (reranker.ts). Measured on
 * 100 real-store fixture queries wrapped in ~600 tokens of paste, success@1 was 49%
 * with the question before the paste and 26% with it after, against 93% for the
 * bare query, and each recall took 5-8 s.
 *
 * WHAT IT DOES
 * ------------
 * A prompt at or under the budget is returned unchanged, which is most typed
 * prompts. A longer one is cut down in four steps:
 *
 *   1. Envelope lines that only carry an id, a path or a status
 *      (`<task-id>b43drliev</task-id>`) are dropped, and lowercase tags are stripped
 *      to their text. Background-task notifications arrive this way; their harness
 *      note, token counts and attribution trailers are dropped as boilerplate.
 *   2. Lines that read as machine output are dropped: fenced code, timestamped or
 *      levelled log lines, stack frames, code statements, SQL, JSON, YAML, CSV,
 *      tables, diffs, key=value runs and symbol-dense lines. Up to two of them that
 *      name an error are kept, in a reserved share of the budget, because
 *      "fix this: <trace>" is answered by the error, not by the prose around it.
 *   3. The likeliest question is moved to the front (see shapePrimeQuery: the
 *      cross-encoder reads the start of the query).
 *   4. If the prose is still over budget, the query is its head and its tail.
 *
 * When the prose is only a pointer ("explain this:"), the pointer leads and the
 * paste's own head and tail fill the budget, because the paste is the subject.
 *
 * The shaped text is used for RECALL ONLY. Nothing here changes what the agent sees.
 * Explicit memory_recall queries are not shaped: an agent's query is written to be
 * a query.
 */

/** Characters of query the prime hook recalls with. 0 disables shaping. */
export const PRIME_QUERY_CHARS = (() => {
  // An explicit 0 disables; anything else invalid falls back to the default (see
  // reranker.ts shapeCap): a typo must not quietly restore whole-prompt recall.
  const v = Number(process.env.AWM_PRIME_QUERY_CHARS?.trim() || NaN);
  return Number.isInteger(v) && v >= 0 ? v : 400;
})();

/** Error-bearing machine lines kept, and the share of the budget they may take. */
const MAX_SALIENT = 2;
const SALIENT_SHARE = 0.3;
/** Lines longer than this are classified on their first CLASSIFY_LEN chars. */
const CLASSIFY_LEN = 400;

// Seconds are required: "2026-10-15 10:30 call with the client" is a person's note.
const TIMESTAMP = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|^\[?\d{2}:\d{2}:\d{2}[.,\]\s]/;
const LOG_LEVEL = /^\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL)\]?[\s:|-]/;
// A frame names a source location (a path or file with :line), so "at 10:30 tomorrow"
// is not one. PowerShell error records are frames too.
// The error header a trace starts or ends with (TypeError: …, requests.exceptions.
// ConnectionError: …) belongs to the trace; it is kept as an error line, below.
const STACK_FRAME = /^(at\s+(async\s+)?(\S+\s+){0,4}\(?\S*[/\\.]\S*:\d+(:\d+)?\)?$|File ".*", line \d+|Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause|[\w.]*(Error|Exception):\s|#\d+\s+0x[0-9a-f]+|\.\.\. \d+ more|At line:\d+ char:\d+|\+ (CategoryInfo|FullyQualifiedErrorId)\s*:)/;
// Keyword AND code syntax: "for the record (see above)", "let me know if x = y" and
// "import members from the 2025 sheet" are prose; the code forms are not.
const CODE_KEYWORD = new RegExp([
  String.raw`^(const|let|var)\s+([\w$]+|\{[^}]*\}|\[[^\]]*\])\s*(:\s*[\w<>[\]|. ]+)?=(?!=)`,
  String.raw`^(async\s+)?function\b\s*\*?\s*[\w$]*\s*\(`,
  String.raw`^import\s+(['"]|.*\s+from\s+['"])`,
  // "export type information to the CSV" is prose; `export type Foo =` is not.
  String.raw`^export\s+(\{|\*|default\b|type\s+\w+\s*[=<{]|interface\b|const\b|let\b|function\b|class\b|async\b)`,
  // One parenthesised condition and nothing after it: "for (most of) the team…" is prose.
  String.raw`^(if|for|while|switch|catch)\s*\([^)]*\)\s*\{?$`,
  String.raw`^def\s+\w+\s*\(`,
  String.raw`^class\s+\w+\s*(\(.*\)\s*:|:$|\{|(extends|implements)\b)`,
  String.raw`^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s.*\b(FROM|INTO|SET|TABLE|WHERE|AS)\b`,
  String.raw`^(FROM|WHERE|JOIN|LEFT JOIN|INNER JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|UNION)\s`,
  String.raw`^SELECT\s+(DISTINCT\s+)?[\w.*]+(\s*,\s*[\w.*]+)*,?$`,
  // Python-style assignment, spaced: `result = self.fetch(x)`. Unspaced `AWM_X=1 didn't
  // help (I checked)` is a person starting a sentence with a flag.
  String.raw`^[\w.]+(\[[^\]]*\])?\s+[-+*/]?=\s+\S.*[(\[{'"]`,
].join('|'));
// An opening brace at the end, or a closing bracket at the start. A line ENDING in '}'
// is often a person's template ("the template uses {name}"), so that alone is not code.
const CODE_END = /\{\s*$|^\s*[}\])]/;
// A trailing ';' is code only with code syntax beside it: "- raise the cap to $30;" is
// a person's list, `return service.load(id);` is not.
const SEMICOLON_END = /;\s*$/;
const CODE_SYNTAX = /\w\(|[=!<>]=|=>|\s=\s|^\s*(return|throw|break|continue)\b/;
// A key line, a bare bracket, or a bare array value ("beta", "alpha", 42, null). A
// quoted sentence on its own line is a person quoting, so a string with spaces needs
// the trailing comma.
const JSON_LINE = /^"[^"]+"\s*:|^[[{]\s*$|^[\]}],?\s*$|^("[^"\s]*",?|"[^"]*",|-?\d[\d.eE+-]*,?|true,?|false,?|null,?)$/;
// Compiler and tool output: lowercase `error[E0308]: …` / `warning: …` headers (a typed
// "Note: …" is prose), Go `panic:` / `goroutine 1 [running]:` lines, `--> src/x.rs:41:10`
// locations, `   |` / `41 |` source gutters, a bare path:line (nothing after it but an
// offset — "src/x.ts:42 throws when…" is a person), and frames whose arguments are hex
// addresses (Go, C).
const TOOL_OUTPUT = /^((error|warning)(\[[\w-]+\])?:\s|panic:\s|goroutine \d+ \[|Process finished with exit code \d+|npm (ERR!|WARN|notice)\s|-->\s*\S+:\d+|\d*\s*\|(\s|$)|[.~]?[\w.-]*[/\\][^\s:]+:\d+(:\d+)?(\s+[+(]\S*)?$)|(0x[0-9a-fA-F]{4,}.*){2}/;
const DIFF_HEADER = /^(diff --git |index [0-9a-f]+\.\.[0-9a-f]+|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null)|@@ .* @@)/;
// One-token key, then one token or nothing (YAML, headers). "Note: fix it" is prose.
// A quoted value must be one token too: `- Sweep: "LOCAL ONLY. Never touch prod"` is a
// person's note. A bare label ("Summary:") is dropped, which costs nothing.
const YAML_LINE = /^(-\s+)?[\w.-]+:(\s+("[^"\s]*"|'[^'\s]*'|\S+))?\s*$/;
// Delimited rows: CSV with no comma-space (a person's list has them), or 2+ table pipes.
const CSV_LINE = /^[^\s,]+(,[^,\s]*){3,}$/;
const TABLE_LINE = /^\|?[^|]*(\s\|\s[^|]*){2,}\|?$|^[-+|: ]{5,}$|^\(\d+ rows?\)$/;
// The lookbehind keeps this linear: \b[\w.-]+ restarts at every '.' and '-' otherwise,
// which took 10 s on a 100 KB run of 'a.a.a.'.
const KEY_VALUE = /(?<![\w.-])[\w.-]+=\S+/g;
// Error words, plus HTTP 4xx/5xx statuses.
const ERROR_WORD = /\b(error|exception|fail(ed|ure)?|fatal|panic|denied|refused|cannot|can't|unable|not found|timed? ?out|undefined|traceback|segfault|abort(ed)?)\b|\b(HTTP\/\S+\s+|status\s*)[45]\d\d\b/i;
// Errno names (ECONNREFUSED, EPIPE) and compiler/vendor codes (TS2304, ORA-00942).
// Case-sensitive: with /i, E[A-Z]{3,} would match "every".
const ERROR_CODE = /\bE[A-Z]{3,}\b|\b[A-Z]{2,4}-?\d{3,5}\b/;
// A block that cannot be the typed request even though it reads as prose: a markdown
// heading, a line that introduces what follows ("Terraform will perform the following
// actions:", "Here is the log:"), a sign-off, or a signature / title line.
const HEADING = /^#{1,6}\s/;
const INTRODUCER = /:\s*$/;
const SIGN_OFF = /^(thanks|thank you|many thanks|cheers|regards|best( regards| wishes)?|sincerely|kind regards|let me know( what you think)?|hope this helps)\b/i;
const SIGNATURE = /^([A-Z][\w&.'’-]*|of|and|the|for|at|&)(\s+([A-Z][\w&.'’-]*|of|and|the|for|at|&)){0,5}$/;
/** Prose shorter than this many words is a pointer ("explain this:"): the paste is the subject. */
const POINTER_WORDS = 3;
const QUESTION = /\?(\s|$)/;
const MAX_QUESTIONS = 2;
const QUESTION_LEN = 150;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_ALL = new RegExp(CJK.source, 'gu');
/** A whole-line tag whose value is one token: an id, a path, a status, a number. */
const ID_TAG_LINE = /^<([\w-]+)>\s*\S*\s*<\/\1>$/;
// Lowercase names only: envelope and markup tags. `Map<String, List<Integer>>` is code
// a person typed into a sentence.
const TAG = /<\/?[a-z][a-z0-9_-]*(\s[^<>]*)?>/g;
// A fence marker starts a line and is not closed on it: "```js", "``` js title=x" and a
// bare "```" are markers; "```npm run build``` fails" is inline code in prose.
const FENCE = /^(```|~~~)(?!.*(```|~~~))/;
// Claude Code's task notifications carry the same harness note on every one ("A
// task-notification fires each time this agent stops…") and token counts. Both say
// nothing about the task, and the note alone took ~150 chars of a 400-char head.
const BOILERPLATE_ELEMENTS = ['note', 'usage', 'subagent_tokens'];
// Attribution trailers an agent's report ends with: they would fill the tail.
const BOILERPLATE_LINE = /^(🤖\s*)?Generated with \[?Claude Code\]?|^Co-Authored-By:|^Claude-Session:|^https:\/\/claude\.ai\/code\/session_/i;

/** True when a line reads as machine output rather than something a person wrote. */
export function isMachineLine(line: string): boolean {
  // Bounded, so every check below is linear in a fixed length whatever was pasted.
  const t = line.trim().slice(0, CLASSIFY_LEN);
  if (!t) return false;
  if (TIMESTAMP.test(t) || LOG_LEVEL.test(t) || STACK_FRAME.test(t) || DIFF_HEADER.test(t) || TOOL_OUTPUT.test(t)) return true;
  // A diff body line is a marker plus code. "- item" (a markdown bullet) and "+1" are
  // not: the rest of the line must itself read as machine output.
  if (/^[+-](?=\S|\s{2})/.test(t) && !/^[+-]\d/.test(t) && isMachineLine(t.slice(1))) return true;
  if (CODE_KEYWORD.test(t) || CODE_END.test(t) || JSON_LINE.test(t)) return true;
  if (YAML_LINE.test(t) || CSV_LINE.test(t) || TABLE_LINE.test(t)) return true;
  if (SEMICOLON_END.test(t) && CODE_SYNTAX.test(t)) return true;
  // Three, and most of the line: "set AWM_RERANK2=1 and AWM_RERANK_TAGS=1" is a person
  // typing; `host=a port=5432 user=b` is not. Pairs inside backticks are a person
  // quoting them, so they do not count.
  const kv = t.replace(/`[^`]*`/g, ' ').match(KEY_VALUE)?.length ?? 0;
  if (kv >= 3 && kv / t.split(/\s+/).length >= 0.4) return true;
  if (t.length >= 8) {
    // Identifiers like d.requires_horse or cleanup2.py are fine in prose; a line that
    // is a quarter punctuation is not. Markdown emphasis and code ticks, path slashes,
    // sentence punctuation and emoji are a person's, so they do not count.
    const symbols = t.replace(/[\p{L}\p{N}\p{M}\p{Extended_Pictographic}‍\s_.'’,*`/\\!?-]/gu, '').length;
    if (symbols / t.length > (t.length >= 24 ? 0.25 : 0.5)) return true;
    // Minified or base64: long and almost no spaces. CJK prose has no spaces either.
    if (t.length >= 200 && !CJK.test(t) && (t.match(/\s/g)?.length ?? 0) / t.length < 0.03) return true;
  }
  return false;
}

const ANY_TAG = /<\/?[A-Za-z][^<>]*>/g;

/**
 * Checks that need the raw line, before tags are stripped and spaces collapsed: a line
 * that is mostly markup (HTML, XML) or laid out in columns (`kubectl get pods`, `ps`,
 * aligned tables) is machine output, though its words would read as prose afterwards.
 */
function isMarkupOrColumns(raw: string): boolean {
  const t = raw.slice(0, CLASSIFY_LEN);
  // Several tags, or tags that are most of the line. "What does <summary> do vs
  // <details>?" mentions two tags; an HTML line is built of them.
  const found = t.match(ANY_TAG) ?? [];
  const share = found.join('').length / t.length;
  if ((share > 0.6 || (share > 0.4 && found.length >= 3)) && !/^<(summary|result)>/.test(t)) return true;
  return /\S(\s{3,}\S+){2,}/.test(t);
}

/** `i` moved off the low half of a surrogate pair, so a cut never splits an emoji. */
function safe(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

/** First `n` chars, cut back to a word boundary when one is near. */
function head(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, safe(s, n));
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

/** Last `n` chars, cut forward to a word boundary when one is near. */
function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  const from = s.length - n;
  const cut = s.slice(safe(s, from) === from ? from : from + 1);
  const sp = cut.indexOf(' ');
  return (sp >= 0 && sp < n * 0.4 ? cut.slice(sp + 1) : cut).trimStart();
}

const ELLIPSIS = ' … ';

/** Head and tail of `s` in at most `budget` chars. */
function headAndTail(s: string, budget: number): string {
  if (s.length <= budget) return s;
  if (budget < 4 * ELLIPSIS.length) return head(s, budget);
  const room = budget - ELLIPSIS.length;
  const h = Math.ceil(room / 2);
  return `${head(s, h)}${ELLIPSIS}${tail(s, room - h)}`;
}

/** Remove `<name>…</name>` elements in one linear pass; an unclosed one is left alone. */
function dropElements(s: string, names: string[]): string {
  for (const name of names) {
    const open = `<${name}>`, close = `</${name}>`;
    let out = '', at = 0;
    for (let i = s.indexOf(open); i >= 0; i = s.indexOf(open, at)) {
      const j = s.indexOf(close, i + open.length);
      if (j < 0) break;
      out += `${s.slice(at, i)}\n`;
      at = j + close.length;
    }
    s = out + s.slice(at);
  }
  return s;
}

/**
 * The query the prime hook recalls with. Pure and synchronous; never throws on a
 * string. `budget` defaults to AWM_PRIME_QUERY_CHARS (400); 0 returns the prompt.
 * Returns '' for a prompt that is nothing but envelope; the caller then skips recall.
 *
 * ORDER MATTERS. The cross-encoder reads the start of the query: the same question and
 * the same memory scored 0.996 with the question in front of 300 chars of notes and
 * 0.007 behind them, and every other memory scored ~0 too, so ranking collapsed. The
 * query therefore leads with the likeliest question: a task's <summary>, then lines
 * that ask something, then the end block of the prompt that reads as a typed request
 * (steps 1-3 below).
 */
export function shapePrimeQuery(prompt: string, budget: number = PRIME_QUERY_CHARS): string {
  if (budget <= 0 || prompt.length <= budget) return prompt;

  let text = prompt.replace(/\r\n?/g, '\n');
  // Envelope handling (boilerplate, tag stripping) applies to task notifications only,
  // never to typed text: "What does <summary> do vs <details>?" keeps its subject.
  const envelope = text.trimStart().startsWith('<task-notification>');
  if (envelope) text = dropElements(text, BOILERPLATE_ELEMENTS);
  const rawLines = text.split('\n');

  // An unclosed fence would turn everything typed after it into machine output, so the
  // last marker of an odd count does not open a block.
  const fences = rawLines.reduce<number[]>((a, l, k) => (FENCE.test(l.trim()) ? [...a, k] : a), []);
  const ignoredFence = fences.length % 2 ? fences[fences.length - 1] : -1;

  const lead: string[] = [];          // <summary> lines
  const prose: string[] = [];         // unique prose lines, in order
  const blocks: { lines: number; prose: string[]; size: number }[] = [{ lines: 0, prose: [], size: 0 }];
  const seen = new Set<string>();     // a line repeated verbatim is paste; keep it once
  const machine: string[] = [];
  const salient: string[] = [];
  let fenced = false;

  for (let k = 0; k < rawLines.length; k++) {
    const trimmed = rawLines[k].trim();
    let b = blocks[blocks.length - 1];
    if (!trimmed) { if (b.lines) blocks.push({ lines: 0, prose: [], size: 0 }); continue; }
    if (FENCE.test(trimmed) && k !== ignoredFence) { fenced = !fenced; continue; }
    if (trimmed.length <= CLASSIFY_LEN && ID_TAG_LINE.test(trimmed)) continue;
    const line = (envelope ? trimmed.replace(TAG, ' ') : trimmed).replace(/\s+/g, ' ').trim();
    if (!line || BOILERPLATE_LINE.test(line)) continue;
    b.lines++;
    if (fenced || isMarkupOrColumns(trimmed) || isMachineLine(line)) {
      machine.push(line);
      const head400 = line.slice(0, CLASSIFY_LEN);
      if (salient.length < MAX_SALIENT && !salient.includes(line) && (ERROR_WORD.test(head400) || ERROR_CODE.test(head400))) {
        salient.push(line);
      }
      continue;
    }
    if (envelope && trimmed.startsWith('<summary>')) { lead.push(line); continue; }
    b.prose.push(line);
    b.size += line.length;
    if (seen.has(line)) continue;
    seen.add(line);
    prose.push(line);
  }

  const wordsIn = (l: string) => l.split(/\s+/).filter(w => /\p{L}{2}/u.test(w)).length;
  const all = [...lead, ...prose];
  const words = wordsIn(all.join(' ')) + (all.join('').match(CJK_ALL)?.length ?? 0) / 2;

  // No prose, or only a pointer to the paste: the paste is what the prompt is about.
  // The pointer leads, and the paste's head and tail fill the rest.
  if (words < POINTER_WORDS) {
    const pointer = all.join(' ');
    const rest = headAndTail(machine.join('\n'), Math.max(0, budget - pointer.length - 1));
    return headAndTail([pointer, rest].filter(Boolean).join('\n'), budget);
  }

  // 1. Questions move to the front, within half the budget.
  const questions: string[] = [];
  const asked = new Set<string>();
  let used = 0;
  for (const line of prose) {
    if (questions.length >= MAX_QUESTIONS) break;
    const at = line.search(QUESTION);
    if (at < 0) continue;
    // A long line is cut to the sentence that asks (searched backwards from the '?',
    // within a bounded window); the line itself stays in the prose.
    let q = line;
    if (line.length > QUESTION_LEN) {
      const from = Math.max(0, at - 2 * QUESTION_LEN);
      const before = line.slice(from, at);
      const stop = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
      q = head(line.slice(stop >= 0 ? from + stop + 2 : from, at + 1).trim(), QUESTION_LEN);
    }
    if (used + q.length + 1 > budget / 2) break;
    questions.push(q);
    if (q === line) asked.add(line);
    used += q.length + 1;
  }

  // 2. Otherwise the typed request is usually a block at one end of the prompt, set off
  // from the paste by a blank line. An end block can lead only if it is mostly prose and
  // holds a sentence that is not a heading, an introducer, a sign-off or a signature.
  // When both ends can, the first leads unless it is clearly the paste (over twice the
  // size of the last). This needs no knowledge of the paste's format, so it holds when
  // some of a paste's lines leak through as prose.
  const filled = blocks.filter(b => b.lines > 0);
  const canLead = (b: { lines: number; prose: string[] }) => b.prose.length / b.lines >= 0.5
    && b.prose.some(l => (wordsIn(l) >= POINTER_WORDS || CJK.test(l))
      && !HEADING.test(l) && !INTRODUCER.test(l) && !SIGN_OFF.test(l) && !SIGNATURE.test(l));
  let leadBlock: string[] = [];
  let decided = questions.length > 0;
  if (!decided && filled.length >= 2) {
    const first = filled[0], last = filled[filled.length - 1];
    const firstOk = canLead(first), lastOk = canLead(last);
    if (lastOk && (!firstOk || last.size * 2 < first.size)) leadBlock = last.prose;
    decided = firstOk || lastOk;
  }

  const front = new Set(leadBlock);
  const remaining = [...new Set(leadBlock)].concat(prose.filter(l => !asked.has(l) && !front.has(l)));
  // Fragments ("## Meeting notes", "Node.js v20.11.0", a stray "+ Get-Item C:\x" that
  // escaped the machine rules) go to the back.
  const isSentence = (l: string) => wordsIn(l) >= POINTER_WORDS || CJK.test(l);
  const sentences = remaining.filter(isSentence);
  const fragments = remaining.filter(l => !isSentence(l));
  // 3. One block, or neither end can lead: among the sentences, the shorter end leads.
  if (!decided && sentences.length >= 2 && sentences[sentences.length - 1].length < sentences[0].length) {
    sentences.unshift(sentences.pop()!);
  }
  const rest = [...sentences, ...fragments];

  // Error lines get a reserved share, so long prose cannot crowd them out.
  const each = Math.floor((budget * SALIENT_SHARE) / Math.max(1, salient.length)) - 1;
  const errors = each >= 20 ? salient.map(e => head(e, each)) : [];
  const reserve = errors.length ? errors.join('\n').length + 1 : 0;
  const body = headAndTail([...lead, ...questions, ...rest].join('\n'), budget - reserve);
  return [body, ...errors].join('\n');
}
