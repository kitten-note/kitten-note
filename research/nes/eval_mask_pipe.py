"""
End-to-end blind correction with the mask proposer in the loop.

Pipeline per CSC test item: encoder detects (top-1 gap >= threshold within
+-2 of a true error) -> mask model proposes top-10 chars at the fired
position -> ranker selects top-1 -> check against the true char.

Compares payload policies on the SAME detected positions:
  (a) confusion-first, (b) ranker over mask-top-10.

Usage: python eval_mask_pipe.py [--threshold 4.0]
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
from demo_enc import edit_logodds, load_model as load_enc  # noqa: E402
from rank_data import RANK_DIM, joint_ids  # noqa: E402
from train_mask import MaskModel  # noqa: E402
from train_rank import Ranker  # noqa: E402

TEST = BASE / "data" / "external" / "shibing624__CSC" / "test.json"
ENC = BASE / "artifacts" / "enc-s-csc" / "model.pt"
MASK = BASE / "artifacts" / "mask-s" / "model.pt"
MASK_VOCAB = BASE / "data" / "mask" / "vocab.json"
RANKER = BASE / "artifacts" / "ranker" / "ranker.pt"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=4.0)
    parser.add_argument("--ranker-path", default="")
    parser.add_argument("--topk", type=int, default=10)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, enc_stoi, enc_maxlen = load_enc(device, ENC)
    mask_vocab = json.loads(MASK_VOCAB.read_text(encoding="utf-8"))
    mask_stoi, mask_maxlen, mask_id = (mask_vocab["stoi"], mask_vocab["maxlen"], mask_vocab["mask_id"])
    mask_itos = {v: k for k, v in mask_stoi.items()}
    mask_model = MaskModel(len(mask_stoi), "S", mask_maxlen).to(device)
    mask_model.load_state_dict(torch.load(MASK, map_location=device, weights_only=False)["model"])
    mask_model.eval()
    ranker_ckpt = torch.load(Path(args.ranker_path) if args.ranker_path else RANKER,
                               map_location=device, weights_only=False)
    arch = ranker_ckpt.get("arch", "linear")
    if arch.startswith("mlp"):
        from train_rank import RankerMLP
        ranker = RankerMLP(hidden=int(arch.split("-")[1])).to(device)
        ranker.load_state_dict(ranker_ckpt["model"])
        ranker.eval()
        w1 = ranker.fc1.weight.detach().cpu().numpy()
        b1 = ranker.fc1.bias.detach().cpu().numpy()
        w2 = ranker.fc2.weight.detach().cpu().numpy()[0]
        b2 = float(ranker.fc2.bias.detach().cpu().numpy()[0])

        def rank_score(left, span, right, wrong, candidate) -> float:
            x = np.zeros(RANK_DIM, dtype=np.float64)
            x[list(joint_ids(left, span, right, wrong, candidate))] = 1.0
            return float(np.maximum(x @ w1.T + b1, 0.0) @ w2 + b2)
    else:
        ranker = Ranker().to(device)
        ranker.load_state_dict(ranker_ckpt["model"])
        ranker.eval()
        rank_w = ranker.linear.weight.detach().cpu().numpy()[0]
        rank_b = float(ranker.linear.bias.detach().cpu().numpy()[0])

        def rank_score(left, span, right, wrong, candidate) -> float:
            ids = joint_ids(left, span, right, wrong, candidate)
            return float(rank_w[ids].sum() + rank_b)
    print(f"[mask-pipe] ranker arch: {arch}", flush=True)
    confusion = load_confusion()
    index = load_content_index()

    items = json.loads(TEST.read_text(encoding="utf-8"))
    detected = conf_ok = pipe_ok = 0
    error_items = 0
    in_top10 = 0

    with torch.no_grad():
        for item in items:
            wrong, correct = item["original_text"], item["correct_text"]
            error_pos = item.get("wrong_ids", [])
            if not error_pos or len(wrong) < 2 or len(wrong) > enc_maxlen - 1:
                continue
            error_items += 1
            tokens = [2] + [enc_stoi.get(c, 1) for c in wrong]
            logits = enc(torch.tensor([tokens], dtype=torch.long, device=device)
                         ).cpu().numpy()[0].astype(np.float64)
            scores = edit_logodds(logits)
            best_gap = int(np.argmax(scores))
            if scores[best_gap] < args.threshold:
                continue
            if not any(abs(best_gap - (p + 1)) <= 2 for p in error_pos):
                continue
            if int(np.argmax(logits[best_gap])) != 1:
                continue
            detected += 1
            char_pos = best_gap - 1
            if not (0 <= char_pos < len(wrong)) or char_pos >= len(correct):
                continue
            truth = correct[char_pos]

            # (a) confusion-first baseline
            pool = []
            for cand in confusion.get(wrong[char_pos], [])[:5]:
                if cand != wrong[char_pos] and cand not in pool:
                    pool.append(cand)
            if index is not None:
                for cand, _ in index.propose_next(wrong[:char_pos], top=3):
                    if cand != wrong[char_pos] and cand not in pool and len(pool) < 8:
                        pool.append(cand)
            if pool and pool[0] == truth:
                conf_ok += 1

            # (b) mask top-10 -> ranker selects
            mtoks = [2] + [mask_stoi.get(c, 1) for c in wrong[:mask_maxlen - 1]]
            mids = torch.tensor([mtoks], dtype=torch.long, device=device)
            masked = mids.clone()
            masked[0, char_pos + 1] = mask_id
            mlogits = mask_model(masked).cpu().numpy()[0, char_pos + 1]
            order = np.argsort(-mlogits)
            order_idx = [i for i in order[:args.topk * 2] if mask_itos.get(int(i)) and mask_itos[int(i)] != wrong[char_pos]][:args.topk]
            proposals = [mask_itos[int(i)] for i in order_idx]
            if truth in [mask_itos[int(i)] for i in order[:args.topk * 2]][:args.topk + 4]:
                in_top10 += 1
            if not proposals:
                continue
            left = wrong[max(0, char_pos - 64):char_pos]
            right = wrong[char_pos + 1:char_pos + 33]
            best_cand = max(proposals, key=lambda c: rank_score(left, wrong[char_pos], right,
                                                                wrong[char_pos], c))
            if best_cand == truth:
                pipe_ok += 1

    print(f"[mask-pipe] error items {error_items}, detected FIX positions {detected}", flush=True)
    print(f"[mask-pipe] truth in mask-top{args.topk}: {in_top10}/{detected} = {in_top10 / max(detected, 1):.4f}", flush=True)
    print(f"[mask-pipe] correction confusion-first : {conf_ok}/{error_items} = {conf_ok / max(error_items, 1):.4f}", flush=True)
    print(f"[mask-pipe] correction mask+ranker     : {pipe_ok}/{error_items} = {pipe_ok / max(error_items, 1):.4f}", flush=True)


if __name__ == "__main__":
    main()
