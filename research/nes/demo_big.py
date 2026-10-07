"""
EFT / NES - interactive demo with the 256M-parameter predictor.

Model: artifacts/big-3ep-geo (260,047,072 params, from scratch, single pass).
Every suggestion goes through the same typed pipeline as v0:

    typed candidate sweep (char/ins/del2-4 per position)
      -> edit log-odds gate (unsaturated ranking)
      -> typed class
      -> content-layer payload (copy-only grounding)
      -> type check (apply_atom must succeed)
      -> policy (at most one suggestion per +-5 chars)

Play:
    python demo_big.py --examples                 # built-in typo examples
    python demo_big.py --file my.txt              # your document, full sweep
    python demo_big.py --stdin                    # type lines, Enter for suggestions
    python demo_big.py --file my.txt --threshold 6 --top 5
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import ATOM_CLASSES, apply_atom  # noqa: E402
from big_data import _hash_ids  # noqa: E402
from big_model import BigEditPredictor  # noqa: E402
from demo import load_content_index, resolve_atom as _resolve_atom  # noqa: E402


def _bounded_span(document: str, pos: int, max_len: int = 4) -> str:
    stop = " \n\t，。！？；：、（）"
    end = pos
    while end < len(document) and document[end] not in stop and end - pos < max_len:
        end += 1
    return document[pos:end]


def resolve_atom(kind: str, document: str, pos: int, index):
    """DEL_SPAN stays a bounded word chunk (no long natural-span expansion)."""
    if kind == "DEL_SPAN":
        span = _bounded_span(document, pos, 4)
        if len(span) >= 2:
            return {"type": "DEL_SPAN", "start": pos, "end": pos + len(span)}
        return None
    return _resolve_atom(kind, document, pos, index)

MODEL = BASE / "artifacts" / "big-3ep-geo" / "model.pt"

EXAMPLES = [
    "他慢慢的走过来，对我们说其实他早就知道了这件事的来龙去脉，只是没说而已。",
    "我真的很喜欢这本书，它让我学到了很多东西。虽然有些地方我还不太明白，但是我觉得很受益非浅。",
    "今天天气真好我们一起去公园散步吧，顺便看看湖边的柳树。",
    "这个这个问题我们下次再讨论，现在已经很晚了。",
    "人工智能正在改变我们的生活方式，从智能手机到自动驾驶汽车，技术的进步让很多事情变得加方便。",
]


def load_model(device: str) -> BigEditPredictor:
    model = BigEditPredictor().to(device)
    model.load_state_dict(torch.load(MODEL, map_location=device, weights_only=False)["model"])
    model.eval()
    return model


def logits_for(model, device, left: str, span: str, right: str) -> np.ndarray:
    ids = _hash_ids(left, span, right).astype(np.int64)
    with torch.no_grad():
        logits = model(torch.from_numpy(ids).to(device), torch.zeros(1, dtype=torch.long, device=device))
        return logits.cpu().numpy()[0].astype(np.float64)


def edit_logodds(logits: np.ndarray) -> float:
    a = logits[1:]
    m = float(a.max())
    return m + float(np.log(np.exp(a - m).sum())) - float(logits[0])


def typed_candidates(document: str, pos: int):
    left = document[max(0, pos - 64):pos]
    yield "char", pos, left, document[pos:pos + 1], document[pos + 1:pos + 33]
    yield "ins", pos, left, "", document[pos:pos + 32]
    for width in (2, 3, 4):
        if pos + width <= len(document):
            yield f"del{width}", pos, left, document[pos:pos + width], document[pos + width:pos + width + 32]


def score_positions(document: str, model, device) -> list:
    scored = []
    for pos in range(len(document)):
        best = None
        for kind, cand_pos, left, span, right in typed_candidates(document, pos):
            logits = logits_for(model, device, left, span, right)
            score = edit_logodds(logits)
            if best is None or score > best["logodds"]:
                best = {"pos": cand_pos, "logodds": score, "class_index": int(np.argmax(logits)), "kind": kind}
        if best is not None and best["class_index"] not in (0, 6):
            scored.append(best)
    scored.sort(key=lambda item: -item["logodds"])
    return scored


def describe(atom: dict, document: str) -> str:
    kind = atom["type"]
    if kind == "FIX_CHAR":
        return f"{document[atom['pos']]!r} → {atom['char']!r}"
    if kind == "DEL_CHAR":
        return f"删除 {document[atom['pos']]!r}"
    if kind == "DEL_SPAN":
        return f"删除 {document[atom['start']:atom['end']]!r}"
    if kind == "INS_CHAR":
        return f"插入 {atom['char']!r}"
    if kind == "INS_SPAN_COPY":
        return f"插入 {atom['payload']!r}"
    if kind == "FMT_BULLET":
        return "行首加 '- '"
    return kind


def sweep(document: str, model, device, index, threshold: float, top: int = 3):
    scored = score_positions(document, model, device)

    accepted, consumed = [], []
    for candidate in scored:
        if len(accepted) >= top or candidate["logodds"] < threshold:
            break
        if any(abs(candidate["pos"] - pos) < 5 for pos in consumed):
            continue
        class_name = ATOM_CLASSES[candidate["class_index"]]
        atom = resolve_atom(class_name, document, candidate["pos"], index)
        if atom is None:
            continue
        if apply_atom(document, atom) is None:
            continue
        accepted.append({**candidate, "class_name": class_name, "atom": atom})
        consumed.append(candidate["pos"])

    repaired = document
    for candidate in sorted(accepted, key=lambda item: -item["pos"]):
        result = apply_atom(repaired, candidate["atom"])
        if result is not None:
            repaired = result

    near = [c for c in scored[:3] if c not in accepted]
    return repaired, accepted, near


def show(document: str, model, device, index, threshold: float, top: int) -> None:
    if len(document) < 24:
        print("=" * 72)
        print("原文 :", document)
        print("  （文本太短，< 24 字，超出训练分布；模型在长文本上工作）")
        return
    repaired, accepted, near = sweep(document, model, device, index, threshold, top)
    print("=" * 72)
    print("原文 :", document)
    print(f"建议 : {len(accepted)} 处（阈值 log-odds ≥ {threshold}）")
    for suggestion in accepted:
        atom = suggestion["atom"]
        pos = suggestion["pos"]
        left = document[max(0, pos - 12):pos]
        right = document[pos + 1:pos + 13]
        print(f"   - pos {pos:>4}  {suggestion['class_name']:<13} log-odds {suggestion['logodds']:>6.2f}  "
              f"{describe(atom, document)}")
        print(f"     …{left}〖{document[pos:pos + 1]}〗{right}…")
    if not accepted and near:
        print("   （未达阈值的最高候选，供参考）")
        for candidate in near:
            print(f"   - pos {candidate['pos']:>4}  {ATOM_CLASSES[candidate['class_index']]:<13} "
                  f"log-odds {candidate['logodds']:>6.2f}")
    if accepted:
        print("修复 :", repaired)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--examples", action="store_true")
    parser.add_argument("--sample", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=6.0)
    parser.add_argument("--top", type=int, default=3)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[demo-big] loading 260M model on {device} ...", flush=True)
    model = load_model(device)
    index = load_content_index()
    print(f"[demo-big] ready (content index: {'yes' if index else 'no'})", flush=True)

    if args.file:
        document = Path(args.file).read_text(encoding="utf-8").strip()
        show(document, model, device, index, args.threshold, args.top)
    elif args.sample:
        import json

        rows = []
        with (BASE / "data" / "samples" / "test.jsonl").open("r", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                if row["label"] != 0:
                    rows.append(row)
                if len(rows) >= args.sample:
                    break
        for row in rows:
            document = row["left"] + row["span"] + row["right"]
            truth = ATOM_CLASSES[row["label"]]
            print("=" * 72)
            print(f"真值 : {truth}（合成测试集留出样本，真编辑位置 pos={len(row['left'])}）")
            show(document, model, device, index, args.threshold, args.top)
    elif args.stdin:
        print("[demo-big] 输入文本后回车（Ctrl+Z 回车 结束）:")
        for line in sys.stdin:
            line = line.strip()
            if line:
                show(line, model, device, index, args.threshold, args.top)
    else:
        for document in EXAMPLES:
            show(document, model, device, index, args.threshold, args.top)


if __name__ == "__main__":
    main()
