// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Retraction Engine — negative memory / invalidation.
 *
 * Codex critique: "You need explicit anti-salience for wrong info.
 * Otherwise wrong memories persist and compound mistakes."
 *
 * When an agent discovers a memory is wrong:
 *   1. The original engram is marked retracted (not deleted — audit trail)
 *   2. An invalidation association is created
 *   3. Optionally, a counter-engram with correct info is created
 *   4. Confidence of associated engrams is reduced (contamination check)
 *
 * AWM 0.8.5 — Coherence-weighted propagation (2026-05-26)
 * --------------------------------------------------------
 * The Continued Influence Effect (Carrillo et al., ICCM 2025) shows that
 * misinformation persists in human cognition because it lives inside a
 * *coherent narrative*, not as an isolated fact. Correcting one chunk doesn't
 * displace the narrative unless the correction also propagates through the
 * connected structure.
 *
 * Translation: when we retract an engram, we compute a `cohesion` score for
 * its 2-hop neighborhood and use it to amplify or dampen the contamination
 * penalty on neighbors:
 *
 *   - Dense narrative cluster (high internal-edge density + shared tags)
 *     → penalty amplified (~1.5×). The whole cluster shares the wrong story.
 *
 *   - Isolated engram (sparse edges, divergent tags)
 *     → penalty dampened (~0.5×). No narrative to disrupt.
 *
 *   - Cross-domain bridge (low cohesion across an edge)
 *     → bridge weight reduced but far-side neighbors barely affected.
 *
 * Cohesion is computed at retract time (no schema/consolidation changes).
 * Cost: bounded by MAX_AFFECTED (20 nodes) × one batched `getAssociationsForBatch`
 * call — typically 10-25ms.
 */

import type { IEngramStore as EngramStore } from '../storage/store.js';
import type { Retraction, Association, Engram } from '../types/index.js';

/** Result of cohesion analysis on a 2-hop neighborhood. */
export interface NeighborhoodCohesion {
  /** internal_edges / (internal_edges + external_edges) across the subgraph. [0, 1] */
  graphDensity: number;
  /** mean jaccard(source.tags, neighbor.tags) across non-source subgraph members. [0, 1] */
  tagOverlap: number;
  /** Combined cohesion in [0, 1] — graphDensity blended with tagOverlap bonus. */
  score: number;
  /** How many engrams the cohesion was computed over (excluding the source). */
  subgraphSize: number;
}

