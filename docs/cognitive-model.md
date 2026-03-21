# Cognitive Model

AWM's design draws from established cognitive science theories. This document explains the theoretical foundations and how they map to implementation.

## ACT-R Activation Decay

**Theory** (Anderson 1993): Memory activation decays as a power law of time since last access. Frequently accessed memories decay more slowly.

**In AWM** (`src/core/decay.ts`):
- Each memory has a `last_access` timestamp and `access_count`
- Activation score decreases with time: `decay = t^(-d)` where `d` is the decay rate
- Multiple accesses create multiple time traces that sum
- High-access memories resist decay proportionally

**Effect**: Recent and frequently-used memories surface first. Old, unused memories gradually fade from retrieval results without manual cleanup.

## Hebbian Learning

**Theory** (Hebb 1949): "Neurons that fire together wire together." Co-activated neural pathways strengthen their connections.

**In AWM** (`src/core/hebbian.ts`, `src/engine/connections.ts`):
- When two memories are retrieved together, a weighted edge forms between them
- Repeated co-retrieval strengthens the edge (weight increases)
- Edges that stop co-firing weaken over consolidation cycles
- Graph walk during retrieval follows strong edges to find related memories

**Effect**: Natural topic clusters emerge. Retrieving one memory about "Express middleware" naturally surfaces related memories about "error handling" and "route guards" if they were previously recalled together.

## Complementary Learning Systems (CLS)

**Theory** (McClelland et al. 1995): The brain uses two systems — the hippocampus for fast, specific episodic capture and the neocortex for slow, generalized knowledge consolidation.

**In AWM**:
- **Fast capture** = salience filter + staging buffer (`src/core/salience.ts`, `src/engine/staging.ts`)
  - New memories are evaluated for novelty and importance
  - High-salience memories go directly to active storage
  - Borderline memories enter staging (the "hippocampal buffer")
- **Slow consolidation** = sleep cycle (`src/engine/consolidation.ts`)
  - Periodic consolidation replays, strengthens clusters, and prunes noise
  - Staging memories are promoted or discarded based on accumulated evidence
  - Cross-topic bridges form between previously separate knowledge

**Effect**: The system can quickly capture important events without committing to them permanently. Over time, consolidation separates signal from noise.

## Synaptic Homeostasis

**Theory** (Tononi & Cirelli 2003): During sleep, overall synaptic strength is scaled down (homeostasis), which improves signal-to-noise by preserving strong connections while weakening diffuse ones.

**In AWM** (`consolidation.ts`, Phase 5):
- After strengthening and bridging, all edge weights in the graph are normalized
- Hub nodes (memories with many connections) have their weights scaled to prevent domination
- This prevents any single well-connected memory from pulling all retrieval toward it

**Effect**: Without homeostasis, popular memories would become "attractors" that dominate every query. Normalization keeps retrieval diverse and relevant. In testing, homeostasis improved cross-topic recall from 50% to 83%.

## Forgetting as Feature

**Theory**: Forgetting is not a failure of memory but an adaptive process. It improves retrieval by reducing interference from irrelevant information (Anderson & Bjork 1994).

**In AWM** (`consolidation.ts`, Phase 6):
- Memories with low confidence, low access count, and old last-access are archived
- Archived memories are removed from active retrieval but preserved in storage
- High-confidence memories (confirmed via feedback) resist forgetting
- Memories with strong edge connections resist forgetting (social protection)

**Effect**: The memory pool stays focused. In the A/B test, AWM stored only 23 of 100 events (77% filtered at write time) yet achieved 100% recall accuracy — because the noise was removed, relevant memories had cleaner retrieval paths.

## Salience Filtering

**Theory**: Not all experiences are equally memorable. Events with high emotional valence, surprise, or causal significance are preferentially encoded (McGaugh 2004).

**In AWM** (`src/core/salience.ts`):
- Each write is scored on: novelty (BM25 duplicate check), surprise (how unexpected), causal depth (how many implications), and effort (how much work went into discovering this)
- Score determines disposition: active (high), staging (medium), discard (low)
- This happens at write time, not retrieval time

**Effect**: Agents don't need to decide what's worth remembering. The salience filter makes that judgment automatically, keeping the memory pool lean.

## Summary of Theory-to-Code Mapping

| Cognitive Theory | AWM Component | Key File |
|-----------------|---------------|----------|
| ACT-R decay | Temporal activation scoring | `src/core/decay.ts` |
| Hebbian learning | Edge strengthening on co-retrieval | `src/core/hebbian.ts` |
| CLS fast path | Salience filter + staging | `src/core/salience.ts` |
| CLS slow path | 7-phase sleep consolidation | `src/engine/consolidation.ts` |
| Synaptic homeostasis | Hub weight normalization | `consolidation.ts` Phase 5 |
| Adaptive forgetting | Archive/delete low-value memories | `consolidation.ts` Phase 6 |
| Salience encoding | Write-time novelty + importance | `src/core/salience.ts` |
