"""
EFT / NES - shard builder for the 256M-parameter run.

Turns every available text source (wiki API corpus + external datasets) into
binary feature shards:
    shards/train/part-*.npz   ids(uint32 flat) / offsets(int64) / labels(uint8)
    shards/val/part-*.npz

Samples come from the perturbation-as-ground-truth engine (edits + near-miss
and random NO_EDIT negatives). Feature hashing targets the 2^23 table used by
big_model.py. Multi-process; bounded by wall-clock deadline and sample cap.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

BASE = Path(__file__).resolve().parent
CORPUS = BASE / "data" / "corpus" / "corpus.txt"
EXTERNAL_TEXT = BASE / "data" / "external" / "all_text.txt"
SHARDS = BASE / "data" / "shards"

NUM_FEATURES = 1 << 23

import sys  # noqa: E402
sys.path.insert(0, str(BASE))
from features import extract_feature_names, fnv1a64  # noqa: E402
from synth import Synthesizer  # noqa: E402

_WORKER: Dict = {}


def _init_worker(corpus_sample: List[str], seed: int) -> None:
    _WORKER["synth"] = Synthesizer(corpus_sample, seed=seed)


def segment(text: str, max_len: int = 260) -> List[str]:
    """Split long paragraphs into synthesizer-friendly segments."""
    text = " ".join(text.split())
    if len(text) <= max_len:
        return [text] if len(text) >= 60 else []
    parts, current = [], ""
    for char in text:
        current += char
        if len(current) >= max_len and char in "。！？；.!?;":
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    # hard-split leftovers
    out = []
    for part in parts:
        while len(part) > max_len * 2:
            out.append(part[:max_len])
            part = part[max_len:]
        if len(part) >= 60:
            out.append(part)
    return out


def _hash_ids(left: str, span: str, right: str) -> np.ndarray:
    ids = {fnv1a64(name) % NUM_FEATURES for name in extract_feature_names(left, span, right)}
    return np.fromiter(ids, dtype=np.uint32)


def _process_chunk(args: Tuple[int, str, List[str]]) -> Tuple[str, int, Dict[int, int]]:
    worker_id, split, lines = args
    sid = os.getpid() % 100000
    out_dir = SHARDS / split
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"part-{sid:05d}-{int(time.time()*1000)%10**7}.npz"

    synth: Synthesizer = _WORKER["synth"]
    flat_ids: List[np.ndarray] = []
    lengths: List[int] = []
    labels: List[int] = []
    class_counts: Dict[int, int] = {}

    for line in lines:
        for piece in segment(line):
            try:
                samples = synth.make_doc_samples(piece)
            except AssertionError:
                continue
            for sample in samples:
                ids = _hash_ids(sample["left"], sample["span"], sample["right"])
                if len(ids) == 0:
                    continue
                flat_ids.append(ids)
                lengths.append(len(ids))
                labels.append(int(sample["label"]))
                class_counts[int(sample["label"])] = class_counts.get(int(sample["label"]), 0) + 1

    if not labels:
        return split, 0, {}

    ids_arr = np.concatenate(flat_ids)
    offsets = np.zeros(len(lengths), dtype=np.int64)
    np.cumsum(lengths[:-1], out=offsets[1:])
    np.savez_compressed(path, ids=ids_arr, offsets=offsets, labels=np.asarray(labels, dtype=np.uint8))
    return split, len(labels), class_counts


def load_lines(cap: int = 1_500_000) -> List[str]:
    lines: List[str] = []
    for path in (CORPUS, EXTERNAL_TEXT):
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if len(line) >= 60:
                    lines.append(line)
                if len(lines) >= cap:
                    break
        if len(lines) >= cap:
            break
    return lines


def build(minutes: float = 25.0, max_samples: int = 16_000_000, workers: int = 16) -> Dict:
    SHARDS.mkdir(parents=True, exist_ok=True)
    for split_dir in (SHARDS / "train", SHARDS / "val"):
        for stale in split_dir.glob("part-*.npz"):
            stale.unlink()

    lines = load_lines()
    print(f"[shards] text lines: {len(lines)}", flush=True)
    if not lines:
        raise SystemExit("no text lines available; run corpus/sources first")

    corpus_sample = lines[:2000]
    train_lines = [line for index, line in enumerate(lines) if index % 50 != 0]
    val_lines = [line for index, line in enumerate(lines) if index % 50 == 0]

    tasks: List[Tuple[int, str, List[str]]] = []
    chunk = 400
    for index in range(0, len(train_lines), chunk):
        tasks.append((index, "train", train_lines[index:index + chunk]))
    for index in range(0, len(val_lines), chunk):
        tasks.append((index, "val", val_lines[index:index + chunk]))

    deadline = time.time() + minutes * 60
    total = 0
    class_totals: Dict[int, int] = {}
    started = time.time()

    with mp.Pool(processes=workers, initializer=_init_worker, initargs=(corpus_sample, 20261007)) as pool:
        for split, count, counts in pool.imap_unordered(_process_chunk, tasks):
            total += count
            for key, value in counts.items():
                class_totals[key] = class_totals.get(key, 0) + value
            if count:
                print(f"[shards] +{count} ({split}) total={total}", flush=True)
            if total >= max_samples or time.time() > deadline:
                pool.terminate()
                break

    stats = {
        "total_samples": total,
        "class_counts": {str(k): v for k, v in sorted(class_totals.items())},
        "minutes": (time.time() - started) / 60,
        "num_features": NUM_FEATURES,
    }
    (SHARDS / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[shards] done: {total} samples in {stats['minutes']:.1f} min", flush=True)
    return stats


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    build()
