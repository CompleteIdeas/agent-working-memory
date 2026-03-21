# Layer Review Report

Date: 2026-03-10
Project: AgentWorkingMemory (AWM)
Reviewer Perspective: Experienced coworker / design review

## Executive Summary
This system looks promising for the stated local-developer use case. It is not just a thin vector-store wrapper: the integration of salience filtering, associative linking, consolidation, and retraction creates meaningful behavior over time.

Novelty appears mostly in architecture composition and practical retrieval behavior rather than in any single new algorithm. No major rewrite is recommended at this stage.

## Scope and Intent Alignment
- Intended use: local, lightweight cognitive memory for agents working in large codebases.
- Current architecture generally matches this intent.
- Current pilot evidence (especially sleep-cycle recall improvement) supports continued investment.

## Layer-by-Layer Review

### 1) Write and Salience Layer
Primary files:
- `src/core/salience.ts`
- `src/api/routes.ts`

What looks strong:
- Noise is filtered before storage, improving long-term signal quality.
- Salience metadata and reason codes are preserved for explainability.

Questions to explore:
- Should salience thresholds adapt per agent/project based on feedback history?
- Should specific project archetypes (monorepo, infra-heavy, frontend-heavy) have preset salience profiles?

### 2) Activation and Retrieval Layer
Primary files:
- `src/engine/activation.ts`
- `src/core/embeddings.ts`
- `src/core/reranker.ts`
- `src/core/query-expander.ts`

What looks strong:
- Multi-signal retrieval pipeline is suitable for complex codebase memory tasks.
- Reranker and expansion are practical quality boosters in local settings.

Questions to explore:
- Should blend weights become feedback-trained instead of static heuristics?
- Should there be a strict “high precision mode” for critical coding tasks (fewer but safer recalls)?

### 3) Associative Graph Layer
Primary files:
- `src/core/hebbian.ts`
- `src/engine/connections.ts`

What looks strong:
- Association growth helps cross-topic recall and emergent linkage.

Questions to explore:
- Should internal maintenance activations avoid incrementing user-facing access/association signals?
- Should graph update policies differ for task memories vs knowledge memories?

### 4) Sleep / Consolidation Layer
Primary file:
- `src/engine/consolidation.ts`

What looks strong:
- This appears to be a key differentiator.
- Pilot observation that recall improves after sleep cycle is strategically important.

Questions to explore:
- Would episode-first consolidation reduce accidental bridge overshoot in very large codebases?
- Should consolidation cadence be adaptive to memory growth rate rather than fixed intervals?

### 5) Retraction and Correction Layer
Primary file:
- `src/engine/retraction.ts`

What looks strong:
- Explicit invalidation/correction path is strong and practical.

Questions to explore:
- Should retracted neighborhoods get temporary rank suppression until reconfirmed?
- Should correction confidence ramp based on repeated successful retrieval feedback?

### 6) Storage and Persistence Layer
Primary file:
- `src/storage/sqlite.ts`

What looks strong:
- SQLite is appropriate for local-first simplicity.
- FTS5 + embeddings + graph metadata in one store is operationally efficient.

Questions to explore:
- For heavy ingest, should embedding updates be batched to reduce write jitter?
- Do you want a simple migration/version table before schema changes accelerate?

### 7) Interface Layer (HTTP + MCP)
Primary files:
- `src/mcp.ts`
- `src/api/routes.ts`

What looks strong:
- MCP integration is well aligned with assistant workflows.

Questions to explore:
- During pilot, should one interface be canonical per DB instance to avoid writer contention?
- Should optional lightweight API key auth be enabled by default for non-loopback binds?

### 8) Evaluation Layer
Primary files:
- `src/engine/eval.ts`
- `tests/`

What looks strong:
- Broad scenario coverage and practical stress-focused tests.

Questions to explore:
- What are the 3 pilot KPIs that decide ship/no-ship regardless of benchmark score?
- Should reproducible seeded runs become mandatory for weekly regression checks?

## Novelty Assessment
- Not novel because of one exclusive algorithm.
- Novel/valuable because of cohesive, local-first cognitive behavior:
  - selective encoding (salience)
  - associative memory updates (Hebbian + graph walk)
  - time-based consolidation and forgetting
  - explicit correction mechanics

This combination is differentiated enough to matter if it keeps producing real workflow gains.

## Better Approach? (Current Recommendation)
No major architectural change is required now.

Most leverage comes from tightening and tuning:
1. Add lightweight auth for local safety.
2. Improve metric fidelity and reproducibility.
3. Keep consolidation and retrieval tuning grounded in pilot KPIs.
4. Preserve simplicity; avoid premature distributed complexity.

## Suggested Pilot KPIs
- Post-sleep recall gain on fixed query set.
- Noise-in-top-5 rate.
- Helpful-feedback ratio over time.
- P95 activation latency.
- Memory DB growth vs retained useful recall.

## Final Recommendation
Continue pilot with current architecture. Focus on trustworthiness and repeatability improvements rather than large redesign.
