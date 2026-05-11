#!/usr/bin/env python3
"""
Letta-style LoCoMo with PER-SESSION writes instead of per-turn.

Diagnosis showed 66% of AWM's failures were retriever failures, not LLM
failures. Letta's harness chunks by session (whole session = one file).
AWM 0.7.16 was storing one-engram-per-turn — too granular, the right
turn doesn't always surface for the question's vocabulary.

This variant writes ONE engram per session, with all turns concatenated
into the content field and the session date in the concept. Matches
Letta's chunking_strategy="session" default.

Compares directly against the per-turn baseline (48.8% overall).

Usage:
  python awm_locomo_session_chunks.py --limit-convs 10 --model gpt-4o-mini
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from openai import OpenAI

# Reuse format_recall_for_llm, run_agent, TOOLS, load_agent_prompt
sys.path.insert(0, str(Path(__file__).parent))
from awm_locomo_letta_style import (
    LOCOMO_DATA, OUTPUT_DIR, CATEGORY_NAMES,
    load_agent_prompt, recall_from_awm, format_recall_for_llm, TOOLS, run_agent,
    agent_has_data,
)


def write_sessions_as_chunks(agent_id: str, conversation: dict, awm_url: str) -> bool:
    """Write ONE engram per session, with all turns concatenated.

    Each session becomes a single chunk — like Letta's file-per-session strategy.
    """
    memories = []
    session_keys = sorted(k for k in conversation if k.startswith("session_") and not k.endswith("_date_time"))

    for sk in session_keys:
        sdt_key = f"{sk}_date_time"
        sdate = conversation.get(sdt_key, "")
        turns = conversation.get(sk, [])
        if not isinstance(turns, list) or not turns:
            continue

        # Concatenate all turns in the session
        lines = []
        for turn in turns:
            speaker = turn.get("speaker", "Unknown")
            text = turn.get("text", "")
            if turn.get("img_url") and turn.get("blip_caption"):
                text = f"{text} [Image: {turn['blip_caption']}]"
            lines.append(f"{speaker}: {text}")
        full_session = "\n".join(lines)

        memories.append({
            "concept": f"Session {sk} ({sdate})",
            "content": full_session,
            "tags": [f"sid={sk}", f"date={sdate[:10] if sdate else 'unknown'}"],
            "sessionId": sk,
        })

    if not memories:
        return False

    # Smaller batch since each memory is large (full session ~5-15KB)
    BATCH = 5
    stored_total = 0
    for i in range(0, len(memories), BATCH):
        batch = memories[i:i + BATCH]
        r = requests.post(
            f"{awm_url}/memory/write-batch",
            json={"agentId": agent_id, "memories": batch},
            timeout=300,
        )
        if r.status_code != 201:
            print(f"  write-batch failed @ {i}: {r.status_code} {r.text[:200]}")
            return False
        stored_total += r.json().get("stored", 0)
    print(f"  wrote {stored_total} session chunks (was {len(memories)} sessions)")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--awm-url", default="http://127.0.0.1:8401")
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--data", default=str(LOCOMO_DATA))
    parser.add_argument("--limit-convs", type=int, default=10)
    parser.add_argument("--limit-questions", type=int, default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-iter", type=int, default=6)
    parser.add_argument("--recall-limit", type=int, default=10)
    parser.add_argument("--agent-prefix", default="locomo-sess", help="Different prefix from per-turn run")
    parser.add_argument("--output-suffix", default="", help="Suffix for results filename")
    args = parser.parse_args()

    try:
        r = requests.get(f"{args.awm_url}/health", timeout=5)
        print(f"AWM: {r.json().get('version','?')} at {args.awm_url}")
    except Exception as e:
        print(f"ERROR: AWM not reachable: {e}")
        sys.exit(1)

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("ERROR: OPENAI_API_KEY not set")
        sys.exit(1)
    client = OpenAI(api_key=key)

    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)
    print(f"Loaded {len(data)} conversations")

    OUTPUT_DIR.mkdir(exist_ok=True)
    output_file = OUTPUT_DIR / f"awm_letta_locomo_sess_{args.model}{args.output_suffix}.jsonl"

    done = set()
    if args.resume and output_file.exists():
        with open(output_file, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    done.add((e["sample_id"], e["question"]))
                except Exception:
                    pass
        print(f"Resume: {len(done)} already completed")

    agent_prompt = load_agent_prompt()
    print(f"Agent prompt: {len(agent_prompt)} chars\n")

    total = 0
    correct_quick = 0
    convs = data[:args.limit_convs]
    start = time.time()

    for ci, sample in enumerate(convs):
        sample_id = sample.get("sample_id", ci)
        agent_id = f"{args.agent_prefix}-conv{sample_id}"
        conversation = sample.get("conversation", {})
        qa_pairs = [q for q in sample.get("qa", []) if q.get("category") != 5]

        print(f"\n--- Conv {sample_id}: {len(qa_pairs)} non-adv QAs (session-chunked) ---")

        if agent_has_data(agent_id, args.awm_url):
            print(f"  {agent_id} already has data — skipping write")
        else:
            t0 = time.time()
            ok = write_sessions_as_chunks(agent_id, conversation, args.awm_url)
            if not ok:
                print(f"  skipping conv {sample_id} (write failed)")
                continue
            print(f"  write time: {time.time() - t0:.1f}s")
            time.sleep(1)

        for qi, qa in enumerate(qa_pairs):
            question = qa.get("question", "")
            answer = qa.get("answer", "")
            category = qa.get("category", -1)
            cat_name = CATEGORY_NAMES.get(category, f"cat{category}")

            if (sample_id, question) in done:
                continue
            if args.limit_questions and total >= args.limit_questions:
                break

            t0 = time.time()
            hyp, recalls, iters = run_agent(
                client, args.model, question, agent_id, args.awm_url,
                agent_prompt, max_iter=args.max_iter, recall_limit=args.recall_limit,
            )
            elapsed = time.time() - t0

            # Quick heuristic
            if isinstance(answer, str) and isinstance(hyp, str):
                hl, al = hyp.lower(), answer.lower()
                if al in hl or all(w in hl for w in al.split() if len(w) > 3):
                    correct_quick += 1
            total += 1

            result = {
                "sample_id": sample_id,
                "category": category,
                "category_name": cat_name,
                "question": question,
                "answer": answer,
                "hypothesis": hyp,
                "recalls": recalls,
                "iterations": iters,
                "elapsed": round(elapsed, 2),
                "chunking": "session",
            }
            with open(output_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(result) + "\n")

            if total % 25 == 1 or total <= 5:
                print(f"  [{cat_name}] {str(question)[:60]}")
                print(f"    A: {str(hyp)[:90]}")
                print(f"    expected: {str(answer)[:90]}  | recalls={recalls} t={elapsed:.1f}s")

        if args.limit_questions and total >= args.limit_questions:
            break

    elapsed_total = time.time() - start
    print(f"\n=== Done ===")
    print(f"Processed: {total} questions in {elapsed_total/60:.1f} min")
    print(f"Quick heuristic: {correct_quick}/{total} = {100*correct_quick/max(total,1):.1f}%")
    print(f"Results: {output_file}")


if __name__ == "__main__":
    main()
