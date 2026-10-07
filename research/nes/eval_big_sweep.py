"""
Sweep evaluation for the 256M-parameter predictor - v3.

Why v3: the trained model saturates (training loss ~0.0000), so softmax
probabilities collapse to exactly 1.0 / 0.0 in float32. Ranking candidate
positions by P(edit) then breaks ties arbitrarily (max() picks the leftmost),
which invalidates the earlier sweep numbers. v3 ranks by the *edit log-odds*:

    score(pos) = logsumexp(logits[1:]) - logits[0]

which is monotone in P(edit) but never saturates, so ties disappear.

Reports:
  * saturation diagnostics (how many positions have P(edit) == 1.0 exactly)
  * threshold-free localisation: rank@argmax on held-out windows
  * operating point tuned on a disjoint split of windows (log-odds quantiles)

Usage: python eval_big_sweep.py [--rows 400] [--tune-rows 200]
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

from big_model import BigEditPredictor  # noqa: E402
from big_data import _hash_ids  # noqa: E402
from synth import load_samples  # noqa: E402

ART = BASE / "artifacts" / "big"


def load_model(device: str) -> BigEditPredictor:
    model = BigEditPredictor().to(device)
    checkpoint = torch.load(ART / "model.pt", map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model


def logits_for(model, device: str, left: str, span: str, right: str) -> np.ndarray:
    ids = _hash_ids(left, span, right).astype(np.int64)
    with torch.no_grad():
        ids_t = torch.from_numpy(ids).to(device)
        offsets = torch.zeros(1, dtype=torch.long, device=device)
        logits = model(ids_t, offsets)
        return logits.cpu().numpy()[0].astype(np.float64)


def edit_logodds(logits: np.ndarray) -> float:
    """logsumexp(edit classes) - logit(NO_EDIT): unsaturated P(edit) proxy."""
    a = logits[1:]
    m = float(a.max())
    lse = m + float(np.log(np.exp(a - m).sum()))
    return lse - float(logits[0])


def collect_windows(model, device: str, rows) -> list:
    windows = []
    for row in rows:
        document = row["left"] + row["span"] + row["right"]
        true_pos = len(row["left"])
        scores = []
        for pos in range(len(document)):
            left = document[max(0, pos - 64):pos]
            span = document[pos:pos + 1]
            right = document[pos + 1:pos + 1 + 32]
            logits = logits_for(model, device, left, span, right)
            scores.append((edit_logodds(logits), int(np.argmax(logits)), pos))
        windows.append((true_pos, int(row["label"]), scores))
    return windows


def rank_accuracy(windows) -> dict:
    position_top1 = class_top1 = 0
    for true_pos, label, scores in windows:
        _, class_index, pos = max(scores, key=lambda item: item[0])
        if abs(pos - true_pos) <= 1:
            position_top1 += 1
            if class_index == label:
                class_top1 += 1
    n = max(len(windows), 1)
    return {"n": len(windows), "position_top1": position_top1 / n, "class_top1": class_top1 / n}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=400)
    parser.add_argument("--tune-rows", type=int, default=200)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model(device)

    rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    edit_rows = [row for row in rows if row["label"] != 0][: args.tune_rows + args.rows]
    tune_rows = edit_rows[: args.tune_rows]
    eval_rows = edit_rows[args.tune_rows:]
    print(f"[big-sweep] tune windows {len(tune_rows)}, eval windows {len(eval_rows)}", flush=True)

    tune_windows = collect_windows(model, device, tune_rows)
    eval_windows = collect_windows(model, device, eval_rows)

    # saturation diagnostics
    total = saturated = 0
    for _true, _label, scores in eval_windows:
        for _score, _class, _pos in scores:
            total += 1
    # recompute saturation from raw margins is not stored; approximate via log-odds
    extreme = sum(1 for _t, _l, ss in eval_windows for s, _c, _p in ss if s > 20.0)
    print(f"[big-sweep] positions {total}, edit-log-odds > 20 (saturated fire): {extreme} "
          f"({extreme / max(total, 1):.3%})", flush=True)

    rank = rank_accuracy(eval_windows)
    print(f"[big-sweep] rank@argmax (edit log-odds): {json.dumps(rank)}", flush=True)

    all_scores = np.array([s for _t, _l, ss in tune_windows for s, _c, _p in ss])
    grid = [float(np.quantile(all_scores, q)) for q in (0.90, 0.95, 0.98, 0.99, 0.995, 0.999)]

    best = None
    for threshold in grid:
        hits = false_fires = fired = 0
        for true_pos, label, scores in tune_windows:
            candidates = [item for item in scores if item[0] >= threshold and item[1] != 0]
            if not candidates:
                continue
            fired += 1
            _, _, pos = max(candidates, key=lambda item: item[0])
            if abs(pos - true_pos) <= 1:
                hits += 1
            else:
                false_fires += 1
        n = max(len(tune_windows), 1)
        hit_rate = hits / n
        false_rate = false_fires / n
        objective = hit_rate - false_rate
        if best is None or objective > best["objective"]:
            best = {"threshold": threshold, "hit_rate": hit_rate, "false_fire_rate": false_rate,
                    "fired_rate": fired / n, "objective": objective}
    print(f"[big-sweep] tuned operating point: {json.dumps({k: round(v, 4) for k, v in best.items()})}",
          flush=True)

    hits = false_fires = fired = class_hits = 0
    for true_pos, label, scores in eval_windows:
        candidates = [item for item in scores if item[0] >= best["threshold"] and item[1] != 0]
        if not candidates:
            continue
        fired += 1
        _, class_index, pos = max(candidates, key=lambda item: item[0])
        if abs(pos - true_pos) <= 1:
            hits += 1
            if class_index == label:
                class_hits += 1
        else:
            false_fires += 1
    n = max(len(eval_windows), 1)
    tuned_eval = {
        "n": len(eval_windows),
        "threshold_logodds": best["threshold"],
        "fired_rate": fired / n,
        "hit_rate": hits / n,
        "class_hit_rate": class_hits / n,
        "false_fire_rate": false_fires / n,
    }
    print(f"[big-sweep] tuned eval: {json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in tuned_eval.items()})}",
          flush=True)

    (ART / "sweep.json").write_text(json.dumps({
        "ranking": "edit_logodds = logsumexp(logits[1:]) - logits[0]",
        "saturation_fire_rate": extreme / max(total, 1),
        "rank_no_threshold": rank,
        "tuned_operating_point": best,
        "tuned_eval": tuned_eval,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[big-sweep] wrote {ART / 'sweep.json'}")


if __name__ == "__main__":
    main()
