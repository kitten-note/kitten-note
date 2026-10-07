"""
EFT-v1 (contextual encoder) - training + evaluation.

Trains the tiny tagger on gap-labeled segments, then evaluates with the SAME
sweep protocol as the depth-1 family: for each held-out 97-char window, one
forward pass tags every gap; rank gaps by edit log-odds; check whether the
argmax gap matches the true gap (derived from the window geometry).

Usage: python train_enc.py [--preset S] [--epochs 4] [--minutes 30]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from enc_model import build as build_model  # noqa: E402
from synth import load_samples  # noqa: E402

SEQ = BASE / "data" / "seq"


def position_metrics(model, device, ids_all: np.ndarray, labels_all: np.ndarray,
                     max_batches: int = 40) -> dict:
    model.eval()
    correct = total = 0
    edit_correct = edit_total = 0
    scores: list = []
    truth: list = []
    per_class_hit = np.zeros(7, dtype=np.int64)
    per_class_total = np.zeros(7, dtype=np.int64)
    with torch.no_grad():
        for start in range(0, len(ids_all), 256):
            if start // 256 >= max_batches:
                break
            ids = torch.from_numpy(ids_all[start:start + 256]).to(device)
            logits = model(ids).cpu().numpy().astype(np.float64)
            predictions = logits.argmax(axis=-1)
            mask = ids_all[start:start + 256] != 0
            labels = labels_all[start:start + 256]
            correct += int(((predictions == labels) & mask).sum())
            total += int(mask.sum())
            edit_mask = mask & (labels != 0)
            edit_total += int(edit_mask.sum())
            if edit_mask.any():
                edit_correct += int(((predictions == labels) & edit_mask).sum())
            for c in range(7):
                class_mask = mask & (labels == c)
                per_class_total[c] += int(class_mask.sum())
                per_class_hit[c] += int(((predictions == c) & class_mask).sum())
            shifted = np.exp(logits - logits.max(axis=-1, keepdims=True))
            edit_probability = 1.0 - (shifted / shifted.sum(axis=-1, keepdims=True))[..., 0]
            scores.extend(edit_probability[mask].tolist())
            truth.extend((labels[mask] != 0).astype(int).tolist())

    scores_arr = np.asarray(scores)
    truth_arr = np.asarray(truth)
    auc = 0.5
    if len(truth_arr) and 0 < truth_arr.sum() < len(truth_arr):
        order = np.argsort(scores_arr)
        ranks = np.empty_like(order)
        ranks[order] = np.arange(len(scores_arr))
        positives = int(truth_arr.sum())
        negatives = len(truth_arr) - positives
        auc = float((ranks[truth_arr == 1].sum() - positives * (positives - 1) / 2) / (positives * negatives))

    return {
        "position_top1": correct / max(total, 1),
        "edit_position_top1": edit_correct / max(edit_total, 1),
        "gate_auc": auc,
        "per_class_recall": {str(c): float(per_class_hit[c] / max(per_class_total[c], 1)) for c in range(7)},
    }


def sweep_eval(model, device, stoi: dict, maxlen: int, rows: int = 400) -> dict:
    """Same-window sweep protocol: one forward pass per window, rank gaps."""
    test_rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    edit_rows = [row for row in test_rows if row["label"] != 0][:rows]

    position_hits = class_hits = 0
    for row in edit_rows:
        document = row["left"] + row["span"] + row["right"]
        tokens = [2] + [stoi.get(char, 1) for char in document[:maxlen - 1]]
        ids = torch.tensor([tokens], dtype=torch.long, device=device)
        with torch.no_grad():
            logits = model(ids).cpu().numpy()[0].astype(np.float64)
        logodds = np.logaddexp.reduce(logits[:, 1:], axis=1) - logits[:, 0]
        best_gap = int(np.argmax(logodds))
        # true gap: char-span atoms anchor at char len(left) -> gap len(left)+1;
        # empty-span atoms (INS/FMT) anchor at gap len(left).
        true_gap = len(row["left"]) + (1 if len(row["span"]) > 0 else 0)
        if abs(best_gap - true_gap) <= 1:
            position_hits += 1
            if int(np.argmax(logits[best_gap])) == int(row["label"]):
                class_hits += 1

    n = max(len(edit_rows), 1)
    return {"n": len(edit_rows), "position_top1": position_hits / n, "class_top1": class_hits / n}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", default="S")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--minutes", type=float, default=30.0)
    parser.add_argument("--weight", default="sqrt", choices=["full", "sqrt", "none"])
    parser.add_argument("--out-dir", default="")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out_dir = Path(args.out_dir) if args.out_dir else BASE / "artifacts" / f"enc-{args.preset.lower()}"
    out_dir.mkdir(parents=True, exist_ok=True)

    vocab = json.loads((SEQ / "vocab.json").read_text(encoding="utf-8"))
    stoi, maxlen = vocab["stoi"], vocab["maxlen"]

    train = np.load(SEQ / "train.npz")
    val = np.load(SEQ / "val.npz")
    train_ids, train_labels = train["ids"], train["labels"]
    print(f"[enc] train segments {len(train_ids)}, val segments {len(val['ids'])}", flush=True)

    model = build_model(args.preset, len(stoi), maxlen).to(device)
    print(f"[enc] preset {args.preset}: {model.parameter_count():,} params", flush=True)

    counts = np.bincount(train_labels[train_ids != 0].ravel(), minlength=7).astype(np.float64)
    weights = counts.sum() / np.maximum(counts, 1)
    if args.weight == "sqrt":
        weights = np.sqrt(weights)
    elif args.weight == "none":
        weights = np.ones_like(weights)
    weights = weights / weights.mean()
    print(f"[enc] position class weights ({args.weight}): {np.round(weights, 2).tolist()}", flush=True)
    criterion = torch.nn.CrossEntropyLoss(
        weight=torch.tensor(weights, dtype=torch.float32, device=device), ignore_index=-100)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-2)
    rng = np.random.default_rng(20261007)
    deadline = time.time() + args.minutes * 60
    step = 0
    started = time.time()

    for epoch in range(args.epochs):
        if time.time() > deadline:
            break
        order = rng.permutation(len(train_ids))
        for start in range(0, len(order), args.batch):
            if time.time() > deadline:
                break
            batch = order[start:start + args.batch]
            ids_t = torch.from_numpy(train_ids[batch]).to(device)
            targets = train_labels[batch].astype(np.int64).copy()
            targets[train_ids[batch] == 0] = -100
            targets_t = torch.from_numpy(targets).to(device)
            model.train()
            optimizer.zero_grad()
            logits = model(ids_t)
            loss = criterion(logits.reshape(-1, 7), targets_t.reshape(-1))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            step += 1
            if step % 100 == 0:
                print(f"[enc] epoch {epoch} step {step} loss {float(loss):.4f}", flush=True)

    print(f"[enc] done: {step} steps in {(time.time() - started) / 60:.1f} min", flush=True)
    torch.save({"model": model.state_dict(), "preset": args.preset, "step": step},
               out_dir / "model.pt")

    val_metrics = position_metrics(model, device, val["ids"], val["labels"])
    print(f"[enc] val positions: {json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in val_metrics.items() if k != 'per_class_recall'})}", flush=True)
    print(f"[enc] val per-class recall: {json.dumps({k: round(v, 3) for k, v in val_metrics['per_class_recall'].items()})}", flush=True)

    sweep = sweep_eval(model, device, stoi, maxlen)
    print(f"[enc] sweep (same 400 windows): {json.dumps(sweep)}", flush=True)

    (out_dir / "metrics.json").write_text(json.dumps({
        "preset": args.preset,
        "params": model.parameter_count(),
        "steps": step,
        "val_positions": val_metrics,
        "sweep": sweep,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[enc] artifacts: {out_dir}", flush=True)


if __name__ == "__main__":
    main()
