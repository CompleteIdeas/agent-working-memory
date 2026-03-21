// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Sleep Cycle — offline memory consolidation.
 *
 * Models the brain's consolidation during sleep:
 *   1. Replay — find clusters of semantically similar memories
 *   2. Strengthen — reinforce edges within clusters + access-weighted boost
 *   3. Bridge — create cross-cluster shortcuts between related topic areas
 *   4. Decay — weaken unused edges, prune dead ones
 *   5. Homeostasis — normalize outgoing edge weights to prevent hub explosion
 *   6. Forget — archive/delete memories that were never retrieved (age-gated)
 *   7. Sweep — promote or discard uncertain (staging) memories
 *
 * No artificial "summary nodes" are created. Instead, the associative
 * graph gets denser where knowledge overlaps and sparser where it doesn't.
 * The beam search graph walk in activation.ts naturally propagates through
 * these strengthened pathways.
 *
 * Run between sessions or on a timer (e.g., every few hours).
 */

import { cosineSimilarity } from '../core/embeddings.js';
import { strengthenAssociation, decayAssociation } from '../core/hebbian.js';
import type { Engram } from '../types/index.js';
import type { EngramStore } from '../storage/sqlite.js';

/** Cosine similarity threshold for considering two memories related */
const SIMILARITY_THRESHOLD = 0.65;

/** Lower threshold for cross-cluster bridge edges */
const BRIDGE_THRESHOLD = 0.25;

/** Minimum edge weight to form a new connection during replay */
const INITIAL_EDGE_WEIGHT = 0.3;

/** Boost factor for strengthening existing edges between cluster members */
const CONSOLIDATION_SIGNAL = 0.5;

/** Max new edges to create per sleep cycle (prevent graph explosion) */
const MAX_NEW_EDGES_PER_CYCLE = 50;

/** Max bridge edges per cycle (cross-cluster shortcuts) */
const MAX_BRIDGE_EDGES_PER_CYCLE = 20;

/** Edge weight below which we prune during decay */
const PRUNE_THRESHOLD = 0.01;

/** Target total outgoing edge weight per node (homeostasis) */
const HOMEOSTASIS_TARGET = 10.0;

/** Grace period before forgetting curve starts (days) */
const FORGET_GRACE_DAYS = 7;

/** Consolidation cycles before 0-access memories get archived */
const FORGET_CYCLE_THRESHOLD = 5;

/** Percentile of edge count distribution used for forgetting protection (0-1) */
const EDGE_PROTECTION_PERCENTILE = 0.25;

/** Age at which never-retrieved memories get archived (days) */
const FORGET_ARCHIVE_DAYS = 30;

/** Age at which archived, never-retrieved, unconnected memories get deleted (days) */
const FORGET_DELETE_DAYS = 90;

/** Cosine similarity above which two low-confidence memories are considered redundant */
const REDUNDANCY_THRESHOLD = 0.85;

/** Max redundant memories to prune per cycle (gradual, not sudden) */
const MAX_REDUNDANCY_PRUNE_PER_CYCLE = 10;

export interface ConsolidationResult {
  clustersFound: number;
  edgesStrengthened: number;
  edgesCreated: number;
  bridgesCreated: number;
  edgesDecayed: number;
  edgesPruned: number;
  edgesNormalized: number;
  memoriesForgotten: number;
  memoriesArchived: number;
  redundancyPruned: number;
  stagingPromoted: number;
  stagingDiscarded: number;
  engramsProcessed: number;
}

export class ConsolidationEngine {
  private store: EngramStore;

  constructor(store: EngramStore) {
    this.store = store;
  }

