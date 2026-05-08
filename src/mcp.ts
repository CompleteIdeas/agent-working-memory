// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Server — Model Context Protocol interface for AgentWorkingMemory.
 *
 * Runs as a stdio-based MCP server that Claude Code connects to directly.
 * Uses the storage and engine layers in-process (no HTTP overhead).
 *
 * Tools exposed (12):
 *   memory_write       — store a memory (salience filter decides disposition)
 *   memory_recall      — activate memories by context (cognitive retrieval)
 *   memory_feedback    — report whether a recalled memory was useful
 *   memory_retract     — invalidate a wrong memory with optional correction
 *   memory_supersede   — replace an outdated memory with a current one
 *   memory_stats       — get memory health metrics
 *   memory_checkpoint  — save structured execution state (survives compaction)
 *   memory_restore     — restore state + targeted recall after compaction
 *   memory_task_add    — create a prioritized task
 *   memory_task_update — change task status, priority, or blocking
 *   memory_task_list   — list tasks filtered by status
 *   memory_task_next   — get the highest-priority actionable task
 *
 * Run: npx tsx src/mcp.ts
 * Config: add to ~/.claude.json or .mcp.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

// Load .env file if present (no external dependency)
try {
  const envPath = resolve(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* No .env file */ }

// MCP uses stdout for JSON-RPC. Redirect console.log to stderr so engine
// startup messages (ConsolidationScheduler, model loading, etc.) don't
// corrupt the transport. This MUST happen before any engine imports.
console.log = console.error;

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { EngramStore } from './storage/sqlite.js';
import { ActivationEngine } from './engine/activation.js';
import { ConnectionEngine } from './engine/connections.js';
import { StagingBuffer } from './engine/staging.js';
import { EvictionEngine } from './engine/eviction.js';
import { RetractionEngine } from './engine/retraction.js';
import { EvalEngine } from './engine/eval.js';
import { ConsolidationEngine } from './engine/consolidation.js';
import { ConsolidationScheduler } from './engine/consolidation-scheduler.js';
import { evaluateSalience, computeNovelty, computeNoveltyWithMatch } from './core/salience.js';
import type { ConsciousState } from './types/checkpoint.js';
import type { SalienceEventType } from './core/salience.js';
import type { TaskStatus, TaskPriority } from './types/engram.js';
import { DEFAULT_AGENT_CONFIG } from './types/agent.js';
import { embed } from './core/embeddings.js';
import { startSidecar } from './hooks/sidecar.js';
import { initLogger, log, getLogPath } from './core/logger.js';
import { queryPeerDecisions, formatPeerDecisions } from './coordination/peer-decisions.js';

// --- Incognito Mode ---
// When AWM_INCOGNITO=1, register zero tools. Claude won't see memory tools at all.
// No DB, no engines, no sidecar — just a bare MCP server that exposes nothing.

const INCOGNITO = process.env.AWM_INCOGNITO === '1' || process.env.AWM_INCOGNITO === 'true';

if (INCOGNITO) {
  console.error('AWM: incognito mode — all memory tools disabled, nothing will be recorded');
  const server = new McpServer({ name: 'agent-working-memory', version: '0.7.7' });
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    console.error('MCP server failed:', err);
    process.exit(1);
  });
  // No tools registered — Claude won't see any memory_* tools
} else {

// --- Setup ---

const DB_PATH = process.env.AWM_DB_PATH ?? 'memory.db';
const AGENT_ID = process.env.AWM_AGENT_ID ?? process.env.WORKER_NAME ?? 'claude-code';
const HOOK_PORT = parseInt(process.env.AWM_HOOK_PORT ?? '8401', 10);
const HOOK_SECRET = process.env.AWM_HOOK_SECRET ?? null;

initLogger(DB_PATH);
log(AGENT_ID, 'startup', `MCP server starting (db: ${DB_PATH}, hooks: ${HOOK_PORT})`);

const store = new EngramStore(DB_PATH);
const activationEngine = new ActivationEngine(store);
const connectionEngine = new ConnectionEngine(store, activationEngine);
const stagingBuffer = new StagingBuffer(store, activationEngine);
const evictionEngine = new EvictionEngine(store);
const retractionEngine = new RetractionEngine(store);
const evalEngine = new EvalEngine(store);
const consolidationEngine = new ConsolidationEngine(store);
const consolidationScheduler = new ConsolidationScheduler(store, consolidationEngine);

stagingBuffer.start(DEFAULT_AGENT_CONFIG.stagingTtlMs);
consolidationScheduler.start();

// Coordination DB handle — set when AWM_COORDINATION=true, used by memory_write for decision propagation
let coordDb: import('better-sqlite3').Database | null = null;

const server = new McpServer({
  name: 'agent-working-memory',
  version: '0.7.7',
});

server.registerResource(
  'awm-overview',
  'awm://server/overview',
  {
    title: 'AWM Overview',
    description: 'AgentWorkingMemory MCP server metadata and discovery notes',
    mimeType: 'text/markdown',
  },
  async () => ({
    contents: [{
      uri: 'awm://server/overview',
      text: [
        '# Agent Working Memory',
        '',
        `Agent: ${AGENT_ID}`,
        `DB: ${DB_PATH}`,
        `Coordination: ${process.env.AWM_COORDINATION === 'true' || process.env.AWM_COORDINATION === '1' ? 'enabled' : 'disabled'}`,
        '',
        'This MCP server primarily exposes tools such as `memory_restore`, `memory_recall`, `memory_write`, and task/checkpoint operations.',
        'The resources below exist so generic MCP clients can discover the server through `resources/list` and `resources/templates/list`.',
      ].join('\n'),
      mimeType: 'text/markdown',
    }],
  })
);

server.registerResource(
  'awm-memory-template',
  new ResourceTemplate('awm://memory/{id}', { list: undefined }),
  {
    title: 'AWM Memory By ID',
    description: 'Metadata resource template for a memory identifier',
    mimeType: 'text/markdown',
  },
  async (_uri, variables) => ({
    contents: [{
      uri: `awm://memory/${variables.id ?? ''}`,
      text: [
        '# AWM Memory Reference',
        '',
        `Requested memory id: ${variables.id ?? ''}`,
        '',
        'Use the AWM memory tools for actual retrieval and mutation:',
        '- `memory_recall` for cognitive retrieval',
        '- `memory_restore` for session state',
        '- `memory_feedback`, `memory_retract`, `memory_supersede` for memory maintenance',
      ].join('\n'),
      mimeType: 'text/markdown',
    }],
  })
);

// --- Auto-classification for memory types ---

function classifyMemoryType(content: string): 'episodic' | 'semantic' | 'procedural' | 'unclassified' {
  const lower = content.toLowerCase();
  // Procedural: how-to, steps, numbered lists
  if (/\bhow to\b|\bsteps?:/i.test(content) || /^\s*\d+[\.\)]\s/m.test(content) || /\bthen run\b|\bfirst,?\s/i.test(content)) {
    return 'procedural';
  }
  // Episodic: past tense events, incidents, specific time references
  if (/\b(discovered|debugged|fixed|encountered|happened|resolved|found that|we did|i did|yesterday|last week|today)\b/i.test(content)) {
    return 'episodic';
  }
  // Semantic: facts, decisions, rules, patterns
  if (/\b(is|are|should|always|never|must|uses?|requires?|means|pattern|decision|rule|convention)\b/i.test(content) && content.length < 500) {
    return 'semantic';
  }
  return 'unclassified';
}

