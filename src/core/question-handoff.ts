// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * The question hand-off (0.22, plan §4.12): AWM never calls a hosted model, but a connected host
 * that has one — Claude Code, MWA, any agent runtime — can do AWM's model work with it. A host
 * declares `capabilities: ["questions"]` on memory_restore; from then on, restore and task-end
 * replies carry a small job: a few of the agent's memories that have no questions yet, and how to
 * write them. The host answers through memory_set_questions; the same normalisation and redaction
 * apply as to questions written with a memory.
 *
 * Why it exists: questions in the keyword index lift natural-language recall (+4.6 points end to
 * end, identifier and topic unchanged — docs/abstention-signals-2026-10-30.md §11), but only for
 * memories that have them, and a store written before 0.22 has none.
 */

import type { Engram } from '../types/engram.js';

export const QUESTION_JOB_ID = 'questions@1';
/** Memories per job: small enough to do in one focused pass without crowding the session. */
export const QUESTION_JOB_SIZE = 5;
const SNIPPET = 400;

export function renderQuestionJob(memories: Engram[], coverage: { withQuestions: number; total: number }): string {
  if (memories.length === 0) return '';
  const pct = coverage.total ? Math.round((100 * coverage.withQuestions) / coverage.total) : 0;
  const items = memories.map((m) => {
    const body = m.content.replace(/\s+/g, ' ').trim();
    return `- id: ${m.id}\n  title: ${m.concept}\n  text: ${body.length > SNIPPET ? `${body.slice(0, SNIPPET)}…` : body}`;
  }).join('\n');
  return `\n\n--- Question job (${QUESTION_JOB_ID}) — you declared the "questions" capability ---
${pct}% of your memories (${coverage.withQuestions} of ${coverage.total}) have questions. Questions are how a memory is found when someone asks in their own words.
As a SEPARATE short pass, write 2-5 questions for each memory below: the way a colleague would ask later without remembering its wording, file names or IDs. Vary them — what happened or was decided, why, and a practical "how do I / where is" when the memory supports one. Then call memory_set_questions once with all of them: { items: [{ id, questions: [...] }, ...] }.
${items}`;
}
