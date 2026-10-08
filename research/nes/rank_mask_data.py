"""
Ranker v2 data: negatives drawn from the mask model's own top-10 proposals
(matching inference distribution), instead of confusion/random negatives.

For sampled CSC train errors: mask the true error char, take mask top-10
as candidates (truth=1, rest=0) with joint features.

Writes: data/rank/rank_mask.npz + stats
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from rank_data import RANK_DIM, joint_ids  # noqa: E402
from train_mask import MaskModel  # noqa: E402

CSC_TRAIN = BASE / "data" / "external" / "shibing624__CSC" / "train.json"
MASK = BASE / "artifacts" / "mask-s" / "model.pt"
MASK_VOCAB = BASE / "data" / "mask" / "vocab.json"
RANK_DIR = BASE / "data" / "rank"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--errors", type=int, default=20000)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    vocab = json.loads(MASK_VOCAB.read_text(encoding="utf-8"))
    mask_stoi, mask_maxlen, mask_id = vocab["stoi"], vocab["maxlen"], vocab["mask_id"]
    mask_itos = {v: k for k, v in mask_stoi.items()}
    mask_model = MaskModel(len(mask_stoi), "S", mask_maxlen).to(device)
    mask_model.load_state_dict(torch.load(MASK, map_location=device, weights_only=False)["model"])
    mask_model.eval()

    rows = json.loads(CSC_TRAIN.read_text(encoding="utf-8"))
    rng = np.random.default_rng(20261008)
    order = rng.permutation(len(rows))

    flat: list = []
    lens: list = []
    labels: list = []
    used = 0

    with torch.no_grad():
        for row_idx in order:
            if used >= args.errors:
                break
            row = rows[row_idx]
            wrong, correct = row.get("original_text", ""), row.get("correct_text", "")
            if len(wrong) != len(correct) or not (2 <= len(wrong) <= mask_maxlen - 1):
                continue
            positions = [p for p in row.get("wrong_ids", []) if 0 <= p < len(wrong)]
            positions = [p for p in positions if wrong[p] != correct[p]]
            if not positions:
                continue
            pos = positions[0]
            toks = [2] + [mask_stoi.get(c, 1) for c in wrong]
            ids = torch.tensor([toks], dtype=torch.long, device=device)
            masked = ids.clone()
            masked[0, pos + 1] = mask_id
            logits = mask_model(masked).cpu().numpy()[0, pos + 1]
            order_idx = np.argsort(-logits)[:10]
            truth = correct[pos]
            hit = False
            left = wrong[max(0, pos - 64):pos]
            right = wrong[pos + 1:pos + 33]
            for cand_id in order_idx:
                cand = mask_itos.get(int(cand_id))
                if not cand or cand == wrong[pos]:
                    continue
                ids_feat = joint_ids(left, wrong[pos], right, wrong[pos], cand)
                if len(ids_feat) == 0:
                    continue
                flat.append(ids_feat)
                lens.append(len(ids_feat))
                is_truth = cand == truth
                labels.append(1 if is_truth else 0)
                hit = hit or is_truth
            if hit:
                used += 1

    ids_arr = np.concatenate(flat)
    offsets = np.zeros(len(lens), dtype=np.int64)
    if len(lens) > 1:
        np.cumsum(lens[:-1], out=offsets[1:])
    np.savez_compressed(RANK_DIR / "rank_mask.npz", ids=ids_arr, offsets=offsets,
                        labels=np.asarray(labels, dtype=np.int8))
    stats = {"errors": used, "samples": len(labels),
             "pos_rate": float(np.mean(labels)) if labels else 0.0}
    (RANK_DIR / "rank_mask_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2),
                                                   encoding="utf-8")
    print(f"[rank-mask-data] {stats}", flush=True)


if __name__ == "__main__":
    main()
