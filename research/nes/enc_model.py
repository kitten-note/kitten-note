"""
EFT-v1 (contextual encoder) - tiny bidirectional char tagger.

Still single-forward-pass, non-autoregressive, typed 7-class output, trained
from scratch: a shallow Transformer encoder reads the whole window/document
and tags every gap. One forward pass per document (vs ~400 window forwards
for the depth-1 family), full left+right context at every position.

Presets (exact counts printed at build time):
    S   d=128,  L=4,  heads=4    ~2.5M   (browser candidate)
    M   d=256,  L=6,  heads=4    ~8M
    L   d=512,  L=8,  heads=8    ~30M
    XL  d=1024, L=12, heads=8    ~150M
    XXL d=1152, L=14, heads=8    ~240M   (256M-class research model)
"""
from __future__ import annotations

import torch
import torch.nn as nn

PRESETS = {
    "S": {"d": 128, "layers": 4, "heads": 4, "ffn": 256},
    "M": {"d": 256, "layers": 6, "heads": 4, "ffn": 512},
    "L": {"d": 512, "layers": 8, "heads": 8, "ffn": 1024},
    "XL": {"d": 1024, "layers": 12, "heads": 8, "ffn": 2048},
    "XXL": {"d": 1152, "layers": 14, "heads": 8, "ffn": 4608},
}


class TinyEditEncoder(nn.Module):
    def __init__(self, vocab_size: int, d: int = 128, layers: int = 4, heads: int = 4,
                 ffn: int = 256, n_classes: int = 7, maxlen: int = 288, dropout: float = 0.1):
        super().__init__()
        self.maxlen = maxlen
        self.tok = nn.Embedding(vocab_size, d, padding_idx=0)
        self.pos = nn.Embedding(maxlen, d)
        layer = nn.TransformerEncoderLayer(d, heads, ffn, dropout,
                                           batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, layers)
        self.head = nn.Linear(d, n_classes)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        length = ids.shape[1]
        positions = torch.arange(length, device=ids.device).unsqueeze(0)
        hidden = self.tok(ids) + self.pos(positions)
        hidden = self.enc(hidden, src_key_padding_mask=(ids == 0))
        return self.head(hidden)

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters())


def build(preset: str, vocab_size: int, maxlen: int = 288) -> TinyEditEncoder:
    config = PRESETS[preset]
    return TinyEditEncoder(vocab_size, d=config["d"], layers=config["layers"],
                           heads=config["heads"], ffn=config["ffn"], maxlen=maxlen)


if __name__ == "__main__":
    for name in PRESETS:
        model = build(name, vocab_size=15000)
        print(f"{name:>3}: {model.parameter_count():>12,}")
