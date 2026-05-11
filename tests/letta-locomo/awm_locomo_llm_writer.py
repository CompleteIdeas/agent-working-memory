#!/usr/bin/env python3
"""
LLM-as-writer Letta-style LoCoMo benchmark.

Mirrors how Mem0, Letta, and USEA Agent actually write to memory in production:
an LLM reads each conversation session, decides what's memorable, and writes
structured memories with semantic tags.

Pipeline:
  1. For each session, send turns + session date to gpt-4o-mini with a
     "memory writer" prompt. Get back N memories per session (typ 3-8).
  2. Write those memories to AWM with their tags (sid, date, plus
     semantic entity/topic tags chosen by the LLM).
  3. Run the same Letta-style agent loop (reads via search_files +
     answer_question) as `awm_locomo_letta_style.py`.

The point: 48.8% on the per-turn raw-dump baseline is AWM-with-no-writer.
This experiment tests whether an LLM in the write loop closes the gap to
Letta's published 74.0%.

Usage:
  OPENAI_API_KEY=sk-... python awm_locomo_llm_writer.py \
    --awm-url http://127.0.0.1:8401 \
    --writer-model gpt-4o-mini \
    --reader-model gpt-4o-mini \
    --limit-convs 10
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from openai import OpenAI


_MONTHS = {m: i + 1 for i, m in enumerate([
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
])}


def parse_locomo_date(s: str) -> str:
    """Parse LoCoMo's natural-language date ('1:56 pm on 8 May 2023') to ISO YYYY-MM-DD.
    Returns 'unknown' if parsing fails."""
    if not s:
        return "unknown"
    s = s.lower().strip()
    # Try ISO first
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # Try "<day> <month>[,] <year>" — LoCoMo format is "8 May, 2023"
    m = re.search(r"(\d{1,2})\s+([a-z]+),?\s+(\d{4})", s)
    if m:
        day = int(m.group(1))
        mon = _MONTHS.get(m.group(2))
        if mon:
            return f"{int(m.group(3)):04d}-{mon:02d}-{day:02d}"
    # Try "<month> <day>, <year>"
    m = re.search(r"([a-z]+)\s+(\d{1,2}),?\s+(\d{4})", s)
    if m:
        mon = _MONTHS.get(m.group(1))
        if mon:
            return f"{int(m.group(3)):04d}-{mon:02d}-{int(m.group(2)):02d}"
    return "unknown"

sys.path.insert(0, str(Path(__file__).parent))
from awm_locomo_letta_style import (
    LOCOMO_DATA, OUTPUT_DIR, CATEGORY_NAMES,
    load_agent_prompt, run_agent, agent_has_data,
)


WRITER_SYSTEM_PROMPT = """\
You are a memory-writer for a long-term memory system. You will be given one
session of a conversation between two people, with a date. Your job is to
extract the facts and observations a future-you would want to recall when
asked about this conversation.

Return JSON:
{
  "memories": [
    {
      "concept": "<short noun-phrase title — 5-12 words, includes key entity>",
      "content": "<the actual fact, written so it can be understood standalone. Include the speaker, the entity/event/topic, and any date or quantity. ~30-80 words.>",
      "tags": ["person=<name>", "topic=<word>", "topic=<word>", "type=<event|fact|preference|opinion|plan|relationship>"],
      "intent": "finding"
    }
  ]
}

Rules:
- Write 3-8 memories per session. Skip filler / small-talk / repeated points.
- Each memory must be self-contained — the future reader won't see the
  surrounding turns.
- Lead the content with the rule/fact (subject + verb + object), not context.
- Include 2+ retrievable identifiers in each memory: speaker name, event,
  location, date, quantity, etc. Use the words a future query would use.
- Tags: include at least one person= and 1-3 topic= tags using lowercase
  single words. Add type= for the kind of memory.
- For factual recall (when something happened, what someone said), use
  intent="finding". For decisions/preferences ("X likes Y") use "decision".
- If a turn includes an image caption, treat the caption content as part of
  the fact.
- Always include the session date in the content if available so temporal
  questions can be answered.
