"""
EFT / NES - training loop for the 256M-parameter predictor.

Streams feature shards into the A2000, trains from scratch (sparse embedding
updates via SparseAdam + AdamW on the head), evaluates on held-out shards and
exports fp32/int8 artifacts plus a report. Wall-clock capped for unattended
runs; checkpoints every few minutes so nothing is lost.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, Iterator, List, Tuple

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from big_model import BigEditPredictor  # noqa: E402

SHARDS = BASE / "data" / "shards"
ART = BASE / "artifacts" / "big"


def shard_paths(split: str) -> List[Path]:
    return sorted((SHARDS / split).glob("part-*.npz"))


def load_shard(path: Path):
    """Load a shard with integrity validation; returns None when unusable."""
    try:
        with np.load(path) as data:
            ids = data["ids"]
            offsets = data["offsets"]
            labels = data["labels"]
    except Exception as error:  # noqa: BLE001
        print(f"[train-256m] cannot load {path.name}: {error}; skipping", flush=True)
        return None
    if len(labels) == 0 or len(ids) == 0:
        return None
    if ids.dtype != np.uint32:
        ids = ids.astype(np.uint32)
    if int(ids.max()) >= (1 << 23):
        print(f"[train-256m] {path.name}: ids out of range (max {int(ids.max())}); skipping", flush=True)
        return None
    if int(offsets[0]) != 0 or int(offsets[-1]) >= len(ids):
        print(f"[train-256m] {path.name}: bad offsets (first {int(offsets[0])}, "
              f"last {int(offsets[-1])}, ids {len(ids)}); skipping", flush=True)
        return None
    if not np.all(np.diff(offsets.astype(np.int64)) >= 0):
        print(f"[train-256m] {path.name}: non-monotonic offsets; skipping", flush=True)
        return None
    return ids, offsets, labels


def count_samples(paths: List[Path]) -> int:
    total = 0
    for path in paths:
        with np.load(path) as data:
            total += len(data["labels"])
    return total


def batches(paths: List[Path], batch_size: int, rng: np.random.Generator,
            repeat: bool = True) -> Iterator[Tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Pool samples across shards into fixed-size batches (correct batch math)."""

    def assemble(buffer_ids: List[np.ndarray], buffer_labels: List[int]):
        flat = np.concatenate(buffer_ids).astype(np.int64)
        lengths = np.array([len(item) for item in buffer_ids], dtype=np.int64)
        offsets = np.zeros(len(buffer_ids), dtype=np.int64)
        if len(buffer_ids) > 1:
            np.cumsum(lengths[:-1], out=offsets[1:])
        return flat, offsets, np.asarray(buffer_labels, dtype=np.int64)

    while True:
        order = list(paths)
        rng.shuffle(order)
        buffer_ids: List[np.ndarray] = []
        buffer_labels: List[int] = []
        for path in order:
            shard = load_shard(path)
            if shard is None:
                continue
            ids, offsets, labels = shard
            ends = np.append(offsets[1:], len(ids))
            for index in rng.permutation(len(labels)):
                buffer_ids.append(ids[int(offsets[index]):int(ends[index])])
                buffer_labels.append(int(labels[index]))
                if len(buffer_ids) >= batch_size:
                    yield assemble(buffer_ids, buffer_labels)
                    buffer_ids, buffer_labels = [], []
        if buffer_ids:
            yield assemble(buffer_ids, buffer_labels)
        if not repeat:
            break


def evaluate(model: BigEditPredictor, paths: List[Path], device: str, max_samples: int = 200_000) -> Dict:
    model.eval()
    correct = edit_total = edit_correct = 0
    scores: List[float] = []
    truth: List[int] = []
    rng = np.random.default_rng(7)
    seen = 0
    with torch.no_grad():
        for flat, offsets, labels in batches(paths, 4096, rng, repeat=False):
            if seen >= max_samples:
                break
            ids_t = torch.from_numpy(flat).to(device)
            off_t = torch.from_numpy(offsets).to(device)
            logits = model(ids_t, off_t)
            probs = torch.softmax(logits, dim=-1).cpu().numpy()
            predictions = probs.argmax(axis=1)
            correct += int((predictions == labels).sum())
            edit_mask = labels != 0
            edit_total += int(edit_mask.sum())
            if edit_mask.any():
                edit_correct += int((predictions[edit_mask] == labels[edit_mask]).sum())
            scores.extend((1.0 - probs[:, 0]).tolist())
            truth.extend((labels != 0).astype(int).tolist())
            seen += len(labels)

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
        "n": seen,
        "top1": correct / max(seen, 1),
        "edit_top1": edit_correct / max(edit_total, 1),
        "gate_auc": auc,
    }


