"""
Sweep evaluation for the 256M-parameter predictor.

Loads artifacts/big/model.pt, derives gate + per-class thresholds from the
validation shards, then runs the corrected local-sweep rule on the held-out
test windows (data/samples/test.jsonl) to quantify the localisation bottleneck
at 260M parameters.

Usage: python eval_big_sweep.py [--rows 400]
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

from atoms import ATOM_CLASSES  # noqa: E402
from big_model import BigEditPredictor  # noqa: E402
from big_data import NUM_FEATURES, _hash_ids  # noqa: E402
from evaluate import local_sweep_metrics  # noqa: E402
from predictors import tune_gate_threshold  # noqa: E402
from synth import load_samples  # noqa: E402

ART = BASE / "artifacts" / "big"
SHARDS = BASE / "data" / "shards"


def load_model(device: str) -> BigEditPredictor:
    model = BigEditPredictor().to(device)
    checkpoint = torch.load(ART / "model.pt", map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model


def probs_for(model, device, left: str, span: str, right: str) -> np.ndarray:
    ids = _hash_ids(left, span, right).astype(np.int64)
    with torch.no_grad():
        ids_t = torch.from_numpy(ids).to(device)
        offsets = torch.zeros(1, dtype=torch.long, device=device)
        logits = model(ids_t, offsets)
        return torch.softmax(logits, dim=-1).cpu().numpy()[0]


def thresholds_from_val(model, device, max_samples: int = 60000):
    """Gate + per-class thresholds from the validation shards."""
    edit_scores, is_edit, class_conf, class_pred, class_true = [], [], [], [], []
    seen = 0
    for path in sorted((SHARDS / "val").glob("part-*.npz")):
        with np.load(path) as data:
            ids, offsets, labels = data["ids"], data["offsets"], data["labels"]
        id_offsets = np.append(offsets, len(ids))
        for index in range(len(labels)):
            if seen >= max_samples:
                break
            start, end = int(id_offsets[index]), int(id_offsets[index + 1])
            ids_t = torch.from_numpy(ids[start:end].astype(np.int64)).to(device)
            with torch.no_grad():
                logits = model(ids_t, torch.zeros(1, dtype=torch.long, device=device))
                probs = torch.softmax(logits, dim=-1).cpu().numpy()[0]
            prediction = int(np.argmax(probs))
            edit_scores.append(float(1.0 - probs[0]))
            is_edit.append(int(labels[index]) != 0)
            class_conf.append(float(probs[prediction]))
            class_pred.append(prediction)
            class_true.append(int(labels[index]))
            seen += 1
        if seen >= max_samples:
            break

    gate = tune_gate_threshold(edit_scores, is_edit, 0.88)
    class_thresholds = {}
    pred_arr = np.asarray(class_pred)
    conf_arr = np.asarray(class_conf)
    true_arr = np.asarray(class_true)
    for class_index in range(1, len(ATOM_CLASSES)):
        mask = pred_arr == class_index
        if mask.sum() < 20:
            class_thresholds[ATOM_CLASSES[class_index]] = 0.5
            continue
        confidence = conf_arr[mask]
        correct = true_arr[mask] == class_index
        order = np.argsort(-confidence)
        precision = np.cumsum(correct[order]) / np.arange(1, len(order) + 1)
        ok = np.where(precision >= 0.9)[0]
        class_thresholds[ATOM_CLASSES[class_index]] = (
            float(confidence[order[int(ok[-1])]]) if len(ok) else float(confidence.max() + 0.01)
        )
    return gate, class_thresholds


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=400)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model(device)
    gate, class_thresholds = thresholds_from_val(model, device)
    print(f"[big-sweep] gate: {json.dumps(gate)}")
    print(f"[big-sweep] class thresholds: {json.dumps({k: round(v, 3) for k, v in class_thresholds.items()})}")

    rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    predict = lambda left, span, right: probs_for(model, device, left, span, right)

    result = local_sweep_metrics(predict, rows, gate["threshold"], max_rows=args.rows,
                                 class_thresholds=class_thresholds)
    print(f"[big-sweep] result: {json.dumps({k: round(v, 4) for k, v in result.items()})}")

    (ART / "sweep.json").write_text(json.dumps({
        "gate": gate,
        "class_thresholds": class_thresholds,
        "sweep": result,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[big-sweep] wrote {ART / 'sweep.json'}")


if __name__ == "__main__":
    main()
