# Stress Test Results — 2026-03-24T13:08:52.499Z

## Summary
| Phase | Pass | Total | Score |
|-------|------|-------|-------|
| Phase 0: Baseline | 10 | 10 | 100% |
| Phase 1: Scale 500 | 10 | 10 | 100% |
| Phase 2: 100 Cycles | 5 | 5 | 100% |
| Phase 3: Catastrophic Forgetting | 5 | 5 | 100% |
| Phase 4: Bridge Formation | 3 | 5 | 60% |
| Phase 5: Adversarial | 7 | 7 | 100% |
| Phase 6: Recovery | 10 | 10 | 100% |
| **OVERALL** | **50** | **52** | **96.2%** |

## Final Stats
- Total memories: 105 (active=95)
- Associations: 6644
- Avg confidence: 0.741

## Graph Health
| Cycle | Edges | Active | Recall | Cross |
|-------|-------|--------|--------|-------|
| 1 | 4322 | 402 | 100% | 80% |
| 10 | 3305 | 312 | 90% | 20% |
| 20 | 5260 | 212 | 90% | 0% |
| 30 | 6088 | 175 | 90% | 20% |
| 40 | 6098 | 113 | 100% | 40% |
| 50 | 5630 | 111 | 100% | 40% |
| 60 | 5149 | 110 | 100% | 40% |
| 70 | 4630 | 106 | 100% | 40% |
| 80 | 4428 | 105 | 100% | 40% |
| 90 | 4208 | 102 | 90% | 40% |
| 100 | 3843 | 90 | 80% | 20% |

## Phase Details
### Phase 0: Baseline
  [PASS] relativity time dilation clocks
  [PASS] Maillard reaction searing browning
  [PASS] bond prices interest rates inverse
  [PASS] insulin blood glucose diabetes
  [PASS] minor scale melancholic harmonic
  [PASS] E=mc^2 mass energy equivalence
  [PASS] compound interest exponential growth
  [PASS] vaccine immune memory cells
  [PASS] sous vide precise temperature cooking
  [PASS] chord progression harmony tension


### Phase 1: Scale 500
  [PASS] relativity time dilation clocks
  [PASS] Maillard reaction searing browning
  [PASS] bond prices interest rates inverse
  [PASS] insulin blood glucose diabetes
  [PASS] minor scale melancholic harmonic
  [PASS] E=mc^2 mass energy equivalence
  [PASS] compound interest exponential growth
  [PASS] vaccine immune memory cells
  [PASS] sous vide precise temperature cooking
  [PASS] chord progression harmony tension

Metrics: {"seedTimeS":468.4,"memPerMin":"64"}

### Phase 2: 100 Cycles
  Edge ratio (first→last): 0.89x (4322→3843)
  Recall stable (last 5 checks ≥40%): true
  Cycle 1: edges=4322 active=402 recall=100% cross=80%
  Cycle 10: edges=3305 active=312 recall=90% cross=20%
  Cycle 20: edges=5260 active=212 recall=90% cross=0%
  Cycle 30: edges=6088 active=175 recall=90% cross=20%
  Cycle 40: edges=6098 active=113 recall=100% cross=40%
  Cycle 50: edges=5630 active=111 recall=100% cross=40%
  Cycle 60: edges=5149 active=110 recall=100% cross=40%
  Cycle 70: edges=4630 active=106 recall=100% cross=40%
  Cycle 80: edges=4428 active=105 recall=100% cross=40%
  Cycle 90: edges=4208 active=102 recall=90% cross=40%
  Cycle 100: edges=3843 active=90 recall=80% cross=20%

Metrics: {"edgeRatio":0.8891716797778806,"lastRecall":80}

### Phase 3: Catastrophic Forgetting
  [SURVIVED] E=mc^2 mass energy equivalence
  [SURVIVED] resting meat juices redistribute cooking
  [SURVIVED] diversification portfolio risk reduction
  [SURVIVED] vaccine immune memory cells response
  [SURVIVED] minor scale melancholic harmonic

Metrics: {"survived":5,"total":5}

### Phase 4: Bridge Formation
  Pre-bridge: 1/5
  Post-bridge: 3/5
  Improvement: YES (+2)
  [PASS] CROSS: timing and measurement in physics and music (physics,music)
  [FAIL] CROSS: precise temperature control in medicine and cookin — only found [cooking]
  [PASS] CROSS: exponential growth compounding biology finance (finance,medicine)
  [FAIL] CROSS: energy transformation chemical and nuclear reactio — only found [physics]
  [PASS] CROSS: risk diversification defense immune system portfol (medicine,finance)


### Phase 5: Adversarial
  Retracted in results: 0 (want 0)
  Spam in physics top-10: 0 (want ≤2)
  Post-spam recall: 5/5


### Phase 6: Recovery
  Baseline was: 100%
  Recovery: 100% (target: ≥70%)
  Recovered: YES
  [PASS] relativity time dilation clocks
  [PASS] Maillard reaction searing browning
  [PASS] bond prices interest rates inverse
  [PASS] insulin blood glucose diabetes
  [PASS] minor scale melancholic harmonic
  [PASS] E=mc^2 mass energy equivalence
  [PASS] compound interest exponential growth
  [PASS] vaccine immune memory cells
  [PASS] sous vide precise temperature cooking
  [PASS] chord progression harmony tension

Metrics: {"baselinePct":100,"recoveryPct":100,"recovered":true}
