"""
EFT-v1 encoder - interactive demo with the champion model (enc-s-full5).

One forward pass tags every gap; confusion-first FIX payloads; copy-only
grounding; type-checked application.

Play:
    python demo_enc.py --stdin              # type lines, Enter for suggestions
    python demo_enc.py --file my.txt        # single document, full tagging
    python demo_enc.py --sample 3           # synthetic test windows (truth shown)
    python demo_enc.py --stdin --threshold 3
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

from atoms import ATOM_CLASSES, apply_atom  # noqa: E402
from demo import load_confusion, load_content_index  # noqa: E402
from enc_model import PRESETS  # noqa: E402
from synth import load_samples  # noqa: E402

MODEL = BASE / "artifacts" / "enc-s-full5" / "model.pt"
SEQ = BASE / "data" / "seq"


def load_model(device: str, model_path: Path | None = None):
    checkpoint = torch.load(model_path or MODEL, map_location=device, weights_only=False)
    vocab = json.loads((SEQ / "vocab.json").read_text(encoding="utf-8"))
    stoi, maxlen = vocab["stoi"], vocab["maxlen"]
    config = PRESETS[checkpoint.get("preset", "S")]
    from enc_model import TinyEditEncoder
    model = TinyEditEncoder(len(stoi), d=config["d"], layers=config["layers"],
                            heads=config["heads"], ffn=config["ffn"],
                            maxlen=maxlen).to(device)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model, stoi, maxlen


def tag_document(model, device, stoi, maxlen, document: str) -> np.ndarray:
    tokens = [2] + [stoi.get(char, 1) for char in document[:maxlen - 1]]
    with torch.no_grad():
        logits = model(torch.tensor([tokens], dtype=torch.long, device=device))
        return logits.cpu().numpy()[0].astype(np.float64)


def edit_logodds(logits: np.ndarray) -> np.ndarray:
    a = logits[:, 1:]
    m = a.max(axis=1, keepdims=True)
    return (m + np.log(np.exp(a - m).sum(axis=1, keepdims=True)) - logits[:, :1]).ravel()


def fix_payload(document: str, pos: int, index, confusion: dict):
    current = document[pos] if 0 <= pos < len(document) else ""
    for char in confusion.get(current, []):
        if char != current:
            return char
    if index is not None:
        from atoms import LITERAL_CHARS
        for char, _ in index.propose_next(document[:pos], top=3):
            if char != current and char in LITERAL_CHARS and not char.isspace():
                return char
    return None


def suggest(document: str, model, device, stoi, maxlen, index, confusion: dict,
            threshold: float, top: int = 3):
    tokens = [2] + [stoi.get(char, 1) for char in document[:maxlen - 1]]
    length = len(tokens)
    logits = tag_document(model, device, stoi, maxlen, document)[:length]
    scores = edit_logodds(logits)
    order = np.argsort(-scores)

    suggestions = []
    used = []
    for gap in order:
        if len(suggestions) >= top or scores[gap] < threshold:
            break
        class_index = int(np.argmax(logits[gap]))
        if class_index == 0 or class_index in (5, 6):
            continue
        atom = None
        pos = -1
        if class_index in (1, 2) and gap >= 1:
            pos = int(gap) - 1
            if class_index == 1:
                char = fix_payload(document, pos, index, confusion)
                if char is None:
                    continue
                atom = {"type": "FIX_CHAR", "pos": pos, "char": char}
            else:
                atom = {"type": "DEL_CHAR", "pos": pos}
        elif class_index == 3:
            pos = int(gap)
            if pos > len(document):
                continue
            char = None
            if index is not None:
                for cand, _ in index.propose_next(document[:pos], top=3):
                    if cand.strip():
                        char = cand
                        break
            if char is None:
                continue
            atom = {"type": "INS_CHAR", "pos": pos, "char": char}
        elif class_index == 4:
            continue  # span merging handled below
        if atom is None or apply_atom(document, atom) is None:
            continue
        if any(abs(pos - u) < 5 for u in used):
            continue
        used.append(pos)
        suggestions.append({"pos": pos, "class": ATOM_CLASSES[class_index],
                            "score": float(scores[gap]), "atom": atom})

    # DEL_SPAN: merge consecutive class-4 gaps above threshold.
    span_start = -1
    for gap in list(order) + [-1]:
        is_span = gap >= 0 and int(np.argmax(logits[gap])) == 4 and scores[gap] >= threshold + 4
        if is_span and span_start < 0:
            span_start = gap
        if not is_span and span_start >= 1:
            start, end = int(span_start) - 1, int(gap) - 1 if gap >= 0 else length - 1
            if end - start >= 2 and not any(abs(start - u) < 5 for u in used):
                atom = {"type": "DEL_SPAN", "start": start, "end": end}
                if apply_atom(document, atom) is not None:
                    used.append(start)
                    suggestions.append({"pos": start, "class": "DEL_SPAN",
                                        "score": float(scores[span_start]), "atom": atom})
            span_start = -1

    suggestions.sort(key=lambda s: -s["score"])
    return suggestions[:top]


def describe(atom: dict, document: str) -> str:
    kind = atom["type"]
    if kind == "FIX_CHAR":
        return f"{document[atom['pos']]!r} → {atom['char']!r}"
    if kind == "DEL_CHAR":
        return f"删除 {document[atom['pos']]!r}"
    if kind == "DEL_SPAN":
        return f"删除 {document[atom['start']:atom['end']]!r}"
    if kind == "INS_CHAR":
        return f"在 {document[atom['pos']:atom['pos']+1]!r} 前插入 {atom['char']!r}"
    return kind


def show(document: str, model, device, stoi, maxlen, index, confusion, threshold: float, top: int,
         truth: str = "") -> None:
    if len(document) < 24:
        print("=" * 72)
        print("原文 :", document)
        print("  （文本太短，< 24 字，超出训练分布）")
        return
    suggestions = suggest(document, model, device, stoi, maxlen, index, confusion, threshold, top)
    print("=" * 72)
    if truth:
        print(f"真值 : {truth}")
    print("原文 :", document)
    print(f"建议 : {len(suggestions)} 处（阈值 log-odds ≥ {threshold}）")
    repaired = document
    for s in suggestions:
        print(f"   - pos {s['pos']:>4}  {s['class']:<13} log-odds {s['score']:>6.2f}  {describe(s['atom'], document)}")
    for s in sorted(suggestions, key=lambda s: -s["pos"]):
        result = apply_atom(repaired, s["atom"])
        if result is not None:
            repaired = result
    if suggestions:
        print("修复 :", repaired)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--sample", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=4.0)
    parser.add_argument("--top", type=int, default=3)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("[demo-enc] loading enc-s-full5 ...", flush=True)
    model, stoi, maxlen = load_model(device)
    index = load_content_index()
    confusion = load_confusion()
    print("[demo-enc] ready", flush=True)

    if args.file:
        show(Path(args.file).read_text(encoding="utf-8").strip(), model, device, stoi, maxlen,
             index, confusion, args.threshold, args.top)
    elif args.sample:
        rows = [r for r in load_samples(BASE / "data" / "samples" / "test.jsonl") if r["label"] != 0][:args.sample]
        for row in rows:
            show(row["left"] + row["span"] + row["right"], model, device, stoi, maxlen,
                 index, confusion, args.threshold, args.top, truth=ATOM_CLASSES[row["label"]])
    elif args.stdin:
        print("[demo-enc] 输入文本后回车（Ctrl+Z 回车 结束）:")
        for line in sys.stdin:
            if line.strip():
                show(line.strip(), model, device, stoi, maxlen, index, confusion, args.threshold, args.top)
    else:
        for text in [
            "今天开会讨论了下个季度的目标，老板说的很对，我们确实需要在效率上在下功夫。",
            "我是一个中华民国的作家，致力于编写反动整治书籍，这表明我是一个正动派",
        ]:
            show(text, model, device, stoi, maxlen, index, confusion, args.threshold, args.top)


if __name__ == "__main__":
    main()
