"""Dump Python HDC cosines for row 94 (debug)."""
import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from features import extract_feature_ids  # noqa: E402
from predictors import HDCPredictor  # noqa: E402

rows = [json.loads(line) for line in (BASE / "data" / "samples" / "test.jsonl").read_text(encoding="utf-8").split("\n") if line]
row = rows[94]

hdc = HDCPredictor.load(BASE / "artifacts" / "v0" / "hdc.npz")
ids = extract_feature_ids(row["left"], row["span"], row["right"])
vector = hdc.encoder.vector(ids).astype(np.float64)
rows_idx = np.asarray(ids, dtype=np.int64) % hdc.encoder.bins
votes = hdc.encoder._bipolar[rows_idx].sum(axis=0, dtype=np.int32)
protos = hdc.prototypes()
norms = np.linalg.norm(protos, axis=1)
cosines = (protos @ vector) / np.maximum(norms * np.linalg.norm(vector), 1e-9)
probs = hdc.predict_proba(ids)

with (BASE / "data" / "vec_py.txt").open("w", encoding="utf-8") as handle:
    handle.write("".join("1" if v > 0 else "0" for v in vector))

sorted_ids = sorted(int(i) for i in ids)
print(json.dumps({
    "ids": sorted_ids,
    "id_count": len(sorted_ids),
    "cosines": [float(c) for c in cosines],
    "probs": [float(p) for p in probs],
    "scale": hdc.scale,
    "prototype_row0": [float(x) for x in protos[0][:8]],
    "bits_at_861": [int(hdc.encoder._bipolar[i % hdc.encoder.bins][861] > 0) for i in sorted_ids],
    "votes_at": {str(pos): int(votes[pos]) for pos in (861, 3128, 3373, 3374, 5427, 5430, 7224, 7225)},
    "ones_at": {str(pos): int((hdc.encoder._bipolar[rows_idx][:, pos] > 0).sum()) for pos in (861, 3128, 3373, 3374, 5427, 5430, 7224, 7225)},
}))
