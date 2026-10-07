"""
Diagnose the INS failure: is it calibration/competition (true class ranked
2nd-3rd -> fixable with weights/thresholds) or representation/ambiguity
(true class ranked last -> needs features/objective changes)?

Usage: python diag_enc.py [--model artifacts/enc-s/model.pt] [--segments 200]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from enc_model import PRESETS, TinyEditEncoder  # noqa: E402

ATOM_NAMES = ["NO_EDIT", "FIX_CHAR", "DEL_CHAR", "INS_CHAR", "DEL_SPAN", "INS_SPAN_COPY", "FMT_BULLET"]


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(BASE / "artifacts" / "enc-s" / "model.pt"))
    parser.add_argument("--segments", type=int, default=200)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    checkpoint = torch.load(args.model, map_location=device, weights_only=False)
    preset = checkpoint.get("preset", "S")
    vocab = json.loads((BASE / "data" / "seq" / "vocab.json").read_text(encoding="utf-8"))
    config = PRESETS[preset]
    model = TinyEditEncoder(len(vocab["stoi"]), d=config["d"], layers=config["layers"],
                            heads=config["heads"], ffn=config["ffn"],
                            maxlen=vocab["maxlen"]).to(device)
    model.load_state_dict(checkpoint["model"])
    model.eval()

    data = np.load(BASE / "data" / "seq" / "val.npz")
    ids_all, labels_all = data["ids"][:args.segments], data["labels"][:args.segments]

    pred_hist = Counter()
    per_class = {c: {"tp": 0, "pred": 0, "true": 0} for c in range(7)}
    ins_ranks: Counter = Counter()

    with torch.no_grad():
        for start in range(0, len(ids_all), 64):
            ids = torch.from_numpy(ids_all[start:start + 64]).to(device)
            logits = model(ids).cpu().numpy().astype(np.float64)
            predictions = logits.argmax(axis=-1)
            mask = ids_all[start:start + 64] != 0
            labels = labels_all[start:start + 64]
            pred_hist.update(predictions[mask].tolist())
            for c in range(7):
                true_mask = mask & (labels == c)
                per_class[c]["true"] += int(true_mask.sum())
                per_class[c]["pred"] += int((mask & (predictions == c)).sum())
                per_class[c]["tp"] += int(((predictions == c) & true_mask).sum())
            order = np.argsort(-logits, axis=-1)
            for c in (3, 5):
                positions = np.argwhere(mask & (labels == c))
                for b, t in positions:
                    rank = int(np.argwhere(order[b, t] == c)[0, 0]) + 1
                    ins_ranks[(c, rank)] += 1

    print(f"[diag-enc] model {args.model} over {len(ids_all)} val segments", flush=True)
    print(f"[diag-enc] prediction histogram: "
          f"{ {ATOM_NAMES[k]: v for k, v in sorted(pred_hist.items())} }", flush=True)
    for c in range(7):
        stats = per_class[c]
        precision = stats["tp"] / max(stats["pred"], 1)
        recall = stats["tp"] / max(stats["true"], 1)
        print(f"[diag-enc] {ATOM_NAMES[c]:<13} P={precision:.3f} R={recall:.3f} "
              f"(pred {stats['pred']}, true {stats['true']})", flush=True)
    for c in (3, 5):
        ranks = {rank: ins_ranks[(c, rank)] for rank in range(1, 8)}
        print(f"[diag-enc] true-class rank at {ATOM_NAMES[c]} positions: {ranks}", flush=True)


if __name__ == "__main__":
    main()
