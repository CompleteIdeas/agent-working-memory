// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Write-time redaction at the storage boundary (S1).
 *
 * The write pipeline redacts up front so embeddings are built from masked text and the
 * caller is told what was masked. This wrapper is the guarantee underneath it: every store
 * method that persists free text — whichever surface, tool or engine called it — passes its
 * text through `redactText` first. Paths that bypass the pipeline (the HTTP batch write,
 * tasks, consolidation summaries, retraction notes, recall-query logs, checkpoints) are
 * covered without each having to remember.
 *
 * Wrapping in `openStore()` covers SQLite, PGlite and Postgres alike. Redaction is
 * idempotent, so text the pipeline already masked passes through unchanged.
 */

import type { IEngramStore } from './store.js';
import { redactText } from '../core/redact.js';
import type { ConsciousState } from '../types/checkpoint.js';

const r = (s: string): string => redactText(s).text;
const rList = (xs: string[] | undefined): string[] | undefined => xs?.map((x) => (typeof x === 'string' ? r(x) : x));
// Memory text is sealed (kept in the vault behind a handle); logs and checkpoints only mask.
const seal = (s: string): string => redactText(s, { seal: true }).text;
const sealList = (xs: string[] | undefined): string[] | undefined => xs?.map((x) => (typeof x === 'string' ? seal(x) : x));

function redactState(state: ConsciousState): ConsciousState {
  if (!state) return state;
  return {
    ...state,
    currentTask: typeof state.currentTask === 'string' ? r(state.currentTask) : state.currentTask,
    notes: typeof state.notes === 'string' ? r(state.notes) : state.notes,
    decisions: rList(state.decisions) ?? state.decisions,
    nextSteps: rList(state.nextSteps) ?? state.nextSteps,
    activeFiles: rList(state.activeFiles) ?? state.activeFiles,
  };
}

/**
 * Argument rewriters keyed by method name. Each receives the original arguments and
 * returns the arguments to forward.
 */
const REWRITE: Record<string, (args: any[]) => any[]> = {
  createEngram: ([input, ...rest]) => [
    input ? { ...input, concept: seal(input.concept ?? ''), content: seal(input.content ?? ''), tags: sealList(input.tags),
      ...(input.questions ? { questions: sealList(input.questions) } : {}) } : input,
    ...rest,
  ],
  // Questions are agent-written text, searchable like content: same redaction.
  setQuestions: ([id, questions, ...rest]) => [id, sealList(questions) ?? questions, ...rest],
  updateContent: ([id, content, ...rest]) => [id, typeof content === 'string' ? seal(content) : content, ...rest],
  updateTags: ([id, tags, ...rest]) => [id, sealList(tags) ?? tags, ...rest],
  saveCheckpoint: ([agentId, state, ...rest]) => [agentId, redactState(state), ...rest],
  saveSessionCheckpoint: ([agentId, sessionId, state, ...rest]) => [agentId, sessionId, redactState(state), ...rest],
  logActivationEvent: ([event, ...rest]) => [event ? { ...event, context: r(event.context ?? '') } : event, ...rest],
  logRetrievalFeedback: ([aid, eid, useful, context, ...rest]) => [aid, eid, useful, typeof context === 'string' ? r(context) : context, ...rest],
  updateAutoCheckpointRecall: ([agentId, context, ...rest]) => [agentId, typeof context === 'string' ? r(context) : context, ...rest],
  createEpisode: ([input, ...rest]) => [input ? { ...input, label: r(input.label ?? '') } : input, ...rest],
};

/** The method names this wrapper rewrites — exported for the coverage test. */
export const REDACTED_METHODS = Object.keys(REWRITE);

/** Stores already wrapped, so wrapping twice is a no-op (callers such as attachQuestions wrap defensively). */
const wrapped = new WeakSet<object>();

/** Whether this store is already the redacting wrapper. */
export function isRedacting(store: object): boolean {
  return wrapped.has(store);
}

export function withRedaction<T extends IEngramStore>(store: T): T {
  if (wrapped.has(store as object)) return store;
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const rewrite = REWRITE[prop];
      if (!rewrite) return value.bind(target);
      return (...args: any[]) => value.apply(target, rewrite(args));
    },
  });
  wrapped.add(proxy as object);
  return proxy;
}
