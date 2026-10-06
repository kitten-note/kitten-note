"""
EFT / NES v0 - Predictors.

All predictors implement the paper's depth-1 contract:
    p(a | x) = softmax_a <phi(x), W_a> / tau
with a *fixed* feature field phi:

    * HDCPredictor      - bipolar prototypes (bundle/cosine); online-updatable
    * HashedSoftmax     - hashed logistic softmax trained on GPU (depth-1)
    * MarkovBaseline    - P(class | char-class context) count model
    * PriorBaseline     - class priors only

Also: confidence calibration (temperature) and gate-threshold tuning.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from features import FEATURE_DIM, HDC_DIM, HDCEncoder

N_CLASSES = 7


# ---------------------------------------------------------------- HDC


class HDCPredictor:
    """Hyperdimensional prototypes: class prototypes are bundles of samples."""

    def __init__(self, dim: int = HDC_DIM, n_classes: int = N_CLASSES, encoder: Optional[HDCEncoder] = None):
        self.dim = dim
        self.n_classes = n_classes
        self.encoder = encoder or HDCEncoder(dim=dim)
        self.sums = np.zeros((n_classes, dim), dtype=np.float64)
        self.counts = np.zeros(n_classes, dtype=np.int64)
        self.scale = 4.0  # sharpening before softmax

    def partial_fit(self, feature_ids: Sequence[int], label: int, weight: float = 1.0) -> None:
        vector = self.encoder.vector(feature_ids).astype(np.float64)
        self.sums[label] += weight * vector
        self.counts[label] += weight

    def prototypes(self) -> np.ndarray:
        safe = np.maximum(self.counts, 1)[:, None]
        return self.sums / safe

    def scores(self, feature_ids: Sequence[int]) -> np.ndarray:
        vector = self.encoder.vector(feature_ids).astype(np.float64)
        protos = self.prototypes()
        norms = np.linalg.norm(protos, axis=1)
        denom = np.maximum(norms * np.linalg.norm(vector), 1e-9)
        return (protos @ vector) / denom

    def predict_proba(self, feature_ids: Sequence[int]) -> np.ndarray:
        logits = self.scale * self.scores(feature_ids)
        logits -= logits.max()
        probs = np.exp(logits)
        return probs / probs.sum()

    def set_temperature(self, val_vectors: List[np.ndarray], val_labels: np.ndarray) -> float:
        """Grid-search the softmax scale on validation data (log-loss)."""
        best_scale, best_loss = self.scale, float("inf")
        protos = self.prototypes()
        norms = np.maximum(np.linalg.norm(protos, axis=1), 1e-9)
        sims = np.stack([(protos @ v) / (norms * max(np.linalg.norm(v), 1e-9)) for v in val_vectors])
        for scale in [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]:
            logits = scale * sims
            logits = logits - logits.max(axis=1, keepdims=True)
            probs = np.exp(logits)
            probs /= probs.sum(axis=1, keepdims=True)
            loss = -np.log(np.maximum(probs[np.arange(len(val_labels)), val_labels], 1e-9)).mean()
            if loss < best_loss:
                best_loss, best_scale = loss, scale
        self.scale = float(best_scale)
        return self.scale

    def save(self, path: Path) -> None:
        np.savez_compressed(
            path,
            sums=self.sums.astype(np.float32),
            counts=self.counts,
            scale=np.array([self.scale]),
            dim=np.array([self.dim]),
        )

    @classmethod
    def load(cls, path: Path) -> "HDCPredictor":
        data = np.load(path)
        predictor = cls(dim=int(data["dim"][0]))
        predictor.sums = data["sums"].astype(np.float64)
        predictor.counts = data["counts"]
        predictor.scale = float(data["scale"][0])
        return predictor


# ---------------------------------------------------------------- logistic (GPU)


class HashedSoftmax:
    """Multiclass softmax over hashed binary features (depth-1 linear model)."""

    def __init__(self, feature_dim: int = FEATURE_DIM, n_classes: int = N_CLASSES):
        self.feature_dim = feature_dim
        self.n_classes = n_classes
        self.weights = np.zeros((feature_dim, n_classes), dtype=np.float32)
        self.bias = np.zeros(n_classes, dtype=np.float32)
        self.temperature = 1.0

    @staticmethod
    def pack(ids: Sequence[int], feature_dim: int = FEATURE_DIM) -> np.ndarray:
        bits = np.zeros(feature_dim, dtype=np.uint8)
        bits[np.asarray(ids, dtype=np.int64)] = 1
        return np.packbits(bits)

    def fit(
        self,
        packed_x: np.ndarray,
        labels: np.ndarray,
        *,
        epochs: int = 3,
        batch_size: int = 1024,
        lr: float = 3e-3,
        device: str = "cpu",
        val: Optional[Tuple[np.ndarray, np.ndarray]] = None,
        verbose: bool = True,
    ) -> Dict:
        import torch
        import torch.nn as nn

        torch_device = torch.device(device)
        n = packed_x.shape[0]
        class_counts = np.bincount(labels, minlength=self.n_classes).astype(np.float32)
        class_weights = np.where(class_counts > 0, class_counts.sum() / np.maximum(class_counts, 1), 0.0)
        class_weights = class_weights / class_weights.mean()
        weight_t = torch.tensor(class_weights, device=torch_device)

        model = nn.Linear(self.feature_dim, self.n_classes).to(torch_device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        criterion = nn.CrossEntropyLoss(weight=weight_t)

        history = []
        for epoch in range(epochs):
            perm = np.random.default_rng(1000 + epoch).permutation(n)
            total_loss, seen = 0.0, 0
            for start in range(0, n, batch_size):
                idx = perm[start:start + batch_size]
                batch = np.unpackbits(packed_x[idx], axis=1).astype(np.float32)
                xb = torch.from_numpy(batch).to(torch_device)
                yb = torch.from_numpy(labels[idx]).to(torch_device)
                optimizer.zero_grad()
                logits = model(xb)
                loss = criterion(logits, yb)
                loss.backward()
                optimizer.step()
                total_loss += float(loss.detach()) * len(idx)
                seen += len(idx)
            message = f"[softmax] epoch {epoch + 1}/{epochs} train loss {total_loss / max(seen, 1):.4f}"
            if val is not None:
                acc = self._accuracy(model, val[0], val[1], torch_device)
                message += f" val acc {acc:.4f}"
            history.append(message)
            if verbose:
                print(message, flush=True)

        self.weights = model.weight.detach().cpu().numpy().T.copy()  # (D, C)
        self.bias = model.bias.detach().cpu().numpy().copy()
        return {"history": history}

    def _accuracy(self, model, packed_x: np.ndarray, labels: np.ndarray, device) -> float:
        import torch

        correct = 0
        for start in range(0, len(labels), 4096):
            batch = np.unpackbits(packed_x[start:start + 4096], axis=1).astype(np.float32)
            logits = model(torch.from_numpy(batch).to(device)).detach().cpu().numpy()
            correct += int((logits.argmax(axis=1) == labels[start:start + 4096]).sum())
        return correct / len(labels)

    def logits(self, feature_ids: Sequence[int]) -> np.ndarray:
        bits = np.unpackbits(self.pack(feature_ids)).astype(np.float32)
        return bits @ self.weights + self.bias

    def predict_proba(self, feature_ids: Sequence[int]) -> np.ndarray:
        logits = self.logits(feature_ids) * self.temperature
        logits = logits - logits.max()
        probs = np.exp(logits)
        return probs / probs.sum()

    def predict_proba_batch(self, rows: Sequence[Sequence[int]]) -> np.ndarray:
        packed = np.stack([self.pack(ids) for ids in rows])
        x = np.unpackbits(packed, axis=1).astype(np.float32)
        logits = (x @ self.weights + self.bias) * self.temperature
        logits -= logits.max(axis=1, keepdims=True)
        probs = np.exp(logits)
        return probs / probs.sum(axis=1, keepdims=True)

    def set_temperature(self, rows: Sequence[Sequence[int]], labels: np.ndarray) -> float:
        logits = np.stack([self.logits(ids) for ids in rows])
        best_t, best_loss = 1.0, float("inf")
        for temperature in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]:
            scaled = logits * temperature
            scaled -= scaled.max(axis=1, keepdims=True)
            probs = np.exp(scaled)
            probs /= probs.sum(axis=1, keepdims=True)
            loss = -np.log(np.maximum(probs[np.arange(len(labels)), labels], 1e-9)).mean()
            if loss < best_loss:
                best_loss, best_t = loss, temperature
        self.temperature = float(best_t)
        return self.temperature

    def save(self, path: Path) -> None:
        np.savez_compressed(path, weights=self.weights, bias=self.bias,
                            temperature=np.array([self.temperature]))

    @classmethod
    def load(cls, path: Path) -> "HashedSoftmax":
        data = np.load(path)
        model = cls(feature_dim=data["weights"].shape[0], n_classes=data["weights"].shape[1])
        model.weights = data["weights"]
        model.bias = data["bias"]
        model.temperature = float(data["temperature"][0])
        return model


# ---------------------------------------------------------------- baselines


class MarkovBaseline:
    """P(class | (prev-char-class, next-char-class)) count model."""

    def __init__(self, n_classes: int = N_CLASSES):
        from features import _char_class  # local import to keep module light

        self.n_classes = n_classes
        self.context_keys = ["cjk", "cp", "sp", "dig", "lat", "oth", "none"]
        self.char_class = _char_class
        self.counts = np.zeros((len(self.context_keys) ** 2, n_classes), dtype=np.float64)

    def _context(self, left: str, right: str) -> int:
        key = self.char_class(left[-1] if left else "") + "|" + self.char_class(right[0] if right else "")
        idx = 0
        for a in self.context_keys:
            for b in self.context_keys:
                if f"{a}|{b}" == key:
                    return idx
                idx += 1
        return 0

    def fit(self, samples: Sequence[Dict]) -> None:
        for sample in samples:
            ctx = self._context(sample["left"], sample["right"])
            self.counts[ctx, sample["label"]] += 1

    def predict_proba(self, left: str, right: str) -> np.ndarray:
        ctx = self._context(left, right)
        row = self.counts[ctx]
        total = row.sum()
        if total < 10:
            row = self.counts.sum(axis=0)
            total = row.sum()
        return row / max(total, 1)


class PriorBaseline:
    def __init__(self, n_classes: int = N_CLASSES):
        self.priors = np.ones(n_classes) / n_classes

    def fit(self, samples: Sequence[Dict]) -> None:
        counts = np.bincount([s["label"] for s in samples], minlength=self.priors.size).astype(np.float64)
        self.priors = counts / max(counts.sum(), 1)

    def predict_proba(self, left: str = "", right: str = "") -> np.ndarray:
        return self.priors


# ---------------------------------------------------------------- calibration helpers


def tune_gate_threshold(edit_probabilities: Sequence[float], is_edit: Sequence[bool],
                        target_precision: float = 0.88) -> Dict:
    """
    Pick a threshold on P(edit) that reaches `target_precision` while keeping
    the best possible recall on the validation split.
    """
    probs = np.asarray(edit_probabilities, dtype=np.float64)
    truth = np.asarray(is_edit, dtype=bool)
    order = np.argsort(-probs)
    sorted_probs = probs[order]
    sorted_truth = truth[order]

    tp = np.cumsum(sorted_truth)
    k = np.arange(1, len(sorted_probs) + 1)
    precision = tp / k
    recall = tp / max(int(truth.sum()), 1)

    ok = precision >= target_precision
    if not ok.any():
        return {"threshold": 1.01, "precision": 0.0, "recall": 0.0, "coverage": 0.0}
    stop = int(np.max(np.where(ok)[0]))
    threshold = float(sorted_probs[stop])
    return {
        "threshold": threshold,
        "precision": float(precision[stop]),
        "recall": float(recall[stop]),
        "coverage": float(k[stop] / len(probs)),
    }
