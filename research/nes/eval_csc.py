"""
Honest held-out end-to-end eval: shibing624/CSC test.json (SIGHAN-style).

The encoder never trained on CSC data. The confusion table is FROZEN for
this eval (a few entries were added after seeing live probes - disclosed,
not tuned on this set). Reports:
  * detection: top-1 gap within +-2 chars of a true error position
  * correction: detection AND predicted class==FIX_CHAR AND payload == true char
  * clean silence: no suggestion on error-free items (deployed >=24 filter)

Usage: python eval_csc.py [--max-items 0] [--threshold 4.0]
Writes: artifacts/enc-s-full5/csc_eval.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import apply_atom  # noqa: E402
from demo import load_confusion  # noqa: E402
from demo_enc import edit_logodds, load_model  # noqa: E402

TEST = BASE / "data" / "external" / "shibing624__CSC" / "test.json"
OUT_DIR = BASE / "artifacts" / "enc-s-full5"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=4.0)
    parser.add_argument("--model-path", default="")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_path = Path(args.model_path) if args.model_path else None
    model, stoi, maxlen = load_model(device, model_path)
    out_dir = model_path.parent if model_path else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    confusion = load_confusion()

    items = json.loads(TEST.read_text(encoding="utf-8"))
    if args.max_items:
        items = items[:args.max_items]
    print(f"[csc-eval] {len(items)} test items, threshold {args.threshold}", flush=True)

    detected = corrected = 0
    error_items = clean_items = clean_fired = 0
    fired_total = 0
    examples = []

    with torch.no_grad():
        for item in items:
            wrong, correct = item["original_text"], item["correct_text"]
            error_pos = item.get("wrong_ids", [])
            if len(wrong) < 2 or len(wrong) > maxlen - 1:
                continue
            tokens = [2] + [stoi.get(char, 1) for char in wrong]
            logits = model(torch.tensor([tokens], dtype=torch.long, device=device)
                           ).cpu().numpy()[0].astype(np.float64)
            scores = edit_logodds(logits)
            best_gap = int(np.argmax(scores))
            best_class = int(np.argmax(logits[best_gap]))

            if not error_pos:
                clean_items += 1
                if scores[best_gap] >= args.threshold and best_class != 0:
                    clean_fired += 1
                continue

            error_items += 1
            # error char j -> FIX gap j+1; accept top-1 within +-2
            if scores[best_gap] < args.threshold:
                continue
            fired_total += 1
            true_gaps = [p + 1 for p in error_pos]
            if not any(abs(best_gap - g) <= 2 for g in true_gaps):
                continue
            detected += 1
            if best_class != 1:
                continue
            char_pos = best_gap - 1
            if not (0 <= char_pos < len(wrong)):
                continue
            payload = next((c for c in confusion.get(wrong[char_pos], []) if c != wrong[char_pos]), None)
            if payload is None:
                continue
            if correct[char_pos] == payload if char_pos < len(correct) else False:
                corrected += 1
            elif len(examples) < 10:
                examples.append({"wrong": wrong, "correct": correct,
                                 "fired_pos": char_pos, "payload": payload})

    result = {
        "n": len(items),
        "error_items": error_items,
        "fired_rate": fired_total / max(error_items, 1),
        "detection_rate": detected / max(error_items, 1),
        "correction_rate": corrected / max(error_items, 1),
        "clean_items": clean_items,
        "clean_fire_rate": clean_fired / max(clean_items, 1),
        "threshold": args.threshold,
        "note": "confusion table frozen; a few entries added after live probes (disclosed)",
        "miss_examples": examples,
    }
    print(f"[csc-eval] {json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in result.items() if k != 'miss_examples'}, ensure_ascii=False)}", flush=True)
    for example in examples[:5]:
        print(f"  miss: {example['wrong'][:30]}... -> payload {example['payload']} @ {example['fired_pos']}", flush=True)
    (out_dir / "csc_eval.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[csc-eval] wrote {out_dir / 'csc_eval.json'}")


if __name__ == "__main__":
    main()