// --- Tools ---

server.tool(
  'memory_write',
  `Store a memory. The salience filter decides whether it's worth keeping (active), needs more evidence (staging), or should be discarded.

CALL THIS PROACTIVELY — do not wait to be asked. Write memories when you:
- Discover something about the codebase, bugs, or architecture
- Make a decision and want to remember why
- Encounter and resolve an error
- Learn a user preference or project pattern
- Complete a significant piece of work

The concept should be a short label (3-8 words). The content should be the full detail.`,
  {
    concept: z.string().describe('Short label for this memory (3-8 words)'),
    content: z.string().describe('Full detail of what was learned'),
    tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
    event_type: z.enum(['observation', 'decision', 'friction', 'surprise', 'causal'])
      .optional().default('observation')
      .describe('Type of event: observation (default), decision, friction (error/blocker), surprise, causal (root cause)'),
    surprise: z.number().min(0).max(1).optional().default(0.3)
      .describe('How surprising was this? 0=expected, 1=very unexpected'),
    decision_made: z.boolean().optional().default(false)
      .describe('Was a decision made? True boosts importance'),
    causal_depth: z.number().min(0).max(1).optional().default(0.3)
      .describe('How deep is the causal understanding? 0=surface, 1=root cause'),
    resolution_effort: z.number().min(0).max(1).optional().default(0.3)
      .describe('How much effort to resolve? 0=trivial, 1=significant debugging'),
    memory_class: z.enum(['canonical', 'working', 'ephemeral']).optional().default('working')
      .describe('Memory class: canonical (source-of-truth, never stages), working (default), ephemeral (temporary, decays faster)'),
    memory_type: z.enum(['episodic', 'semantic', 'procedural', 'unclassified']).optional()
      .describe('Memory type: episodic (events/incidents), semantic (facts/decisions), procedural (how-to/steps). Auto-classified if omitted.'),
    supersedes: z.string().optional()
      .describe('ID of an older memory this one replaces. The old memory is down-ranked, not deleted.'),
    // --- Agent-provided metadata (stored as searchable tags) ---
    project: z.string().optional()
      .describe('Project context (e.g., "EquiHub", "AWM"). Becomes a searchable tag.'),
    topic: z.string().optional()
      .describe('Subject area (e.g., "database-migration", "auth-flow"). Becomes a searchable tag.'),
    source: z.enum(['code-reading', 'debugging', 'discussion', 'research', 'testing', 'observation']).optional()
      .describe('How this knowledge was acquired.'),
    confidence_level: z.enum(['verified', 'observed', 'assumed']).optional()
      .describe('Confidence: verified (tested), observed (read in code), assumed (reasoning).'),
    session_id: z.string().optional()
      .describe('Session/conversation grouping ID. Memories with same session_id are associated.'),
    intent: z.enum(['decision', 'question', 'todo', 'finding', 'context']).optional()
      .describe('What kind of memory this is.'),
  },
  async (params) => {
    // Check novelty with match info for reinforcement
    const noveltyResult = computeNoveltyWithMatch(store, AGENT_ID, params.concept, params.content);
    const novelty = noveltyResult.novelty;

    // --- Reinforce-on-Duplicate check ---
    // Tightened thresholds: require near-exact match (novelty < 0.3, BM25 > 0.85, 60% content overlap)
    if (novelty < 0.3
        && noveltyResult.matchScore > 0.85
        && noveltyResult.matchedEngramId) {
      const matchedEngram = store.getEngram(noveltyResult.matchedEngramId);
      if (matchedEngram) {
        const existingTokens = new Set(matchedEngram.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const newTokens = new Set(params.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const t of newTokens) { if (existingTokens.has(t)) overlap++; }
        const contentOverlap = newTokens.size > 0 ? overlap / newTokens.size : 0;

        if (contentOverlap > 0.6) {
          // True duplicate — reinforce existing and skip creation
          store.touchEngram(noveltyResult.matchedEngramId);
          try { store.updateAutoCheckpointWrite(AGENT_ID, noveltyResult.matchedEngramId); } catch { /* non-fatal */ }
          log(AGENT_ID, 'write:reinforce', `"${params.concept}" → reinforced "${matchedEngram.concept}" (overlap=${contentOverlap.toFixed(2)})`);
          return {
            content: [{
              type: 'text' as const,
              text: `Reinforced existing memory "${matchedEngram.concept}" (overlap ${(contentOverlap * 100).toFixed(0)}%)`,
            }],
          };
        }
        // Partial match — continue to create new memory
        log(AGENT_ID, 'write:partial-match', `"${params.concept}" partially matched "${matchedEngram.concept}" (overlap=${contentOverlap.toFixed(2)}), creating new memory`);
      }
    }

    const salience = evaluateSalience({
      content: params.content,
      eventType: params.event_type as SalienceEventType,
      surprise: params.surprise,
      decisionMade: params.decision_made,
      causalDepth: params.causal_depth,
      resolutionEffort: params.resolution_effort,
      novelty,
      memoryClass: params.memory_class,
    });

    // v0.5.4: No longer discard — store everything, use salience for ranking.
    // Low-salience memories get low confidence so they rank below high-salience
    // in retrieval, but remain available for recall when needed.
    const isLowSalience = salience.disposition === 'discard';

    const CONFIDENCE_PRIORS: Record<string, number> = {
      decision: 0.65,
      friction: 0.60,
      causal:   0.60,
      surprise: 0.55,
      observation: 0.45,
    };
    const confidencePrior = isLowSalience
      ? 0.25
      : salience.disposition === 'staging'
      ? 0.40
      : CONFIDENCE_PRIORS[params.event_type ?? 'observation'] ?? 0.45;

    const memoryType = params.memory_type ?? classifyMemoryType(params.content);

    // Assemble tags: user-provided + agent metadata (stored as searchable prefixed tags)
    const userTags = params.tags ?? [];
    const metaTags: string[] = [];
    if (params.project) metaTags.push(`proj=${params.project}`);
    if (params.topic) metaTags.push(`topic=${params.topic}`);
    if (params.source) metaTags.push(`src=${params.source}`);
    if (params.confidence_level) metaTags.push(`conf=${params.confidence_level}`);
    if (params.session_id) metaTags.push(`sid=${params.session_id}`);
    if (params.intent) metaTags.push(`intent=${params.intent}`);
    const allTags = isLowSalience
      ? [...userTags, ...metaTags, 'low-salience']
      : [...userTags, ...metaTags];

    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: params.concept,
      content: params.content,
      tags: allTags,
      salience: salience.score,
      confidence: confidencePrior,
      salienceFeatures: salience.features,
      reasonCodes: salience.reasonCodes,
      ttl: salience.disposition === 'staging' ? DEFAULT_AGENT_CONFIG.stagingTtlMs : undefined,
      memoryClass: params.memory_class,
      memoryType,
      supersedes: params.supersedes,
    });

    if (salience.disposition === 'staging') {
      store.updateStage(engram.id, 'staging');
    } else {
      connectionEngine.enqueue(engram.id);
    }

    // Handle supersession: mark old memory as superseded
    if (params.supersedes) {
      const oldEngram = store.getEngram(params.supersedes);
      if (oldEngram) {
        store.supersedeEngram(params.supersedes, engram.id);
        // Create supersession association
        store.upsertAssociation(engram.id, oldEngram.id, 0.8, 'causal', 0.9);
      }
    }

    // Generate embedding asynchronously (don't block response)
    embed(`${params.concept} ${params.content}`).then(vec => {
      store.updateEmbedding(engram.id, vec);
    }).catch(() => {}); // Embedding failure is non-fatal

    // Auto-checkpoint: track write
    try { store.updateAutoCheckpointWrite(AGENT_ID, engram.id); } catch { /* non-fatal */ }

    // Decision propagation: when decision_made=true and coordination is enabled,
    // broadcast to coord_decisions so other agents can discover it
    if (params.decision_made && coordDb) {
      try {
        const agent = coordDb.prepare(
          `SELECT id, current_task FROM coord_agents WHERE name = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
        ).get(AGENT_ID) as { id: string; current_task: string | null } | undefined;
        if (agent) {
          coordDb.prepare(
            `INSERT INTO coord_decisions (author_id, assignment_id, tags, summary) VALUES (?, ?, ?, ?)`
          ).run(agent.id, agent.current_task, params.tags ? JSON.stringify(params.tags) : null, params.concept);
        }
      } catch { /* decision propagation is non-fatal */ }
    }

    const logDisposition = isLowSalience ? 'low-salience' : salience.disposition;
    log(AGENT_ID, `write:${logDisposition}`, `"${params.concept}" salience=${salience.score.toFixed(2)} novelty=${novelty.toFixed(1)} id=${engram.id}`);

    return {
      content: [{
        type: 'text' as const,
        text: `Stored (${salience.disposition}) "${params.concept}" [${salience.score.toFixed(2)}]\nID: ${engram.id}`,
      }],
    };
  }
);

server.tool(
  'memory_recall',
  `Recall memories relevant to a query. Uses cognitive activation — not keyword search.

ALWAYS call this when:
- Starting work on a project or topic (recall what you know)
- Debugging (recall similar errors and solutions)
- Making decisions (recall past decisions and outcomes)
- The user mentions a topic you might have stored memories about

Accepts either "query" or "context" parameter — both work identically.
Returns the most relevant memories ranked by text relevance, temporal recency, and associative strength.`,
  {
    query: z.string().optional().describe('What to search for — describe the situation, question, or topic'),
    context: z.string().optional().describe('Alias for query (either works)'),
    limit: z.number().optional().default(5).describe('Max memories to return (default 5)'),
    min_score: z.number().optional().default(0.05).describe('Minimum relevance score (default 0.05)'),
    include_staging: z.boolean().optional().default(false).describe('Include weak/unconfirmed memories?'),
    use_reranker: z.boolean().optional().default(true).describe('Use cross-encoder re-ranking for better relevance (default true)'),
    use_expansion: z.boolean().optional().default(true).describe('Expand query with synonyms for better recall (default true)'),
    memory_type: z.enum(['episodic', 'semantic', 'procedural']).optional().describe('Filter by memory type (omit to search all types)'),
    workspace: z.string().optional().describe('Search across all agents in this workspace (hive mode). Omit for agent-scoped recall only.'),
  },
  async (params) => {
    const queryText = params.query ?? params.context;
    if (!queryText) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Error: provide either "query" or "context" parameter with your search text.',
        }],
      };
    }
    // Use workspace from param, env var, or omit for agent-scoped
    const workspace = params.workspace ?? process.env.AWM_WORKSPACE ?? undefined;
    const results = await activationEngine.activate({
      agentId: AGENT_ID,
      context: queryText,
      limit: params.limit,
      minScore: params.min_score,
      includeStaging: params.include_staging,
      useReranker: params.use_reranker,
      useExpansion: params.use_expansion,
      memoryType: params.memory_type,
      workspace,
    });

    // Auto-checkpoint: track recall
    try {
      const ids = results.map(r => r.engram.id);
      store.updateAutoCheckpointRecall(AGENT_ID, queryText, ids);
    } catch { /* non-fatal */ }

    log(AGENT_ID, 'recall', `"${queryText.slice(0, 80)}" → ${results.length} results`);

    // Peer decisions: append recent decisions by other agents relevant to this query
    const peerSuffix = coordDb
      ? formatPeerDecisions(queryPeerDecisions(coordDb, AGENT_ID, queryText))
      : '';

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No relevant memories found.' + peerSuffix,
        }],
      };
    }

    const lines = results.map((r, i) => {
      return `${i + 1}. **${r.engram.concept}** (${r.score.toFixed(3)}): ${r.engram.content}`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n') + peerSuffix,
      }],
    };
  }
);

server.tool(
  'memory_feedback',
  `Report whether a recalled memory was actually useful. This updates the memory's confidence score — useful memories become stronger, useless ones weaken.

Always call this after using a recalled memory so the system learns what's valuable.`,
  {
    engram_id: z.string().describe('ID of the memory (from memory_recall results)'),
    useful: z.boolean().describe('Was this memory actually helpful?'),
    context: z.string().optional().describe('Brief note on why it was/wasn\'t useful'),
  },
  async (params) => {
    store.logRetrievalFeedback(null, params.engram_id, params.useful, params.context ?? '');

    const engram = store.getEngram(params.engram_id);
    if (engram) {
      const delta = params.useful
        ? DEFAULT_AGENT_CONFIG.feedbackPositiveBoost
        : -DEFAULT_AGENT_CONFIG.feedbackNegativePenalty;
      store.updateConfidence(engram.id, engram.confidence + delta);
    }

    // Validation-gated Hebbian: resolve pending co-activation pairs for this engram
    const hebbianUpdated = activationEngine.resolveHebbianFeedback(params.engram_id, params.useful);

    return {
      content: [{
        type: 'text' as const,
        text: `Feedback: ${params.useful ? '+useful' : '-not useful'}${hebbianUpdated > 0 ? ` (${hebbianUpdated} association${hebbianUpdated > 1 ? 's' : ''} ${params.useful ? 'strengthened' : 'weakened'})` : ''}`,
      }],
    };
  }
);

server.tool(
  'memory_retract',
  `Retract a memory that turned out to be wrong. Creates a correction and reduces confidence of related memories.

Use this when you discover a memory contains incorrect information.`,
  {
    engram_id: z.string().describe('ID of the wrong memory'),
    reason: z.string().describe('Why is this memory wrong?'),
    correction: z.string().optional().describe('What is the correct information? (creates a new memory)'),
  },
  async (params) => {
    const result = retractionEngine.retract({
      agentId: AGENT_ID,
      targetEngramId: params.engram_id,
      reason: params.reason,
      counterContent: params.correction,
    });

    const parts = [`Memory ${params.engram_id} retracted.`];
    if (result.correctionId) {
      parts.push(`Correction stored as ${result.correctionId}.`);
    }
    parts.push(`${result.associatesAffected} related memories had confidence reduced.`);

    return {
      content: [{
        type: 'text' as const,
        text: parts.join(' '),
      }],
    };
  }
);

server.tool(
  'memory_supersede',
  `Replace an outdated memory with a newer one. Unlike retraction (which marks memories as wrong), supersession marks the old memory as outdated but historically correct.

Use this when:
- A status or count has changed (e.g., "5 reviews done" → "7 reviews done")
- Architecture or infrastructure evolved (e.g., "two-repo model" → "three-repo model")
- A schedule or plan was updated

The old memory stays in the database (searchable for history) but is heavily down-ranked in recall so the current version dominates.`,
  {
    old_engram_id: z.string().describe('ID of the outdated memory'),
    new_engram_id: z.string().describe('ID of the replacement memory'),
    reason: z.string().optional().describe('Why the old memory is outdated'),
  },
  async (params) => {
    const oldEngram = store.getEngram(params.old_engram_id);
    if (!oldEngram) {
      return { content: [{ type: 'text' as const, text: `Old memory not found: ${params.old_engram_id}` }] };
    }
    const newEngram = store.getEngram(params.new_engram_id);
    if (!newEngram) {
      return { content: [{ type: 'text' as const, text: `New memory not found: ${params.new_engram_id}` }] };
    }

    store.supersedeEngram(params.old_engram_id, params.new_engram_id);

    // Create supersession association (new → old)
    store.upsertAssociation(params.new_engram_id, params.old_engram_id, 0.8, 'causal', 0.9);

    // Reduce old memory's confidence (not to zero — it's historical, not wrong)
    store.updateConfidence(params.old_engram_id, Math.max(0.2, oldEngram.confidence * 0.4));

    log(AGENT_ID, 'supersede', `"${oldEngram.concept}" → "${newEngram.concept}"${params.reason ? ` (${params.reason})` : ''}`);

    return {
      content: [{
        type: 'text' as const,
        text: `Superseded: "${oldEngram.concept}" → "${newEngram.concept}"`,
      }],
    };
  }
);

server.tool(
  'memory_stats',
  `Get memory health stats — how many memories, confidence levels, association count, and system performance.
Also shows the activity log path so the user can tail it to see what's happening.`,
  {},
  async () => {
    const metrics = evalEngine.computeMetrics(AGENT_ID);
    const checkpoint = store.getCheckpoint(AGENT_ID);
    const lines = [
      `Agent: ${AGENT_ID}`,
      `Active memories: ${metrics.activeEngramCount}`,
      `Staging: ${metrics.stagingEngramCount}`,
      `Retracted: ${metrics.retractedCount}`,
      `Avg confidence: ${metrics.avgConfidence.toFixed(3)}`,
      `Total edges: ${metrics.totalEdges}`,
      `Edge utility: ${(metrics.edgeUtilityRate * 100).toFixed(1)}%`,
      `Activations (24h): ${metrics.activationCount}`,
      `Avg latency: ${metrics.avgLatencyMs.toFixed(1)}ms`,
      ``,
      `Session writes: ${checkpoint?.auto.writeCountSinceConsolidation ?? 0}`,
      `Session recalls: ${checkpoint?.auto.recallCountSinceConsolidation ?? 0}`,
      `Last activity: ${checkpoint?.auto.lastActivityAt?.toISOString() ?? 'never'}`,
      `Checkpoint: ${checkpoint?.executionState ? checkpoint.executionState.currentTask : 'none'}`,
      ``,
      `Activity log: ${getLogPath() ?? 'not configured'}`,
      `Hook sidecar: 127.0.0.1:${HOOK_PORT}`,
    ];

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n'),
      }],
    };
  }
);

