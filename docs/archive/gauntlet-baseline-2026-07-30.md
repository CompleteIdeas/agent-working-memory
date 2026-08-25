# Gauntlet Baseline — 2026-07-30

The **memory gauntlet** is AWM's end-to-end acceptance suite: a scientific single-factor
ablation that measures whether the memory substrate — and nothing else — carries facts
across sessions. It lives in the `memory-working-agent` (MWA) repo at `src/gauntlet/`
(`npm run gauntlet`); this document records what it tests, how, and the standing baseline
for the 0.11.x line (Waves 1–3 + D11).

## 1. Methodology — why the numbers are trustworthy

- **Independent variable:** the memory substrate only. Arms: `awm` (the real engine),
  `off` (NullMemory — the one-bit-flipped control), `notes` (append-only flat file,
  lexical substring recall), `longctx` (no retrieval — dump the whole store, byte-capped),
  `rag` (AWM's own embedding model over a flat store — the strong baseline).
- **Held constant:** model (`gpt-5-4-mini` via Azure), decoding, harness code, task order,
  seed data, budgets (8 steps / 90 s per task), tools.
- **Hard reset:** the working directory is **wiped between every task** and each task runs
  as a fresh session. The only channel that can carry a fact from a seed to a probe is the
  memory store.
- **k repetitions** with mean ± sd and a 95% bootstrap CI. At k=3 the CIs are wide
  (±5–18 pp); treat per-probe differences as directional and require k≥10 before flipping
  any engine default on gauntlet evidence.
- **Difficulty band:** the suite is tuned so memory-ON lands in 30–85% — high enough to be
  usable, low enough that improvements are measurable. Failure is informative by design.

## 2. What each probe tests (memory suite)

Ten seed sessions teach a confusable fictional world (3 projects × owner/codename/budget,
a twice-churned due date, a taught transformation rule, a 3-term glossary, a standing
signoff policy). Ten probes then interrogate it, each targeting one mechanism:

| Probe | Mechanism | What passing proves |
|---|---|---|
| `recall-person` | single-hop recall | A plainly-stated fact ("Priya Rao leads design") survives sessions and paraphrase ("who leads design?"). |
| `multihop` | 3-hop chaining | scheduler → Sarah → owns Cygnus → codename Falcon, with **no** entity named in the query. Known store-side limit; solved harness-side (entity bridge / follow-up recalls) by design. |
| `supersede-due` | supersession | After July 1 → Sep 30 → Aug 15 churn, only the **latest** date returns; stale values must not. |
| `distractor-codename` / `distractor-budget` | disambiguation | The right project's value among 3 parallel-shaped competitors, without bleed. |
| `sparse-cue` | vocabulary mismatch | "my main project" resolves to Atlas → Magpie with no shared keywords. |
| `skill-apply` | procedural memory | A taught rule (REL-\<CODENAME\>) is recalled **and applied** to a different project. |
| `composite` | cross-session assembly / enumeration | ALL taught glossary terms are assembled into a file — an "everything about X" query, structurally hostile to top-k semantic recall. |
| `policy-signoff` | standing policy | A "from now on" preference fires on a later task that never mentions it. |
| `abstain` | safety | A never-taught fact ("my spouse's name") gets an abstention, not a confabulation. |

A second suite (`contextswitch`) seeds four clients with parallel-shaped attributes and
switches client every probe, scoring **context bleed** (wrong client's value present = fail
even if the right one also appears).

## 3. Standing baseline (0.11.x, Wave 1–3 build + harness fixes)

Primary contrast (k=3): **awm 67–74% vs off 0%** on memory-dependent probes — the
substrate is the entire effect. Config ablation, memory suite, k=3 each:

| Config | MD score | Floor rep | Notes |
|---|---|---|---|
| defaults (pre-harness-fix) | 67% ± 18 | 44% | June-parity: no regression from Waves 1–3 |
| bridge flags only (`QUERY_BRIDGE`+`AUTOTAG`+`BROAD_EDGES`) | 59% ± 5 | 56% | distractors 100% but displaces unprompted facts |
| expansion only (`RECALL_EXPAND`) | 63% ± 14 | 44% | — |
| all four flags | 74% ± 10 | 67% | wins did NOT decompose to single factors |
| defaults + harness fixes | 70% ± 10 | 56% | policy path deterministic; abstain scorer fixed |
| **harness fixes + `AUTOTAG` + `ENTITY_INDEX_FETCH` (D11)** | **74% ± 5** | **67%** | **best floor + tightest CI; 6 of 9 probes at 100%** |

The D11 configuration is the **recommended evaluation baseline** going forward: six probes
at 100% (both distractors, sparse-cue, skill-apply, supersede-due, policy-signoff), the
entity index live-populated at 215–311 mentions per store, mean recall 177 ms.

Efficiency context (the axes pass-rate hides): ~29–31k in-tokens/task, ~500 recall calls
per k=3 run, 142–177 ms mean recall — retrieval is in-process; there is no network hop.

## 4. Known gaps — exact signatures (do not re-diagnose)

- **`composite` (33%)** — *echo pollution.* The taught facts now exist in every store
  (verified), but the task's own meta-writes (`skill:`, `agent run:`, `question:` engrams
  that quote the instruction) outrank the fact engram for the assembly query, and the query
  names no entities so index injection cannot fire. Fix direction: **apparatus demotion**
  (down-rank `kind=run-outcome` / `topic=agent` for non-meta queries) — ranking hygiene,
  not another retrieval feature.
