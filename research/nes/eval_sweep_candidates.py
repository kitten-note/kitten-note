"""
Typed-candidate sweep - threshold-free localisation with class-appropriate
candidate windows.

At every position p in the 97-char test window, propose:
    char : span = doc[p:p+1]           (FIX_CHAR / DEL_CHAR geometry)
    ins  : span = ""                   (INS_CHAR / INS_SPAN_COPY geometry)
    del2 : span = doc[p:p+2]           (DEL_SPAN geometry)
    del3 : span = doc[p:p+3]           (DEL_SPAN geometry)

Rank all candidates by edit log-odds = logsumexp(logits[1:]) - logits[0].
Report whether the best candidate lands within +-1 of the true position with
the true class. No thresholds involved.

Usage: python eval_sweep_candidates.py [--model artifacts/big/model.pt] [--rows 400]
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

from big_model import BigEditPredictor  # noqa: E402
from big_data import _hash_ids  # noqa: E402
from synth import load_samples  # noqa: E402

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


def candidates(document, pos):
    left = document[max(0, pos - 64):pos]
    yield "char", pos, left, document[pos:pos + 1], document[pos + 1:pos + 33]
    yield "ins", pos, left, "", document[pos:pos + 32]
    if pos + 2 <= len(document):
        yield "del2", pos, left, document[pos:pos + 2], document[pos + 2:pos + 2 + 32]
    if pos + 3 <= len(document):
        yield "del3", pos, left, document[pos:pos + 3], document[pos + 3:pos + 3 + 32]
    if pos + 4 <= len(document):
        yield "del4", pos, left, document[pos:pos + 4], document[pos + 4:pos + 4 + 32]


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(BASE / "artifacts" / "big" / "model.pt"))
    parser.add_argument("--rows", type=int, default=400)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = BigEditPredictor().to(device)
    model.load_state_dict(torch.load(args.model, map_location=device, weights_only=False)["model"])
    model.eval()
    print(f"[cand-sweep] model: {args.model}", flush=True)

    rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    edit_rows = [row for row in rows if row["label"] != 0][: args.rows]
    print(f"[cand-sweep] windows: {len(edit_rows)}", flush=True)

    position_hits = class_hits = 0
    per_class_total = Counter()
    per_class_hit = Counter()
    type_used = Counter()
    type_scores = {"char": [], "ins": [], "del2": [], "del3": [], "del4": []}

    for row in edit_rows:
        document = row["left"] + row["span"] + row["right"]
        true_pos = len(row["left"])
        label = int(row["label"])
        per_class_total[label] += 1

        best = None
        for pos in range(len(document)):
            for kind, cand_pos, left, span, right in candidates(document, pos):
                logits = logits_for(model, device, left, span, right)
                score = edit_logodds(logits)
                class_index = int(np.argmax(logits))
                if len(type_scores[kind]) < 20000:
                    type_scores[kind].append(score)
                if best is None or score > best[0]:
                    best = (score, cand_pos, class_index, kind)

        score, pos, class_index, kind = best
        type_used[kind] += 1
        if abs(pos - true_pos) <= 1:
            position_hits += 1
            if class_index == label:
                class_hits += 1
                per_class_hit[label] += 1

    n = max(len(edit_rows), 1)
    print(f"[cand-sweep] position_top1 {position_hits/n:.4f} ({position_hits}/{n})", flush=True)
    print(f"[cand-sweep] class_top1    {class_hits/n:.4f} ({class_hits}/{n})", flush=True)
    per_class = {ATOM_NAMES[k]: f"{per_class_hit[k]}/{per_class_total[k]}" for k in sorted(per_class_total)}
    print(f"[cand-sweep] per-class hits: {json.dumps(per_class, ensure_ascii=False)}", flush=True)
    print(f"[cand-sweep] best-candidate type distribution: {dict(type_used)}", flush=True)
    medians = {kind: (round(float(np.median(values)), 2) if values else None) for kind, values in type_scores.items()}
    print(f"[cand-sweep] per-type median edit-log-odds: {json.dumps(medians)}", flush=True)

    result = {
        "model": args.model,
        "windows": len(edit_rows),
        "position_top1": position_hits / n,
        "class_top1": class_hits / n,
        "per_class_hits": {ATOM_NAMES[k]: {"hit": per_class_hit[k], "total": per_class_total[k]}
                           for k in sorted(per_class_total)},
        "best_candidate_type_distribution": dict(type_used),
        "per_type_median_edit_logodds": {k: (float(np.median(v)) if v else None) for k, v in type_scores.items()},
    }
    out_path = Path(args.model).parent / "candidate_sweep.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[cand-sweep] wrote {out_path}")


if __name__ == "__main__":
    main()
