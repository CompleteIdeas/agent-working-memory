"""
Fine-tune the MS-MARCO MiniLM cross-encoder on LOCOMO dialogue retrieval data.

Generates (question, dialogue_turn) pairs from LOCOMO ground truth:
- Positive pairs: question + evidence turn (label=1)
- Hard negatives: question + random non-evidence turn from same conversation (label=0)

Exports the fine-tuned model to ONNX for use in the AWM retrieval pipeline.

Usage:
    python scripts/finetune-reranker.py [--epochs 3] [--output models/reranker-locomo]
"""

import json
import random
import argparse
import os
from pathlib import Path

from sentence_transformers import CrossEncoder
import torch

# --- Config ---
BASE_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
LOCOMO_PATH = "tests/locomo-eval/data/locomo10.json"
HARD_NEGATIVES_PER_POSITIVE = 4
SEED = 42

random.seed(SEED)


def load_locomo_data(path: str):
    """Load LOCOMO dataset and extract training pairs."""
    with open(path) as f:
        data = json.load(f)

    all_pairs = []  # (question, passage, label)
    eval_pairs = []  # For evaluation

    for conv_idx, conv in enumerate(data):
        conversation = conv["conversation"]

        # Build turn lookup: dia_id -> text
        turn_lookup = {}
        all_turns = []
        for key, value in conversation.items():
            if key.startswith("session_") and not key.endswith("date_time"):
                if isinstance(value, list):
                    for turn in value:
                        dia_id = turn.get("dia_id", "")
                        text = turn.get("text", "")
                        speaker = turn.get("speaker", "")
                        full_text = f"{speaker}: {text}" if speaker else text
                        if dia_id and text:
                            turn_lookup[dia_id] = full_text
                            all_turns.append(full_text)

        # Process QA pairs
        qa_pairs = conv.get("qa", [])
        for qa_idx, qa in enumerate(qa_pairs):
            question = qa["question"]
            evidence_ids = qa.get("evidence", [])
            category = qa.get("category", 0)

            # Skip adversarial (category 5) — no evidence turns
            if category == 5:
                continue

            # Get positive turns (evidence)
            positive_turns = []
            for eid in evidence_ids:
                if eid in turn_lookup:
                    positive_turns.append(turn_lookup[eid])

            if not positive_turns:
                continue

            # Get negative turns (non-evidence from same conversation)
            evidence_set = set(evidence_ids)
            negative_pool = [
                text for dia_id, text in turn_lookup.items()
                if dia_id not in evidence_set
            ]

            # Create training pairs
            for pos_text in positive_turns:
                pair_set = [(question, pos_text, 1)]

                # Sample hard negatives
                n_neg = min(HARD_NEGATIVES_PER_POSITIVE, len(negative_pool))
                negatives = random.sample(negative_pool, n_neg)
                for neg_text in negatives:
                    pair_set.append((question, neg_text, 0))

                # Split: first 8 conversations for training, last 2 for eval
                if conv_idx < 8:
                    all_pairs.extend(pair_set)
                else:
                    eval_pairs.extend(pair_set)

    return all_pairs, eval_pairs


def create_eval_dataset(eval_pairs):
    """Create evaluation dataset in CERerankingEvaluator format."""
    # Group by question
    from collections import defaultdict
    grouped = defaultdict(lambda: {"positive": [], "negative": []})
    for q, passage, label in eval_pairs:
        if label == 1:
            grouped[q]["positive"].append(passage)
        else:
            grouped[q]["negative"].append(passage)

    samples = []
    for q, docs in grouped.items():
        if docs["positive"] and docs["negative"]:
            samples.append({
                "query": q,
                "positive": docs["positive"],
                "negative": docs["negative"],
            })
    return samples


