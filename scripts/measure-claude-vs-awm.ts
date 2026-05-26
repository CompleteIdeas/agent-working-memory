/**
 * Compare token cost of file-based retrieval vs AWM retrieval in real
 * Claude Code sessions.
 *
 * Walks JSONL transcripts in ~/.claude/projects/, classifies every tool_use
 * by category, and sums the bytes consumed by tool_result content for each.
 * Reports per-session and rollup totals.
 *
 * Categories:
 *   file_retrieval: Read, Grep, Glob, NotebookRead, Bash(find/cat/grep/ls)
 *   awm_retrieval:  mcp__agent-working-memory__memory_{recall,restore,
 *                   task_list,task_next,stats}
 *   web_retrieval:  WebFetch, WebSearch
 *   editing:        Edit, Write, NotebookEdit
 *   bash_other:     Bash for non-retrieval (npm, git, build, etc.)
 *   delegation:     Agent
 *   meta:           TaskCreate/TaskList/TaskUpdate, ToolSearch, etc.
 *
 * Run: npx tsx scripts/measure-claude-vs-awm.ts [topN]
 */

import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TOP_N = Number(process.argv[2] ?? 15);
const PROJECTS_DIR = 'C:/Users/robert/.claude/projects';

const FILE_RETRIEVAL_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const WEB_RETRIEVAL_TOOLS = new Set(['WebFetch', 'WebSearch']);
const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const META_TOOLS = new Set([
  'TaskCreate', 'TaskList', 'TaskUpdate', 'TaskGet', 'TaskOutput', 'TaskStop',
  'ToolSearch', 'ScheduleWakeup', 'AskUserQuestion', 'CronCreate', 'CronList',
  'CronDelete', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'PushNotification', 'RemoteTrigger', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'Monitor', 'ShareOnboardingGuide', 'SendUserFile',
]);
const DELEGATION_TOOLS = new Set(['Agent']);
const BASH_RETRIEVAL_PATTERN = /^(find\b|cat\b|head\b|tail\b|less\b|more\b|grep\b|rg\b|ls\b|tree\b|wc\b)/;

function categorize(toolName: string, toolInput: any): string {
  if (toolName.startsWith('mcp__agent-working-memory__')) {
    const op = toolName.slice('mcp__agent-working-memory__'.length);
    if (['memory_recall', 'memory_restore', 'memory_task_list', 'memory_task_next', 'memory_stats'].includes(op)) {
      return 'awm_retrieval';
    }
    return 'awm_write';
  }
  if (FILE_RETRIEVAL_TOOLS.has(toolName)) return 'file_retrieval';
  if (WEB_RETRIEVAL_TOOLS.has(toolName)) return 'web_retrieval';
  if (EDITING_TOOLS.has(toolName)) return 'editing';
  if (DELEGATION_TOOLS.has(toolName)) return 'delegation';
  if (META_TOOLS.has(toolName)) return 'meta';
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = (toolInput?.command ?? '').trim();
    if (BASH_RETRIEVAL_PATTERN.test(cmd)) return 'file_retrieval';
    return 'bash_other';
  }
  return 'other';
}

function tokenCount(content: any): number {
  // Tool results can be strings or arrays of content blocks. We use char/4
  // as a token estimate — same heuristic test:tokens uses for AWM measurement.
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (typeof block === 'string') total += Math.ceil(block.length / 4);
      else if (block?.type === 'text' && typeof block.text === 'string') total += Math.ceil(block.text.length / 4);
      else if (block?.content) total += tokenCount(block.content);
    }
    return total;
  }
  if (content == null) return 0;
  return Math.ceil(JSON.stringify(content).length / 4);
}

interface SessionStats {
  sessionId: string;
  projectDir: string;
  filePath: string;
  fileSize: number;
  mtime: number;
  toolCallCount: number;
  byCategory: Record<string, { calls: number; tokensIn: number; tokensOut: number }>;
  totalAssistantMessages: number;
  totalUserMessages: number;
  // Actual model-reported usage totals (Anthropic's tokenizer)
  actualUsage: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  };
  // Cache-delta attribution: sum of cache_creation_input_tokens on turns that
  // immediately follow tool_result-bearing user messages, attributed
  // proportionally to the tool categories in each preceding user message.
  attributedTokens: Record<string, number>;
}

