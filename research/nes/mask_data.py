"""
Masked-char proposer data: tokenized segments for MLM pretraining.

Samples lines from the 8B-corpus clean shards (round-robin), random-crops
to <=190 chars (room for <S>), keeps >=24 chars. Masking is applied
DYNAMICALLY in training (not stored). Vocab = seq vocab + <MASK> id.

Writes: data/mask/{train,val}.npz (padded ids) + vocab.json + stats.json
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

MASK_DIR = BASE / "data" / "mask"
CLEAN = BASE / "data" / "bigcorpus" / "clean"
SEQ_VOCAB = BASE / "data" / "seq" / "vocab.json"
MAXLEN = 192


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--segments", type=int, default=1_000_000)
    parser.add_argument("--minutes", type=float, default=20.0)
    args = parser.parse_args()

    MASK_DIR.mkdir(parents=True, exist_ok=True)
    seq_vocab = json.loads(SEQ_VOCAB.read_text(encoding="utf-8"))
    stoi = dict(seq_vocab["stoi"])
    mask_id = len(stoi)
    stoi["<MASK>"] = mask_id
    (MASK_DIR / "vocab.json").write_text(
        json.dumps({"stoi": stoi, "maxlen": MAXLEN, "mask_id": mask_id}, ensure_ascii=False),
        encoding="utf-8")
    print(f"[mask-data] vocab {len(stoi)} (mask id {mask_id})", flush=True)

    shards = sorted(CLEAN.glob("*.txt"))
    print(f"[mask-data] {len(shards)} clean shards", flush=True)
    rng = np.random.default_rng(20261008)
    deadline = time.time() + args.minutes * 60

    collected: list = []
    handles = [p.open("r", encoding="utf-8", errors="replace") for p in shards]
    try:
        while len(collected) < args.segments and time.time() < deadline:
            progressed = False
            for handle in handles:
                if len(collected) >= args.segments or time.time() > deadline:
                    break
                for _ in range(200):
                    line = handle.readline()
                    if not line:
                        break
                    progressed = True
                    if rng.random() > 0.06:
                        continue
                    text = line.strip()
                    if len(text) > MAXLEN - 2:
                        start = int(rng.integers(0, len(text) - (MAXLEN - 2)))
                        text = text[start:start + MAXLEN - 2]
                    if len(text) < 24:
                        continue
                    toks = [2] + [stoi.get(c, 1) for c in text]
                    collected.append(toks)
                    if len(collected) >= args.segments:
                        break
            if not progressed:
                break
    finally:
        for handle in handles:
            handle.close()

    print(f"[mask-data] collected {len(collected)} segments", flush=True)
    order = rng.permutation(len(collected))
    cut = int(len(collected) * 0.98)

    def pack(items):
        ids = np.zeros((len(items), MAXLEN), dtype=np.int32)
        for i, toks in enumerate(items):
            ids[i, :len(toks)] = toks
        return ids

    train_ids = pack([collected[i] for i in order[:cut]])
    val_ids = pack([collected[i] for i in order[cut:]])
    np.savez_compressed(MASK_DIR / "train.npz", ids=train_ids)
    np.savez_compressed(MASK_DIR / "val.npz", ids=val_ids)
    stats = {"train": len(train_ids), "val": len(val_ids), "vocab": len(stoi)}
    (MASK_DIR / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[mask-data] {stats}", flush=True)


if __name__ == "__main__":
    main()
