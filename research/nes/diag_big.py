"""
Diagnose the gap between sample-level metrics and sweep-level localisation
for the 256M model on data/samples/test.jsonl.

For every test row:
  (a) sample-level: feed the exact (left, span, right) window -> prediction
  (b) sweep-level: slide over the 97-char document, rank by edit log-odds

Prints aggregate stats plus annotated mismatch examples so we can see *where*
the model fires when it is not the true position.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from big_model import BigEditPredictor  # noqa: E402
from big_data import _hash_ids  # noqa: E402
from synth import load_samples  # noqa: E402

ART = BASE / "artifacts" / "big"
ATOM_NAMES = ["NO_EDIT", "FIX_CHAR", "DEL_CHAR", "INS_CHAR", "DEL_SPAN", "INS_SPAN_COPY", "FMT_BULLET"]


def logits_for(model, device, left, span, right):
    ids = _hash_ids(left, span, right).astype(np.int64)
    with torch.no_grad():
        logits = model(torch.from_numpy(ids).to(device), torch.zeros(1, dtype=torch.long, device=device))
        return logits.cpu().numpy()[0].astype(np.float64)


def edit_logodds(logits):
    a = logits[1:]
    m = float(a.max())
    return m + float(np.log(np.exp(a - m).sum())) - float(logits[0])


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = BigEditPredictor().to(device)
    model.load_state_dict(torch.load(ART / "model.pt", map_location=device, weights_only=False)["model"])
    model.eval()

    rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    edit_rows = [r for r in rows if r["label"] != 0]
    print(f"[diag] total rows {len(rows)}, edit rows {len(edit_rows)}", flush=True)
    print(f"[diag] label counts: {dict(Counter(r['label'] for r in edit_rows))}", flush=True)

    # (a) sample-level accuracy on the exact windows
    correct = 0
    edit_correct = 0
    pred_counts = Counter()
    for row in rows:
        logits = logits_for(model, device, row["left"], row["span"], row["right"])
        pred = int(np.argmax(logits))
        pred_counts[pred] += 1
        if pred == int(row["label"]):
            correct += 1
            if row["label"] != 0:
                edit_correct += 1
    n = len(rows)
    print(f"[diag] sample-level top1 {correct/n:.4f} ({correct}/{n}); edit rows correct {edit_correct}/{len(edit_rows)}", flush=True)
    print(f"[diag] prediction distribution: {dict(sorted(pred_counts.items()))}", flush=True)

    # (b) sweep-level with log-odds on a subset
    subset = edit_rows[:120]
    offsets = Counter()
    examples = []
    for row in subset:
        document = row["left"] + row["span"] + row["right"]
        true_pos = len(row["left"])
        scores = []
        for pos in range(len(document)):
            left = document[max(0, pos - 64):pos]
            span = document[pos:pos + 1]
            right = document[pos + 1:pos + 1 + 32]
            logits = logits_for(model, device, left, span, right)
            scores.append((edit_logodds(logits), int(np.argmax(logits)), pos))
        true_score = next(item[0] for item in scores if item[2] == true_pos)
        best_score, best_class, best_pos = max(scores, key=lambda item: item[0])
        offsets[best_pos - true_pos] += 1
        if abs(best_pos - true_pos) > 1 and len(examples) < 8:
            examples.append((row, document, true_pos, best_pos, best_score, true_score, best_class))

    print(f"[diag] argmax offset from true pos (signed, top 12): "
          f"{dict(offsets.most_common(12))}", flush=True)

    for row, document, true_pos, best_pos, best_score, true_score, best_class in examples:
        lo = max(0, min(true_pos, best_pos) - 6)
        hi = min(len(document), max(true_pos, best_pos) + 7)
        marked = ""
        for index in range(lo, hi):
            char = document[index]
            if index == true_pos:
                marked += f"〖{char}〗"
            elif index == best_pos:
                marked += f"【{char}】"
            else:
                marked += char
        print(f"[diag] label={ATOM_NAMES[row['label']]} true_pos={true_pos} fired_pos={best_pos} "
              f"(Δ={best_pos - true_pos}) fired_class={ATOM_NAMES[best_class]} "
              f"score_fired={best_score:.2f} score_true={true_score:.2f}", flush=True)
        print(f"        ...{marked}...", flush=True)


if __name__ == "__main__":
    main()
