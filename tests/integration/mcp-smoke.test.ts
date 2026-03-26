/**
 * MCP Smoke Test — exercises all 11 MCP tool code paths.
 *
 * Tests the same store/engine layer that MCP tools call,
 * verifying the full tool surface works end-to-end.
 *
 * Tools covered:
 *   1. memory_write       — salience filter + create engram
 *   2. memory_recall      — activation pipeline retrieval
 *   3. memory_feedback    — confidence adjustment
 *   4. memory_retract     — retraction + correction
 *   5. memory_stats       — eval metrics computation
 *   6. memory_checkpoint  — save execution state
 *   7. memory_restore     — restore state + recall
 *   8. memory_task_add    — task creation
 *   9. memory_task_update — task status change
 *  10. memory_task_list   — task listing
 *  11. memory_task_next   — next actionable task
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { EvictionEngine } from '../../src/engine/eviction.js';
import { RetractionEngine } from '../../src/engine/retraction.js';
import { EvalEngine } from '../../src/engine/eval.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';
import { ConsolidationScheduler } from '../../src/engine/consolidation-scheduler.js';
import { evaluateSalience } from '../../src/core/salience.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/types/agent.js';
import type { ConsciousState } from '../../src/types/checkpoint.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `awm-mcp-smoke-${Date.now()}.db`);
const AGENT_ID = 'mcp-smoke-agent';

let store: EngramStore;
let activation: ActivationEngine;
let connections: ConnectionEngine;
let eviction: EvictionEngine;
let retraction: RetractionEngine;
let evalEngine: EvalEngine;
let consolidationEngine: ConsolidationEngine;
let consolidationScheduler: ConsolidationScheduler;

beforeEach(() => {
  try { unlinkSync(TEST_DB); } catch {}
  store = new EngramStore(TEST_DB);
  activation = new ActivationEngine(store);
  connections = new ConnectionEngine(store, activation);
  eviction = new EvictionEngine(store);
  retraction = new RetractionEngine(store);
  evalEngine = new EvalEngine(store);
  consolidationEngine = new ConsolidationEngine(store);
  consolidationScheduler = new ConsolidationScheduler(store, consolidationEngine);
});

afterEach(() => {
  consolidationScheduler.stop();
  store.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe('MCP smoke tests — all 11 tools', () => {

  // Tool 1: memory_write
  it('memory_write: salience filter routes correctly', () => {
    // High-value write → active
    const salience = evaluateSalience({
      content: 'Critical database migration pattern discovered',
      eventType: 'causal',
      surprise: 0.8,
      causalDepth: 0.7,
      resolutionEffort: 0.6,
    });
    expect(salience.disposition).toBe('active');

    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'DB migration pattern',
      content: 'Critical database migration pattern discovered',
      tags: ['database', 'migration'],
      salience: salience.score,
      salienceFeatures: salience.features,
      reasonCodes: salience.reasonCodes,
    });
    expect(engram.id).toBeDefined();
    expect(engram.stage).toBe('active');

    // Low-value duplicate write → discard
    const low = evaluateSalience({
      content: 'noted',
      eventType: 'observation',
      novelty: 0.1, // duplicate
    });
    expect(low.disposition).toBe('discard');
  });

  // Tool 1 (cont): staging gets TTL
  it('memory_write: staging engrams receive TTL', () => {
    const salience = evaluateSalience({
      content: 'Saw some logs about retry behavior',
      eventType: 'observation',
      surprise: 0.3,
      causalDepth: 0.2,
      resolutionEffort: 0.2,
    });

    if (salience.disposition === 'staging') {
      const engram = store.createEngram({
        agentId: AGENT_ID,
        concept: 'Retry logs observed',
        content: 'Saw some logs about retry behavior',
        salience: salience.score,
        ttl: DEFAULT_AGENT_CONFIG.stagingTtlMs,
      });
      store.updateStage(engram.id, 'staging');

      const fetched = store.getEngram(engram.id)!;
      expect(fetched.stage).toBe('staging');
      expect(fetched.ttl).toBe(DEFAULT_AGENT_CONFIG.stagingTtlMs);
    }
  });

  // Tool 2: memory_recall
  it('memory_recall: retrieves relevant memories', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'React hooks pattern',
      content: 'useEffect cleanup prevents memory leaks in React components',
      tags: ['react', 'hooks'],
      salience: 0.7,
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Pizza dough recipe',
      content: 'Mix flour water yeast and salt for pizza dough',
      tags: ['cooking'],
      salience: 0.4,
    });

    const results = await activation.activate({
      agentId: AGENT_ID,
      context: 'React useEffect cleanup memory leak',
      limit: 5,
      minScore: 0.05,
      useReranker: false,
      useExpansion: false,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].engram.concept).toBe('React hooks pattern');
  });

  // Tool 2 (cont): auto-checkpoint on recall
  it('memory_recall: updates auto-checkpoint', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'checkpoint test',
      content: 'unique keyword zorblax for checkpoint testing',
      salience: 0.6,
    });

    await activation.activate({
      agentId: AGENT_ID,
      context: 'zorblax',
      useReranker: false,
      useExpansion: false,
    });

    // Simulate what MCP handler does
    store.updateAutoCheckpointRecall(AGENT_ID, 'zorblax', []);

    const checkpoint = store.getCheckpoint(AGENT_ID);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.auto.lastRecallContext).toBe('zorblax');
    expect(checkpoint!.auto.recallCountSinceConsolidation).toBe(1);
  });

  // Tool 3: memory_feedback
  it('memory_feedback: adjusts confidence', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'feedback test',
      content: 'test content for feedback',
      salience: 0.5,
      confidence: 0.5,
    });

    // Positive feedback
    store.logRetrievalFeedback(null, engram.id, true, 'helpful');
    store.updateConfidence(engram.id, 0.5 + DEFAULT_AGENT_CONFIG.feedbackPositiveBoost);

    const after = store.getEngram(engram.id)!;
    expect(after.confidence).toBeGreaterThan(0.5);

    // Negative feedback
    store.logRetrievalFeedback(null, engram.id, false, 'not relevant');
    store.updateConfidence(engram.id, after.confidence - DEFAULT_AGENT_CONFIG.feedbackNegativePenalty);

    const afterNeg = store.getEngram(engram.id)!;
    expect(afterNeg.confidence).toBeLessThan(after.confidence);
  });

  // Tool 3 (cont): MCP feedback counted in precision
  it('memory_feedback: MCP null-event feedback counted in precision', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'precision test',
      content: 'test content',
      salience: 0.5,
    });

    // MCP writes feedback with null activation_event_id
    store.logRetrievalFeedback(null, engram.id, true, 'useful');
    store.logRetrievalFeedback(null, engram.id, false, 'not useful');

    const precision = store.getRetrievalPrecision(AGENT_ID, 24);
    expect(precision).toBe(0.5); // 1 useful out of 2
  });

  // Tool 4: memory_retract
  it('memory_retract: retracts and creates correction', () => {
    const wrong = store.createEngram({
      agentId: AGENT_ID,
      concept: 'wrong fact',
      content: 'The sky is green',
      salience: 0.5,
      confidence: 0.7,
    });

    const result = retraction.retract({
      agentId: AGENT_ID,
      targetEngramId: wrong.id,
      reason: 'Incorrect color',
      counterContent: 'The sky is blue',
    });

    expect(result.retractedId).toBe(wrong.id);
    expect(result.correctionId).toBeDefined();

    const retracted = store.getEngram(wrong.id)!;
    expect(retracted.retracted).toBe(true);
  });

  // Tool 5: memory_stats
  it('memory_stats: computes metrics', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'stats test',
      content: 'content for stats verification',
      salience: 0.6,
    });

    const metrics = evalEngine.computeMetrics(AGENT_ID);
    expect(metrics.agentId).toBe(AGENT_ID);
    expect(metrics.activeEngramCount).toBe(1);
    expect(metrics.avgConfidence).toBeGreaterThan(0);
  });

  // Tool 6: memory_checkpoint
  it('memory_checkpoint: saves execution state', () => {
    const state: ConsciousState = {
      currentTask: 'Implement auth middleware',
      decisions: ['Use bearer tokens', 'Keep /health public'],
      activeFiles: ['src/index.ts', 'src/api/routes.ts'],
      nextSteps: ['Add x-api-key support', 'Write tests'],
      relatedMemoryIds: [],
      notes: 'Auth is optional via AWM_API_KEY env var',
      episodeId: null,
    };

    store.saveCheckpoint(AGENT_ID, state);

    const checkpoint = store.getCheckpoint(AGENT_ID);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.executionState).toEqual(state);
    expect(checkpoint!.checkpointAt).toBeInstanceOf(Date);
  });

  // Tool 7: memory_restore
  it('memory_restore: restores state and recalls memories', async () => {
    // Write a memory
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Auth implementation',
      content: 'Bearer token auth checks AWM_API_KEY environment variable',
      tags: ['auth'],
      salience: 0.8,
    });

    // Auto-checkpoint from write
    store.updateAutoCheckpointWrite(AGENT_ID, engram.id);

    // Save explicit checkpoint
    store.saveCheckpoint(AGENT_ID, {
      currentTask: 'Add auth',
      decisions: ['Bearer tokens'],
      activeFiles: ['src/index.ts'],
      nextSteps: ['Test auth'],
      relatedMemoryIds: [engram.id],
      notes: '',
      episodeId: null,
    });

    // Restore
    const checkpoint = store.getCheckpoint(AGENT_ID);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.executionState!.currentTask).toBe('Add auth');
    expect(checkpoint!.auto.lastWriteId).toBe(engram.id);

    // Last write should be retrievable
    const lastWrite = store.getEngram(checkpoint!.auto.lastWriteId!);
    expect(lastWrite).not.toBeNull();
    expect(lastWrite!.concept).toBe('Auth implementation');
  });

  // Tool 8: memory_task_add
  it('memory_task_add: creates prioritized task', () => {
    const task = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Fix login bug',
      content: 'Users report 500 error on login when email has + character',
      tags: ['task', 'bug'],
      salience: 0.9,
      confidence: 0.8,
      taskStatus: 'open',
      taskPriority: 'high',
    });

    expect(task.taskStatus).toBe('open');
    expect(task.taskPriority).toBe('high');
    expect(task.tags).toContain('task');
  });

  // Tool 9: memory_task_update
  it('memory_task_update: changes status and priority', () => {
    const task = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Update tests',
      content: 'Add MCP smoke tests',
      tags: ['task'],
      salience: 0.9,
      confidence: 0.8,
      taskStatus: 'open',
      taskPriority: 'medium',
    });

    store.updateTaskStatus(task.id, 'in_progress');
    store.updateTaskPriority(task.id, 'high');

    const updated = store.getEngram(task.id)!;
    expect(updated.taskStatus).toBe('in_progress');
    expect(updated.taskPriority).toBe('high');

    // Block on another task
    store.updateBlockedBy(task.id, 'some-other-task-id');
    const blocked = store.getEngram(task.id)!;
    expect(blocked.taskStatus).toBe('blocked');
    expect(blocked.blockedBy).toBe('some-other-task-id');

    // Unblock
    store.updateBlockedBy(task.id, null);
    const unblocked = store.getEngram(task.id)!;
    expect(unblocked.taskStatus).toBe('open');
    expect(unblocked.blockedBy).toBeNull();
  });

  // Tool 10: memory_task_list
  it('memory_task_list: lists and filters tasks', () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Task A',
      content: 'First task',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'open',
      taskPriority: 'high',
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Task B',
      content: 'Second task',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'done',
      taskPriority: 'low',
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Task C',
      content: 'Third task',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'in_progress',
      taskPriority: 'urgent',
    });

    // All tasks
    const all = store.getTasks(AGENT_ID);
    expect(all.length).toBe(3);

    // Filter by status
    const open = store.getTasks(AGENT_ID, 'open');
    expect(open.length).toBe(1);
    expect(open[0].concept).toBe('Task A');

    const done = store.getTasks(AGENT_ID, 'done');
    expect(done.length).toBe(1);

    // Priority ordering: urgent first
    expect(all[0].taskPriority).toBe('urgent');
  });

  // Tool 11: memory_task_next
  it('memory_task_next: returns highest-priority actionable task', () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Low priority task',
      content: 'Not urgent',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'open',
      taskPriority: 'low',
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Urgent task',
      content: 'Do this first',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'open',
      taskPriority: 'urgent',
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Blocked task',
      content: 'Cannot do yet',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'blocked',
      taskPriority: 'urgent',
    });

    const next = store.getNextTask(AGENT_ID);
    expect(next).not.toBeNull();
    expect(next!.concept).toBe('Urgent task');

    // In-progress takes priority over open
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'Already started',
      content: 'In progress task',
      tags: ['task'],
      salience: 0.9,
      taskStatus: 'in_progress',
      taskPriority: 'low',
    });

    const next2 = store.getNextTask(AGENT_ID);
    expect(next2).not.toBeNull();
    expect(next2!.concept).toBe('Already started');
  });

  // Internal retrieval doesn't distort stats
  it('internal activate skips access count and event logging', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'internal test',
      content: 'unique keyword qwfpgj for internal test',
      salience: 0.6,
    });

    // Internal call
    await activation.activate({
      agentId: AGENT_ID,
      context: 'qwfpgj',
      useReranker: false,
      useExpansion: false,
      internal: true,
    });

    const engrams = store.getEngramsByAgent(AGENT_ID);
    expect(engrams[0].accessCount).toBe(0); // Not touched

    const stats = store.getActivationStats(AGENT_ID, 24);
    expect(stats.count).toBe(0); // Not logged

    // User call should touch and log
    await activation.activate({
      agentId: AGENT_ID,
      context: 'qwfpgj',
      useReranker: false,
      useExpansion: false,
    });

    const engramsAfter = store.getEngramsByAgent(AGENT_ID);
    expect(engramsAfter[0].accessCount).toBe(1);

    const statsAfter = store.getActivationStats(AGENT_ID, 24);
    expect(statsAfter.count).toBe(1);
  });

  // Consolidation scheduler lifecycle
  it('consolidation scheduler starts and stops cleanly', () => {
    consolidationScheduler.start();
    // Starting again is idempotent
    consolidationScheduler.start();
    consolidationScheduler.stop();
    consolidationScheduler.stop(); // Double stop is safe
  });

  // Consolidation markConsolidation resets counters
  it('markConsolidation resets write/recall counters', () => {
    store.updateAutoCheckpointWrite(AGENT_ID, 'fake-id-1');
    store.updateAutoCheckpointWrite(AGENT_ID, 'fake-id-2');
    store.updateAutoCheckpointRecall(AGENT_ID, 'test', ['a']);

    let cp = store.getCheckpoint(AGENT_ID)!;
    expect(cp.auto.writeCountSinceConsolidation).toBe(2);
    expect(cp.auto.recallCountSinceConsolidation).toBe(1);

    store.markConsolidation(AGENT_ID, false); // full consolidation

    cp = store.getCheckpoint(AGENT_ID)!;
    expect(cp.auto.writeCountSinceConsolidation).toBe(0);
    expect(cp.auto.recallCountSinceConsolidation).toBe(0);
    expect(cp.lastConsolidationAt).toBeInstanceOf(Date);
  });

  // Active agents listing
  it('getActiveAgents returns agents with activity', () => {
    store.updateAutoCheckpointWrite(AGENT_ID, 'fake-id');
    store.updateAutoCheckpointWrite('other-agent', 'fake-id-2');

    const agents = store.getActiveAgents();
    expect(agents.length).toBe(2);
    expect(agents.map(a => a.agentId).sort()).toEqual([AGENT_ID, 'other-agent'].sort());
  });
});
