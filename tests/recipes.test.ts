import { describe, it, expect } from 'vitest';
import {
  SKILL_DERIVATION, FRICTION_LESSON, getRecipe, listRecipes,
  validateRecipeWrite, recipeSlug, renderTaskEndInvitation,
} from '../src/recipes/index.js';

describe('cognition recipes (D14)', () => {
  it('registry resolves both shipped recipes by id@version', () => {
    expect(getRecipe('skill-derivation@1')).toBe(SKILL_DERIVATION);
    expect(getRecipe('friction-lesson@1')).toBe(FRICTION_LESSON);
    expect(getRecipe('nonsense@9')).toBeNull();
    expect(listRecipes().length).toBe(2);
  });

  it('skill validation accepts a well-formed skill', () => {
    const v = validateRecipeWrite('skill-derivation@1', 'skill: triage scouting inbox',
      '1. Search inbox for scouting emails\n2. Read each\n3. Extract actions and reply');
    expect(v.ok).toBe(true);
  });

  it('skill validation rejects wrong concept prefix, short content, and step-less prose', () => {
    expect(validateRecipeWrite('skill-derivation@1', 'triage inbox', '1. a\n2. b longer content here').ok).toBe(false);
    expect(validateRecipeWrite('skill-derivation@1', 'skill: x', 'too short').ok).toBe(false);
    const prose = validateRecipeWrite('skill-derivation@1', 'skill: x',
      'this is a long paragraph of prose without any steps in it at all whatsoever');
    expect(prose.ok).toBe(false);
    expect(prose.errors.join(' ')).toContain('steps');
  });

  it('friction validation enforces lesson prefix and substance', () => {
    expect(validateRecipeWrite('friction-lesson@1', 'lesson: python heredoc escaping',
      'Editing TS regexes via python heredocs mangles escapes — use the Edit tool because tsc only catches it after the fact.').ok).toBe(true);
    expect(validateRecipeWrite('friction-lesson@1', 'oops', 'short').ok).toBe(false);
  });

  it('unknown recipe ids are rejected — provenance cannot claim a recipe that does not exist', () => {
    const v = validateRecipeWrite('made-up@1', 'skill: x', '1. step one\n2. step two here');
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('unknown recipe');
  });

  it('slug derivation strips prefixes and normalizes', () => {
    expect(recipeSlug('skill: Triage Scouting Inbox!')).toBe('triage-scouting-inbox');
    expect(recipeSlug('lesson: SQLite multi-writer')).toBe('sqlite-multi-writer');
  });

  it('task-end invitation names both recipes with gates and write-back contracts', () => {
    const inv = renderTaskEndInvitation();
    expect(inv).toContain('skill-derivation@1');
    expect(inv).toContain('friction-lesson@1');
    expect(inv).toContain('SEPARATE focused pass');
    expect(inv).toContain("origin_class: 'recipe'");
  });
});