- DO NOT use markdown, code fences, or commentary. Return ONLY the JSON object.
"""


def session_text(turns: list) -> str:
    lines = []
    for t in turns:
        speaker = t.get("speaker", "Unknown")
        text = t.get("text", "")
        if t.get("img_url") and t.get("blip_caption"):
            text = f"{text} [Image: {t['blip_caption']}]"
        lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def llm_write_session(client: OpenAI, model: str, session_id: str, session_date: str, turns: list) -> list[dict]:
    """Call the LLM with the session text and parse out a list of memory dicts."""
    user_msg = (
        f"Session: {session_id}\n"
        f"Date: {session_date}\n"
        f"\n"
        f"{session_text(turns)}\n"
    )
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": WRITER_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=2000,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
        return data.get("memories", [])
    except Exception as e:
        print(f"  WRITER error on {session_id}: {type(e).__name__}: {str(e)[:120]}")
        return []


def write_conversation_with_llm(
    client: OpenAI,
    writer_model: str,
    agent_id: str,
    conversation: dict,
    awm_url: str,
) -> int:
    """For each session, generate memories via the LLM and POST to AWM. Returns total memories stored."""
    session_keys = sorted(k for k in conversation if k.startswith("session_") and not k.endswith("_date_time"))
    total_stored = 0
    for sk in session_keys:
        sdate = conversation.get(f"{sk}_date_time", "")
        turns = conversation.get(sk, [])
        if not isinstance(turns, list) or not turns:
            continue

        memories = llm_write_session(client, writer_model, sk, sdate, turns)
        if not memories:
            print(f"    {sk}: 0 memories (LLM returned empty)")
            continue

        # Augment tags with sid + date for entity-bridge boost.
        # Dedupe; drop any malformed tags the LLM may have produced.
        iso_date = parse_locomo_date(sdate)
        sid_tag = f"sid={sk}"
        date_tag = f"date={iso_date}"
        payload_memories = []
        for m in memories:
            raw_tags = m.get("tags") or []
            cleaned = []
            seen = set()
            for t in raw_tags:
                if not isinstance(t, str):
                    continue
                t = t.strip()
                if not t or t in seen:
                    continue
                # Don't let the LLM smuggle a competing sid/date tag
                if t.startswith("sid=") or t.startswith("date="):
                    continue
                cleaned.append(t[:60])
                seen.add(t)
            # AWM /memory/write-batch auto-appends `sid={sessionId}` when sessionId is set
            # (routes.ts:211). Don't add sid_tag manually — that's the dup source.
            # Metadata fields (topic/src/intent/conf) aren't accepted by the batch endpoint,
            # so encode them in tags directly using AWM's convention.
            meta_tags = [
                date_tag,
                f"intent={m.get('intent') or 'finding'}",
                "topic=locomo-conversation",
                "src=llm-writer",
                "conf=observed",
            ]
            cleaned.extend(meta_tags)
            payload_memories.append({
                "concept": (m.get("concept") or "")[:200],
                "content": (m.get("content") or "")[:1500],
                "tags": cleaned[:16],
                "sessionId": sk,                      # AWM adds sid={sk} tag automatically
            })

        # Write to AWM
        BATCH = 8
        for i in range(0, len(payload_memories), BATCH):
            batch = payload_memories[i:i + BATCH]
            r = requests.post(
                f"{awm_url}/memory/write-batch",
                json={"agentId": agent_id, "memories": batch},
                timeout=300,
            )
            if r.status_code != 201:
                print(f"    {sk}: write failed @ {i}: {r.status_code} {r.text[:200]}")
                continue
            total_stored += r.json().get("stored", 0)
        print(f"    {sk}: wrote {len(payload_memories)} memories")

    return total_stored


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--awm-url", default="http://127.0.0.1:8401")
    parser.add_argument("--writer-model", default="gpt-4o-mini")
    parser.add_argument("--reader-model", default="gpt-4o-mini")
    parser.add_argument("--data", default=str(LOCOMO_DATA))
    parser.add_argument("--limit-convs", type=int, default=10)
    parser.add_argument("--limit-questions", type=int, default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-iter", type=int, default=6)
    parser.add_argument("--recall-limit", type=int, default=10)
    parser.add_argument("--agent-prefix", default="locomo-llmw")
    parser.add_argument("--output-suffix", default="", help="Suffix appended to results filename")
    parser.add_argument("--skip-write", action="store_true", help="Assume LLM-written data already in AWM")
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
    output_file = OUTPUT_DIR / f"awm_letta_locomo_llmw_{args.reader_model}{args.output_suffix}.jsonl"

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
    print(f"Agent prompt: {len(agent_prompt)} chars")
    print(f"Writer model: {args.writer_model}  |  Reader model: {args.reader_model}\n")

    total = 0
    correct_quick = 0
    convs = data[:args.limit_convs]
    start = time.time()

    for ci, sample in enumerate(convs):
        sample_id = sample.get("sample_id", ci)
        agent_id = f"{args.agent_prefix}-conv{sample_id}"
        conversation = sample.get("conversation", {})
        qa_pairs = [q for q in sample.get("qa", []) if q.get("category") != 5]

        print(f"\n--- Conv {sample_id}: {len(qa_pairs)} non-adv QAs (LLM-writer) ---")

        if args.skip_write:
            pass
        elif agent_has_data(agent_id, args.awm_url):
            print(f"  {agent_id} already has data — skipping write")
        else:
            t0 = time.time()
            stored = write_conversation_with_llm(client, args.writer_model, agent_id, conversation, args.awm_url)
            print(f"  total stored: {stored} memories ({time.time() - t0:.1f}s)")
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
                client, args.reader_model, question, agent_id, args.awm_url,
                agent_prompt, max_iter=args.max_iter, recall_limit=args.recall_limit,
            )
            elapsed = time.time() - t0

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
                "writer_model": args.writer_model,
                "writer_pattern": "llm-extract",
            }
            with open(output_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(result) + "\n")

            if total % 25 == 1 or total <= 5:
                print(f"  [{cat_name}] {str(question)[:60]}")
                print(f"    A: {str(hyp)[:90]}")
                print(f"    expected: {str(answer)[:80]}  | recalls={recalls} t={elapsed:.1f}s")

        if args.limit_questions and total >= args.limit_questions:
            break

    elapsed_total = time.time() - start
    print(f"\n=== Done ===")
    print(f"Processed: {total} questions in {elapsed_total/60:.1f} min")
    print(f"Quick heuristic: {correct_quick}/{total} = {100*correct_quick/max(total,1):.1f}%")
    print(f"Results: {output_file}")


if __name__ == "__main__":
    main()
