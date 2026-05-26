/**
 * Coherence-weighted retraction tests.
 *
 * Validates the Continued Influence Effect (CIE) inspired propagation:
 *   - Dense narrative clusters get amplified contamination penalty
 *   - Isolated engrams get dampened penalty
 *   - Cross-domain bridges contaminate less aggressively across the bridge
 *
 * The cohesion calculation is deterministic given a graph; we build
 * synthetic graphs to assert specific shapes.
 *
 * Run: npx vitest run tests/engine/coherence-retraction.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { RetractionEngine } from '../../src/engine/retraction.js';

const AGENT = 'coh-test';

describe('RetractionEngine — coherence-weighted propagation', () => {
  let store: EngramStore;
  let retraction: RetractionEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-coh-'));
    store = new EngramStore(join(tmp, 'test.db'));
    retraction = new RetractionEngine(store);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('computeNeighborhoodCohesion', () => {
    it('returns zero cohesion for an isolated engram with no neighbors', async () => {
      const e = store.createEngram({ agentId: AGENT, concept: 'lonely', content: 'no edges' });
      const c = await retraction.computeNeighborhoodCohesion(e, 2);
      expect(c.subgraphSize).toBe(0);
      expect(c.graphDensity).toBe(0);
      expect(c.tagOverlap).toBe(0);
      expect(c.score).toBe(0);
    });

    it('reports HIGH cohesion for a dense narrative cluster (triangle + shared tags)', async () => {
      // Triangle: A↔B↔C↔A. All three share tags. Coherent narrative.
      const sharedTags = ['proj=Orion', 'sprint=12', 'topic=auth'];
      const A = store.createEngram({ agentId: AGENT, concept: 'auth-A', content: 'OAuth flow start', tags: sharedTags });
      const B = store.createEngram({ agentId: AGENT, concept: 'auth-B', content: 'token refresh', tags: sharedTags });
      const C = store.createEngram({ agentId: AGENT, concept: 'auth-C', content: 'session timeout', tags: sharedTags });
      store.upsertAssociation(A.id, B.id, 0.7, 'hebbian');
      store.upsertAssociation(B.id, C.id, 0.7, 'hebbian');
      store.upsertAssociation(C.id, A.id, 0.7, 'hebbian');

      const c = await retraction.computeNeighborhoodCohesion(A, 2);
      expect(c.subgraphSize).toBe(2);
      expect(c.graphDensity).toBeCloseTo(1.0, 5); // All edges are internal
      expect(c.tagOverlap).toBeCloseTo(1.0, 5);   // All neighbors share all tags
      expect(c.score).toBeGreaterThanOrEqual(0.95);
    });

    it('reports MID cohesion for a hub: structurally connected but no shared narrative', async () => {
      // Center connected to 5 leaves; leaves not connected to each other; divergent tags.
      const center = store.createEngram({ agentId: AGENT, concept: 'hub', content: 'central node', tags: ['hub'] });
      for (let i = 0; i < 5; i++) {
        const leaf = store.createEngram({ agentId: AGENT, concept: `leaf-${i}`, content: `unique ${i}`, tags: [`topic=${i}`] });
        store.upsertAssociation(center.id, leaf.id, 0.5, 'connection');
      }
      const c = await retraction.computeNeighborhoodCohesion(center, 2);
      expect(c.subgraphSize).toBe(5);
      // All 5 edges are internal to the subgraph (center + leaves) → density = 1.0.
      // But tags don't overlap → tagOverlap = 0.
      // Score = density * (0.5 + 0.5 * tagOverlap) = 1.0 * 0.5 = 0.5
      // This is the *exact* signal we want: structural connection alone is not
      // enough to claim narrative coherence. A hub of unrelated topics caps at
      // the neutral midpoint (no amplification of retraction penalty).
      expect(c.graphDensity).toBeCloseTo(1.0, 5);
      expect(c.tagOverlap).toBe(0);
      expect(c.score).toBeCloseTo(0.5, 5);
    });

    it('reports moderate cohesion for a cluster with mixed tag overlap', async () => {
      // Triangle with partial tag overlap.
      const A = store.createEngram({ agentId: AGENT, concept: 'A', content: 'a', tags: ['x', 'y'] });
      const B = store.createEngram({ agentId: AGENT, concept: 'B', content: 'b', tags: ['x'] });          // 50% overlap
      const C = store.createEngram({ agentId: AGENT, concept: 'C', content: 'c', tags: ['z'] });          // 0% overlap
      store.upsertAssociation(A.id, B.id, 0.5, 'hebbian');
      store.upsertAssociation(B.id, C.id, 0.5, 'hebbian');

      const c = await retraction.computeNeighborhoodCohesion(A, 2);
      expect(c.subgraphSize).toBe(2);
      expect(c.tagOverlap).toBeLessThan(0.5);
      expect(c.tagOverlap).toBeGreaterThan(0);
      // graphDensity for a 2-hop chain: 2 internal edges (A-B, B-C), 0 external = 1.0
      expect(c.graphDensity).toBeCloseTo(1.0, 5);
    });

    it('reports LOW cohesion when external edges dominate', async () => {
      // Source connected to 2 in-cluster nodes; those nodes have many external edges.
      const A = store.createEngram({ agentId: AGENT, concept: 'A', content: 'source', tags: ['core'] });
      const B = store.createEngram({ agentId: AGENT, concept: 'B', content: 'b', tags: ['core'] });
      const C = store.createEngram({ agentId: AGENT, concept: 'C', content: 'c', tags: ['core'] });
      // B has 8 external edges to engrams that are NOT in the 2-hop subgraph from A.
      // (They are reachable from B but the BFS hits MAX_AFFECTED bound — for this test
      // we cap depth=1 to verify external-edge counting works.)
      store.upsertAssociation(A.id, B.id, 0.5, 'hebbian');
      store.upsertAssociation(A.id, C.id, 0.5, 'hebbian');
      // Add 8 outer engrams connected only to B (will be in subgraph if depth=2)
      // To make them "external," use depth=1 so only A,B,C are in-subgraph.
      for (let i = 0; i < 8; i++) {
        const outer = store.createEngram({ agentId: AGENT, concept: `outer-${i}`, content: `o${i}` });
        store.upsertAssociation(B.id, outer.id, 0.3, 'hebbian');
      }

      const c = await retraction.computeNeighborhoodCohesion(A, 1);
      // depth=1: subgraph = {A, B, C}.
      // Edges from A,B,C: A-B (internal), A-C (internal), B→8 outers (external).
      // Internal=2, External=8 → density = 2/10 = 0.2
      expect(c.subgraphSize).toBe(2);
      expect(c.graphDensity).toBeCloseTo(0.2, 1);
      expect(c.score).toBeLessThan(0.4);
    });
  });

  describe('retraction propagation amplifies in dense clusters, dampens in isolation', () => {
    it('densely-coherent cluster → neighbor confidence drops MORE than baseline (cohesion=neutral)', async () => {
      // Two equivalent graphs, identical baseline confidence:
      //   - Coherent: triangle A↔B↔C with shared tags
      //   - Loose: chain A→B→C with no shared tags
      // Retract A in each; B+C confidence drop should be LARGER in coherent case.
      const sharedTags = ['proj=Aurora', 'topic=billing'];

      // Coherent cluster
      const ca = store.createEngram({ agentId: AGENT, concept: 'A1', content: 'billing fact A', tags: sharedTags, confidence: 0.7 });
      const cb = store.createEngram({ agentId: AGENT, concept: 'B1', content: 'billing fact B', tags: sharedTags, confidence: 0.7 });
      const cc = store.createEngram({ agentId: AGENT, concept: 'C1', content: 'billing fact C', tags: sharedTags, confidence: 0.7 });
      store.upsertAssociation(ca.id, cb.id, 0.7, 'hebbian');
      store.upsertAssociation(cb.id, cc.id, 0.7, 'hebbian');
      store.upsertAssociation(cc.id, ca.id, 0.7, 'hebbian');

      // Loose chain (different agent so they don't pollute)
      const loose = 'coh-test-loose';
      const la = store.createEngram({ agentId: loose, concept: 'A2', content: 'fact A', tags: ['t1'], confidence: 0.7 });
      const lb = store.createEngram({ agentId: loose, concept: 'B2', content: 'fact B', tags: ['t2'], confidence: 0.7 });
      const lc = store.createEngram({ agentId: loose, concept: 'C2', content: 'fact C', tags: ['t3'], confidence: 0.7 });
      store.upsertAssociation(la.id, lb.id, 0.7, 'hebbian');
      store.upsertAssociation(lb.id, lc.id, 0.7, 'hebbian');

      // Retract A in each
      const coherentResult = await retraction.retract({
        agentId: AGENT, targetEngramId: ca.id, reason: 'wrong',
      });
      const looseResult = await retraction.retract({
        agentId: loose, targetEngramId: la.id, reason: 'wrong',
      });

      expect(coherentResult.cohesion.score).toBeGreaterThan(looseResult.cohesion.score);

      // Read updated confidences
      const cbAfter = store.getEngram(cb.id)!;
      const lbAfter = store.getEngram(lb.id)!;
      const coherentDrop = 0.7 - cbAfter.confidence;
      const looseDrop = 0.7 - lbAfter.confidence;

      expect(coherentDrop).toBeGreaterThan(looseDrop);
    });

    it('isolated engram retraction does not propagate (no neighbors → score=0 → no penalty)', async () => {
      const a = store.createEngram({ agentId: AGENT, concept: 'orphan', content: 'lonely', confidence: 0.7 });
      const result = await retraction.retract({ agentId: AGENT, targetEngramId: a.id, reason: 'wrong' });
      expect(result.associatesAffected).toBe(0);
      expect(result.cohesion.score).toBe(0);
    });
  });

  describe('counter-narrative replacement (inheritNarrativeEdges)', () => {
    it('correction inherits strong-edge neighbors from the retracted memory', async () => {
      // Build a small narrative: wrong-fact at the center, three strong-edge neighbors.
      const wrong = store.createEngram({ agentId: AGENT, concept: 'project alpha launch date', content: 'Project Alpha launches Tuesday', tags: ['proj=alpha'] });
      const n1 = store.createEngram({ agentId: AGENT, concept: 'project alpha team', content: 'Team is 5 engineers', tags: ['proj=alpha'] });
      const n2 = store.createEngram({ agentId: AGENT, concept: 'project alpha budget', content: 'Budget is $200K', tags: ['proj=alpha'] });
      const n3 = store.createEngram({ agentId: AGENT, concept: 'project alpha tech stack', content: 'Stack: Postgres + Node', tags: ['proj=alpha'] });
      store.upsertAssociation(wrong.id, n1.id, 0.7, 'connection');
      store.upsertAssociation(wrong.id, n2.id, 0.6, 'connection');
      store.upsertAssociation(wrong.id, n3.id, 0.5, 'connection');

      const result = await retraction.retract({
        agentId: AGENT,
        targetEngramId: wrong.id,
        reason: 'wrong date',
        counterContent: 'Project Alpha launches Wednesday',
      });

      expect(result.correctionId).toBeTruthy();
      expect(result.narrativeEdgesInherited).toBe(3);

      // Verify the correction now has edges to all three neighbors
      const correctionAssocs = store.getAssociationsFor(result.correctionId!);
      const neighborIds = new Set(correctionAssocs.map(a =>
        a.fromEngramId === result.correctionId ? a.toEngramId : a.fromEngramId
      ));
      expect(neighborIds.has(n1.id)).toBe(true);
      expect(neighborIds.has(n2.id)).toBe(true);
      expect(neighborIds.has(n3.id)).toBe(true);
    });

    it('inherited edges have reduced weight (0.7× original)', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      const neighbor = store.createEngram({ agentId: AGENT, concept: 'n', content: 'fact' });
      store.upsertAssociation(wrong.id, neighbor.id, 0.8, 'connection');

      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x', counterContent: 'right',
      });

      const assocs = store.getAssociationsFor(result.correctionId!);
      const inherited = assocs.find(a =>
        (a.fromEngramId === result.correctionId && a.toEngramId === neighbor.id) ||
        (a.toEngramId === result.correctionId && a.fromEngramId === neighbor.id)
      );
      expect(inherited).toBeDefined();
      expect(inherited!.weight).toBeCloseTo(0.8 * 0.7, 5);
    });

    it('skips edges below the inheritance threshold (weight < 0.4)', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      const strong = store.createEngram({ agentId: AGENT, concept: 's', content: 'strong' });
      const weak = store.createEngram({ agentId: AGENT, concept: 'wk', content: 'weak' });
      store.upsertAssociation(wrong.id, strong.id, 0.6, 'connection');
      store.upsertAssociation(wrong.id, weak.id, 0.2, 'connection');

      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x', counterContent: 'right',
      });

      expect(result.narrativeEdgesInherited).toBe(1);
      // Verify the strong one was inherited, weak one was not
      const assocs = store.getAssociationsFor(result.correctionId!);
      const inheritedIds = new Set(assocs.map(a =>
        a.fromEngramId === result.correctionId ? a.toEngramId : a.fromEngramId
      ));
      expect(inheritedIds.has(strong.id)).toBe(true);
      expect(inheritedIds.has(weak.id)).toBe(false);
    });

    it('skips edge types with special semantics (causal, temporal, invalidation)', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      const causal = store.createEngram({ agentId: AGENT, concept: 'cause', content: 'cause' });
      const temporal = store.createEngram({ agentId: AGENT, concept: 'before', content: 'before' });
      const narrative = store.createEngram({ agentId: AGENT, concept: 'context', content: 'context' });
      store.upsertAssociation(wrong.id, causal.id, 0.7, 'causal');
      store.upsertAssociation(wrong.id, temporal.id, 0.7, 'temporal');
      store.upsertAssociation(wrong.id, narrative.id, 0.7, 'connection');

      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x', counterContent: 'right',
      });

      // Only the 'connection' type should be inherited; causal/temporal skipped.
      expect(result.narrativeEdgesInherited).toBe(1);
      const assocs = store.getAssociationsFor(result.correctionId!);
      const inheritedIds = new Set(assocs.map(a =>
        a.fromEngramId === result.correctionId ? a.toEngramId : a.fromEngramId
      ));
      expect(inheritedIds.has(narrative.id)).toBe(true);
      expect(inheritedIds.has(causal.id)).toBe(false);
      expect(inheritedIds.has(temporal.id)).toBe(false);
    });

    it('skips retracted neighbors (no point connecting to other wrong memories)', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      const alsoRetracted = store.createEngram({ agentId: AGENT, concept: 'also-wrong', content: 'also wrong' });
      const healthy = store.createEngram({ agentId: AGENT, concept: 'ok', content: 'ok' });
      store.upsertAssociation(wrong.id, alsoRetracted.id, 0.6, 'connection');
      store.upsertAssociation(wrong.id, healthy.id, 0.6, 'connection');
      // Pre-retract the "alsoRetracted" engram
      store.retractEngram(alsoRetracted.id, null);

      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x', counterContent: 'right',
      });

      expect(result.narrativeEdgesInherited).toBe(1);
      const assocs = store.getAssociationsFor(result.correctionId!);
      const inheritedIds = new Set(assocs.map(a =>
        a.fromEngramId === result.correctionId ? a.toEngramId : a.fromEngramId
      ));
      expect(inheritedIds.has(healthy.id)).toBe(true);
      expect(inheritedIds.has(alsoRetracted.id)).toBe(false);
    });

    it('caps at top-10 edges by weight', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      // Create 15 neighbors with descending weights
      const neighbors: string[] = [];
      for (let i = 0; i < 15; i++) {
        const n = store.createEngram({ agentId: AGENT, concept: `n${i}`, content: `neighbor ${i}` });
        store.upsertAssociation(wrong.id, n.id, 0.9 - i * 0.03, 'connection');
        neighbors.push(n.id);
      }
      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x', counterContent: 'right',
      });

      expect(result.narrativeEdgesInherited).toBe(10);
      // Verify top-10 (by weight) were inherited — that's neighbors[0..9]
      const assocs = store.getAssociationsFor(result.correctionId!);
      const inheritedIds = new Set(assocs.map(a =>
        a.fromEngramId === result.correctionId ? a.toEngramId : a.fromEngramId
      ));
      for (let i = 0; i < 10; i++) expect(inheritedIds.has(neighbors[i])).toBe(true);
      // Below the cutoff
      for (let i = 10; i < 15; i++) expect(inheritedIds.has(neighbors[i])).toBe(false);
    });

    it('returns 0 inherited when no counterContent provided', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'w', content: 'wrong' });
      const n = store.createEngram({ agentId: AGENT, concept: 'n', content: 'n' });
      store.upsertAssociation(wrong.id, n.id, 0.7, 'connection');

      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: wrong.id, reason: 'x',
        // no counterContent
      });

      expect(result.correctionId).toBeNull();
      expect(result.narrativeEdgesInherited).toBe(0);
    });
  });

  describe('contract compatibility', () => {
    it('retract() result still includes retractedId, correctionId, associatesAffected', async () => {
      const a = store.createEngram({ agentId: AGENT, concept: 'x', content: 'x' });
      const result = await retraction.retract({
        agentId: AGENT, targetEngramId: a.id, reason: 'wrong', counterContent: 'right',
      });
      expect(result.retractedId).toBe(a.id);
      expect(result.correctionId).toBeTruthy();
      expect(typeof result.associatesAffected).toBe('number');
      // New field — cohesion — is additive, doesn't break older callers.
      expect(result.cohesion).toBeDefined();
      expect(result.cohesion.score).toBeGreaterThanOrEqual(0);
      expect(result.cohesion.score).toBeLessThanOrEqual(1);
    });

    it('legacy correction creation behavior preserved', async () => {
      const wrong = store.createEngram({ agentId: AGENT, concept: 'http 418 is timeout', content: 'wrong' });
      const result = await retraction.retract({
        agentId: AGENT,
        targetEngramId: wrong.id,
        reason: 'incorrect',
        counterContent: 'HTTP 418 is "I am a Teapot"',
      });
      const retracted = store.getEngram(wrong.id)!;
      expect(retracted.retracted).toBe(true);
      expect(retracted.retractedBy).toBe(result.correctionId);
      const correction = store.getEngram(result.correctionId!)!;
      expect(correction.stage).toBe('active');
      expect(correction.concept.startsWith('correction:')).toBe(true);
    });
  });
});