// --- Checkpointing Tools ---

server.tool(
  'memory_checkpoint',
  `Save your current execution state so you can recover after context compaction.

ALWAYS call this before:
- Long operations (multi-file generation, large refactors, overnight work)
- Anything that might fill the context window
- Switching to a different task

Also call periodically during long sessions to avoid losing state. The state is saved per-agent and overwrites any previous checkpoint.`,
  {
    current_task: z.string().describe('What you are currently working on'),
    decisions: z.array(z.string()).optional().default([])
      .describe('Key decisions made so far'),
    active_files: z.array(z.string()).optional().default([])
      .describe('Files you are currently working with'),
    next_steps: z.array(z.string()).optional().default([])
      .describe('What needs to happen next'),
    related_memory_ids: z.array(z.string()).optional().default([])
      .describe('IDs of memories relevant to current work'),
    notes: z.string().optional().default('')
      .describe('Any other context worth preserving'),
    episode_id: z.string().optional()
      .describe('Current episode ID if known'),
  },
  async (params) => {
    const state: ConsciousState = {
      currentTask: params.current_task,
      decisions: params.decisions,
      activeFiles: params.active_files,
      nextSteps: params.next_steps,
      relatedMemoryIds: params.related_memory_ids,
      notes: params.notes,
      episodeId: params.episode_id ?? null,
    };

    store.saveCheckpoint(AGENT_ID, state);
    log(AGENT_ID, 'checkpoint', `"${params.current_task}" decisions=${params.decisions.length} files=${params.active_files.length}`);

    return {
      content: [{
        type: 'text' as const,
        text: `Checkpoint saved: "${params.current_task}" (${params.decisions.length} decisions, ${params.active_files.length} files)`,
      }],
    };
  }
);