def export_int8(model: BigEditPredictor, out_dir: Path) -> Dict:
    weight = model.embedding.weight.detach().cpu().float()
    scales = weight.abs().amax(dim=1).clamp(min=1e-6) / 127.0
    quantized = (weight / scales[:, None]).round().clamp(-127, 127).to(torch.int8)
    np.savez(
        out_dir / "embedding_int8.npz",
        q=quantized.numpy(),
        scale=scales.numpy().astype(np.float16),
        head=model.head.weight.detach().cpu().numpy().astype(np.float16),
        bias=model.head.bias.detach().cpu().numpy().astype(np.float16),
    )
    return {"int8_bytes": int(quantized.numel() + scales.numel() * 2), "rows": int(weight.shape[0]), "dim": int(weight.shape[1])}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=75.0)
    parser.add_argument("--batch", type=int, default=16384)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--max-epochs", type=int, default=4)
    args = parser.parse_args()

    device = args.device if torch.cuda.is_available() else "cpu"
    train_paths = shard_paths("train")
    val_paths = shard_paths("val")
    if not train_paths:
        raise SystemExit("no training shards; run big_data.build() first")

    train_total = count_samples(train_paths)
    ART.mkdir(parents=True, exist_ok=True)
    print(f"[train-256m] train samples {train_total:,} across {len(train_paths)} shards; device {device}", flush=True)

    model = BigEditPredictor().to(device)
    params = model.parameter_count()
    print(f"[train-256m] parameters: {params:,}", flush=True)

    embedding_optimizer = torch.optim.SparseAdam(list(model.embedding.parameters()), lr=args.lr)
    head_optimizer = torch.optim.AdamW(list(model.head.parameters()), lr=args.lr, weight_decay=1e-4)
    criterion = torch.nn.CrossEntropyLoss()

    stats_path = SHARDS / "stats.json"
    class_counts = {}
    if stats_path.exists():
        class_counts = {int(k): v for k, v in json.loads(stats_path.read_text(encoding="utf-8"))["class_counts"].items()}
    if class_counts:
        counts = np.array([class_counts.get(c, 1) for c in range(7)], dtype=np.float64)
        weights = counts.sum() / np.maximum(counts, 1)
        weights = weights / weights.mean()
        class_weights = torch.tensor(weights, dtype=torch.float32, device=device)
        criterion = torch.nn.CrossEntropyLoss(weight=class_weights)
        print(f"[train-256m] class weights: {np.round(weights, 2).tolist()}", flush=True)

    deadline = time.time() + args.minutes * 60
    rng = np.random.default_rng(20261007)
    step = seen = 0
    loss_ema = None
    history = []
    started = time.time()

    for epoch in range(args.max_epochs):
        if time.time() > deadline:
            break
        for flat, offsets, labels in batches(train_paths, args.batch, rng):
            if time.time() > deadline:
                break
            model.train()
            ids_t = torch.from_numpy(flat).to(device, non_blocking=True)
            off_t = torch.from_numpy(offsets).to(device, non_blocking=True)
            labels_t = torch.from_numpy(labels).to(device, non_blocking=True)
            embedding_optimizer.zero_grad(set_to_none=True)
            head_optimizer.zero_grad(set_to_none=True)
            logits = model(ids_t, off_t)
            loss = criterion(logits, labels_t)
            loss.backward()
            embedding_optimizer.step()
            head_optimizer.step()

            step += 1
            seen += len(labels)
            loss_value = float(loss.detach())
            loss_ema = loss_value if loss_ema is None else 0.98 * loss_ema + 0.02 * loss_value

            if step % 50 == 0:
                elapsed = time.time() - started
                rate = seen / max(elapsed, 1e-9)
                print(f"[train-256m] epoch {epoch} step {step} seen {seen:,} loss {loss_ema:.4f} "
                      f"({rate:.0f} samples/s)", flush=True)

            if step % 400 == 0:
                torch.save({"model": model.state_dict(), "step": step, "seen": seen}, ART / "checkpoint.pt")
                print(f"[train-256m] checkpoint saved at step {step}", flush=True)

    training_minutes = (time.time() - started) / 60
    torch.save({"model": model.state_dict(), "step": step, "seen": seen}, ART / "model.pt")
    print(f"[train-256m] training done: {step} steps, {seen:,} samples, {training_minutes:.1f} min", flush=True)

    metrics = {"parameters": params, "steps": step, "samples": seen, "training_minutes": training_minutes, "steps_per_epoch": None}
    if val_paths:
        eval_metrics = evaluate(model, val_paths, device)
        metrics["eval"] = eval_metrics
        print(f"[train-256m] eval: {eval_metrics}", flush=True)

    export_info = export_int8(model, ART)
    metrics["int8_export"] = export_info
    (ART / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    report = [
        "# EFT / NES - 256M-parameter predictor",
        "",
        f"- parameters: **{params:,}** (E: {model.num_features:,} x {model.dim} + head)",
        f"- training: {step} steps / {seen:,} samples / {training_minutes:.1f} min on {device}",
        f"- data: {train_total:,} train samples (shards), val {count_samples(val_paths):,}",
        f"- eval: {metrics.get('eval', 'n/a')}",
        f"- int8 export: {export_info}",
        "- paradigm: single forward propagation (embedding-bag + linear), no attention, no autoregression;",
        "  outputs the same 7 typed atoms and passes the same type checker / copy-only grounding layer as v0.",
        "",
    ]
    (ART / "REPORT.md").write_text("\n".join(report), encoding="utf-8")
    print(f"[train-256m] artifacts: {ART}", flush=True)


if __name__ == "__main__":
    main()
