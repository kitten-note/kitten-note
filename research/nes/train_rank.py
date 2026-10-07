"""
Payload ranker: depth-1 hashed logistic model over joint
(context features, wrong char, candidate char). Trains in minutes.

Usage: python train_rank.py [--minutes 10]
Writes: artifacts/ranker/ranker.pt + metrics.json (train/val AUC).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from rank_data import RANK_DIM  # noqa: E402

ART = BASE / "artifacts" / "ranker"


class Ranker(nn.Module):
    def __init__(self, dim: int = RANK_DIM):
        super().__init__()
        self.linear = nn.Linear(dim, 1)


def batch_scores(model: Ranker, ids: np.ndarray, offsets: np.ndarray, labels: np.ndarray,
                 device: str, batch: int = 4096):
    model.eval()
    out = np.zeros(len(labels), dtype=np.float64)
    with torch.no_grad():
        ends = np.append(offsets[1:], len(ids))
        for start in range(0, len(labels), batch):
            chunk = range(start, min(start + batch, len(labels)))
            rows = []
            for i in chunk:
                vec = np.zeros(RANK_DIM, dtype=np.float32)
                vec[ids[offsets[i]:ends[i]]] = 1.0
                rows.append(vec)
            scores = model.linear(torch.stack([torch.from_numpy(r) for r in rows]).to(device))
            out[start:start + len(rows)] = scores.cpu().numpy().ravel()
    return out


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--batch", type=int, default=2048)
    parser.add_argument("--lr", type=float, default=0.5)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ART.mkdir(parents=True, exist_ok=True)
    data = np.load(BASE / "data" / "rank" / "rank_train.npz")
    ids, offsets, labels = data["ids"], data["offsets"], data["labels"]
    print(f"[rank] samples {len(labels)} (pos rate {labels.mean():.3f})", flush=True)

    rng = np.random.default_rng(7)
    perm = rng.permutation(len(labels))
    cut = int(len(labels) * 0.97)
    train_idx, val_idx = perm[:cut], perm[cut:]

    model = Ranker().to(device)
    optimizer = torch.optim.AdamW(model.linear.parameters(), lr=1e-2, weight_decay=1e-4)
    criterion = nn.BCEWithLogitsLoss()
    deadline = time.time() + args.minutes * 60

    ends = np.append(offsets[1:], len(ids))
    step = 0
    order = rng.permutation(train_idx)
    while time.time() < deadline:
        for start in range(0, len(order), args.batch):
            if time.time() > deadline:
                break
            batch_idx = order[start:start + args.batch]
            rows = np.zeros((len(batch_idx), RANK_DIM), dtype=np.float32)
            for r, i in enumerate(batch_idx):
                rows[r, ids[offsets[i]:ends[i]]] = 1.0
            model.train()
            optimizer.zero_grad()
            logits = model.linear(torch.from_numpy(rows).to(device)).squeeze(-1)
            loss = criterion(logits, torch.from_numpy(labels[batch_idx].astype(np.float32)).to(device))
            loss.backward()
            optimizer.step()
            step += 1
            if step % 50 == 0:
                print(f"[rank] step {step} loss {float(loss):.4f}", flush=True)
        order = rng.permutation(train_idx)
        if time.time() > deadline:
            break

    scores = batch_scores(model, ids, offsets, labels, device)
    for name, idx in (("train", train_idx), ("val", val_idx)):
        order_idx = np.argsort(scores[idx])
        ranks = np.empty_like(order_idx)
        ranks[order_idx] = np.arange(len(idx))
        positives = labels[idx].sum()
        negatives = len(idx) - positives
        auc = float((ranks[labels[idx] == 1].sum() - positives * (positives - 1) / 2) / (positives * negatives))
        print(f"[rank] {name} AUC {auc:.4f}", flush=True)

    torch.save({"model": model.state_dict()}, ART / "ranker.pt")
    (ART / "metrics.json").write_text(json.dumps({"steps": step, "dim": RANK_DIM}, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    print(f"[rank] artifacts: {ART}", flush=True)


if __name__ == "__main__":
    main()
