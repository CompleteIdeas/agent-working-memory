// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Auto-Tagger — generates meta-tags for memories at write time.
 *
 * Meta-tags serve as categorical signals that boost BM25 recall.
 * They're indexed in FTS5 alongside concept/content/tags, so queries
 * that match a category tag get better BM25 scores.
 *
 * Three sources of tags:
 * 1. Content analysis — extract topics, entities, categories from the text
 * 2. Context propagation — inherit relevant tags from related memories
 * 3. Type classification — fact/experience/belief/entity markers
 *
 * Design: lightweight heuristics, no LLM calls. Tags are additive —
 * they enrich the existing tag set without replacing user-provided tags.
 */

/**
 * Extract meta-tags from memory content using keyword patterns.
 * Returns tags prefixed with 'cat:' to distinguish from user tags.
 */
export function extractMetaTags(concept: string, content: string): string[] {
  const tags: string[] = [];
  const text = `${concept} ${content}`.toLowerCase();

  // --- Category tags (broad topic classification) ---

  // People / personal
  if (/\b(i |my |i'm |i've |we |our |me )\b/.test(text)) {
    tags.push('cat:personal');
  }

  // Work / professional
  if (/\b(work|job|office|meeting|project|team|manager|colleague|career|salary|hired)\b/.test(text)) {
    tags.push('cat:work');
  }

  // Technology / computing
  if (/\b(code|programming|software|database|api|server|deploy|bug|git|typescript|python|react|node)\b/.test(text)) {
    tags.push('cat:tech');
  }

  // Health / wellness
  if (/\b(health|doctor|exercise|yoga|gym|diet|sleep|meditation|therapy|medicine|symptom)\b/.test(text)) {
    tags.push('cat:health');
  }

  // Finance / money
  if (/\b(money|budget|savings|invest|salary|cost|price|payment|bank|credit|expense|coupon|store|bought|purchased)\b/.test(text)) {
    tags.push('cat:finance');
  }

  // Home / living
  if (/\b(home|house|apartment|room|kitchen|bedroom|furniture|garden|repair|renovation|neighbor|moved)\b/.test(text)) {
    tags.push('cat:home');
  }

  // Travel / location
  if (/\b(travel|trip|vacation|flight|hotel|restaurant|city|country|visited|downtown|park)\b/.test(text)) {
    tags.push('cat:location');
  }

  // Education / learning
  if (/\b(school|university|college|degree|course|class|study|learn|graduate|student|teacher|exam)\b/.test(text)) {
    tags.push('cat:education');
  }

  // Social / relationships
  if (/\b(friend|family|partner|spouse|child|parent|sibling|birthday|party|dinner|wedding|date)\b/.test(text)) {
    tags.push('cat:social');
  }

  // Hobbies / entertainment
  if (/\b(music|movie|book|game|sport|hobby|play|concert|theater|playlist|podcast|guitar|tennis|yoga|painting)\b/.test(text)) {
    tags.push('cat:hobby');
  }

  // Shopping / consumer
  if (/\b(bought|purchased|ordered|shop|store|amazon|target|walmart|coupon|sale|discount|delivery)\b/.test(text)) {
    tags.push('cat:shopping');
  }

  // Food / cooking
  if (/\b(cook|recipe|restaurant|meal|food|dinner|lunch|breakfast|coffee|tea|bake|kitchen)\b/.test(text)) {
    tags.push('cat:food');
  }

  // Pets / animals
  if (/\b(pet|dog|cat|animal|vet|shelter|walk|breed)\b/.test(text)) {
    tags.push('cat:pets');
  }

  // Time markers
  if (/\b(yesterday|today|last week|last month|tomorrow|next week|this morning|this evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text)) {
    tags.push('cat:temporal');
  }

  // --- Entity extraction (simple noun phrase patterns) ---

  // Proper nouns (capitalized words that aren't sentence starters)
  const properNouns = content.match(/(?:^|\.\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);
  if (properNouns) {
    const unique = [...new Set(properNouns.map(n => n.trim()).filter(n => n.length > 2 && n.length < 30))];
    for (const noun of unique.slice(0, 5)) {
      tags.push(`entity:${noun}`);
    }
  }

  // --- Knowledge type tags ---

  // Preference (I like/prefer/enjoy/love/hate)
  if (/\b(i like|i prefer|i enjoy|i love|i hate|my favorite|i don't like)\b/.test(text)) {
    tags.push('cat:preference');
  }

  // Fact (declarative statements about identity/attributes)
  if (/\b(my name is|i am a|i work at|i live in|i graduated|my birthday|i was born)\b/.test(text)) {
    tags.push('cat:identity');
  }

  // Plan / intention
  if (/\b(i plan to|i'm going to|i want to|i'm thinking of|i'm considering|next week i|planning to)\b/.test(text)) {
    tags.push('cat:plan');
  }

  // Experience / event
  if (/\b(i went|i visited|i attended|i tried|i saw|i heard|i found|i discovered)\b/.test(text)) {
    tags.push('cat:experience');
  }

  return tags;
}

/**
 * Propagate relevant tags from related memories to a new memory.
 * Called after connection engine links the new memory to existing ones.
 *
 * Strategy: inherit meta-tags from strongly connected neighbors,
 * but only tags that appear in 2+ neighbors (consensus filtering).
 */
export function propagateTagsFromNeighbors(
  existingTags: string[],
  neighborTagSets: string[][],
): string[] {
  if (neighborTagSets.length === 0) return [];

  // Count meta-tag occurrences across neighbors
  const tagCounts = new Map<string, number>();
  for (const tags of neighborTagSets) {
    for (const tag of tags) {
      if (tag.startsWith('cat:') || tag.startsWith('entity:')) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  // Only propagate tags that appear in 2+ neighbors (consensus)
  const propagated: string[] = [];
  const existingSet = new Set(existingTags);
  for (const [tag, count] of tagCounts) {
    if (count >= 2 && !existingSet.has(tag)) {
      propagated.push(tag);
    }
  }

  return propagated.slice(0, 5); // Cap to avoid tag bloat
}
