"""
Payload ranker data: (context, wrong_char, candidate_char) -> {0,1}.

Supervision comes from CSC train pairs: the correct char is the positive;
negatives are hard (other confusion chars) + random. Same-length
substitution pairs only. NEVER reads test.json.

Writes: data/rank/rank_train.npz (flat ids/offsets/labels) + stats.json
Feature: joint hash of context feature names with wrong/candidate chars.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from demo import load_confusion  # noqa: E402
from features import extract_feature_names, fnv1a64  # noqa: E402

RANK_DIM = 1 << 15
CSC_TRAIN = BASE / "data" / "external" / "shibing624__CSC" / "train.json"
RANK_DIR = BASE / "data" / "rank"

COMMON_FILLERS = list("的是了我有在个一不了大中上可下要就年时会如用所子也于")


def joint_ids(left: str, span: str, right: str, wrong: str, candidate: str) -> np.ndarray:
    ids = set()
    for name in extract_feature_names(left, span, right):
        ids.add(fnv1a64(f"{name}|W={wrong}|C={candidate}") % RANK_DIM)
    return np.fromiter(ids, dtype=np.uint32)


def build(cap_positives: int = 200_000, minutes: float = 15.0) -> dict:
    RANK_DIR.mkdir(parents=True, exist_ok=True)
    confusion = load_confusion()
    rows = json.loads(CSC_TRAIN.read_text(encoding="utf-8"))
    print(f"[rank-data] {len(rows)} CSC train pairs", flush=True)

    rng = np.random.default_rng(20261007)
    flat: list = []
    lens: list = []
    labels: list = []
    positives = 0
    deadline = time.time() + minutes * 60

    for row in rows:
        if positives >= cap_positives or time.time() > deadline:
            break
        wrong, correct = row.get("original_text", ""), row.get("correct_text", "")
        if len(wrong) != len(correct) or not (2 <= len(wrong) <= 200):
            continue
        for pos in row.get("wrong_ids", []):
            if positives >= cap_positives or time.time() > deadline:
                break
            if not (0 <= pos < len(wrong)) or wrong[pos] == correct[pos]:
                continue
            left, span, right = wrong[max(0, pos - 64):pos], wrong[pos], wrong[pos + 1:pos + 33]
            truth = correct[pos]
            negs = []
            for alt in confusion.get(wrong[pos], []):
                if alt != truth and alt != wrong[pos]:
                    negs.append(alt)
                if len(negs) >= 2:
                    break
            while len(negs) < 4:
                cand = rng.choice(COMMON_FILLERS)
                if cand != truth and cand != wrong[pos] and cand not in negs:
                    negs.append(cand)
            for candidate, label in [(truth, 1)] + [(c, 0) for c in negs[:4]]:
                ids = joint_ids(left, span, right, wrong[pos], candidate)
                if len(ids) == 0:
                    continue
                flat.append(ids)
                lens.append(len(ids))
                labels.append(label)
            positives += 1

    ids_arr = np.concatenate(flat)
    offsets = np.zeros(len(lens), dtype=np.int64)
    if len(lens) > 1:
        np.cumsum(lens[:-1], out=offsets[1:])
    np.savez_compressed(RANK_DIR / "rank_train.npz", ids=ids_arr, offsets=offsets,
                        labels=np.asarray(labels, dtype=np.int8))
    stats = {"positives": positives, "samples": len(labels), "dim": RANK_DIM}
    (RANK_DIR / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[rank-data] {stats}", flush=True)
    return stats


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    build()
