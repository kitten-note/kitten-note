"""
EFT-v1 (contextual encoder) - sequence-label data pipeline.

Gap tagging formulation: for a noisy doc of n chars, there are n+1 gaps
(gap i = "before char i"). Each gap gets one of the 7 typed classes:

    FIX_CHAR / DEL_CHAR on char j      -> gap j+1
    INS_CHAR / INS_SPAN_COPY at gap p  -> gap p
    DEL_SPAN covering chars [s, e)      -> gaps s+1 .. e  (merged at inference)
    FMT_BULLET at line start L         -> gap L
    otherwise                          -> NO_EDIT

Input tokens: [<S>, c0 .. c{n-1}] (n+1 slots, one per gap). No span input at
all, so the v0 geometry leakage (span length predicting the label) disappears
structurally. Clean segments (no edits) are built-in hard negatives.

Writes: data/seq/{train,val}.npz (padded ids/labels) + vocab.json + stats.json
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import CLASS_TO_ID, apply_atom, diff_to_atoms  # noqa: E402
from big_data import load_lines, segment  # noqa: E402
from synth import Synthesizer  # noqa: E402

SEQ_DIR = BASE / "data" / "seq"
REV_PAIRS = BASE / "data" / "external" / "rev_pairs.jsonl"
CSC_TRAIN = BASE / "data" / "external" / "shibing624__CSC" / "train.json"
CSC_DEV = BASE / "data" / "external" / "shibing624__CSC" / "dev.json"


def _atom_anchor(atom: dict) -> int:
    kind = atom["type"]
    if kind in ("FIX_CHAR", "DEL_CHAR", "INS_CHAR", "INS_SPAN_COPY"):
        return atom["pos"]
    if kind == "DEL_SPAN":
        return atom["start"]
    if kind == "FMT_BULLET":
        return atom["line_start"]
    return 0


def _atom_span(atom: dict) -> tuple:
    kind = atom["type"]
    if kind in ("FIX_CHAR", "DEL_CHAR"):
        return atom["pos"], atom["pos"] + 1
    if kind in ("INS_CHAR", "INS_SPAN_COPY"):
        return atom["pos"], atom["pos"]
    if kind == "DEL_SPAN":
        return atom["start"], atom["end"]
    if kind == "FMT_BULLET":
        return atom["line_start"], atom["line_start"]
    return 0, 0


def _shift_atom(atom: dict, delta: int) -> dict:
    out = dict(atom)
    kind = out["type"]
    if kind in ("FIX_CHAR", "DEL_CHAR", "INS_CHAR", "INS_SPAN_COPY"):
        out["pos"] = out["pos"] + delta
    elif kind == "DEL_SPAN":
        out["start"] = out["start"] + delta
        out["end"] = out["end"] + delta
    elif kind == "FMT_BULLET":
        out["line_start"] = out["line_start"] + delta
    return out


def load_rev_labeled(cap_windows: int = 8000, window: int = 240) -> List:
    """Real human edits (wiki revisions) as gap-labeled segments.

    Full articles don't fit the encoder window: cut one window per edit
    covering the atom span plus context, remap positions, re-validate.
    """
    items = []
    seen = set()
    if not REV_PAIRS.exists():
        return items
    with REV_PAIRS.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if len(items) >= cap_windows:
                break
            try:
                item = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            wrong, correct = item.get("wrong", ""), item.get("correct", "")
            if len(wrong) < 24 or wrong == correct:
                continue
            try:
                atoms = diff_to_atoms(wrong, correct, max_ops=3)
            except Exception:  # noqa: BLE001
                continue
            if not (1 <= len(atoms) <= 3):
                continue
            if any(a.get("type") not in CLASS_TO_ID or a["type"] == "NO_EDIT" for a in atoms):
                continue
            for atom in atoms:
                if len(items) >= cap_windows:
                    break
                start_span, end_span = _atom_span(atom)
                start = max(0, start_span - 100)
                end = min(len(wrong), max(end_span + 100, start + 24))
                if end - start > 280 or end - start < 24:
                    continue
                piece = wrong[start:end]
                if piece in seen:
                    continue
                seen.add(piece)
                remapped = _shift_atom(atom, -start)
                test = apply_atom(piece, remapped)
                if test is None:
                    continue
                labels, _ = gap_labels(
                    piece, [{"atom": remapped, "label": CLASS_TO_ID[remapped["type"]]}])
                if labels.sum() == 0:
                    continue
                items.append((piece, labels))
    return items


MAXLEN = 288            # tokens incl. <S>
PAD, UNK, BOS = 0, 1, 2
MAX_VOCAB = 15000


def build_vocab(lines: List[str], max_vocab: int = MAX_VOCAB) -> Dict[str, int]:
    counts: Counter = Counter()
    for line in lines[:200_000]:
        counts.update(line)
    chars = [ch for ch, _ in counts.most_common(max_vocab)]
    stoi = {"<PAD>": PAD, "<UNK>": UNK, "<S>": BOS}
    for char in chars:
        if char not in stoi:
            stoi[char] = len(stoi)
    return stoi


def encode(text: str, stoi: Dict[str, int]) -> List[int]:
    return [BOS] + [stoi.get(char, UNK) for char in text[:MAXLEN - 1]]


def gap_labels(noisy: str, samples: List[Dict]) -> Tuple[np.ndarray, int]:
    """Gap-level labels for one noisy doc. Returns (labels, collisions)."""
    labels = np.zeros(len(noisy) + 1, dtype=np.int8)
    collisions = 0
    for sample in samples:
        if int(sample["label"]) == 0:
            continue
        atom = sample["atom"]
        kind = atom["type"]
        label = CLASS_TO_ID[kind]
        if kind in ("FIX_CHAR", "DEL_CHAR"):
            gaps = [atom["pos"] + 1]
        elif kind in ("INS_CHAR", "INS_SPAN_COPY"):
            gaps = [atom["pos"]]
        elif kind == "DEL_SPAN":
            gaps = list(range(atom["start"] + 1, atom["end"] + 1))
        elif kind == "FMT_BULLET":
            gaps = [atom["line_start"]]
        else:
            continue
        for gap in gaps:
            if 0 <= gap <= len(noisy):
                if labels[gap] != 0:
                    collisions += 1
                labels[gap] = label
    return labels, collisions


def load_csc_labeled(path: Path, cap: int = 300_000) -> List:
    """Real human typos (CSC train/dev) as gap-labeled segments.

    Same-length substitution pairs only: error char j -> FIX_CHAR at gap j+1.
    NEVER point this at test.json (it stays the blind set).
    """
    assert path.name != "test.json", "test.json stays blind"
    items = []
    if not path.exists():
        return items
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return items
    for row in rows:
        if len(items) >= cap:
            break
        wrong, correct = row.get("original_text", ""), row.get("correct_text", "")
        if len(wrong) != len(correct) or not (2 <= len(wrong) <= MAXLEN - 1):
            continue
        positions = [p for p in row.get("wrong_ids", []) if 0 <= p < len(wrong)]
        if not positions:
            continue
        labels = np.zeros(len(wrong) + 1, dtype=np.int8)
        for pos in positions:
            if wrong[pos] == correct[pos]:
                continue
            labels[pos + 1] = CLASS_TO_ID["FIX_CHAR"]
        if labels.sum() == 0:
            continue
        items.append((wrong, labels))
    return items


def build(max_segments: int = 60_000, minutes: float = 20.0, seed: int = 20261007,
          short_n: int = 2) -> Dict:
    SEQ_DIR.mkdir(parents=True, exist_ok=True)
    lines = load_lines()
    print(f"[seq] text lines: {len(lines)}", flush=True)

    stoi = build_vocab(lines)
    (SEQ_DIR / "vocab.json").write_text(
        json.dumps({"stoi": stoi, "maxlen": MAXLEN}, ensure_ascii=False), encoding="utf-8")
    print(f"[seq] vocab: {len(stoi)}", flush=True)

    synth = Synthesizer(lines[:2000], seed=seed)
    rng = np.random.default_rng(seed + 1)
    deadline = time.time() + minutes * 60
    edited, clean = [], []
    collisions = 0
    scanned = 0

    for line in lines:
        if (len(edited) >= max_segments and len(clean) >= 15000) or time.time() > deadline:
            break
        pieces = list(segment(line))
        # Short-text regime (42-60 chars): the app sees short notes/chat text,
        # but synthesis previously only saw 60-260 char pieces. Slices below
        # 42 chars are skipped (synthesis needs 2*EDGE+10 chars of context).
        if len(line) >= 50:
            for _ in range(short_n):
                start = int(rng.integers(0, len(line) - 42))
                end = start + int(rng.integers(42, min(61, len(line) - start + 1)))
                cand = " ".join(line[start:end].split())
                if 42 <= len(cand) <= 60:
                    pieces.append(cand)
        for piece in pieces:
            if (len(edited) >= max_segments and len(clean) >= 15000) or time.time() > deadline:
                break
            scanned += 1
            # Explicit clean segments (raw text, all-zero labels): the
            # synthesizer injects edits into almost every piece, so natural
            # clean segments would otherwise be ~0.01% of the data.
            if len(clean) < 15000 and 60 <= len(piece) <= MAXLEN - 10 and rng.random() < 0.25:
                clean.append((piece, np.zeros(len(piece) + 1, dtype=np.int8)))
                continue
            try:
                samples, noisy = synth.make_doc_samples(piece, return_noisy=True)
            except AssertionError:
                continue
            if len(noisy) + 1 > MAXLEN or len(noisy) < 24:
                continue
            edits = [s for s in samples if int(s["label"]) != 0]
            if not edits:
                if len(clean) < 15000 and len(piece) >= 60:
                    clean.append((piece, np.zeros(len(piece) + 1, dtype=np.int8)))
                continue
            labels, hit = gap_labels(noisy, edits)
            collisions += hit
            edited.append((noisy, labels))

    print(f"[seq] scanned {scanned} pieces -> {len(edited)} edited + {len(clean)} clean "
          f"(collisions {collisions})", flush=True)

    rev_items = load_rev_labeled()
    print(f"[seq] real revision windows: {len(rev_items)}", flush=True)
    edited.extend(rev_items)

    csc_items = load_csc_labeled(CSC_TRAIN)
    print(f"[seq] real CSC typo segments: {len(csc_items)}", flush=True)
    edited.extend(csc_items)

    rng = np.random.default_rng(seed)
    edited_ids = rng.permutation(len(edited))
    val_take = max(100, len(edited) // 50)

    def pack(items):
        ids = np.zeros((len(items), MAXLEN), dtype=np.int32)
        labels = np.zeros((len(items), MAXLEN), dtype=np.int8)
        for i, (text, lab) in enumerate(items):
            toks = encode(text, stoi)
            ids[i, :len(toks)] = toks
            labels[i, :len(lab)] = lab[:MAXLEN]
        return ids, labels

    train_items = [edited[i] for i in edited_ids[val_take:]] + clean
    val_items = [edited[i] for i in edited_ids[:val_take]]
    csc_dev = load_csc_labeled(CSC_DEV, cap=3000)
    print(f"[seq] real CSC dev segments in val: {len(csc_dev)}", flush=True)
    val_items.extend(csc_dev)
    train_ids, train_labels = pack(train_items)
    val_ids, val_labels = pack(val_items)
    np.savez_compressed(SEQ_DIR / "train.npz", ids=train_ids, labels=train_labels)
    np.savez_compressed(SEQ_DIR / "val.npz", ids=val_ids, labels=val_labels)

    counts = Counter(train_labels[train_ids != PAD].tolist())
    stats = {
        "train_segments": len(train_items),
        "val_segments": len(val_items),
        "rev_windows": len(rev_items),
        "vocab": len(stoi),
        "maxlen": MAXLEN,
        "train_position_counts": {str(k): int(v) for k, v in sorted(counts.items())},
    }
    (SEQ_DIR / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[seq] {json.dumps(stats, ensure_ascii=False)}", flush=True)
    return stats


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--short-n", type=int, default=2)
    parser.add_argument("--max-segments", type=int, default=60_000)
    build(max_segments=parser.parse_args().max_segments,
          short_n=parser.parse_args().short_n)
