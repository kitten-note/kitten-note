"""
EFT / NES v0 - Inference demo.

Modes:
    python demo.py                 # in-distribution: held-out synthetic samples
                                   #   (shows predicted class vs ground truth)
    python demo.py --examples      # out-of-domain stress: hand-written sentences
    python demo.py --file path.txt # single document, full position sweep

Every suggestion goes through: calibrated gate -> class -> content-layer payload
(copy-only) -> type-system validation -> policy layer (destructive ops need
higher confidence).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import ATOM_CLASSES, LITERAL_CHARS, apply_atom, expand_span  # noqa: E402
from content import build_index_from_lines  # noqa: E402
from features import extract_feature_ids  # noqa: E402
from predictors import HashedSoftmax, HDCPredictor  # noqa: E402

ART = BASE / "artifacts" / "v0"
SAMPLES = BASE / "data" / "samples" / "test.jsonl"

EXAMPLES = [
    "我们在公园里慢慢的走着，他觉得这样做是对的，因为大家都开心，孩子也在旁边玩。",
    "她认真的做完了作业，然后再仔细的检查了一遍，发现了一个小错误并改正了。",
    "地球是我们的家园，保护环境就是保护自己。我们在日常生活中要节约用水用电，"
    "减少浪费，做好垃圾分类，让地球变得加美好，也让未来的人们能够继续幸福地生活。",
    "他慢慢的走过来，对我们说其实他早就知道了这件事的来龙去脉，只是没说而已。",
]

DESTRUCTIVE = {"DEL_CHAR", "DEL_SPAN", "FMT_BULLET"}
DESTRUCTIVE_MIN_CONF = 0.55           # policy layer (L3): deletions need corroboration


def load_content_index():
    from corpus import load_corpus

    try:
        return build_index_from_lines(load_corpus())
    except FileNotFoundError:
        return None


def resolve_atom(kind: str, document: str, pos: int, index) -> dict | None:
    """Content-layer payload resolution + type check (zero hallucination)."""
    if kind == "FIX_CHAR":
        if index is not None:
            for char, _count in index.propose_next(document[:pos], top=3):
                if char != document[pos] and char in LITERAL_CHARS and not char.isspace():
                    return {"type": "FIX_CHAR", "pos": pos, "char": char}
        return None
    if kind == "INS_CHAR":
        if index is not None:
            for char, _count in index.propose_next(document[:pos], top=3):
                if char in LITERAL_CHARS:
                    return {"type": "INS_CHAR", "pos": pos, "char": char}
        return None
    if kind == "DEL_CHAR":
        return {"type": "DEL_CHAR", "pos": pos}
    if kind == "DEL_SPAN":
        span = expand_span(document, pos, max_len=6)
        if len(span) >= 2:
            start = document.find(span, max(0, pos - 6))
            if start >= 0:
                return {"type": "DEL_SPAN", "start": start, "end": start + len(span)}
        return None
    if kind == "INS_SPAN_COPY":
        if index is not None:
            spans = index.propose_span(document[:pos], max_len=8, top=3)
            if spans:
                return {"type": "INS_SPAN_COPY", "pos": pos, "payload": spans[0]}
        return None
    if kind == "FMT_BULLET":
        line_start = document.rfind("\n", 0, pos) + 1
        return {"type": "FMT_BULLET", "line_start": line_start, "action": "add"}
    return None


def predict_at(document: str, pos: int, hdc, softmax, thresholds, model_name, index,
               min_confidence: float = 0.30) -> dict | None:
    left = document[max(0, pos - 64):pos]
    span = document[pos:pos + 1]
    right = document[pos + 1:pos + 1 + 32]
    ids = extract_feature_ids(left, span, right)
    probs = softmax.predict_proba(ids) if model_name == "softmax" else hdc.predict_proba(ids)
    edit_probability = float(1.0 - probs[0])
    class_index = int(np.argmax(probs))
    if class_index == 0 or edit_probability < thresholds.get(model_name, 0.9):
        return None
    kind = ATOM_CLASSES[class_index]
    confidence = float(probs[class_index])
    if confidence < min_confidence:
        return None
    if kind in DESTRUCTIVE and confidence < DESTRUCTIVE_MIN_CONF:
        return None
    atom = resolve_atom(kind, document, pos, index)
    if atom is None:
        return None
    return {
        "pos": pos,
        "class": kind,
        "confidence": confidence,
        "edit_probability": edit_probability,
        "atom": atom,
    }


def sweep(document: str, hdc, softmax, thresholds, model_name="softmax", index=None,
          max_suggestions=3):
    candidates = []
    for pos in range(len(document)):
        prediction = predict_at(document, pos, hdc, softmax, thresholds, model_name, index)
        if prediction:
            candidates.append(prediction)
    candidates.sort(key=lambda c: -c["edit_probability"])

    applied, consumed, current = [], [], document
    for candidate in candidates:
        if len(applied) >= max_suggestions:
            break
        delta = sum((len(a["after"]) - len(a["before"])) for a in applied if a["pos"] < candidate["pos"])
        pos = candidate["pos"] + delta
        if not (0 <= pos < len(current)) or any(abs(pos - p) < 5 for p in consumed):
            continue
        atom = candidate["atom"]
        if atom["type"] in ("FIX_CHAR", "DEL_CHAR", "INS_CHAR"):
            atom = {**atom, "pos": pos}
        elif atom["type"] in ("DEL_SPAN",):
            shift = pos - candidate["pos"]
            atom = {**atom, "start": atom["start"] + shift, "end": atom["end"] + shift}
        elif atom["type"] == "INS_SPAN_COPY":
            atom = {**atom, "pos": pos}
        elif atom["type"] == "FMT_BULLET":
            atom = {**atom, "line_start": current.rfind("\n", 0, pos) + 1}

        repaired = apply_atom(current, atom)
        if repaired is None:
            continue
        applied.append({
            **{k: candidate[k] for k in ("pos", "class", "confidence", "edit_probability")},
            "before": current[pos:pos + 1] if atom["type"] in ("DEL_CHAR", "FIX_CHAR") else "",
            "after": atom.get("char", atom.get("payload", "")),
        })
        consumed.append(pos)
        current = repaired
    return current, applied


def demo_samples(count: int, hdc, softmax, thresholds, index) -> None:
    rows = []
    with SAMPLES.open("r", encoding="utf-8") as handle:
        for line in handle:
            rows.append(json.loads(line))
    edits = [r for r in rows if r["label"] != 0][:count]
    hit = 0
    for row in edits:
        document = row["left"] + row["span"] + row["right"]
        pos = len(row["left"])
        prediction = predict_at(document, pos, hdc, softmax, thresholds, "softmax", index)
        truth = ATOM_CLASSES[row["label"]]
        if prediction and prediction["class"] == truth:
            hit += 1
        predicted = f"{prediction['class']} (P={prediction['edit_probability']:.3f}, conf={prediction['confidence']:.3f})" if prediction else "—"
        print(f"  真值 {truth:<14} 预测 {predicted}")
        print(f"    上下文 …{document[max(0, pos-24):pos]}〖{document[pos:pos+1]}〗{document[pos+1:pos+25]}…")
    print(f"\n在分布命中: {hit}/{len(edits)}")


def demo_document(document: str, hdc, softmax, thresholds, index) -> None:
    repaired, suggestions = sweep(document, hdc, softmax, thresholds, index=index)
    print("=" * 72)
    print("原文 :", document[:110] + ("…" if len(document) > 110 else ""))
    print(f"建议 : {len(suggestions)} 处")
    for s in suggestions:
        detail = f"→ {s['after']!r}" if s["after"] else f"×删除 {s['before']!r}"
        print(
            f"   - pos {s['pos']:>4}  {s['class']:<13} "
            f"P(edit)={s['edit_probability']:.3f} conf={s['confidence']:.3f}  {detail}"
        )
    print("修复 :", repaired[:110] + ("…" if len(repaired) > 110 else ""))


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, default="")
    parser.add_argument("--examples", action="store_true")
    parser.add_argument("--model", default="softmax", choices=["softmax", "hdc"])
    parser.add_argument("--count", type=int, default=6)
    args = parser.parse_args()

    hdc = HDCPredictor.load(ART / "hdc.npz")
    softmax = HashedSoftmax.load(ART / "softmax.npz")
    config = json.loads((ART / "config.json").read_text(encoding="utf-8"))
    thresholds = config.get("thresholds", {})
    index = load_content_index()

    if args.file:
        demo_document(Path(args.file).read_text(encoding="utf-8"), hdc, softmax, thresholds, index)
    elif args.examples:
        for document in EXAMPLES:
            demo_document(document, hdc, softmax, thresholds, index)
    else:
        print("== 在分布样本（留出集）逐点预测 ==")
        demo_samples(args.count, hdc, softmax, thresholds, index)


if __name__ == "__main__":
    main()