server.tool(
  'memory_restore',
  `Restore your previous execution state after context compaction or at session start.

Returns:
- Your saved execution state (task, decisions, next steps, files)
- Recently recalled memories for context
- Your last write for continuity
- How long you were idle

Use this at the start of every session or after compaction to pick up where you left off.`,
  {},
  async () => {
    const checkpoint = store.getCheckpoint(AGENT_ID);

    const now = Date.now();
    const idleMs = checkpoint
      ? now - checkpoint.auto.lastActivityAt.getTime()
      : 0;

    // Get last written engram
    let lastWrite: { id: string; concept: string; content: string } | null = null;
    if (checkpoint?.auto.lastWriteId) {
      const engram = store.getEngram(checkpoint.auto.lastWriteId);
      if (engram) {
        lastWrite = { id: engram.id, concept: engram.concept, content: engram.content };
      }
    }

    // Recall memories using last context
    let recalledMemories: Array<{ id: string; concept: string; content: string; score: number }> = [];
    const recallContext = checkpoint?.auto.lastRecallContext
      ?? checkpoint?.executionState?.currentTask
      ?? null;

    if (recallContext) {
      try {
        const results = await activationEngine.activate({
          agentId: AGENT_ID,
          context: recallContext,
          limit: 5,
          minScore: 0.05,
          useReranker: true,
          useExpansion: true,
          workspace: process.env.AWM_WORKSPACE ?? undefined,
        });
        recalledMemories = results.map(r => ({
          id: r.engram.id,
          concept: r.engram.concept,
          content: r.engram.content,
          score: r.score,
        }));
      } catch { /* recall failure is non-fatal */ }
    }

    // Consolidation on restore:
    // - If idle >5min but last consolidation was recent (graceful exit ran it), skip
    // - If idle >5min and no recent consolidation, run full cycle (non-graceful exit fallback)
    const MINI_IDLE_MS = 5 * 60_000;
    const FULL_CONSOLIDATION_GAP_MS = 10 * 60_000; // 10 min — if last consolidation was longer ago, run full
    let miniConsolidationTriggered = false;
    let fullConsolidationTriggered = false;

    if (idleMs > MINI_IDLE_MS) {
      const sinceLastConsolidation = checkpoint?.lastConsolidationAt
        ? now - checkpoint.lastConsolidationAt.getTime()
        : Infinity;

      if (sinceLastConsolidation > FULL_CONSOLIDATION_GAP_MS) {
        // No recent consolidation — graceful exit didn't happen, run full cycle
        fullConsolidationTriggered = true;
        try {
          const result = await consolidationEngine.consolidate(AGENT_ID);
          store.markConsolidation(AGENT_ID, false);
          log(AGENT_ID, 'consolidation', `full sleep cycle on restore (no graceful exit, idle ${Math.round(idleMs / 60_000)}min, last consolidation ${Math.round(sinceLastConsolidation / 60_000)}min ago) — ${result.edgesStrengthened} strengthened, ${result.memoriesForgotten} forgotten`);
        } catch { /* consolidation failure is non-fatal */ }
      } else {
        // Recent consolidation exists — graceful exit already handled it, just do mini
        miniConsolidationTriggered = true;
        consolidationScheduler.runMiniConsolidation(AGENT_ID).catch(() => {});
      }
    }

    // Format response
    const parts: string[] = [];
    const idleMin = Math.round(idleMs / 60_000);
    const consolidationNote = fullConsolidationTriggered
      ? ' (full consolidation — no graceful exit detected)'
      : miniConsolidationTriggered
        ? ' (mini-consolidation triggered)'
        : '';
    log(AGENT_ID, 'restore', `idle=${idleMin}min checkpoint=${!!checkpoint?.executionState} recalled=${recalledMemories.length} lastWrite=${lastWrite?.concept ?? 'none'}${fullConsolidationTriggered ? ' FULL_CONSOLIDATION' : ''}`);
    parts.push(`Idle: ${idleMin}min${consolidationNote}`);

    if (checkpoint?.executionState) {
      const s = checkpoint.executionState;
      parts.push(`\n**Current task:** ${s.currentTask}`);
      if (s.decisions.length) parts.push(`**Decisions:** ${s.decisions.join('; ')}`);
      if (s.nextSteps.length) parts.push(`**Next steps:** ${s.nextSteps.map((st, i) => `${i + 1}. ${st}`).join(', ')}`);
      if (s.activeFiles.length) parts.push(`**Active files:** ${s.activeFiles.join(', ')}`);
      if (s.notes) parts.push(`**Notes:** ${s.notes}`);
      if (checkpoint.checkpointAt) parts.push(`_Saved at: ${checkpoint.checkpointAt.toISOString()}_`);
    } else {
      parts.push('\nNo explicit checkpoint saved.');
      parts.push('\n**Tip:** Use memory_write to save important learnings, and memory_checkpoint before long operations so you can recover state.');
    }

    if (lastWrite) {
      parts.push(`\n**Last write:** ${lastWrite.concept}\n${lastWrite.content}`);
    }

    if (recalledMemories.length > 0) {
      parts.push(`\n**Recalled memories (${recalledMemories.length}):**`);
      for (const m of recalledMemories) {
        parts.push(`- **${m.concept}** (${m.score.toFixed(3)}): ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`);
      }
    }

    // Peer decisions: show recent decisions from other agents (last 30 min)
    if (coordDb) {
      try {
        const myAgent = coordDb.prepare(
          `SELECT id FROM coord_agents WHERE name = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
        ).get(AGENT_ID) as { id: string } | undefined;

        const peerDecisions = coordDb.prepare(
          `SELECT d.summary, a.name AS author_name, d.created_at
           FROM coord_decisions d JOIN coord_agents a ON d.author_id = a.id
           WHERE d.author_id != ? AND d.created_at > datetime('now', '-30 minutes')
           ORDER BY d.created_at DESC LIMIT 10`
        ).all(myAgent?.id ?? '') as Array<{ summary: string; author_name: string; created_at: string }>;

        if (peerDecisions.length > 0) {
          parts.push(`\n**Peer decisions (last 30 min):**`);
          for (const d of peerDecisions) {
            parts.push(`- [${d.author_name}] ${d.summary} (${d.created_at})`);
          }
        }
      } catch { /* peer decisions are non-fatal */ }
    }

    return {
      content: [{
        type: 'text' as const,
        text: parts.join('\n'),
      }],
    };
  }
);

// --- Task Management Tools ---

server.tool(
  'memory_task_add',
  `Create a task that you need to come back to. Tasks are memories with status and priority tracking.

Use this when:
- You identify work that needs doing but can't do it right now
- The user mentions something to do later
- You want to park a sub-task while focusing on something more urgent

Tasks automatically get high salience so they won't be discarded.`,
  {
    concept: z.string().describe('Short task title (3-10 words)'),
    content: z.string().describe('Full task description — what needs doing, context, acceptance criteria'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium')
      .describe('Task priority: urgent (do now), high (do soon), medium (normal), low (backlog)'),
    blocked_by: z.string().optional().describe('ID of a task that must finish first'),
  },
  async (params) => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: params.concept,
      content: params.content,
      tags: [...(params.tags ?? []), 'task'],
      salience: 0.9, // Tasks always high salience
      confidence: 0.8,
      salienceFeatures: {
        surprise: 0.5,
        decisionMade: true,
        causalDepth: 0.5,
        resolutionEffort: 0.5,
        eventType: 'decision',
      },
      reasonCodes: ['task-created'],
      taskStatus: params.blocked_by ? 'blocked' : 'open',
      taskPriority: params.priority as TaskPriority,
      blockedBy: params.blocked_by,
    });

    connectionEngine.enqueue(engram.id);

    // Generate embedding asynchronously
    embed(`${params.concept} ${params.content}`).then(vec => {
      store.updateEmbedding(engram.id, vec);
    }).catch(() => {});

    return {
      content: [{
        type: 'text' as const,
        text: `Task created: "${params.concept}" (${params.priority})`,
      }],
    };
  }
);

server.tool(
  'memory_task_update',
  `Update a task's status or priority. Use this to:
- Start working on a task (open → in_progress)
- Mark a task done (→ done)
- Block a task on another (→ blocked)
- Reprioritize (change priority)
- Unblock a task (clear blocked_by)`,
  {
    task_id: z.string().describe('ID of the task to update'),
    status: z.enum(['open', 'in_progress', 'blocked', 'done']).optional()
      .describe('New status'),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional()
      .describe('New priority'),
    blocked_by: z.string().optional().describe('ID of blocking task (set to empty string to unblock)'),
  },
  async (params) => {
    const engram = store.getEngram(params.task_id);
    if (!engram || !engram.taskStatus) {
      return { content: [{ type: 'text' as const, text: `Task not found: ${params.task_id}` }] };
    }

    if (params.blocked_by !== undefined) {
      store.updateBlockedBy(params.task_id, params.blocked_by || null);
    }
    if (params.status) {
      store.updateTaskStatus(params.task_id, params.status as TaskStatus);
    }
    if (params.priority) {
      store.updateTaskPriority(params.task_id, params.priority as TaskPriority);
    }

    const updated = store.getEngram(params.task_id)!;
    return {
      content: [{
        type: 'text' as const,
        text: `Updated: "${updated.concept}" → ${updated.taskStatus} (${updated.taskPriority})`,
      }],
    };
  }
);

server.tool(
  'memory_task_list',
  `List tasks with optional status filter. Shows tasks ordered by priority (urgent first).

Use at the start of a session to see what's pending, or to check blocked/done tasks.`,
  {
    status: z.enum(['open', 'in_progress', 'blocked', 'done']).optional()
      .describe('Filter by status (omit to see all active tasks)'),
    include_done: z.boolean().optional().default(false)
      .describe('Include completed tasks?'),
  },
  async (params) => {
    let tasks = store.getTasks(AGENT_ID, params.status as TaskStatus | undefined);
    if (!params.include_done && !params.status) {
      tasks = tasks.filter(t => t.taskStatus !== 'done');
    }

    if (tasks.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
    }

    const lines = tasks.map((t, i) => {
      const blocked = t.blockedBy ? ` [blocked by ${t.blockedBy}]` : '';
      const tags = t.tags?.filter(tag => tag !== 'task').join(', ');
      return `${i + 1}. [${t.taskStatus}] **${t.concept}** (${t.taskPriority})${blocked}\n   ${t.content.slice(0, 120)}${t.content.length > 120 ? '...' : ''}\n   ${tags ? `Tags: ${tags} | ` : ''}ID: ${t.id}`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Tasks (${tasks.length}):\n\n${lines.join('\n\n')}`,
      }],
    };
  }
);

server.tool(
  'memory_task_next',
  `Get the single most important task to work on next.

Prioritizes: in_progress tasks first (finish what you started), then by priority level, then oldest first. Skips blocked and done tasks.

Use this when you finish a task or need to decide what to do next.`,
  {},
  async () => {
    const next = store.getNextTask(AGENT_ID);
    if (!next) {
      return { content: [{ type: 'text' as const, text: 'No actionable tasks. All clear!' }] };
    }

    const blocked = next.blockedBy ? `\nBlocked by: ${next.blockedBy}` : '';
    const tags = next.tags?.filter(tag => tag !== 'task').join(', ');

    return {
      content: [{
        type: 'text' as const,
        text: `Next task:\n**${next.concept}** (${next.taskPriority})\nStatus: ${next.taskStatus}\n${next.content}${blocked}\n${tags ? `Tags: ${tags}\n` : ''}ID: ${next.id}`,
      }],
    };
  }
);

// --- Task Bracket Tools ---

server.tool(
  'memory_task_begin',
  `Signal that you're starting a significant task. Auto-checkpoints current state and recalls relevant memories.

CALL THIS when starting:
- A multi-step operation (doc generation, large refactor, migration)
- Work on a new topic or project area
- Anything that might fill the context window

This ensures your state is saved before you start, and primes recall with relevant context.`,
  {
    topic: z.string().describe('What task are you starting? (3-15 words)'),
    files: z.array(z.string()).optional().default([])
      .describe('Files you expect to work with'),
    notes: z.string().optional().default('')
      .describe('Any additional context'),
  },
  async (params) => {
    // 1. Checkpoint current state
    const checkpoint = store.getCheckpoint(AGENT_ID);
    const prevTask = checkpoint?.executionState?.currentTask ?? 'None';

    store.saveCheckpoint(AGENT_ID, {
      currentTask: params.topic,
      decisions: [],
      activeFiles: params.files,
      nextSteps: [],
      relatedMemoryIds: [],
      notes: params.notes || `Started via memory_task_begin. Previous task: ${prevTask}`,
      episodeId: null,
    });

    // 2. Auto-recall relevant memories
    let recalledSummary = '';
    try {
      const results = await activationEngine.activate({
        agentId: AGENT_ID,
        context: params.topic,
        limit: 5,
        minScore: 0.05,
        useReranker: true,
        useExpansion: true,
        workspace: process.env.AWM_WORKSPACE ?? undefined,
      });

      if (results.length > 0) {
        const lines = results.map((r, i) => {
          const tags = r.engram.tags?.length ? ` [${r.engram.tags.join(', ')}]` : '';
          return `${i + 1}. **${r.engram.concept}** (${r.score.toFixed(3)})${tags}\n   ${r.engram.content.slice(0, 150)}${r.engram.content.length > 150 ? '...' : ''}`;
        });
        recalledSummary = `\n\n**Recalled memories (${results.length}):**\n${lines.join('\n')}`;

        // Track recall
        store.updateAutoCheckpointRecall(AGENT_ID, params.topic, results.map(r => r.engram.id));
      }
    } catch { /* recall failure is non-fatal */ }

    log(AGENT_ID, 'task:begin', `"${params.topic}" prev="${prevTask}"`);

    return {
      content: [{
        type: 'text' as const,
        text: `Started: "${params.topic}" (prev: ${prevTask})${recalledSummary}`,
      }],
    };
  }
);

server.tool(
  'memory_task_end',
  `Signal that you've finished a significant task. Writes a summary memory and auto-checkpoints.

CALL THIS when you finish:
- A multi-step operation
- Before switching to a different topic
- At the end of a work session

This captures what was accomplished so future sessions can recall it.`,
  {
    summary: z.string().describe('What was accomplished? Include key outcomes, decisions, and any issues.'),
    tags: z.array(z.string()).optional().default([])
      .describe('Tags for the summary memory'),
    supersedes: z.array(z.string()).optional().default([])
      .describe('IDs of older memories this task summary replaces (marks them as superseded)'),
  },
  async (params) => {
    // 1. Write summary as a memory
    const salience = evaluateSalience({
      content: params.summary,
      eventType: 'decision',
      surprise: 0.3,
      decisionMade: true,
      causalDepth: 0.5,
      resolutionEffort: 0.5,
    });

    // Determine the real task name for the summary engram
    const checkpoint = store.getCheckpoint(AGENT_ID);
    const rawTask = checkpoint?.executionState?.currentTask ?? 'Unknown task';
    // Strip any "Completed: " prefixes to avoid cascading
    const cleanedTask = rawTask.replace(/^(Completed: )+/, '');
    // Don't use auto-checkpoint or already-completed tasks as real task names
    const isNamedTask = !cleanedTask.startsWith('Auto-checkpoint') && cleanedTask !== 'Unknown task';
    const completedTask = isNamedTask
      ? cleanedTask
      : params.summary.slice(0, 60).replace(/\n/g, ' ');

    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: completedTask.slice(0, 80),
      content: params.summary,
      tags: [...params.tags, 'task-summary'],
      salience: isNamedTask ? Math.max(salience.score, 0.7) : salience.score, // Only floor salience for named tasks
      confidence: 0.65, // Task summaries are decision-grade (completed work)
      salienceFeatures: salience.features,
      reasonCodes: [...salience.reasonCodes, 'task-end'],
    });

    connectionEngine.enqueue(engram.id);

    // 2. Handle supersessions — mark old memories as outdated
    let supersededCount = 0;
    for (const oldId of params.supersedes) {
      const oldEngram = store.getEngram(oldId);
      if (oldEngram) {
        store.supersedeEngram(oldId, engram.id);
        store.upsertAssociation(engram.id, oldId, 0.8, 'causal', 0.9);
        store.updateConfidence(oldId, Math.max(0.2, oldEngram.confidence * 0.4));
        supersededCount++;
      }
    }

    // Generate embedding asynchronously
    embed(`Task completed: ${params.summary}`).then(vec => {
      store.updateEmbedding(engram.id, vec);
    }).catch(() => {});

    // 2. Update checkpoint to reflect completion
    store.saveCheckpoint(AGENT_ID, {
      currentTask: `Completed: ${completedTask}`,
      decisions: checkpoint?.executionState?.decisions ?? [],
      activeFiles: [],
      nextSteps: [],
      relatedMemoryIds: [engram.id],
      notes: `Task completed. Summary memory: ${engram.id}`,
      episodeId: null,
    });

    store.updateAutoCheckpointWrite(AGENT_ID, engram.id);
    log(AGENT_ID, 'task:end', `"${completedTask}" summary=${engram.id} salience=${salience.score.toFixed(2)} superseded=${supersededCount}`);

    const supersededNote = supersededCount > 0 ? ` (${supersededCount} old memories superseded)` : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Completed: "${completedTask}" [${salience.score.toFixed(2)}]${supersededNote}`,
      }],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start hook sidecar (lightweight HTTP for Claude Code hooks)
  const sidecar = startSidecar({
    store,
    agentId: AGENT_ID,
    secret: HOOK_SECRET,
    port: HOOK_PORT,
    onConsolidate: async (agentId, reason) => {
      console.error(`[mcp] consolidation triggered: ${reason}`);
      const result = await consolidationEngine.consolidate(agentId);
      store.markConsolidation(agentId, false);
      console.error(`[mcp] consolidation done: ${result.edgesStrengthened} strengthened, ${result.memoriesForgotten} forgotten`);
    },
  });

  // Coordination MCP tools (opt-in via AWM_COORDINATION=true)
  const coordEnabled = process.env.AWM_COORDINATION === 'true' || process.env.AWM_COORDINATION === '1';
  if (coordEnabled) {
    const { initCoordinationTables } = await import('./coordination/schema.js');
    const { registerCoordinationTools } = await import('./coordination/mcp-tools.js');
    initCoordinationTables(store.getDb());
    registerCoordinationTools(server, store.getDb());
    coordDb = store.getDb();
  } else {
    console.error('AWM: coordination tools disabled (set AWM_COORDINATION=true to enable)');
  }

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`AgentWorkingMemory MCP server started (agent: ${AGENT_ID}, db: ${DB_PATH})`);
  console.error(`Hook sidecar on 127.0.0.1:${HOOK_PORT}${HOOK_SECRET ? ' (auth enabled)' : ' (no auth — set AWM_HOOK_SECRET)'}`);

  // Clean shutdown
  const cleanup = () => {
    sidecar.close();
    consolidationScheduler.stop();
    stagingBuffer.stop();
    try { store.walCheckpoint(); } catch { /* non-fatal */ }
    store.close();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

main().catch(err => {
  console.error('MCP server failed:', err);
  process.exit(1);
});

} // end else (non-incognito)