  /**
   * Run a full sleep cycle for an agent.
   *
   * Phase 1: Replay — find clusters of semantically similar memories
   * Phase 2: Strengthen — reinforce edges within clusters (access-weighted)
   * Phase 3: Bridge — create cross-cluster shortcuts
   * Phase 4: Decay — weaken unused edges, prune dead ones
   * Phase 5: Homeostasis — normalize outgoing edge weights per node
   * Phase 6: Forget — archive/delete memories never retrieved (age-gated)
   * Phase 7: Sweep — check staging buffer for resonance
   */
  consolidate(agentId: string): ConsolidationResult {
    const result: ConsolidationResult = {
      clustersFound: 0,
      edgesStrengthened: 0,
      edgesCreated: 0,
      bridgesCreated: 0,
      edgesDecayed: 0,
      edgesPruned: 0,
      edgesNormalized: 0,
      memoriesForgotten: 0,
      memoriesArchived: 0,
      redundancyPruned: 0,
      stagingPromoted: 0,
      stagingDiscarded: 0,
      engramsProcessed: 0,
    };

    // --- Phase 1: Replay ---
    // Get all active engrams with embeddings
    const engrams = this.store.getEngramsByAgent(agentId, 'active')
      .filter(e => e.embedding && e.embedding.length > 0);

    result.engramsProcessed = engrams.length;
    if (engrams.length < 2) return result;

    // Find clusters of related memories
    const clusters = this.findClusters(engrams);
    result.clustersFound = clusters.length;

    // --- Phase 2: Strengthen (access-weighted) ---
    // Memories that are retrieved more often get stronger consolidation.
    // This mirrors how the brain preferentially consolidates practiced memories.
    let newEdges = 0;
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const a = cluster[i];
          const b = cluster[j];

          // Access-weighted signal: more retrieved = stronger consolidation
          const accessFactor = Math.min(
            1.0,
            0.3 + 0.7 * Math.log1p(a.accessCount + b.accessCount) / Math.log1p(20),
          );

          const existing = this.store.getAssociation(a.id, b.id);
          if (existing) {
            const newWeight = strengthenAssociation(
              existing.weight, CONSOLIDATION_SIGNAL * accessFactor, 0.25,
            );
            this.store.upsertAssociation(
              a.id, b.id, newWeight, existing.type, existing.confidence,
            );
            result.edgesStrengthened++;
          } else if (newEdges < MAX_NEW_EDGES_PER_CYCLE) {
            this.store.upsertAssociation(
              a.id, b.id, INITIAL_EDGE_WEIGHT * accessFactor, 'connection',
            );
            newEdges++;
            result.edgesCreated++;
          }
        }
      }
    }

    // --- Phase 3: Cross-cluster bridge edges ---
    // For each pair of clusters, compute centroid similarity. If moderate
    // similarity exists but no direct edge, create a low-weight bridge.
    // This is what enables cross-topic retrieval to improve over time.
    if (clusters.length >= 2) {
      let bridges = 0;
      const centroids = clusters.map(cluster => this.computeCentroid(cluster));

      for (let i = 0; i < clusters.length && bridges < MAX_BRIDGE_EDGES_PER_CYCLE; i++) {
        for (let j = i + 1; j < clusters.length && bridges < MAX_BRIDGE_EDGES_PER_CYCLE; j++) {
          const sim = cosineSimilarity(centroids[i], centroids[j]);
          if (sim < BRIDGE_THRESHOLD || sim >= SIMILARITY_THRESHOLD) continue;

          // Find the best representative from each cluster (highest accessCount)
          const repA = clusters[i].reduce((best, e) => e.accessCount > best.accessCount ? e : best);
          const repB = clusters[j].reduce((best, e) => e.accessCount > best.accessCount ? e : best);

          const existing = this.store.getAssociation(repA.id, repB.id);
          if (!existing) {
            // Bridge weight proportional to inter-cluster similarity
            const bridgeWeight = 0.15 + 0.15 * ((sim - BRIDGE_THRESHOLD) / (SIMILARITY_THRESHOLD - BRIDGE_THRESHOLD));
            this.store.upsertAssociation(repA.id, repB.id, bridgeWeight, 'bridge');
            bridges++;
            result.bridgesCreated++;
          }
        }
      }
    }

    // --- Phase 4: Decay (confidence-modulated) ---
    // High-confidence edges decay slower. This means edges between memories
    // that received positive feedback are more durable — just like how
    // practiced memories are more resistant to forgetting in the brain.
    // Base half-life: 7 days. High-confidence (0.8+) gets up to 30 days.
    const engramConfMap = new Map(engrams.map(e => [e.id, e.confidence]));
    const associations = this.store.getAllAssociations(agentId);
    for (const assoc of associations) {
      const daysSince =
        (Date.now() - assoc.lastActivated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 0.5) continue; // Skip recently activated

      // Confidence-modulated half-life: higher confidence = slower decay (capped at 3x)
      // Base: 7 days. Conf 0.5 → 7 days. Conf 0.8 → ~15 days. Conf 1.0 → 21 days (3x).
      // Cap prevents any edge from becoming immortal.
      const fromConf = engramConfMap.get(assoc.fromEngramId) ?? 0.5;
      const toConf = engramConfMap.get(assoc.toEngramId) ?? 0.5;
      const maxConf = Math.max(fromConf, toConf);
      const halfLifeDays = Math.min(7 * (1 + 2 * Math.max(0, (maxConf - 0.5) / 0.5)), 21);

      const newWeight = decayAssociation(assoc.weight, daysSince, halfLifeDays);
      if (newWeight < PRUNE_THRESHOLD) {
        this.store.deleteAssociation(assoc.id);
        result.edgesPruned++;
      } else if (Math.abs(newWeight - assoc.weight) > 0.001) {
        this.store.upsertAssociation(
          assoc.fromEngramId, assoc.toEngramId,
          newWeight, assoc.type, assoc.confidence,
        );
        result.edgesDecayed++;
      }
    }

    // --- Phase 5: Synaptic homeostasis ---
    // Normalize total outgoing edge weight per node to prevent hub explosion.
    // Nodes with many strong edges get scaled down so relative weights stay meaningful.
    const engramIds = new Set(engrams.map(e => e.id));
    for (const id of engramIds) {
      const outgoing = this.store.getOutgoingAssociations(id);
      const totalWeight = outgoing.reduce((sum, a) => sum + a.weight, 0);
      if (totalWeight > HOMEOSTASIS_TARGET) {
        const scale = HOMEOSTASIS_TARGET / totalWeight;
        for (const edge of outgoing) {
          const newWeight = edge.weight * scale;
          if (newWeight < PRUNE_THRESHOLD) {
            this.store.deleteAssociation(edge.id);
            result.edgesPruned++;
          } else {
            this.store.upsertAssociation(
              edge.fromEngramId, edge.toEngramId,
              newWeight, edge.type, edge.confidence,
            );
          }
        }
        result.edgesNormalized++;
      }
    }

    // --- Phase 6: Forgetting (age-gated) ---
    // Models how human memory actually works:
    // - New memories get a grace period (too new to judge)
    // - Retrieval acts as rehearsal — resets the forgetting clock
    // - Well-connected memories persist (edges = integration into knowledge)
    // - Old, isolated, unretrieved memories fade to archive (not deleted)
    // - Archived memories can still be recovered via deep search
    // - Only truly orphaned, ancient memories get deleted
    //
    // Key insight: outdated memories still have value as historical context.
    // "We used to use X" helps explain why we now use Y.
    // Compute edge count percentile for relative protection threshold.
    // With avg 12 edges/node, an absolute threshold of 3 protects everything.
    // Use 25th percentile so "weakly connected" is relative to actual graph density.
    const edgeCounts = engrams.map(e => this.store.countAssociationsFor(e.id));
    edgeCounts.sort((a, b) => a - b);
    const percentileIdx = Math.floor(edgeCounts.length * EDGE_PROTECTION_PERCENTILE);
    const baseEdgeThreshold = edgeCounts.length > 0 ? edgeCounts[percentileIdx] : 3;

    // Get consolidation cycle count for cycle-based archiving
    const cycleCount = this.store.getConsolidationCycleCount(agentId);

    for (const engram of engrams) {
      const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < FORGET_GRACE_DAYS) continue; // Grace period — too new to judge

      const edgeCount = this.store.countAssociationsFor(engram.id);

      // Use relative threshold (percentile-based) instead of absolute.
      // High-confidence memories need fewer edges to survive.
      const confReduction = engram.confidence > 0.7
        ? Math.min(0.6, (engram.confidence - 0.7) * 2)
        : 0;
      const edgeProtectionThreshold = Math.max(1, Math.round(baseEdgeThreshold * (1 - confReduction)));
      if (edgeCount > edgeProtectionThreshold) continue;

      // Cycle-based archive: 0-access memories archived after N cycles
      // regardless of age. Handles small pools where time thresholds are too generous.
      if (engram.accessCount === 0 && cycleCount >= FORGET_CYCLE_THRESHOLD) {
        this.store.updateStage(engram.id, 'archived');
        result.memoriesArchived++;
        continue;
      }

      // Compute effective forgetting threshold based on memory strength signals.
      // Rehearsal (access + feedback) extends protection but NEVER makes immortal.
      // Models a sharp 20-year senior dev: confirmed knowledge persists for months/years.
      // - Base: FORGET_ARCHIVE_DAYS (30 days)
      // - Access extends by log-scaled factor: 5 accesses ≈ 2x, 10 ≈ 2.5x
      // - Confidence modulates up to 4x (0.5→1x, 0.7→2.6x, 0.8→3.4x, 1.0→4x)
      // - Hard cap: 12x base (360 days) — even the sharpest memory fades after a year
      const accessFactor = 1 + Math.log1p(engram.accessCount) * 0.6;
      const confFactor = 1 + 3 * Math.max(0, (engram.confidence - 0.5) / 0.5);
      const effectiveArchiveDays = Math.min(
        FORGET_ARCHIVE_DAYS * accessFactor * confFactor,
        FORGET_ARCHIVE_DAYS * 12,  // Hard cap: 12x base (360 days)
      );

      const daysSinceAccess = (Date.now() - engram.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

      if (engram.accessCount === 0 && ageDays > FORGET_ARCHIVE_DAYS) {
        // Never retrieved, old, weakly connected → archive
        this.store.updateStage(engram.id, 'archived');
        result.memoriesArchived++;
      } else if (engram.accessCount > 0 && daysSinceAccess > effectiveArchiveDays) {
        // Accessed before but not recently enough given its strength — archive
        this.store.updateStage(engram.id, 'archived');
        result.memoriesArchived++;
      }
    }

    // Check archived memories for deletion — only truly orphaned ancient ones
    const archived = this.store.getEngramsByAgent(agentId, 'archived');
    for (const engram of archived) {
      const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const edgeCount = this.store.countAssociationsFor(engram.id);

      if (engram.accessCount === 0 && ageDays > FORGET_DELETE_DAYS && edgeCount === 0) {
        // Very old, never accessed, completely isolated → truly forgotten
        this.store.deleteEngram(engram.id);
        result.memoriesForgotten++;
      }
      // Otherwise: stay archived — still searchable, just not in active recall
    }

    // --- Phase 6.5: Redundancy pruning ---
    // A senior dev doesn't store 30 nearly-identical memories. When multiple
    // low-confidence memories are semantically redundant (cosine > 0.85), keep
    // only the one with highest accessCount + confidence and archive the rest.
    // This naturally defeats volume-based attacks (narcissistic interference,
    // spam) while improving signal-to-noise ratio for linked memories.
    // High-confidence memories (feedback-confirmed) are never pruned — they
    // represent verified knowledge worth keeping even if similar.
    // Only consider memories that are both low-confidence AND rarely accessed.
    // Memories retrieved 3+ times have proven useful — they stay even if similar
    // to others. This prevents pruning seed memories that match bulk templates.
    const lowConfEngrams = engrams.filter(e =>
      e.confidence < 0.6 && e.accessCount < 3 && e.embedding && e.embedding.length > 0);
    const pruned = new Set<string>();
    let redundancyCount = 0;

    // Sort by quality: highest accessCount + confidence first (survivors)
    const sortedLow = [...lowConfEngrams].sort((a, b) =>
      (b.accessCount + b.confidence * 10) - (a.accessCount + a.confidence * 10));

    for (let i = 0; i < sortedLow.length && redundancyCount < MAX_REDUNDANCY_PRUNE_PER_CYCLE; i++) {
      if (pruned.has(sortedLow[i].id)) continue;
      for (let j = i + 1; j < sortedLow.length && redundancyCount < MAX_REDUNDANCY_PRUNE_PER_CYCLE; j++) {
        if (pruned.has(sortedLow[j].id)) continue;
        if (!sortedLow[i].embedding || !sortedLow[j].embedding) continue;

        const sim = cosineSimilarity(sortedLow[i].embedding!, sortedLow[j].embedding!);
        if (sim >= REDUNDANCY_THRESHOLD) {
          // Archive the lower-quality duplicate
          this.store.updateStage(sortedLow[j].id, 'archived');
          pruned.add(sortedLow[j].id);
          redundancyCount++;
        }
      }
    }
    result.redundancyPruned = redundancyCount;

    // --- Phase 7: Sweep staging ---
    const staging = this.store.getEngramsByAgent(agentId, 'staging')
      .filter(e => e.embedding && e.embedding.length > 0);

    for (const staged of staging) {
      const ageMs = Date.now() - staged.createdAt.getTime();

      // Check if this staging memory resonates with any active memory
      let maxSim = 0;
      for (const active of engrams) {
        if (!active.embedding || !staged.embedding) continue;
        const sim = cosineSimilarity(staged.embedding, active.embedding);
        if (sim > maxSim) maxSim = sim;
      }

      if (maxSim >= 0.6) {
        // Resonates — promote to active
        this.store.updateStage(staged.id, 'active');
        result.stagingPromoted++;
      } else if (ageMs > 24 * 60 * 60 * 1000) {
        // Over 24h and no resonance — discard
        this.store.deleteEngram(staged.id);
        result.stagingDiscarded++;
      }
      // Otherwise: leave in staging, maybe next cycle
    }

    return result;
  }

  /**
   * Find clusters of semantically similar memories.
   * Greedy agglomerative — each memory belongs to at most one cluster.
   * Clusters of size 2+ are returned (pairs count — they link).
   */
  private findClusters(engrams: Engram[]): Engram[][] {
    const assigned = new Set<string>();
    const clusters: Engram[][] = [];

    // Seed clusters from most-accessed memories (strongest traces)
    const sorted = [...engrams].sort((a, b) => b.accessCount - a.accessCount);

    for (const seed of sorted) {
      if (assigned.has(seed.id)) continue;

      const cluster: Engram[] = [seed];
      assigned.add(seed.id);

      for (const candidate of sorted) {
        if (assigned.has(candidate.id)) continue;
        if (!seed.embedding || !candidate.embedding) continue;

        const sim = cosineSimilarity(seed.embedding, candidate.embedding);
        if (sim >= SIMILARITY_THRESHOLD) {
          cluster.push(candidate);
          assigned.add(candidate.id);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      } else {
        for (const e of cluster) assigned.delete(e.id);
      }
    }

    return clusters;
  }

  /**
   * Compute the centroid (average embedding) of a cluster.
   */
  private computeCentroid(cluster: Engram[]): number[] {
    const withEmbed = cluster.filter(e => e.embedding && e.embedding.length > 0);
    if (withEmbed.length === 0) return [];

    const dim = withEmbed[0].embedding!.length;
    const centroid = new Array<number>(dim).fill(0);
    for (const e of withEmbed) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += e.embedding![i];
      }
    }
    for (let i = 0; i < dim; i++) {
      centroid[i] /= withEmbed.length;
    }
    return centroid;
  }
}
