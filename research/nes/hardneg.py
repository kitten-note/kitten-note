"""
Mine hard negatives: sweep clean train-domain text with the geometry-balanced
model; high-confidence fires on clean text become NO_EDIT samples with matched
geometry (they teach the model what its own false alarms look like).

Batched GPU forward pass; dedupes by local signature.

Usage: python hardneg.py [--lines 800] [--threshold 10] [--cap 40000]
Writes: data/hardneg.jsonl  ({left, span, right, label:0, kind:"hardneg"})
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

from big_data import NUM_FEATURES, _hash_ids, load_lines  # noqa: E402
from big_model import BigEditPredictor  # noqa: E402
from eval_sweep_candidates import candidates  # noqa: E402

MODEL = BASE / "artifacts" / "big-3ep-geo" / "model.pt"
OUT = BASE / "data" / "hardneg.jsonl"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", type=int, default=800)
    parser.add_argument("--threshold", type=float, default=10.0)
    parser.add_argument("--cap", type=int, default=40000)
    parser.add_argument("--batch", type=int, default=8192)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = BigEditPredictor().to(device)
    model.load_state_dict(torch.load(MODEL, map_location=device, weights_only=False)["model"])
    model.eval()

    lines = [line for line in load_lines(cap=200_000) if 60 <= len(line) <= 600][: args.lines]
    print(f"[hardneg] sweeping {len(lines)} clean lines", flush=True)

    seen_signatures = set()
    kept = 0
    with OUT.open("w", encoding="utf-8") as handle:
        flat_ids: list = []
        meta: list = []
        lengths: list = []

        def flush() -> int:
            nonlocal kept
            if not flat_ids:
                return 0
            flat = np.concatenate(flat_ids).astype(np.int64)
            offsets = np.zeros(len(flat_ids), dtype=np.int64)
            if len(flat_ids) > 1:
                np.cumsum(np.asarray(lengths[:-1]), out=offsets[1:])
            with torch.no_grad():
                logits = model(torch.from_numpy(flat).to(device),
                               torch.from_numpy(offsets).to(device)).cpu().numpy().astype(np.float64)
            count = 0
            for row_logits, (left, span, right) in zip(logits, meta):
                a = row_logits[1:]
                m = float(a.max())
                score = m + float(np.log(np.exp(a - m).sum())) - float(row_logits[0])
                if score < args.threshold:
                    continue
                signature = (left[-16:], span, right[:16])
                if signature in seen_signatures:
                    continue
                seen_signatures.add(signature)
                handle.write(json.dumps(
                    {"left": left, "span": span, "right": right, "label": 0, "kind": "hardneg"},
                    ensure_ascii=False) + "\n")
                kept += 1
                count += 1
                if kept >= args.cap:
                    break
            flat_ids.clear()
            meta.clear()
            lengths.clear()
            return count

        for line in lines:
            if kept >= args.cap:
                break
            document = " ".join(line.split())
            for pos in range(len(document)):
                if kept >= args.cap:
                    break
                for _kind, _p, left, span, right in candidates(document, pos):
                    ids = _hash_ids(left, span, right)
                    if len(ids) == 0:
                        continue
                    flat_ids.append(ids.astype(np.int64))
                    meta.append((left, span, right))
                    lengths.append(len(ids))
                    if len(flat_ids) >= args.batch:
                        flush()
                        if kept >= args.cap:
                            break
            if len(flat_ids) >= args.batch // 2:
                flush()
        flush()

    print(f"[hardneg] kept {kept} hard negatives -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
