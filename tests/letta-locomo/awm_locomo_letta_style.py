#!/usr/bin/env python3
"""
AWM adapter for the Letta-style LoCoMo benchmark.

Replicates Letta's harness (https://github.com/letta-ai/letta-leaderboard)
with AWM as the memory backend instead of Letta's file-based archival memory.

Flow per conversation:
  1. Write all per-turn messages to AWM with sid + date tags (one-time per conv)
  2. For each non-adversarial QA pair:
       a) Run an agent loop with OpenAI function-calling:
          - tools: search_files(query) -> AWM recall, answer_question(answer) -> terminal
          - system prompt: Letta's locomo_agent.txt (loaded if present)
          - up to MAX_ITER turns
       b) Save hypothesis + question + true answer + category to JSONL
  3. Grading (separate step): SimpleQA template via grade.py

Excludes category 5 (adversarial) — Letta's published 74% number is on
the 4 non-adversarial categories only.

Usage:
  OPENAI_API_KEY=sk-... python awm_locomo_letta_style.py \
    --awm-url http://127.0.0.1:8401 \
    --model gpt-4o-mini \
    --limit-convs 10 \
    --skip-write
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from openai import OpenAI


HERE = Path(__file__).parent
LOCOMO_DATA = HERE.parent / "letta-leaderboard" / "leaderboard" / "locomo" / "locomo10.json"
LETTA_AGENT_PROMPT = HERE.parent / "letta-leaderboard" / "leaderboard" / "locomo" / "locomo_agent.txt"
OUTPUT_DIR = HERE / "awm_results"

CATEGORY_NAMES = {
    1: "single-hop",
    2: "multi-hop",
    3: "temporal",
    4: "open-domain",
    5: "adversarial",
}


def load_agent_prompt() -> str:
    if LETTA_AGENT_PROMPT.exists():
        return LETTA_AGENT_PROMPT.read_text(encoding="utf-8")
    # Fallback abbreviated prompt
    return (
        "You are answering questions about a long conversation history. "
        "Use search_files to retrieve relevant context. Refer to file timestamps "
        "for time references. Try direct question searches first. "
        "Provide precise answers (e.g., 'June 2025' not 'last summer'). "
        "Call answer_question with your final precise answer."
    )


def write_sessions_to_awm(agent_id: str, conversation: dict, awm_url: str) -> bool:
    """Write all session turns to AWM as one-engram-per-turn with sid+date tags.

    Mirrors the structure Letta uses (chunking_strategy='session') by keeping
    session boundaries visible via tags + concept naming.
    """
    memories = []
    session_keys = sorted(k for k in conversation if k.startswith("session_") and not k.endswith("_date_time"))
    for sk in session_keys:
        sdt_key = f"{sk}_date_time"
        sdate = conversation.get(sdt_key, "")
        turns = conversation.get(sk, [])
        if not isinstance(turns, list):
            continue
        for turn in turns:
            speaker = turn.get("speaker", "Unknown")
            text = turn.get("text", "")
            # Inline image caption if present (Letta does the same)
            if turn.get("img_url") and turn.get("blip_caption"):
                text = f"{text} [Image: {turn['blip_caption']}]"
            memories.append({
                "concept": f"{speaker} in {sk} ({sdate})",
                "content": f"{speaker}: {text}",
                "tags": [f"sid={sk}", f"date={sdate[:10] if sdate else 'unknown'}"],
                "sessionId": sk,
            })

    if not memories:
        return False

    BATCH = 20
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
    print(f"  wrote {stored_total} memories ({len(memories)} turns)")
    return True


def agent_has_data(agent_id: str, awm_url: str) -> bool:
    """Check if AWM already has memories under this agent_id (avoid duplicate writes)."""
    try:
        r = requests.post(
            f"{awm_url}/memory/activate",
            json={"agentId": agent_id, "context": "test probe", "limit": 1, "useReranker": False, "useExpansion": False},
            timeout=10,
        )
        if r.status_code != 200:
            return False
        return len(r.json().get("results", [])) > 0
    except Exception:
        return False


def recall_from_awm(agent_id: str, query: str, awm_url: str, limit: int = 10) -> list:
    r = requests.post(
        f"{awm_url}/memory/activate",
        json={
            "agentId": agent_id,
            "context": query,
            "limit": limit,
            "useReranker": True,    # Use full retrieval power for Letta-style runs
            "useExpansion": True,
        },
        timeout=120,
    )
    if r.status_code != 200:
        return []
    return r.json().get("results", [])


def format_recall_for_llm(results: list) -> str:
    if not results:
        return "No matching memories found. Try a different query."
    lines = []
    for r in results:
        eng = r.get("engram", {})
        concept = eng.get("concept", "")
        content = eng.get("content", "")
        score = r.get("score", 0)
        if len(content) > 800:
            content = content[:800] + "..."
        lines.append(f"[{concept}] (score={score:.2f})\n{content}")
    return "\n\n".join(lines)


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search the conversation history for relevant context. Use specific queries with named entities or specific terms. Avoid generic queries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query - specific terms, entities, or exact phrases."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "answer_question",
            "description": "Return your final precise answer. Call this when you have enough information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "answer": {"type": "string", "description": "Precise concise answer. Use specific dates (e.g., 'June 2025') not relative references."},
                },
                "required": ["answer"],
            },
        },
    },
]


def run_agent(
    client: OpenAI,
    model: str,
    question: str,
    agent_id: str,
    awm_url: str,
    agent_prompt: str,
    max_iter: int = 6,
    recall_limit: int = 10,
) -> tuple[str, int, int]:
    """Run the Letta-style agent loop. Returns (answer, recalls_done, iterations)."""
    messages = [
        {"role": "system", "content": agent_prompt},
        {"role": "user", "content": question},
    ]
    recalls = 0

    # Match Letta's tool_rules: must START with search_files
    forced_first_search = False

    is_reasoning = model.startswith(("o1", "o3", "o4", "gpt-5"))

    for it in range(max_iter):
        kwargs = {
            "model": model,
            "messages": messages,
            "tools": TOOLS,
        }
        # Force the first tool call to be search_files (mirrors Letta's InitToolRule)
        if not forced_first_search:
            kwargs["tool_choice"] = {"type": "function", "function": {"name": "search_files"}}
            forced_first_search = True
        else:
            kwargs["tool_choice"] = "auto"
        if is_reasoning:
            kwargs["max_completion_tokens"] = 4000
        else:
            kwargs["temperature"] = 0
            kwargs["max_tokens"] = 500

        try:
            resp = client.chat.completions.create(**kwargs)
        except Exception as e:
            return f"[ERROR: {type(e).__name__}: {str(e)[:120]}]", recalls, it

        msg = resp.choices[0].message
        # Append assistant message
        assistant_dict = {
            "role": "assistant",
            "content": msg.content or "",
        }
        if msg.tool_calls:
            assistant_dict["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ]
        messages.append(assistant_dict)

        if not msg.tool_calls:
            # Agent didn't call any tool - just took its final content as answer
            return (msg.content or "").strip(), recalls, it + 1

        # Process tool calls
        for tc in msg.tool_calls:
            fn = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            if fn == "search_files":
                q = args.get("query", "").strip()
                if not q:
                    tool_out = "Error: empty query"
                else:
                    results = recall_from_awm(agent_id, q, awm_url, limit=recall_limit)
                    tool_out = format_recall_for_llm(results)
                    recalls += 1
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_out[:6000],  # Truncate to keep context manageable
                })
            elif fn == "answer_question":
                answer = args.get("answer", "").strip()
                return answer, recalls, it + 1
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": f"Unknown tool: {fn}",
                })

    return "[max iterations reached without answer]", recalls, max_iter


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--awm-url", default="http://127.0.0.1:8401")
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--data", default=str(LOCOMO_DATA))
    parser.add_argument("--limit-convs", type=int, default=10, help="Max conversations to process")
    parser.add_argument("--limit-questions", type=int, default=None, help="Max questions across all convs")
    parser.add_argument("--skip-write", action="store_true", help="Assume agents already have data in AWM")
    parser.add_argument("--resume", action="store_true", help="Skip questions already in output file")
    parser.add_argument("--max-iter", type=int, default=6, help="Max agent loop iterations")
    parser.add_argument("--recall-limit", type=int, default=10, help="AWM recall top-K")
    parser.add_argument("--agent-prefix", default="locomo-letta", help="Agent ID prefix per conversation")
    parser.add_argument("--output-suffix", default="", help="Suffix appended to results filename")
    args = parser.parse_args()

    # Verify AWM
    try:
        r = requests.get(f"{args.awm_url}/health", timeout=5)
        print(f"AWM: {r.json().get('version', '?')} at {args.awm_url}")
    except Exception as e:
        print(f"ERROR: AWM not reachable: {e}")
        sys.exit(1)

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("ERROR: OPENAI_API_KEY not set")
        sys.exit(1)
    client = OpenAI(api_key=key)

    # Load LoCoMo
    if not Path(args.data).exists():
        print(f"ERROR: LoCoMo dataset not found at {args.data}")
        sys.exit(1)
    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)
    print(f"Loaded {len(data)} conversations")

    # Output file
    OUTPUT_DIR.mkdir(exist_ok=True)
    output_file = OUTPUT_DIR / f"awm_letta_locomo_{args.model}{args.output_suffix}.jsonl"

    # Resume support — track (sample_id, question) pairs already done
    done = set()
    if args.resume and output_file.exists():
        with open(output_file, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    done.add((e["sample_id"], e["question"]))
                except Exception:
                    pass
        print(f"Resume: {len(done)} already completed, will skip")

    agent_prompt = load_agent_prompt()
    print(f"Agent prompt: {len(agent_prompt)} chars\n")

    total = 0
    correct_quick = 0  # rough heuristic; LLM-judge runs separately

    convs_to_process = data[:args.limit_convs]
    start_time = time.time()

    for ci, sample in enumerate(convs_to_process):
        sample_id = sample.get("sample_id", ci)
        agent_id = f"{args.agent_prefix}-conv{sample_id}"
        conversation = sample.get("conversation", {})
        qa_pairs = [q for q in sample.get("qa", []) if q.get("category") != 5]

        print(f"\n--- Conv {sample_id}: {len(qa_pairs)} non-adversarial QAs ---")

        # Step 1: write sessions (unless --skip-write OR agent already has data)
        if args.skip_write:
            pass
        elif agent_has_data(agent_id, args.awm_url):
            print(f"  agent {agent_id} already has data — skipping write")
        else:
            t0 = time.time()
            ok = write_sessions_to_awm(agent_id, conversation, args.awm_url)
            if not ok:
                print(f"  skipping conv {sample_id} (write failed)")
                continue
            print(f"  write time: {time.time() - t0:.1f}s")
            time.sleep(1)

        # Step 2: per-question agent loop
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
            hypothesis, recalls, iters = run_agent(
                client, args.model, question, agent_id, args.awm_url,
                agent_prompt, max_iter=args.max_iter, recall_limit=args.recall_limit,
            )
            elapsed = time.time() - t0

            # Cheap heuristic match (real scoring is via grader)
            if isinstance(answer, str) and isinstance(hypothesis, str):
                h_lower = hypothesis.lower()
                a_lower = answer.lower()
                quick = a_lower in h_lower or all(w in h_lower for w in a_lower.split() if len(w) > 3)
                if quick:
                    correct_quick += 1

            total += 1

            result = {
                "sample_id": sample_id,
                "category": category,
                "category_name": cat_name,
                "question": question,
                "answer": answer,
                "hypothesis": hypothesis,
                "recalls": recalls,
                "iterations": iters,
                "elapsed": round(elapsed, 2),
            }
            with open(output_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(result) + "\n")

            if total % 10 == 1 or total <= 5:
                print(f"  [{cat_name}] Q: {str(question)[:60]}...")
                print(f"    A: {str(hypothesis)[:80]}")
                print(f"    Expected: {str(answer)[:80]}")
                print(f"    recalls={recalls} iters={iters} t={elapsed:.1f}s")

        if args.limit_questions and total >= args.limit_questions:
            break

    elapsed_total = time.time() - start_time
    print(f"\n=== Done ===")
    print(f"Processed: {total} questions in {elapsed_total/60:.1f} min")
    print(f"Quick heuristic: {correct_quick}/{total} = {100*correct_quick/max(total,1):.1f}%")
    print(f"Results: {output_file}")
    print(f"Next step: grade with src/evaluation/evaluate_qa.py or letta-style grader")


if __name__ == "__main__":
    main()
