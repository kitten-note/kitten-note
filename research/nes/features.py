"""
EFT / NES v0 - Feature field phi.

Depth-1 feature extraction (pure parallel computation):
    * grounded context n-grams   (left 1..4-grams, right 1..3-grams, ctx span)
    * structural state           (char classes, line boundaries, punctuation distance)
    * span identity              (the span under consideration)
    * behaviour slot             (last-atom class, constant 0 during synthesis)

Two representations share the same hashed feature ids:
    * binary bag for the hashed logistic model (GPU-trained, our depth-1 class)
    * bipolar hypervector for the HDC prototype experts (online, on-device)
"""
from __future__ import annotations

from typing import List, Sequence

import numpy as np

FEATURE_DIM = 16384          # hashed feature bins
FEATURE_VERSION = 2          # bump to invalidate feature caches
HDC_DIM = 8192               # hypervector dimension (bits)
HDC_BINS = 4096              # base-vector table size (ids are reduced mod this)
HDC_SEED = 0xE7F0
LAST_ATOM_SLOT = 1.0         # placeholder feature for behaviour state

PUNCT = set("，。！？；：、,.!?;:;\"'“”‘’（）()《》〈〉【】[]—…·")
CJK_PUNCT = set("，。！？；：、（）《》“”‘’—…·")


def _char_class(char: str) -> str:
    if not char:
        return "none"
    if char in CJK_PUNCT:
        return "cp"
    if char.isspace():
        return "sp"
    if "\u4e00" <= char <= "\u9fff":
        return "cjk"
    if char.isdigit():
        return "dig"
    if char.isalpha():
        return "lat"
    return "oth"


def _dist_bucket(text: str, punct: set, cap: int = 8) -> int:
    for distance in range(1, cap + 1):
        if len(text) < distance:
            break
        if text[-distance] in punct:
            return distance
    return cap + 1


def _distance_to_punct(side: str, cap: int = 8) -> int:
    for distance, char in enumerate(reversed(side), start=1):
        if distance > cap:
            break
        if char in PUNCT or char == "\n":
            return distance
    return cap + 1


def fnv1a64(text: str) -> int:
    h = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def hash_feature(name: str) -> int:
    return fnv1a64(name) % FEATURE_DIM


def extract_feature_names(left: str, span: str, right: str, last_atom: str = "NONE") -> List[str]:
    names: List[str] = []
    for k in (1, 2, 3, 4):
        if len(left) >= k:
            names.append(f"L{k}:{left[-k:]}")
    for k in (1, 2, 3):
        if len(right) >= k:
            names.append(f"R{k}:{right[:k]}")
    names.append(f"S:{span}" if span else "S:∅")
    names.append(f"SL:{min(len(span), 8)}")
    prev_char = left[-1] if left else ""
    next_char = right[0] if right else ""
    names.append(f"PC:{_char_class(prev_char)}")
    names.append(f"NC:{_char_class(next_char)}")
    names.append(f"PB:{prev_char in PUNCT}")
    names.append(f"NB:{next_char in PUNCT}")
    names.append(f"PN:{prev_char == chr(10)}")
    names.append(f"NN:{next_char == chr(10)}")
    names.append(f"PD:{_distance_to_punct(left)}")
    names.append(f"ND:{_distance_to_punct(right)}")
    names.append(f"CTX:{left[-8:]}→{right[:4]}")
    names.append(f"TAIL:{left[-16:]}")
    names.append(f"HEAD:{right[:12]}")
    # Boundary-crossing features: the only way a linear model can judge whether
    # *this span* fits its neighbours (typo/punctuation detection).
    span_char = span[:1] if span else "∅"
    names.append(f"BLC:{left[-1:]}{span_char}")
    names.append(f"BRC:{span_char}{right[:1]}")
    names.append(f"B2L:{left[-2:]}{span_char}")
    names.append(f"B2R:{span_char}{right[:2]}")
    names.append(f"XC:{_char_class(prev_char)}{_char_class(span_char if span else '')}{_char_class(next_char)}")
    names.append(f"LA:{last_atom}")
    return names


def extract_feature_ids(left: str, span: str, right: str, last_atom: str = "NONE") -> np.ndarray:
    ids = {hash_feature(name) for name in extract_feature_names(left, span, right, last_atom)}
    return np.fromiter(ids, dtype=np.int32)


class HDCEncoder:
    """Binary hyperdimensional encoder with deterministic base vectors."""

    def __init__(self, dim: int = HDC_DIM, feature_dim: int = FEATURE_DIM,
                 bins: int = HDC_BINS, seed: int = HDC_SEED):
        self.dim = dim
        self.feature_dim = feature_dim
        self.bins = bins
        rng = np.random.default_rng(seed)
        bits = rng.integers(0, 2, size=(bins, dim), dtype=np.uint8)
        self._packed = np.packbits(bits, axis=1)          # (bins, dim/8)
        self._bipolar = bits.astype(np.int8) * 2 - 1       # (bins, dim) int8 (+-1)

    def vector(self, feature_ids: Sequence[int]) -> np.ndarray:
        """Bundle active features into one bipolar hypervector (+-1, int8)."""
        if len(feature_ids) == 0:
            return np.ones(self.dim, dtype=np.int8)
        rows = np.asarray(feature_ids, dtype=np.int64) % self.bins
        votes = self._bipolar[rows].sum(axis=0, dtype=np.int32)
        votes[votes == 0] = 1
        return np.where(votes > 0, 1, -1).astype(np.int8)

    def packed_vector(self, feature_ids: Sequence[int]) -> np.ndarray:
        polar = self.vector(feature_ids)
        return np.packbits((polar > 0).astype(np.uint8))


def binary_matrix(rows: Sequence[Sequence[int]], feature_dim: int = FEATURE_DIM) -> np.ndarray:
    """Dense binary bag-of-features matrix (rows x feature_dim), float32."""
    out = np.zeros((len(rows), feature_dim), dtype=np.float32)
    for i, ids in enumerate(rows):
        out[i, np.asarray(ids, dtype=np.int64)] = 1.0
    return out