- **`multihop` (0–33%)** — the probe contains zero proper nouns, so every entity-keyed
  feature is inert. Per the 2026-06 decision this is solved **harness-side** (MWA's
  `bridgeEntities` follow-up recalls lifted it 0→67% when both hops reach context).
- **`recall-person` (33–100%, flaky)** — model behavior: clarifying questions
  ("which project do you mean by 'design'?") and trust-hedging ("no verified information"),
  not retrieval. Fluctuates with pool composition.

## 5. Harness fixes baked into the baseline (2026-07-30)

1. **Deterministic policy capture** (`src/agent.ts`) — an explicit "remember a standing
   preference: …" is stored via `savePolicy` verbatim (regex fast-path, no LLM judgment
   call); `listPolicies()` then primes it into every future task. Previously the LLM
   extractor skipped the explicit declaration in ~2/3 of reps.
2. **Deterministic teach capture** (`src/agent.ts`) — "remember …: A; B; C" stores the full
   taught clause verbatim **before** the lossy auto-learn extraction (which kept 1 of 3
   glossary terms — the others existed nowhere, making `composite` unwinnable).
3. **Run-record truncation 80→240 chars** — the old cut destroyed taught facts mid-list.
4. **Abstain scorer regex** (`src/gauntlet/tasks.ts`) — now accepts "couldn't/can't/unable
   to verify|confirm|determine" phrasings. Abstain scores before/after this fix are not
   comparable (abstain is not memory-dependent, so MD headlines are unaffected).

## 6. Reproducing

```bash
cd memory-working-agent
npm run gauntlet -- --arms awm,off --k 3 --suite memory           # primary contrast
AWM_AUTOTAG=1 AWM_ENTITY_INDEX_FETCH=1 \
  npm run gauntlet -- --arms awm --k 3 --suite memory             # D11 baseline config
npm run gauntlet -- --arms awm,off --k 3 --suite contextswitch    # bleed suite
npm run gauntlet -- --arms awm,rag --k 3 --suite memory --pad 300 # scale stress
```

Each run wipes `results/gauntlet/` — archive `scorecard.json` first. The 2026-07-30
scorecards are archived at `memory-working-agent/results/archive/scorecard-wave3-*.json`.

## 7. Standing decisions

- **No engine default flips on k=3 evidence** — the 2×2 flag ablation showed combined-flag
  wins that no single factor reproduced, with overlapping CIs throughout. A k≥10 powered
  run of defaults vs the D11 config is the gate.
- **`AWM_ENTITY_INDEX_FETCH` stays opt-in** until that run; it is the recommended flag set
  for gauntlet evaluation in the meantime.
- The gauntlet is the **acceptance test for retrieval changes**: any change to activation,
  salience, or the write pipeline should re-run the primary contrast before shipping.