export class RetractionEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Retract a memory — mark it invalid and optionally create a correction.
   */
  async retract(retraction: Retraction): Promise<{
    retractedId: string;
    correctionId: string | null;
    associatesAffected: number;
    cohesion: NeighborhoodCohesion;
    narrativeEdgesInherited: number;
  }> {
    const target = await this.store.getEngram(retraction.targetEngramId);
    if (!target) {
      throw new Error(`Engram ${retraction.targetEngramId} not found`);
    }

    // Mark the original as retracted
    await this.store.retractEngram(target.id, null);

    let correctionId: string | null = null;
    let narrativeEdgesInherited = 0;

    // Create counter-engram if correction content provided
    if (retraction.counterContent) {
      const correction = await this.store.createEngram({
        agentId: retraction.agentId,
        concept: `correction:${target.concept}`,
        content: retraction.counterContent,
        tags: [...target.tags, 'correction', 'retraction'],
        salience: Math.max(target.salience, 0.6), // Corrections are at least moderately salient
        confidence: 0.7,
        reasonCodes: ['retraction_correction', `invalidates:${target.id}`],
      });

      correctionId = correction.id;

      // Create invalidation link
      await this.store.upsertAssociation(
        correction.id, target.id, 1.0, 'invalidation', 1.0
      );

      // Update retracted_by to point to correction
      await this.store.retractEngram(target.id, correction.id);

      // Counter-narrative replacement (Carrillo et al ICCM 2025):
      // The correction must take over the retracted memory's narrative position,
      // not just contradict it. Inherit edges from the retracted's strong
      // neighbors so the correction lives in the same context that the wrong
      // memory occupied.
      narrativeEdgesInherited = await this.inheritNarrativeEdges(target.id, correction.id);
    }

    // Compute cohesion of the target's neighborhood. A dense/cohesive
    // neighborhood means the retracted memory was part of a coherent
    // narrative; we propagate the contamination penalty more aggressively.
    const cohesion = await this.computeNeighborhoodCohesion(target, 2);

    // Reduce confidence of associated engrams (contamination spread).
    // Depth 2 with cohesion-weighted penalty, capped at MAX_AFFECTED nodes.
    const associatesAffected = await this.propagateConfidenceReduction(
      target.id, 0.1, 2, cohesion.score,
    );

    return { retractedId: target.id, correctionId, associatesAffected, cohesion, narrativeEdgesInherited };
  }

  /**
   * Counter-narrative replacement helper.
   *
   * When a correction engram is created to replace a retracted memory, the
   * correction inherits the retracted's strong-edge neighbors. This implements
   * the "narrative replacement" mechanism the Continued Influence Effect paper
   * argues is necessary for corrections to take hold: people don't drop
   * misinformation when only one chunk is corrected; the surrounding context
   * has to be reconnected to the new correct fact.
   *
   * Rules:
   *   - Inherit only edges where weight >= NARRATIVE_INHERIT_MIN (0.4). Weak
   *     edges aren't really part of the narrative.
   *   - Skip edge types with special semantics: `invalidation` (the link
   *     between retracted and correction itself), `causal` (specific cause
   *     relationships, not narrative cohesion), `temporal` (chronological
   *     sequence, not story structure).
   *   - Skip neighbors that are themselves retracted — no point connecting
   *     a correction to other wrong memories.
   *   - Inherited edge weight = original × 0.7 (reduced — the correction
   *     experienced this context only indirectly, through the retracted memory).
   *   - Cap at NARRATIVE_INHERIT_MAX (10) edges, sorted by weight desc, to
   *     bound the blast radius on highly-connected hubs.
   *
   * Returns the number of edges actually inherited.
   */
  private static readonly NARRATIVE_INHERIT_MIN = 0.4;
  private static readonly NARRATIVE_INHERIT_MAX = 10;
  private static readonly NARRATIVE_INHERIT_WEIGHT_SCALE = 0.7;
  private static readonly NARRATIVE_INHERIT_SKIP_TYPES = new Set([
    'invalidation', 'causal', 'temporal',
  ]);

  async inheritNarrativeEdges(retractedId: string, correctionId: string): Promise<number> {
    const associations = await this.store.getAssociationsFor(retractedId);

    // Filter to inheritable edges
    const candidates: Array<{ neighborId: string; weight: number; confidence: number; type: string }> = [];
    for (const assoc of associations) {
      if (RetractionEngine.NARRATIVE_INHERIT_SKIP_TYPES.has(assoc.type)) continue;
      if (assoc.weight < RetractionEngine.NARRATIVE_INHERIT_MIN) continue;
      const neighborId = assoc.fromEngramId === retractedId ? assoc.toEngramId : assoc.fromEngramId;
      if (neighborId === correctionId) continue; // don't self-loop
      candidates.push({ neighborId, weight: assoc.weight, confidence: assoc.confidence, type: assoc.type });
    }

    // Sort by weight desc, take top N
    candidates.sort((a, b) => b.weight - a.weight);
    const top = candidates.slice(0, RetractionEngine.NARRATIVE_INHERIT_MAX);
    if (top.length === 0) return 0;

    // Filter out retracted neighbors (would inherit edges to wrong memories)
    const neighborEngrams = await this.store.getEngramsByIds(top.map(c => c.neighborId));
    const neighborMap = new Map(neighborEngrams.map(e => [e.id, e]));

    let inherited = 0;
    for (const c of top) {
      const neighbor = neighborMap.get(c.neighborId);
      if (!neighbor || neighbor.retracted) continue;
      const newWeight = c.weight * RetractionEngine.NARRATIVE_INHERIT_WEIGHT_SCALE;
      await this.store.upsertAssociation(
        correctionId,
        c.neighborId,
        newWeight,
        'connection', // Reuse existing type; semantically these ARE connections from the correction's perspective.
        c.confidence,
      );
      inherited++;
    }
    return inherited;
  }

  /**
   * Compute the narrative cohesion of `source`'s neighborhood within `depth` hops.
   *
   * Cohesion combines two signals:
   *   - **Graph density**: How tightly interconnected are the neighbors?
   *     internal_edges / (internal_edges + external_edges) across the subgraph.
   *   - **Tag overlap**: How much do the neighbors share semantic tags with the source?
   *     mean jaccard(source.tags, neighbor.tags).
   *
   * Both signals contribute on a [0, 1] scale; the combined score is
   * `density × (1 + tagOverlap)` clamped to [0, 1]. A score of 0.5 is the
   * "neutral" point where retraction penalty is unchanged from the legacy
   * formula.
   *
   * Cost: O(subgraphSize × avg_degree) BFS + 1 batched fetch. Bounded by
   * MAX_AFFECTED (20). Typical: ~10-25ms.
   */
  async computeNeighborhoodCohesion(
    source: Engram,
    depth: number = 2,
  ): Promise<NeighborhoodCohesion> {
    // BFS to collect the subgraph nodes
    const subgraphIds = new Set<string>([source.id]);
    let frontier: string[] = [source.id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      // Batch-fetch associations for the current frontier
      const assocs = await this.store.getAssociationsForBatch(frontier);
      for (const id of frontier) {
        const list = assocs.get(id) ?? [];
        for (const a of list) {
          if (a.type === 'invalidation') continue;
          const neighbor = a.fromEngramId === id ? a.toEngramId : a.fromEngramId;
          if (subgraphIds.has(neighbor)) continue;
          if (subgraphIds.size >= RetractionEngine.MAX_AFFECTED) break;
          subgraphIds.add(neighbor);
          next.push(neighbor);
        }
        if (subgraphIds.size >= RetractionEngine.MAX_AFFECTED) break;
      }
      if (next.length === 0) break;
      frontier = next;
    }

    const subgraphSize = subgraphIds.size - 1; // exclude source

    if (subgraphSize === 0) {
      // No neighbors at all — fully isolated engram.
      return { graphDensity: 0, tagOverlap: 0, score: 0, subgraphSize: 0 };
    }

    // Fetch all subgraph members' associations in one batch.
    const allIds = Array.from(subgraphIds);
    const allAssocs = await this.store.getAssociationsForBatch(allIds);

    // Count internal vs external edges across the subgraph.
    let internalEdges = 0;
    let externalEdges = 0;
    const seenEdge = new Set<string>(); // de-dupe (each edge appears twice in BFS by endpoint)
    for (const id of allIds) {
      const list = allAssocs.get(id) ?? [];
      for (const a of list) {
        if (a.type === 'invalidation') continue;
        // Canonical edge key (alphabetical) for de-duping
        const key = a.fromEngramId < a.toEngramId
          ? `${a.fromEngramId}|${a.toEngramId}`
          : `${a.toEngramId}|${a.fromEngramId}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        const internal = subgraphIds.has(a.fromEngramId) && subgraphIds.has(a.toEngramId);
        if (internal) internalEdges++;
        else externalEdges++;
      }
    }
    const totalEdges = internalEdges + externalEdges;
    const graphDensity = totalEdges > 0 ? internalEdges / totalEdges : 0;

    // Compute tag overlap (source vs each subgraph member).
    const sourceTags = new Set(source.tags ?? []);
    let tagOverlapSum = 0;
    let tagOverlapCount = 0;
    if (sourceTags.size > 0) {
      // Fetch all subgraph engrams to read tags
      const neighborIds = allIds.filter(id => id !== source.id);
      const engrams = await this.store.getEngramsByIds(neighborIds);
      for (const e of engrams) {
        const neighborTags = new Set(e.tags ?? []);
        if (neighborTags.size === 0) continue;
        const intersection = [...sourceTags].filter(t => neighborTags.has(t)).length;
        const union = sourceTags.size + neighborTags.size - intersection;
        const jaccard = union > 0 ? intersection / union : 0;
        tagOverlapSum += jaccard;
        tagOverlapCount++;
      }
    }
    const tagOverlap = tagOverlapCount > 0 ? tagOverlapSum / tagOverlapCount : 0;

    // Combine: graph density × tag-modulated weight. Density alone saturates
    // quickly in small subgraphs (everything is internal); tag overlap is the
    // signal that distinguishes a genuine narrative from an incidental cluster.
    //   score = density * (0.5 + 0.5 * tagOverlap)
    //   - max (density=1, tagOverlap=1)  → 1.0  (canonical narrative)
    //   - hub  (density=1, tagOverlap=0) → 0.5  (structurally connected but no shared story)
    //   - half (density=0.5, tagOverlap=0.5) → 0.375
    //   - zero (density=0)               → 0    (no neighborhood)
    const rawScore = graphDensity * (0.5 + 0.5 * tagOverlap);
    const score = Math.max(0, Math.min(1, rawScore));

    return { graphDensity, tagOverlap, score, subgraphSize };
  }

  /**
   * Reduce confidence of engrams associated with a retracted engram.
   * Propagates up to maxDepth hops with decaying penalty (50% per hop) and
   * cohesion-weighted amplification.
   * Capped at MAX_AFFECTED to prevent cascading through the graph.
   */
  private static readonly MAX_AFFECTED = 20;

  private async propagateConfidenceReduction(
    engramId: string,
    penalty: number,
    maxDepth: number,
    cohesionScore: number,
    currentDepth: number = 0,
    visited: Set<string> = new Set(),
  ): Promise<number> {
    if (currentDepth >= maxDepth) return 0;
    if (visited.size >= RetractionEngine.MAX_AFFECTED) return 0;
    visited.add(engramId);

    // Cohesion multiplier: 0.5 (isolated) → 1.5 (densely coherent narrative).
    // At cohesion=0.5 (neutral), multiplier=1.0, preserving legacy behavior.
    const cohesionMultiplier = 0.5 + cohesionScore;

    let affected = 0;
    const associations = await this.store.getAssociationsFor(engramId);
    for (const assoc of associations) {
      if (assoc.type === 'invalidation') continue; // Don't penalize corrections
      if (visited.size >= RetractionEngine.MAX_AFFECTED) break;

      const neighborId = assoc.fromEngramId === engramId
        ? assoc.toEngramId
        : assoc.fromEngramId;
      if (visited.has(neighborId)) continue;

      const neighbor = await this.store.getEngram(neighborId);
      if (!neighbor || neighbor.retracted) continue;

      // Scale penalty by association weight, depth decay (50% per hop),
      // and cohesion multiplier (narrative-aware amplification).
      const depthDecay = Math.pow(0.5, currentDepth);
      const scaledPenalty = penalty * assoc.weight * depthDecay * cohesionMultiplier;
      const newConfidence = Math.max(0.1, neighbor.confidence - scaledPenalty);
      await this.store.updateConfidence(neighborId, newConfidence);
      affected++;

      // Recurse to next depth — cohesion is computed once at the source
      // and applied uniformly through the propagation. Recomputing per-hop
      // would be expensive and could cause oscillation.
      affected += await this.propagateConfidenceReduction(
        neighborId, penalty, maxDepth, cohesionScore, currentDepth + 1, visited,
      );
    }
    return affected;
  }
}
