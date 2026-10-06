"""
EFT / NES - the 256M-parameter predictor (from scratch, single pass, type safe).

Architecture (one forward propagation, no attention, no autoregression):

    p(a | x) = softmax( W2 · sum( E[id] for id in features(x) ) + b )

    E : (2^23 x 31) embedding table      = 260,046,848 parameters
    W2: (31 x 7) + b                     = 224 parameters
    total                                = 260,047,072 parameters

Trained from random initialisation (no base model). Output space is the same
7 typed edit atoms as v0; emission still passes the type checker and the
copy-only grounding layer, so T4 (type safety / zero hallucination) carries over.
"""
from __future__ import annotations

import torch
import torch.nn as nn

NUM_FEATURES = 1 << 23          # 8,388,608 hashed feature slots
EMB_DIM = 31
N_CLASSES = 7
TOTAL_PARAMS = NUM_FEATURES * EMB_DIM + EMB_DIM * N_CLASSES + N_CLASSES


class BigEditPredictor(nn.Module):
    def __init__(self, num_features: int = NUM_FEATURES, dim: int = EMB_DIM, n_classes: int = N_CLASSES):
        super().__init__()
        self.num_features = num_features
        self.dim = dim
        # sparse=True keeps per-step work proportional to touched rows
        self.embedding = nn.EmbeddingBag(num_features, dim, mode="sum", sparse=True)
        self.head = nn.Linear(dim, n_classes)
        nn.init.normal_(self.embedding.weight, std=0.02)
        nn.init.zeros_(self.head.bias)
        nn.init.xavier_uniform_(self.head.weight)

    def forward(self, ids: torch.Tensor, offsets: torch.Tensor) -> torch.Tensor:
        pooled = self.embedding(ids, offsets)
        return self.head(pooled)

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    @torch.no_grad()
    def predict_proba(self, ids: torch.Tensor, offsets: torch.Tensor) -> torch.Tensor:
        self.eval()
        logits = self.forward(ids, offsets)
        return torch.softmax(logits, dim=-1)


if __name__ == "__main__":
    model = BigEditPredictor()
    print(f"parameters: {model.parameter_count():,}")
    assert model.parameter_count() == TOTAL_PARAMS
    x = torch.tensor([1, 5, 9, 2, 4], dtype=torch.long)
    off = torch.tensor([0, 3, 5], dtype=torch.long)
    print("forward ok:", model(x, off).shape)
