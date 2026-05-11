#!/usr/bin/env python3
"""
Random-sample failure diagnosis for Letta-style LoCoMo.

For each sampled INCORRECT or NOT_ATTEMPTED entry:
  - print question, gold answer, AWM hypothesis
  - re-run a recall and show the top-10 memories
  - flag whether the right info appears to be in the recall

Helps answer: "Is AWM failing to recall the right memory, or is the LLM
failing to extract from a recall that contains the answer?"

Usage:
  python diagnose_failures.py awm_results/awm_letta_locomo_gpt-4o-mini.jsonl.graded-gpt-4.1
"""

import argparse
import json
import random
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def recall(awm_url: str, agent_id: str, query: str, limit: int = 10) -> list:
    cmd = [
        "curl", "-s", "--max-time", "30",
        "-X", "POST", f"{awm_url}/memory/activate",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({
            "agentId": agent_id, "context": query, "limit": limit,
            "useReranker": True, "useExpansion": True,
        }),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        return []
    try:
        return json.loads(r.stdout).get("results", [])
    except Exception:
        return []


def keywords_from_answer(ans: str) -> list:
    """Pull the meaningful tokens from a gold answer for substring checking."""
    if not isinstance(ans, str):
        ans = str(ans)
    # Strip filler
    parts = re.split(r"[\s,.!?;:'\"\-]+", ans.lower())
    return [p for p in parts if len(p) >= 3 and p not in {
        "the", "and", "for", "with", "from", "that", "this", "was", "were",
        "are", "his", "her", "its", "but", "out", "yes", "not"
    }]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("graded_file")
    parser.add_argument("--awm-url", default="http://127.0.0.1:8401")
    parser.add_argument("--agent-prefix", default="locomo-letta")
    parser.add_argument("--sample", type=int, default=15, help="Sample N failures per category")
    parser.add_argument("--filter-grade", choices=["B", "C", "BC"], default="BC")
    args = parser.parse_args()

    entries = []
    with open(args.graded_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    by_cat = defaultdict(list)
    for e in entries:
        g = e.get("grade", "C")
        if (args.filter_grade == "B" and g == "B") or \
           (args.filter_grade == "C" and g == "C") or \
           (args.filter_grade == "BC" and g in ("B", "C")):
            by_cat[e["category_name"]].append(e)

    random.seed(42)
    summary = defaultdict(lambda: {"answer_present_in_recall": 0, "answer_absent_in_recall": 0, "recall_error": 0})

    out_path = Path(args.graded_file + ".diagnosis.txt")
    with open(out_path, "w", encoding="utf-8") as out:
        for cat in sorted(by_cat):
            failures = by_cat[cat]
            random.shuffle(failures)
            sample = failures[:args.sample]
            print(f"\n=== {cat} ({len(failures)} total {args.filter_grade} failures; sampling {len(sample)}) ===", file=out)

            for fe in sample:
                agent_id = f"{args.agent_prefix}-conv{fe['sample_id']}"
                question = fe["question"]
                gold = str(fe["answer"])
                hyp = str(fe["hypothesis"])
                grade = fe.get("grade", "?")

                # Re-recall with the question
                results = recall(args.awm_url, agent_id, question, limit=10)
                if not results:
                    summary[cat]["recall_error"] += 1
                    continue

                # Did the gold answer's keywords show up in the top-10?
                kws = keywords_from_answer(gold)
                if not kws:
                    answer_present = False
                else:
                    combined_contents = " \n ".join(
                        (r.get("engram", {}).get("content", "") + " " + r.get("engram", {}).get("concept", "")).lower()
                        for r in results
                    )
                    answer_present = sum(1 for kw in kws if kw in combined_contents) >= max(1, len(kws) // 2)

                if answer_present:
                    summary[cat]["answer_present_in_recall"] += 1
                else:
                    summary[cat]["answer_absent_in_recall"] += 1

                print(f"\n  Q [{grade}]: {question}", file=out)
                print(f"  Gold: {gold}", file=out)
                print(f"  Hyp:  {hyp}", file=out)
                print(f"  Recall has answer-keywords: {answer_present}", file=out)
                if not answer_present:
                    # Show top-3 recall headers (concepts only) so we can see what was returned
                    print(f"  Recall returned (top 3):", file=out)
                    for r in results[:3]:
                        print(f"    [{r.get('engram',{}).get('concept','?')[:60]}] {r.get('engram',{}).get('content','')[:120]}", file=out)

    print(f"Diagnosis written to: {out_path}")
    print()
    print("Summary by category:")
    for cat in sorted(summary):
        s = summary[cat]
        total = sum(s.values())
        ap = s["answer_present_in_recall"]
        aa = s["answer_absent_in_recall"]
        re_ = s["recall_error"]
        print(f"  {cat:14s} n={total}  answer-in-recall={ap} (LLM failure)  answer-not-in-recall={aa} (recall failure)  errors={re_}")
    print()
    print("Interpretation:")
    print("  - High 'answer-in-recall': retriever did its job, LLM didn't use the context well")
    print("  - High 'answer-not-in-recall': retriever missed — concept matching / vocabulary issue")


if __name__ == "__main__":
    main()
