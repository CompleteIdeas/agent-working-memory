# Memory Quality Hardening RFC

## Purpose

This RFC turns recent real-world findings into implementation tasks that improve recall precision, reduce stale/noisy memory retrieval, and lower token waste during long multi-agent workflows.

## Findings This RFC Responds To

- Recall returned mixed domains (requirements + architecture + migration history + unrelated project context) for focused requirements tasks.
- Stale facts were still present in memory and required manual cleanup passes.
- Important status summaries were sometimes stored as `staging` and did not reliably dominate recall.
- Teams spent significant effort manually removing anecdotal or political context from requirement docs after memory-assisted ingestion.
- Operational validation required a stable Vitest mode (`--pool=forks --maxWorkers=1`) due runtime/thread instability in default modes.

## Proposed Changes

### 1. Memory classes with policy

Change:
- Add `memory_class` to engrams: `canonical | working | historical | task_log`.
- Add per-class defaults for salience floor, TTL, and recall weighting.

Why:
- Mixed-domain recall indicates one global ranking is not enough.
- Canonical truth and task logs should not compete equally.

Acceptance:
- `canonical` memories are never staged.
- `task_log` memories have lower default recall rank and optional TTL.
- Recall top-5 for requirements queries contains at least 4 class-compatible results in eval suite.

---

### 2. Explicit supersession graph

Change:
- Add nullable fields: `supersedes_engram_id`, `superseded_by_engram_id`, `supersession_reason`.
- Add MCP/API operation: `memory_supersede(oldId, newId, reason)`.

Why:
- Stale entries had to be identified manually; the system should encode "new truth replaces old truth."

Acceptance:
- Superseded memories are down-ranked by default recall.
- `memory_recall` optionally includes superseded items only when `includeHistorical=true`.
- Tests verify a superseded memory cannot outrank its successor for equivalent query intent.

---

### 3. Mandatory task-end memory hygiene

Change:
- Extend `memory_task_end` to run:
  1. canonical summary write
  2. stale candidate detection
  3. supersede/retract suggestions (or auto-apply in strict mode)
  4. checkpoint

Why:
- Manual cleanup after each work block is expensive and inconsistent.

Acceptance:
- Every `memory_task_end` generates exactly one canonical session summary.
- If stale candidates exist, tool output includes explicit supersession actions.

---

### 4. Actionability scoring in retrieval

Change:
- Add `actionability_score` feature (0..1) computed from requirement-like signals:
  - business rule language
  - system constraints
  - interface/data model impact
  - acceptance criteria structure
- Blend into composite score after text relevance gate.

Why:
- User explicitly reported non-actionable context overshadowing system requirements.

Acceptance:
- For requirement-focused eval prompts, actionable precision@5 improves against baseline.
- Anecdotal/personality-heavy memories receive lower ranking unless query explicitly targets history/context.

---

### 5. Domain-tag-first recall

Change:
- Require at least one domain tag in writes (`requirements`, `status`, `architecture`, `operations`, etc.).
- Add first-pass recall by matching/expanding domain tags, then global fallback.

Why:
- Cross-domain bleed was observed during requirements reconciliation tasks.

Acceptance:
- Query with `domain=requirements` does not return non-requirement memories in top-5 unless insufficient candidates exist.

---

### 6. Canonical dedupe and cluster winner

Change:
- Add duplicate cluster pass for high-similarity same-domain memories.
- Elect a canonical winner by freshness, confidence, and explicit supersession links.
- Keep non-winners as linked variants.

Why:
- Multiple near-duplicate status memories created contradictions and extra token use.

Acceptance:
- Duplicate clusters expose one canonical default result.
- Variant memories remain accessible via detail/diagnostic APIs.

---

### 7. Replace binary negative-memory model with stateful validity

Change:
- Add `validity_state`: `valid | stale | superseded | incorrect`.
- Keep retraction for `incorrect`, prefer supersession for `stale/superseded`.

Why:
- Not all old memories are wrong; many are historically true but no longer current.

Acceptance:
- Default recall excludes `stale/superseded/incorrect` unless requested.
- Historical queries can include stale data intentionally.

---

### 8. Stronger recency policy for volatile facts

Change:
- Add volatility hint (manual or inferred): `low | medium | high`.
- Apply stronger decay for high-volatility classes (`status`, schedules, counts).

Why:
- Operational truth changed quickly and old states lingered.

Acceptance:
- High-volatility memories older than configured window lose priority unless reinforced recently.

---

### 9. Evaluation suite for actionable retrieval quality

Change:
- Add eval set with labeled queries and labels:
  - actionable requirement
  - stale status
  - historical context
- Track precision@k and stale suppression rate.

Why:
- Existing tests validate mechanics; they do not fully validate requirement relevance quality.

Acceptance:
- CI publishes actionable precision@5 and stale suppression metrics.
- Regression threshold blocks merge when metrics degrade beyond tolerance.

---

### 10. Stable CI execution profile for ML/runtime tests

Change:
- Set default CI test command to:
  - `npx vitest run --pool=forks --maxWorkers=1`
- Optionally split pure-unit and ML/integration jobs.

Why:
- Default parallel runtime produced instability and masked true signal.

Acceptance:
- CI test runs are deterministic across repeated runs on target runner.
- Flake rate remains below agreed threshold.

## Data Model and API Sketch

Minimum schema additions:

- `engrams.memory_class TEXT NOT NULL DEFAULT 'working'`
- `engrams.validity_state TEXT NOT NULL DEFAULT 'valid'`
- `engrams.volatility TEXT NOT NULL DEFAULT 'medium'`
- `engrams.supersedes_engram_id TEXT NULL`
- `engrams.superseded_by_engram_id TEXT NULL`
- `engrams.actionability_score REAL NOT NULL DEFAULT 0.0`

Minimum API/MCP additions:

- `memory_supersede`
- `memory_reclassify`
- `memory_hygiene` (optional explicit trigger)

## Rollout Plan

1. Schema migration + backward-compatible defaults.
2. Write-path updates (class/tag/validity/actionability inference).
3. Recall scoring updates (domain-first, supersession, actionability).
4. Task-end hygiene integration.
5. Eval metrics + CI threshold enforcement.

## Non-Goals

- This RFC does not change core storage technology (SQLite remains).
- This RFC does not require cloud retrieval services.
- This RFC does not replace existing salience/decay logic; it extends ranking and lifecycle controls.
