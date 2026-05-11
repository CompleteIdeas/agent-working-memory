#!/usr/bin/env python3
"""
Generate a clean comparison report from graded Letta-style LoCoMo results.

Compares AWM against Letta's published 74.0% (gpt-4o-mini) and Mem0's 68.5%.
Letta excluded category 5 (adversarial) — our scoring matches that.

Usage:
  python report_letta_locomo.py awm_results/awm_letta_locomo_gpt-4o-mini.jsonl.graded-gpt-4.1
"""

import json
import sys
from collections import defaultdict
from pathlib import Path


# Published numbers (LoCoMo, non-adversarial, gpt-4o-mini reader)
PUBLISHED = {
    "Letta (file-based)": 74.0,
    "Mem0": 68.5,
}


def main():
    if len(sys.argv) < 2:
        print("Usage: report_letta_locomo.py <graded_file>")
        sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"Not found: {path}")
        sys.exit(1)

    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    # Per-category
    cat_correct = defaultdict(int)
    cat_total = defaultdict(int)
    cat_recalls = defaultdict(list)
    cat_iters = defaultdict(list)
    cat_elapsed = defaultdict(list)

    sample_correct = defaultdict(int)
    sample_total = defaultdict(int)

    grade_dist = defaultdict(int)
    n = 0
    correct = 0

    for e in entries:
        cat = e.get("category_name", "?")
        grade = e.get("grade", "C")
        grade_dist[grade] += 1
        is_correct = grade == "A"
        cat_total[cat] += 1
        if is_correct:
            cat_correct[cat] += 1
            correct += 1
        n += 1
        cat_recalls[cat].append(e.get("recalls", 0))
        cat_iters[cat].append(e.get("iterations", 0))
        cat_elapsed[cat].append(e.get("elapsed", 0))

        sid = e.get("sample_id", "?")
        sample_total[sid] += 1
        if is_correct:
            sample_correct[sid] += 1

    overall_pct = 100 * correct / max(n, 1)

    print("=" * 72)
    print("AWM 0.7.16 on Letta-style LoCoMo (non-adversarial, agent multi-recall)")
    print("=" * 72)
    print()
    print(f"Total graded: {n}")
    print(f"Grade distribution: A={grade_dist['A']} (correct), B={grade_dist['B']} (incorrect), C={grade_dist['C']} (not attempted)")
    print(f"Reader: gpt-4o-mini  |  Judge: gpt-4.1  |  Backend: AWM 0.7.16")
    print()

    # Published comparison
    print(f"{'System':30s} {'Score':>8s}  Notes")
    print("-" * 60)
    for name, score in sorted(PUBLISHED.items(), key=lambda x: -x[1]):
        gap = score - overall_pct
        marker = ""
        if abs(gap) < 2:
            marker = "(within 2pp — tie)"
        elif gap > 0:
            marker = f"(+{gap:.1f}pp ahead of AWM)"
        else:
            marker = f"(AWM ahead by {-gap:.1f}pp)"
        print(f"  {name:28s} {score:>6.1f}%  {marker}")
    print(f"  {'AWM 0.7.16 (this run)':28s} {overall_pct:>6.1f}%")
    print()

    # Per-category
    print("Per-category breakdown:")
    print(f"  {'Category':16s} {'Correct':>10s} {'Total':>8s} {'Acc%':>8s} {'AvgRec':>8s} {'AvgIter':>8s} {'Avg s':>8s}")
    for cat in sorted(cat_total, key=lambda c: -cat_total[c]):
        c = cat_correct[cat]
        t = cat_total[cat]
        ar = sum(cat_recalls[cat]) / max(t, 1)
        ai = sum(cat_iters[cat]) / max(t, 1)
        ae = sum(cat_elapsed[cat]) / max(t, 1)
        print(f"  {cat:16s} {c:>10d} {t:>8d} {100*c/max(t,1):>7.1f}% {ar:>8.2f} {ai:>8.2f} {ae:>8.1f}")
    print()

    # Per-sample (per-conversation)
    print("Per-conversation breakdown:")
    for sid in sorted(sample_total):
        c = sample_correct[sid]
        t = sample_total[sid]
        print(f"  {sid:12s} {c:>4d}/{t:<4d} = {100*c/max(t,1):>5.1f}%")
    print()

    # Behavioral notes
    all_recalls = [e.get("recalls", 0) for e in entries]
    all_iters = [e.get("iterations", 0) for e in entries]
    multi_recall = sum(1 for r in all_recalls if r >= 2)
    print(f"Agent behavior:")
    print(f"  Avg recalls/question:    {sum(all_recalls)/max(n,1):.2f}")
    print(f"  Multi-recall questions:  {multi_recall}/{n} ({100*multi_recall/max(n,1):.1f}%)")
    print(f"  Avg iterations:          {sum(all_iters)/max(n,1):.2f}")
    print(f"  Max recalls in one Q:    {max(all_recalls) if all_recalls else 0}")
    print()
    print("=" * 72)


if __name__ == "__main__":
    main()
