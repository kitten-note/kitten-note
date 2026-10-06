"""
Re-evaluate the trained v0 model with the corrected sweep decision rule
(gate -> per-class confidence thresholds -> greedy suppression).

Usage: python eval_sweep.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from evaluate import local_sweep_metrics  # noqa: E402
from features import extract_feature_ids  # noqa: E402
from predictors import HashedSoftmax  # noqa: E402
from synth import load_samples  # noqa: E402

ART = BASE / "artifacts" / "v0"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    softmax = HashedSoftmax.load(ART / "softmax.npz")
    config = json.loads((ART / "config.json").read_text(encoding="utf-8"))
    rows = load_samples(BASE / "data" / "samples" / "test.jsonl")
    gate = config["thresholds"]["softmax"]
    class_thresholds = config.get("class_thresholds", {})

    predict = lambda left, span, right: softmax.predict_proba(extract_feature_ids(left, span, right))

    old_rule = local_sweep_metrics(predict, rows, gate, max_rows=1200)
    new_rule = local_sweep_metrics(predict, rows, gate, max_rows=1200, class_thresholds=class_thresholds)

    print("old rule (gate only):        ", {k: round(v, 4) for k, v in old_rule.items()})
    print("new rule (+class thresholds):", {k: round(v, 4) for k, v in new_rule.items()})

    metrics_path = ART / "metrics.json"
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        metrics["sweep_corrected"] = new_rule
        metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"updated {metrics_path}")


if __name__ == "__main__":
    main()
