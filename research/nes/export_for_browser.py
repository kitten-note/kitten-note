"""
EFT / NES v0 - Export trained artifacts for the browser (JS) reference runtime.

Reads artifacts/v0/{hdc.npz, softmax.npz, config.json} plus the test split and
writes a self-contained bundle into artifacts/v0/browser/:

    model.json          - meta (dims, thresholds, scales)
    prototypes.bin      - float32 (7 x D) HDC class prototypes
    base.bin            - packed bits (FEATURE_DIM x D/8) HDC base vectors
    softmax.bin         - float32 (D x 7) weights + float32 bias + temperature
    test_vectors.json   - 200 samples with Python-computed expected probabilities

The JS runtime (browser/eft.mjs) must reproduce expected probabilities within
1e-4 (checked by browser/test_infer.mjs under Node).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import ATOM_CLASSES  # noqa: E402
from features import FEATURE_DIM, HDCEncoder, extract_feature_ids  # noqa: E402
from predictors import HashedSoftmax, HDCPredictor  # noqa: E402

ART = BASE / "artifacts" / "v0"
OUT = ART / "browser"
SAMPLES = BASE / "data" / "samples" / "test.jsonl"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    hdc = HDCPredictor.load(ART / "hdc.npz")
    softmax = HashedSoftmax.load(ART / "softmax.npz")
    config = json.loads((ART / "config.json").read_text(encoding="utf-8"))

    OUT.mkdir(parents=True, exist_ok=True)

    # 1) HDC artifacts -----------------------------------------------------
    prototypes = hdc.prototypes().astype(np.float64)  # float64 = exact match with Python
    prototypes.tofile(OUT / "prototypes.bin")
    # base vectors: regenerate exactly like HDCEncoder does (same seed)
    encoder = HDCEncoder()
    encoder._packed.astype(np.uint8).tofile(OUT / "base.bin")

    # 2) softmax artifacts -------------------------------------------------
    with (OUT / "softmax.bin").open("wb") as handle:
        handle.write(np.asarray(softmax.weights, dtype=np.float64).tobytes())
        handle.write(np.asarray(softmax.bias, dtype=np.float64).tobytes())

    (OUT / "model.json").write_text(json.dumps({
        "version": "eft-nes-v0",
        "classes": ATOM_CLASSES,
        "feature_dim": FEATURE_DIM,
        "hdc_dim": hdc.dim,
        "hdc_bins": encoder.bins,
        "hdc_scale": hdc.scale,
        "softmax_temperature": softmax.temperature,
        "gate_thresholds": config.get("thresholds", {}),
        "files": {
            "prototypes": "prototypes.bin",
            "base": "base.bin",
            "softmax": "softmax.bin",
        },
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # 3) golden vectors ----------------------------------------------------
    rows = []
    with SAMPLES.open("r", encoding="utf-8") as handle:
        for line in handle:
            rows.append(json.loads(line))
            if len(rows) >= 200:
                break

    vectors = []
    for row in rows:
        ids = extract_feature_ids(row["left"], row["span"], row["right"])
        hdc_probs = hdc.predict_proba(ids)
        softmax_probs = softmax.predict_proba(ids)
        vectors.append({
            "left": row["left"],
            "span": row["span"],
            "right": row["right"],
            "label": row["label"],
            "hdc_probs": [float(p) for p in hdc_probs],
            "softmax_probs": [float(p) for p in softmax_probs],
        })

    (OUT / "test_vectors.json").write_text(
        json.dumps(vectors, ensure_ascii=False), encoding="utf-8")

    print(f"[export] wrote browser bundle to {OUT}")
    for path in sorted(OUT.iterdir()):
        print(f"    {path.name}: {path.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