async function parseSession(filePath: string): Promise<SessionStats> {
  const stat = statSync(filePath);
  const stats: SessionStats = {
    sessionId: '',
    projectDir: '',
    filePath,
    fileSize: stat.size,
    mtime: stat.mtimeMs,
    toolCallCount: 0,
    byCategory: {},
    totalAssistantMessages: 0,
    totalUserMessages: 0,
    actualUsage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
    attributedTokens: {},
  };
  // tool_use_id → (category, inputTokens)
  const toolUseIndex = new Map<string, { category: string; inputTokens: number; name: string }>();
  // Pending: per-category byte fractions of the most recent tool_result-bearing user message,
  // waiting to be attributed by the NEXT assistant message's cache_creation_input_tokens.
  let pendingAttribution: Record<string, number> | null = null;
  // Dedupe: the JSONL streams multiple assistant chunks under the same message id.
  // We only want to count usage once per message id.
  const seenAssistantMessageIds = new Set<string>();

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!stats.sessionId && obj.sessionId) stats.sessionId = obj.sessionId;
    if (!stats.projectDir && obj.cwd) stats.projectDir = obj.cwd;

    if (obj.type === 'assistant') {
      const blocks = obj.message?.content;
      const msgId = obj.message?.id;
      const isNewMessage = msgId && !seenAssistantMessageIds.has(msgId);
      if (isNewMessage) {
        stats.totalAssistantMessages++;
        seenAssistantMessageIds.add(msgId);
        // Roll up real usage from this assistant turn (only on first chunk)
        const usage = obj.message?.usage ?? {};
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
        stats.actualUsage.inputTokens += Number(usage.input_tokens ?? 0);
        stats.actualUsage.cacheCreationInputTokens += cacheCreate;
        stats.actualUsage.cacheReadInputTokens += Number(usage.cache_read_input_tokens ?? 0);
        stats.actualUsage.outputTokens += Number(usage.output_tokens ?? 0);

        // Attribute the cache_creation_input_tokens to the categories that
        // contributed to the user message immediately before this turn. This
        // captures real Anthropic tokenizer output for new content added to
        // the context. Caveat: cache_creation also includes this turn's own
        // thinking + tool_use bytes, so it's an upper bound — we report it
        // alongside the byte-based estimate for cross-validation.
        if (pendingAttribution && cacheCreate > 0) {
          const total = Object.values(pendingAttribution).reduce((a, b) => a + b, 0);
          if (total > 0) {
            for (const [cat, bytes] of Object.entries(pendingAttribution)) {
              const fraction = bytes / total;
              stats.attributedTokens[cat] = (stats.attributedTokens[cat] ?? 0) + Math.round(cacheCreate * fraction);
            }
          }
          pendingAttribution = null;
        }
      }
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type === 'tool_use') {
            const name = block.name ?? 'unknown';
            const category = categorize(name, block.input);
            const inputTokens = tokenCount(block.input);
            toolUseIndex.set(block.id, { category, inputTokens, name });
            stats.toolCallCount++;
            if (!stats.byCategory[category]) stats.byCategory[category] = { calls: 0, tokensIn: 0, tokensOut: 0 };
            stats.byCategory[category].calls++;
            stats.byCategory[category].tokensIn += inputTokens;
          }
        }
      }
    } else if (obj.type === 'user') {
      stats.totalUserMessages++;
      const blocks = obj.message?.content;
      const userAttribution: Record<string, number> = {};
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type === 'tool_result') {
            const idx = toolUseIndex.get(block.tool_use_id);
            if (idx) {
              const outTokens = tokenCount(block.content);
              stats.byCategory[idx.category].tokensOut += outTokens;
              // userAttribution uses the same outTokens for proportional attribution.
              // Absolute units don't matter — we normalize by total at attribution time.
              userAttribution[idx.category] = (userAttribution[idx.category] ?? 0) + outTokens;
            }
          }
        }
      }
      if (Object.keys(userAttribution).length > 0) {
        pendingAttribution = userAttribution;
      }
    }
  }

  return stats;
}

