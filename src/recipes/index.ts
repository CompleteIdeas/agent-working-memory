// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Cognition Recipes — the intelligence interface (D14, 2026-07-30).
 *
 * AWM is a memory space for an LLM, not containing an LLM. Anything that
 * requires real thinking (distilling a procedure, reflecting on a failure)
 * runs HOST-SIDE: AWM ships a versioned recipe — a prompt plus a strict
 * output contract — the host agent executes it as a SEPARATE focused call,
 * and writes the result back as an ordinary memory carrying provenance
 * (origin_class='recipe', recipe_id). AWM validates the write-back shape.
 *
 * Ported from memory-working-agent (MWA #14, live since 2026-06-15), whose
 * production lessons are baked in:
 *  - SEPARATE focused call: cheap models reliably omit a "skill" field when
 *    it is bundled with other questions. One recipe = one call.
 *  - Host-side gating: only the host knows whether a task was procedural
 *    (tool calls, dispatches). The invitation states the gate; the host
 *    decides.
 *  - Dedupe by concept: writing the same skill name reinforces the existing
 *    memory (the R1 write-pipeline rule) instead of piling up copies.
 */

export interface RecipeValidation {
  ok: boolean;
  errors: string[];
}

export interface CognitionRecipe {
  /** Stable id including version, e.g. 'skill-derivation@1'. */
  id: string;
  title: string;
  /** When the HOST should run this (the host owns the gate). */
  gate: string;
  /** The system prompt for the host's separate focused call. */
  prompt: string;
  /** Human-readable description of the required JSON output. */
  output: string;
  /** How the host must write the result back to AWM. */
  writeBack: string;
  /** Validate a write-back's concept/content shape. */
  validate(concept: string, content: string): RecipeValidation;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export const SKILL_DERIVATION: CognitionRecipe = {
  id: 'skill-derivation@1',
  title: 'Derive a reusable skill from a completed task',
  gate: 'Run ONLY after a task that used tools/multiple steps (roughly: 3+ tool calls or a delegated sub-task). Skip trivial one-offs.',
  prompt: 'A task was just completed using tools. If it followed a REPEATABLE procedure that would help on similar future requests, output ONLY JSON {"name":"short skill name (e.g. \'triage scouting inbox\')","steps":"numbered how-to a future run can follow"}. If it was a trivial one-off, output exactly {}.',
  output: '{"name": string, "steps": string-with-numbered-lines} or {} when nothing repeatable was learned.',
  writeBack: "memory_write with concept: 'skill: <name>', content: <steps>, origin_class: 'recipe', recipe_id: 'skill-derivation@1', memory_class: 'canonical', memory_type: 'procedural', tags: ['topic=skill', 'skill=<slug>'].",
  validate(concept: string, content: string): RecipeValidation {
    const errors: string[] = [];
    if (!/^skill:\s*\S/.test(concept)) errors.push("concept must start with 'skill: <name>'");
    if (!content || content.trim().length < 20) errors.push('steps content too short to be a usable procedure');
    if (!/(^|\n)\s*(\d+[.)]|[-*])\s+/.test(content)) errors.push('content must contain numbered or bulleted steps');
    return { ok: errors.length === 0, errors };
  },
};

export const FRICTION_LESSON: CognitionRecipe = {
  id: 'friction-lesson@1',
  title: 'Record a failure lesson (Reflexion) from a task that went wrong',
  gate: 'Run ONLY after a task that failed, required a retry/revert, or surfaced a wrong assumption.',
  prompt: 'A task just hit a failure, retry, or wrong assumption. Output ONLY JSON {"topic":"short subject of the lesson","lesson":"what went wrong and the rule to apply next time (include the WHY)"}. If nothing generalizable was learned, output exactly {}.',
  output: '{"topic": string, "lesson": string} or {} when nothing generalizable was learned.',
  writeBack: "memory_write with concept: 'lesson: <topic>', content: <lesson>, origin_class: 'recipe', recipe_id: 'friction-lesson@1', memory_class: 'canonical', event_type: 'friction', tags: ['topic=friction', 'about=<slug>'].",
  validate(concept: string, content: string): RecipeValidation {
    const errors: string[] = [];
    if (!/^lesson:\s*\S/.test(concept)) errors.push("concept must start with 'lesson: <topic>'");
    if (!content || content.trim().length < 20) errors.push('lesson content too short to be applicable');
    return { ok: errors.length === 0, errors };
  },
};

const REGISTRY: Record<string, CognitionRecipe> = {
  [SKILL_DERIVATION.id]: SKILL_DERIVATION,
  [FRICTION_LESSON.id]: FRICTION_LESSON,
};

export function getRecipe(id: string): CognitionRecipe | null {
  return REGISTRY[id] ?? null;
}

export function listRecipes(): CognitionRecipe[] {
  return Object.values(REGISTRY);
}

/**
 * Validate a recipe-attributed write. Unknown recipe ids are rejected —
 * provenance must never claim a recipe that does not exist.
 */
export function validateRecipeWrite(recipeId: string, concept: string, content: string): RecipeValidation {
  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, errors: [`unknown recipe id '${recipeId}' — known: ${Object.keys(REGISTRY).join(', ')}`] };
  return recipe.validate(concept, content);
}

/** Derive the standard skill/lesson slug tag value from a concept. */
export function recipeSlug(concept: string): string {
  return slugify(concept.replace(/^(skill|lesson):\s*/i, ''));
}

/**
 * The invitation appended to memory_task_end responses. Kept compact — it is
 * read by an LLM in-band. The host runs the recipe as its OWN next step
 * (separate focused call) and writes back via ordinary memory_write.
 */
export function renderTaskEndInvitation(): string {
  return [
    '',
    'COGNITION RECIPES (host-side — you do the thinking, one SEPARATE focused pass each):',
    `1. ${SKILL_DERIVATION.title}. Gate: ${SKILL_DERIVATION.gate}`,
    `   Think: ${SKILL_DERIVATION.prompt}`,
    `   If non-empty, write back: ${SKILL_DERIVATION.writeBack}`,
    `2. ${FRICTION_LESSON.title}. Gate: ${FRICTION_LESSON.gate}`,
    `   Think: ${FRICTION_LESSON.prompt}`,
    `   If non-empty, write back: ${FRICTION_LESSON.writeBack}`,
  ].join('\n');
}
