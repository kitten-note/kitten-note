"""
Blind correction shootout on CSC test.json: confusion-first payload vs
learned ranker payload. Same candidate pool, same fired positions from the
encoder (enc-s-csc, threshold 4.0) - only the ranking differs.

Usage: python eval_rank.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from demo import load_confusion, load_content_index  # noqa: E402
from demo_enc import edit_logodds, load_model  # noqa: E402
from rank_data import RANK_DIM, joint_ids  # noqa: E402
from train_rank import Ranker  # noqa: E402

TEST = BASE / "data" / "external" / "shibing624__CSC" / "test.json"
ENC = BASE / "artifacts" / "enc-s-full5"
RANKER = BASE / "artifacts" / "ranker" / "ranker.pt"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, stoi, maxlen = load_model(device, BASE / "artifacts" / "enc-s-csc" / "model.pt")
    index = load_content_index()
    confusion = load_confusion()
    ranker = Ranker().to(device)
    ranker.load_state_dict(torch.load(RANKER, map_location=device, weights_only=False)["model"])
    ranker.eval()
    weight = ranker.linear.weight.detach().cpu().numpy()[0]
    bias = float(ranker.linear.bias.detach().cpu().numpy()[0])

    items = json.loads(TEST.read_text(encoding="utf-8"))
    detected = conf_ok = rank_ok = 0
    error_items = 0

    def rank_score(left, span, right, wrong, candidate) -> float:
        ids = joint_ids(left, span, right, wrong, candidate)
        return float(weight[ids].sum() + bias)

    with torch.no_grad():
        for item in items:
            wrong, correct = item["original_text"], item["correct_text"]
            error_pos = item.get("wrong_ids", [])
            if not error_pos or len(wrong) < 2 or len(wrong) > maxlen - 1:
                continue
            error_items += 1
            tokens = [2] + [stoi.get(char, 1) for char in wrong]
            logits = model(torch.tensor([tokens], dtype=torch.long, device=device)
                           ).cpu().numpy()[0].astype(np.float64)
            scores = edit_logodds(logits)
            best_gap = int(np.argmax(scores))
            if scores[best_gap] < 4.0 or int(np.argmax(logits[best_gap])) != 1:
                continue
            char_pos = best_gap - 1
            if not (0 <= char_pos < len(wrong)) or not any(abs(best_gap - (p + 1)) <= 2 for p in error_pos):
                continue
            detected += 1

            left = wrong[max(0, char_pos - 64):char_pos]
            span = wrong[char_pos]
            right = wrong[char_pos + 1:char_pos + 33]
            pool = []
            for cand in confusion.get(wrong[char_pos], [])[:5]:
                if cand != wrong[char_pos] and cand not in pool:
                    pool.append(cand)
            if index is not None:
                for cand, _ in index.propose_next(wrong[:char_pos], top=3):
                    if cand != wrong[char_pos] and cand not in pool and len(pool) < 8:
                        pool.append(cand)
            if not pool:
                continue
            truth = correct[char_pos] if char_pos < len(correct) else ""
            if pool[0] == truth:
                conf_ok += 1
            best_cand = max(pool, key=lambda c: rank_score(left, span, right, wrong[char_pos], c))
            if best_cand == truth:
                rank_ok += 1

    print(f"[eval-rank] error items {error_items}, detected positions {detected}", flush=True)
    print(f"[eval-rank] correction confusion-first: {conf_ok}/{error_items} = {conf_ok / max(error_items, 1):.4f}", flush=True)
    print(f"[eval-rank] correction ranker-top1    : {rank_ok}/{error_items} = {rank_ok / max(error_items, 1):.4f}", flush=True)


if __name__ == "__main__":
    main()
