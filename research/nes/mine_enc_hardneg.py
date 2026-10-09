"""
Hard-negative mining for the gap tagger: sweep train-domain segments with
the best blind detector; segments where it fires confidently (>=6.0) with
no true edit within +-8 gaps become extra clean training segments
(upsampled). Directly attacks the 36-42% clean-fire rate.

Usage: python mine_enc_hardneg.py [--segments 20000] [--cap 12000] [--fire 6.0]
Writes: data/hardneg_enc.jsonl (one raw text per line)
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

from demo_enc import edit_logodds, load_model  # noqa: E402

ENC = BASE / "artifacts" / "enc-s-csc" / "model.pt"
SEQ = BASE / "data" / "seq"
OUT = BASE / "data" / "hardneg_enc.jsonl"
EXCLUDE = 8


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--segments", type=int, default=20000)
    parser.add_argument("--cap", type=int, default=12000)
    parser.add_argument("--minutes", type=float, default=15.0)
    parser.add_argument("--fire", type=float, default=6.0)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, stoi, maxlen = load_model(device, ENC)
    itos = {v: k for k, v in stoi.items() if isinstance(v, int) and v >= 3}
    train = np.load(SEQ / "train.npz")
    train_ids, train_labels = train["ids"], train["labels"]

    deadline = time.time() + args.minutes * 60
    kept = 0
    scanned = 0
    with OUT.open("w", encoding="utf-8") as handle:
        with torch.no_grad():
            for start in range(0, min(len(train_ids), args.segments), 128):
                if kept >= args.cap or time.time() > deadline:
                    break
                batch = train_ids[start:start + 128]
                logits = model(torch.from_numpy(batch).to(device)).cpu().numpy().astype(np.float64)
                for b in range(len(batch)):
                    if kept >= args.cap:
                        break
                    scanned += 1
                    length = int((batch[b] != 0).sum())
                    if length < 25:
                        continue
                    scores = edit_logodds(logits[b][:length])
                    order = np.argsort(-scores)
                    edits = set(np.argwhere(train_labels[start + b][:length] != 0).ravel().tolist())
                    for gap in order[:3]:
                        if scores[gap] < args.fire:
                            break
                        if any(abs(int(gap) - e) <= EXCLUDE for e in edits):
                            continue
                        text = "".join(itos.get(int(tok), "") for tok in batch[b][1:length])
                        if len(text) >= 24:
                            handle.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")
                            kept += 1
                        break
    print(f"[mine] scanned {scanned} segments, kept {kept} hard negatives -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