async function main() {
  console.log('Scanning Claude Code session transcripts in ' + PROJECTS_DIR + '...\n');

  // Find all .jsonl files across all project subdirs
  const projects = readdirSync(PROJECTS_DIR).filter(d => {
    try { return statSync(join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
  });
  const allSessions: { project: string; file: string; mtime: number; size: number }[] = [];
  for (const proj of projects) {
    const projDir = join(PROJECTS_DIR, proj);
    let entries: string[];
    try { entries = readdirSync(projDir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = join(projDir, f);
      try {
        const st = statSync(fp);
        allSessions.push({ project: proj, file: fp, mtime: st.mtimeMs, size: st.size });
      } catch { /* skip */ }
    }
  }
  // Most recent first
  allSessions.sort((a, b) => b.mtime - a.mtime);
  console.log(`Found ${allSessions.length} session files. Parsing top ${TOP_N} by recency.\n`);

  const results: SessionStats[] = [];
  for (let i = 0; i < Math.min(TOP_N, allSessions.length); i++) {
    const { file, project, size } = allSessions[i];
    process.stderr.write(`[${i + 1}/${TOP_N}] ${project.slice(-40)}/${file.split(/[\\/]/).pop()} (${(size / 1024 / 1024).toFixed(1)} MB)...`);
    const stats = await parseSession(file);
    results.push(stats);
    process.stderr.write(' done\n');
  }

  // Per-session breakdown
  console.log('\n=== PER-SESSION BREAKDOWN (char/4 byte estimates) ===\n');
  console.log('session                              | tools  | file_ret bytes  | awm_ret bytes  | bash_other');
  console.log('-------------------------------------+--------+-----------------+----------------+-----------');
  for (const s of results) {
    const fileRetOut = s.byCategory.file_retrieval?.tokensOut ?? 0;
    const awmRetOut = s.byCategory.awm_retrieval?.tokensOut ?? 0;
    const bashOtherOut = s.byCategory.bash_other?.tokensOut ?? 0;
    const fileRetCalls = s.byCategory.file_retrieval?.calls ?? 0;
    const awmRetCalls = s.byCategory.awm_retrieval?.calls ?? 0;
    console.log(
      s.sessionId.slice(0, 36) + ' | ' +
      String(s.toolCallCount).padStart(6) + ' | ' +
      `${String(fileRetOut).padStart(8)} (${String(fileRetCalls).padStart(3)} calls)`.padEnd(15) + ' | ' +
      `${String(awmRetOut).padStart(7)} (${String(awmRetCalls).padStart(2)} calls)`.padEnd(14) + ' | ' +
      String(bashOtherOut).padStart(10)
    );
  }

  // Actual Anthropic-reported usage per session
  console.log('\n=== PER-SESSION ACTUAL MODEL USAGE (Anthropic-reported) ===\n');
  console.log('session                              | input_tok | cache_create | cache_read    | output_tok');
  console.log('-------------------------------------+-----------+--------------+---------------+-----------');
  for (const s of results) {
    const u = s.actualUsage;
    console.log(
      s.sessionId.slice(0, 36) + ' | ' +
      String(u.inputTokens).padStart(9) + ' | ' +
      String(u.cacheCreationInputTokens).padStart(12) + ' | ' +
      String(u.cacheReadInputTokens).padStart(13) + ' | ' +
      String(u.outputTokens).padStart(10)
    );
  }

  // Rollup
  const rollup: Record<string, { calls: number; tokensOut: number; attributed: number }> = {};
  for (const s of results) {
    for (const [cat, cnts] of Object.entries(s.byCategory)) {
      if (!rollup[cat]) rollup[cat] = { calls: 0, tokensOut: 0, attributed: 0 };
      rollup[cat].calls += cnts.calls;
      rollup[cat].tokensOut += cnts.tokensOut;
    }
    for (const [cat, tok] of Object.entries(s.attributedTokens)) {
      if (!rollup[cat]) rollup[cat] = { calls: 0, tokensOut: 0, attributed: 0 };
      rollup[cat].attributed += tok;
    }
  }

  console.log('\n=== ROLLUP (across all parsed sessions) ===\n');
  console.log('category        | calls   | estimated (char/4) | attributed (real) | per-call (real)');
  console.log('----------------+---------+--------------------+-------------------+----------------');
  const sortedCats = Object.entries(rollup).sort((a, b) => b[1].attributed - a[1].attributed);
  for (const [cat, cnts] of sortedCats) {
    const perCall = cnts.calls > 0 ? Math.round(cnts.attributed / cnts.calls) : 0;
    console.log(
      cat.padEnd(15) + ' | ' +
      String(cnts.calls).padStart(7) + ' | ' +
      String(cnts.tokensOut).padStart(16) + '   | ' +
      String(cnts.attributed).padStart(15) + '   | ' +
      String(perCall).padStart(13)
    );
  }

  // Actual session totals
  const totalActual = results.reduce((acc, s) => ({
    inputTokens: acc.inputTokens + s.actualUsage.inputTokens,
    cacheCreationInputTokens: acc.cacheCreationInputTokens + s.actualUsage.cacheCreationInputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens + s.actualUsage.cacheReadInputTokens,
    outputTokens: acc.outputTokens + s.actualUsage.outputTokens,
  }), { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 });

  console.log('\n=== ACTUAL TOTALS (Anthropic-reported, across all parsed sessions) ===');
  console.log(`Total input_tokens (uncached input):       ${totalActual.inputTokens.toLocaleString()}`);
  console.log(`Total cache_creation_input_tokens (new):   ${totalActual.cacheCreationInputTokens.toLocaleString()}`);
  console.log(`Total cache_read_input_tokens (reused):    ${totalActual.cacheReadInputTokens.toLocaleString()}`);
  console.log(`Total output_tokens:                       ${totalActual.outputTokens.toLocaleString()}`);
  console.log(`New context added across sessions:         ${(totalActual.inputTokens + totalActual.cacheCreationInputTokens).toLocaleString()}`);

  // Headline
  const fileRet = rollup.file_retrieval;
  const awmRet = rollup.awm_retrieval;
  if (fileRet && awmRet && awmRet.calls > 0) {
    console.log('\n=== HEADLINE COMPARISON (real Anthropic-attributed tokens) ===');
    console.log(`File retrieval (Read/Grep/Glob/Bash-find): ${fileRet.attributed.toLocaleString()} tokens / ${fileRet.calls} calls = ${Math.round(fileRet.attributed / fileRet.calls)} tok/call`);
    console.log(`AWM retrieval (recall/restore/task_list):  ${awmRet.attributed.toLocaleString()} tokens / ${awmRet.calls} calls = ${Math.round(awmRet.attributed / awmRet.calls)} tok/call`);
    console.log(`Call ratio file_retrieval:awm_retrieval =  ${(fileRet.calls / awmRet.calls).toFixed(1)}:1`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
