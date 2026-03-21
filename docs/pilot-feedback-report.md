# Pilot Feedback Report

Date: 2026-03-10
Project: AgentWorkingMemory (AWM)
Stage: Pilot

## 1) Scope and Product Intent (Confirmed)
- Primary target is a local developer workflow.
- Goal is a small, lightweight cognitive memory layer for an agent.
- System should improve recall of ongoing work context between sessions.
- Security needs are pragmatic for local use, with interest in a simple API key gate to reduce accidental/unauthorized injection.

## 2) Positive Signals and Observed Wins
- Sleep cycle/consolidation behavior appears to improve subsequent recall quality.
- Existing evaluation artifacts show consistent directionality in favor of AWM behavior over naive retrieval in pilot-style scenarios.
- Architecture remains simple for local deployment (single service + SQLite + local models), aligned with pilot constraints.

## 3) Consolidated Feedback Items

### 3.1 Product/Architecture Feedback
- Keep local-first simplicity as the main product posture for pilot.
- Avoid over-optimizing for multi-tenant or internet-facing production at this stage.
- Prefer one writer process per DB file during pilot (MCP-only or HTTP-only per instance).

### 3.2 Security Feedback
- Add optional lightweight auth for HTTP routes.
- Suggested approach:
  - `AWM_API_KEY` enables auth.
  - Accept `x-api-key` and/or `Authorization: Bearer <key>`.
  - Keep `/health` unauthenticated.
- Rationale: low-friction protection while preserving local-dev ergonomics.

### 3.3 Testing and Evaluation Quality Feedback
- Test suite is broad and creative (self-test, stress, edge cases, A/B, LOCOMO, sleep-cycle).
- Current quality caveats:
  - LOCOMO runner currently evaluates a single conversation index, limiting representativeness.
  - Some stress/edge checks rely on topic-tag matching, which can overestimate evidence-level recall quality.
  - A/B baseline is intentionally weak (keyword-based), so win margin is directional, not definitive.
  - Randomness in several runners reduces strict run-to-run comparability.
  - MCP smoke test coverage appears behind current MCP tool surface.
  - Deterministic unit/integration test count is still relatively small compared to scenario-runner surface.

### 3.4 Operational Feedback
- Reported benchmark percentages are useful for pilot trend monitoring.
- They should not yet be treated as production-grade proof without tighter reproducibility and broader benchmark coverage.

## 4) Pilot Interpretation
- Status: Promising and worth continuing.
- Confidence level: Medium for pilot usefulness, lower for production generalization.
- Most important validated hypothesis so far:
  - Consolidation/sleep-cycle can improve next-recall quality in practical workflows.

## 5) Priority Actions for Next Pilot Iteration
1. Implement optional API key auth for HTTP endpoints.
2. Add deterministic mode (seeded random) to stress/self-test runners.
3. Expand LOCOMO run to all available conversations and report mean + variance.
4. Refresh MCP smoke test to current tool inventory.
5. Define pilot checkpoints and track trend metrics per run:
   - pre-vs-post sleep recall hit rate
   - top-1 relevance on fixed query set
   - noise in top-5
   - latency and DB growth over time

## 6) Suggested Pilot Decision Gates
- Continue pilot if:
  - post-sleep recall improvement remains consistent across multiple runs,
  - false recall/noise remains controlled,
  - latency remains acceptable for local developer use.
- Pause and rework if:
  - recall gains are inconsistent after code changes,
  - noise contamination rises,
  - retrieval quality regresses on fixed seeded scenarios.

## 7) Summary
AWM currently fits the intended local-developer pilot: lightweight, practical, and showing evidence of meaningful recall improvement after consolidation. The main next step is not major architectural expansion, but tightening security basics and evaluation rigor so pilot gains can be trusted and repeated.
