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

from atoms import CLASS_TO_ID  # noqa: E402
from big_data import load_lines, segment  # noqa: E402
from synth import Synthesizer  # noqa: E402

SEQ_DIR = BASE / "data" / "seq"
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


def build(max_segments: int = 60_000, minutes: float = 20.0, seed: int = 20261007) -> Dict:
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
        if len(edited) >= max_segments or time.time() > deadline:
            break
        for piece in segment(line):
            if len(edited) >= max_segments or time.time() > deadline:
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
    train_ids, train_labels = pack(train_items)
    val_ids, val_labels = pack(val_items)
    np.savez_compressed(SEQ_DIR / "train.npz", ids=train_ids, labels=train_labels)
    np.savez_compressed(SEQ_DIR / "val.npz", ids=val_ids, labels=val_labels)

    counts = Counter(train_labels[train_ids != PAD].tolist())
    stats = {
        "train_segments": len(train_items),
        "val_segments": len(val_items),
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
    build()
