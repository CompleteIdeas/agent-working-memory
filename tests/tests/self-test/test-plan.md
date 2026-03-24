# AgentWorkingMemory — Self-Test Plan

## Purpose
This test plan is designed for an AI agent (Claude) to run against a live AWM
server. The agent acts as both the user of the memory system and the evaluator.
The goal: objectively measure whether the memory system helps and find where
it breaks down.

---

## Test Dimensions

### 1. WRITE QUALITY — Does the salience filter keep the right things?
**Objective:** Agent writes 50 observations of varying importance. Verify that
high-value observations are stored, low-value are discarded, and borderline
cases go to staging.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 1.1 Obvious keep | Write 10 causal discoveries | All 10 → active |
| 1.2 Obvious discard | Write 10 trivial observations ("file read ok") | All 10 → discard |
| 1.3 Borderline → staging | Write 10 mild friction events | ≥7 → staging |
| 1.4 Decision moments | Write 10 decision records | All 10 → active |
| 1.5 Mixed batch | Write 10 mixed-signal observations | Correct 3-way split ≥80% |

**Scoring:** `write_accuracy = correct_dispositions / total_writes`

---

### 2. RETRIEVAL PRECISION — Does activation return relevant memories?
**Objective:** After populating memory, query with 20 different contexts and
judge whether returned memories are actually relevant.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 2.1 Exact topic match | Query "database indexing" after writing DB memories | Top result is DB-related |
| 2.2 Semantic neighbor | Query "speeding up queries" (no literal overlap) | Still finds DB memories |
| 2.3 Cross-domain isolation | Query "cooking" after writing DB + cooking | Only cooking results |
| 2.4 Temporal recency | Query after writing old + new on same topic | New scores higher |
| 2.5 Frequency boost | Query topic that was accessed 10x vs 1x | 10x scores higher |
| 2.6 Empty context | Query topic with no related memories | Returns empty or low scores |
| 2.7 Noise resistance | Query with irrelevant words mixed in | Still finds signal |

**Scoring:** `precision_at_5 = relevant_in_top_5 / min(5, total_returned)`

---

### 3. ASSOCIATION QUALITY — Do Hebbian links form correctly?
**Objective:** Trigger co-activations and verify that association edges form
between related memories and NOT between unrelated ones.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 3.1 Co-activation creates edges | Activate 2 related memories together 3x | Edge weight > 0.1 |
| 3.2 Repeated co-activation strengthens | Activate same pair 10x | Weight increases monotonically |
| 3.3 Unrelated no edges | Activate unrelated memories separately | No edge between them |
| 3.4 Edge graph boost | Memory A linked to B, query B → A gets graph boost | A.graphBoost > 0 |
| 3.5 Edge decay works | Stop co-activating, run decay | Weight decreases |

**Scoring:** `association_accuracy = correct_edge_presence / total_checked`

---

### 4. RETRACTION — Does negative memory work?
**Objective:** Write wrong memories, retract them, verify they don't contaminate
future activations.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 4.1 Retracted hidden | Retract memory, activate same topic | Retracted not returned |
| 4.2 Correction surfaces | Retract + provide correction | Correction returned instead |
| 4.3 Confidence propagation | Retract, check neighbors | Neighbor confidence decreased |
| 4.4 Audit trail | Inspect retracted engram | retracted=true, retractedBy set |

**Scoring:** `retraction_accuracy = correct_behavior / total_retraction_tests`

---

### 5. EVICTION — Does capacity management work?
**Objective:** Fill memory to capacity, verify eviction targets the right engrams.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 5.1 Over-capacity eviction | Write 20 with cap 10, evict | Count = 10 |
| 5.2 Low-value evicted first | Mix high/low salience, evict | Low-salience archived |
| 5.3 Frequently accessed survive | Access some 10x, evict | High-access survive |
| 5.4 Edge pruning | Create 30 edges on one engram (cap 20) | Weakest pruned to 20 |

**Scoring:** `eviction_accuracy = correct_survivors / expected_survivors`

---

### 6. STAGING BUFFER — Does promotion/discard work?
**Objective:** Write staging entries, verify that resonant ones promote and
non-resonant ones discard.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 6.1 Resonance promotes | Stage entry, write related active memory, sweep | Staged → promoted |
| 6.2 No resonance discards | Stage entry with no related memories, expire TTL, sweep | Staged → discarded |
| 6.3 Promotion logged | Check staging_events after promotion | Event logged with action='promoted' |

**Scoring:** `staging_accuracy = correct_outcomes / total_staging_tests`

---

### 7. FEEDBACK LOOP — Does confidence update correctly?
**Objective:** Provide positive/negative feedback and verify confidence adjusts.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 7.1 Positive feedback | Mark memory useful | Confidence increases |
| 7.2 Negative feedback | Mark memory not useful | Confidence decreases |
| 7.3 Repeated negative kills ranking | Mark memory bad 5x, activate | Drops in ranking |
| 7.4 Feedback logged | Check retrieval_feedback table | Events recorded |

**Scoring:** `feedback_accuracy = correct_direction / total_feedback_tests`

---

### 8. EVAL METRICS — Are measurements accurate?
**Objective:** After running all above tests, verify eval metrics reflect reality.

| Test | Method | Pass Criteria |
|------|--------|---------------|
| 8.1 Precision reflects feedback | Compare metrics.avgPrecisionAtK to actual | Within ±10% |
| 8.2 Staging metrics match | Compare metrics staging counts to actual | Exact match |
| 8.3 Edge utility tracked | Check edgeUtilityRate > 0 after activations | > 0 |
| 8.4 Retraction rate accurate | Compare retractionRate to actual | Exact match |

---

## Composite Scoring

```
overall_score = (
  write_accuracy * 0.15 +
  precision_at_5 * 0.25 +          # Retrieval is the most important
  association_accuracy * 0.15 +
  retraction_accuracy * 0.10 +
  eviction_accuracy * 0.10 +
  staging_accuracy * 0.10 +
  feedback_accuracy * 0.05 +
  eval_accuracy * 0.10
)
```

**Grade scale:**
- 0.90+ = Excellent — memory system is reliably helping
- 0.75-0.89 = Good — core works, edges need tuning
- 0.60-0.74 = Fair — fundamental issues to address
- <0.60 = Poor — major rework needed

---

## Self-Improvement Protocol

After running the test suite, the agent should:

1. **Identify weakest dimension** — which category scored lowest?
2. **Analyze failures** — what specific tests failed and why?
3. **Hypothesize fixes** — what parameter changes or code changes would help?
4. **Test hypothesis** — re-run affected tests with changes
5. **Log findings** — write results to memory (meta: the system remembering how to improve itself)

This creates a recursive improvement loop where the memory system gets better
at remembering by remembering what made it better at remembering.
