# Letta-style LoCoMo benchmark — AWM adapter

Apples-to-apples comparison against [Letta's published 74.0% LoCoMo number](https://github.com/letta-ai/letta-leaderboard/blob/main/leaderboard/locomo/locomo_benchmark.py).

Replicates Letta's harness with AWM as the memory backend:

- Same dataset (`locomo10.json`, 10 conversations, 1540 non-adversarial QA pairs — Letta excludes category 5 adversarial)
- Same reader (`gpt-4o-mini`)
- Same judge (`gpt-4.1`) using SimpleQA grading template
- Same agent loop pattern: `search_files` (forced init) → optional more searches → `answer_question` (terminal)
- Same system prompt (Letta's `locomo_agent.txt`)

The point: when published memory-system numbers are quoted on LoCoMo, run our retriever through the same harness with the same reader/judge so the comparison is methodologically clean.

## Files

| Script | What it does |
|---|---|
| `awm_locomo_letta_style.py` | Main adapter. Per-turn write into AWM, multi-recall agent loop, results saved as JSONL. |
| `awm_locomo_llm_writer.py` | Variant: LLM (gpt-4o-mini) reads each session and writes structured memories with semantic prefix tags (`person=`, `topic=`, `intent=`, `date=`, `sid=`). Mirrors how Mem0/Letta/USEA Agent write memories in production. |
| `awm_locomo_session_chunks.py` | Variant: write one engram per session (whole session text). Tests Letta's file-per-session chunking strategy. **Result: worse — bigger context dumps confuse the LLM more than they help.** |
| `grade_letta_locomo.py` | Grades a results JSONL using gpt-4.1 + SimpleQA template (CORRECT/INCORRECT/NOT_ATTEMPTED → A/B/C). |
| `report_letta_locomo.py` | Per-category + per-conversation breakdown, compares to published baselines. |
| `diagnose_failures.py` | Random samples 25 failures per category, re-runs recall, flags whether the gold answer keywords are present in top-10 (retriever failure) or absent (LLM extraction failure). |
| `results.json` | Compact summary of two runs (per-turn raw + LLM-writer) — overall + per-category + config. |

## How to run

Requires AWM running on port 8401 with a clean DB and `OPENAI_API_KEY` in env.

```bash
# 1. Start a dedicated AWM coordinator on 8401 (won't pollute production memory)
AWM_PORT=8401 AWM_DB_PATH=/tmp/locomo_test.db node packages/awm/dist/index.js

# 2. Run the per-turn baseline (writes 4000+ turns per conv, ~90 min for 10 convs)
python awm_locomo_letta_style.py --limit-convs 10

# 3. Or run with LLM-writer (extracts ~5-7 memories per session, ~120 min)
python awm_locomo_llm_writer.py --limit-convs 10

# 4. Grade with gpt-4.1
python grade_letta_locomo.py awm_results/<results>.jsonl --judge gpt-4.1

# 5. Report
python report_letta_locomo.py awm_results/<results>.jsonl.graded-gpt-4.1
```

Dataset (`locomo10.json`) must be on disk — fetch from the official LoCoMo or Letta-leaderboard repos.

## Results (AWM 0.7.16, n=1540, gpt-4o-mini reader, gpt-4.1 judge)

| Run | Overall | open-domain | multi-hop | single-hop | temporal |
|---|---|---|---|---|---|
| **Published — Letta (file)** | **74.0%** | — | — | — | — |
| **Published — Mem0** | **68.5%** | — | — | — | — |
| AWM per-turn raw write | **48.8%** | 57.2% | 53.0% | 24.1% | 34.4% |
| AWM LLM-writer | **46.9%** | 54.8% | 46.4% | 26.2% | 39.6% |
| AWM session-chunk write (negative) | ~27% partial | 28.8% | 43.3% | 8.1% | 19.0% |

Plus, on a prior 0.7.15 LoCoMo run (excluded from this table because methodology differs):

- **AWM adversarial (category 5): 86.8%** — refusing to hallucinate facts that weren't memorized. Letta doesn't publish a comparable number on adversarial.

## Findings

1. **LLM-writer didn't close the gap.** Per-turn raw and LLM-curated both land at ~47-49%. The 25pp gap to Letta isn't a writer problem.
2. **The writer compresses lossy-ly.** LLM-writer helps temporal (+5pp) and single-hop (+2pp) — clean dated facts beat scattered turns. But it *hurts* multi-hop (−7pp) and open-domain (−2pp) — synthesis needs more raw substrate. Net wash.
3. **Diagnosis: 66% of AWM failures are retriever-coverage failures**, not LLM extraction failures. The gold answer simply isn't in the top-10 returned memories. Temporal 84% recall failure, single-hop 64%. Letta's harness returns whole-session files (~10KB each) per search; AWM returns ~10 memories (~2KB total). The structural difference is context bandwidth per recall, not write quality.
4. **LoCoMo is a chatbot-memory benchmark.** It measures verbatim recall of small talk across conversation sessions. AWM was designed for productivity workflows where staying on topic and filtering noise matter — explicitly *not* a sponge that remembers everything. The benchmark structure rewards memory systems that hoard. AWM's salience filter is engineered to do the opposite.
5. **Production fit beats benchmark fit.** USEA Agent at 75% retrievalPrecision on real productivity tasks (Freshdesk tickets, DB lookups, member triage) with a cheap LLM is the relevant signal. With tag-enrichment patch deployed 2026-05-11, expect production retrievalPrecision to climb as new tagged memories accumulate.