def main():
    parser = argparse.ArgumentParser(description="Fine-tune reranker on LOCOMO data")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=16, help="Batch size")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate")
    parser.add_argument("--output", type=str, default="models/reranker-locomo",
                        help="Output directory for fine-tuned model")
    parser.add_argument("--export-onnx", action="store_true", default=True,
                        help="Export to ONNX after training")
    args = parser.parse_args()

    print(f"Loading LOCOMO data from {LOCOMO_PATH}...")
    train_pairs, eval_pairs = load_locomo_data(LOCOMO_PATH)
    print(f"  Training pairs: {len(train_pairs)} ({sum(1 for _,_,l in train_pairs if l==1)} positive, {sum(1 for _,_,l in train_pairs if l==0)} negative)")
    print(f"  Eval pairs:     {len(eval_pairs)} ({sum(1 for _,_,l in eval_pairs if l==1)} positive, {sum(1 for _,_,l in eval_pairs if l==0)} negative)")

    # Prepare training data as (sentence1, sentence2, label) tuples
    from sentence_transformers.trainer import SentenceTransformerTrainer
    from datasets import Dataset

    train_dict = {
        "sentence1": [q for q, p, l in train_pairs],
        "sentence2": [p for q, p, l in train_pairs],
        "label": [float(l) for q, p, l in train_pairs],
    }
    eval_dict = {
        "sentence1": [q for q, p, l in eval_pairs],
        "sentence2": [p for q, p, l in eval_pairs],
        "label": [float(l) for q, p, l in eval_pairs],
    }
    train_dataset = Dataset.from_dict(train_dict).shuffle(seed=SEED)
    eval_dataset = Dataset.from_dict(eval_dict)

    print(f"  Train dataset: {len(train_dataset)} examples")
    print(f"  Eval dataset:  {len(eval_dataset)} examples")

    # Load base model
    print(f"\nLoading base model: {BASE_MODEL}")
    model = CrossEncoder(BASE_MODEL, num_labels=1, max_length=256)

    # Pre-training check: score a few examples
    print("\nPre-training sample scores...")
    sample_pairs = [(q, p) for q, p, l in eval_pairs[:10]]
    pre_scores = model.predict(sample_pairs)
    for i, (q, p, l) in enumerate(eval_pairs[:5]):
        print(f"  [{l}] {pre_scores[i]:.4f} | Q: {q[:50]}... | P: {p[:50]}...")

    # Train using CrossEncoderTrainer
    from sentence_transformers.cross_encoder import CrossEncoderTrainer
    from sentence_transformers.cross_encoder.training_args import CrossEncoderTrainingArguments

    training_args = CrossEncoderTrainingArguments(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        learning_rate=args.lr,
        warmup_steps=int(0.1 * (len(train_dataset) // args.batch_size) * args.epochs),
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        logging_steps=50,
        seed=SEED,
    )

    trainer = CrossEncoderTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
    )

    print(f"\nTraining for {args.epochs} epochs (batch_size={args.batch_size}, lr={args.lr})...")
    trainer.train()

    # Save best model
    model.save_pretrained(args.output)
    print(f"\nModel saved to {args.output}")

    # Post-training check
    print("\nPost-training sample scores...")
    post_scores = model.predict(sample_pairs)
    for i, (q, p, l) in enumerate(eval_pairs[:5]):
        print(f"  [{l}] {post_scores[i]:.4f} (was {pre_scores[i]:.4f}) | Q: {q[:50]}...")

    # Export to ONNX
    if args.export_onnx:
        onnx_dir = os.path.join(args.output, "onnx")
        print(f"\nExporting to ONNX at {onnx_dir}...")
        try:
            from optimum.exporters.onnx import main_export
            main_export(
                model_name_or_path=args.output,
                output=onnx_dir,
                task="text-classification",
                opset=17,
            )
            print(f"  ONNX export complete!")

            # Copy tokenizer files for @huggingface/transformers compatibility
            import shutil
            for f in ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt"]:
                src = os.path.join(args.output, f)
                dst = os.path.join(onnx_dir, f)
                if os.path.exists(src) and not os.path.exists(dst):
                    shutil.copy2(src, dst)

            print(f"\n  To use in AWM, set environment variable:")
            print(f"    AWM_RERANKER_MODEL={os.path.abspath(onnx_dir)}")
        except Exception as e:
            print(f"  ONNX export failed: {e}")
            print("  You can manually export later with:")
            print(f"    optimum-cli export onnx --model {args.output} {onnx_dir}")

    print("\nDone!")
    print(f"Model saved to: {args.output}")


if __name__ == "__main__":
    main()
