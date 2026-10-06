"""Dump Python feature names for the first rows of the test split (debug)."""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from features import extract_feature_names  # noqa: E402

rows = []
with (BASE / "data" / "samples" / "test.jsonl").open("r", encoding="utf-8") as handle:
    for line in handle:
        rows.append(json.loads(line))

only = int(sys.argv[1]) if len(sys.argv) > 1 else None
picked = rows[:3] if only is None else [rows[only]]

out = [
    {
        "row": i if only is None else only,
        "left": r["left"],
        "span": r["span"],
        "right": r["right"],
        "names": extract_feature_names(r["left"], r["span"], r["right"]),
    }
    for i, r in enumerate(picked)
]
print(json.dumps(out, ensure_ascii=False))
