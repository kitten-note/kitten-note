"""
Masked-char proposer pretraining (EFT-v1 backbone + MLM head, from scratch).

BERT 80/10/10 masking over the 8B-corpus segments. Checkpoints every few
minutes with --resume for multi-round training. Final report includes the
metric that matters for NES: CSC coverage@k (is the true char in the top-k
proposals when the error position is masked?).

Usage: python train_mask.py [--minutes 45] [--epochs 3] [--resume]
Writes: artifacts/mask-s/{model.pt, checkpoint.pt, metrics.json}
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from enc_model import PRESETS, TinyEditEncoder  # noqa: E402

MASK_DIR = BASE / "data" / "mask"
ART = BASE / "artifacts" / "mask-s"
CSC_TEST = BASE / "data" / "external" / "shibing624__CSC" / "test.json"


class MaskModel(nn.Module):
    def __init__(self, vocab_size: int, preset: str = "S", maxlen: int = 192):
        super().__init__()
        config = PRESETS[preset]
        self.backbone = TinyEditEncoder(vocab_size, d=config["d"], layers=config["layers"],
                                        heads=config["heads"], ffn=config["ffn"], maxlen=maxlen)
        self.mlm = nn.Linear(config["d"], vocab_size)
        self.preset = preset

    def forward(self, ids: torch.Tensor, positions: torch.Tensor | None = None) -> torch.Tensor:
        length = ids.shape[1]
        hidden = self.backbone.tok(ids) + self.backbone.pos(
            torch.arange(length, device=ids.device).unsqueeze(0))
        hidden = self.backbone.enc(hidden, src_key_padding_mask=(ids == 0))
        logits = self.mlm(hidden)
        if positions is not None:
            logits = logits[torch.arange(len(ids), device=ids.device)[:, None], positions]
        return logits

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters())


def backbone_hidden(model: MaskModel, ids: torch.Tensor) -> torch.Tensor:
    length = ids.shape[1]
    hidden = model.backbone.tok(ids) + model.backbone.pos(
        torch.arange(length, device=ids.device).unsqueeze(0))
    return model.backbone.enc(hidden, src_key_padding_mask=(ids == 0))


def build_q_table(train_ids: np.ndarray, vocab_size: int, power: float = 0.75) -> np.ndarray:
    """Unigram^0.75 proposal distribution over the training segments.

    Uniform negative sampling systematically inflates frequent-token logits
    (they are rarely sampled as negatives), which collapses full-softmax
    top-1 while top-k survives. Sampling negatives from unigram^0.75 plus
    logQ correction removes most of the bias (standard word2vec/Mikolov fix).
    Special ids 0,1,2 (PAD/UNK/<S>) and the mask id get zero mass.
    """
    counts = np.bincount(train_ids.ravel(), minlength=vocab_size).astype(np.float64)
    counts[:3] = 0.0
    counts[-1] = 0.0  # <MASK> is the last id
    powered = np.power(counts, power)
    total = powered.sum()
    if total <= 0:
        powered[:] = 1.0
        powered[:3] = 0.0
        powered[-1] = 0.0
        total = powered.sum()
    return (powered / total).astype(np.float64)


def sampled_loss(model: MaskModel, masked: torch.Tensor, targets: torch.Tensor,
                 n_neg: int = 512, q_table: torch.Tensor | None = None) -> torch.Tensor:
    """Full backbone forward, but the 15k head only on masked positions with
    sampled negatives (full softmax would cost ~94B MACs per batch).

    With q_table (unigram proposal): negatives come from the proposal and
    all sampled logits get the logQ correction, which fixes the top-1
    collapse caused by uniform sampling.
    """
    device = masked.device
    hidden = backbone_hidden(model, masked)
    valid = targets != -100
    hm = hidden[valid]
    tm = targets[valid].long()
    count = int(tm.numel())
    if count == 0:
        return (model.mlm.weight.sum() * 0.0 + model.mlm.bias.sum() * 0.0)
    vocab_size = model.mlm.out_features
    if q_table is None:
        neg = torch.randint(3, vocab_size - 1, (n_neg,), device=device)
        cand = torch.cat([tm.unsqueeze(1), neg.unsqueeze(0).expand(count, -1)], dim=1)
        weights = model.mlm.weight[cand]              # [M, 1+n, d]
        scores = (hm.unsqueeze(1) * weights).sum(-1) + model.mlm.bias[cand]
    else:
        neg = torch.multinomial(q_table, n_neg, replacement=True)
        cand = torch.cat([tm.unsqueeze(1), neg.unsqueeze(0).expand(count, -1)], dim=1)
        weights = model.mlm.weight[cand]
        scores = (hm.unsqueeze(1) * weights).sum(-1) + model.mlm.bias[cand]
        q_log = torch.log(q_table[cand].clamp(min=1e-12))
        scores = scores - q_log
    return torch.nn.functional.cross_entropy(scores, torch.zeros(count, dtype=torch.long, device=device))


def apply_mask(ids: np.ndarray, mask_id: int, vocab_size: int, rng: np.random.Generator):
    """BERT 80/10/10 dynamic masking. Returns (masked_ids, targets, n_masked)."""
    work = ids.copy()
    targets = np.full_like(ids, -100)
    active = ids != 0
    active[:, 0] = False  # never mask <S>
    roll = rng.random(ids.shape)
    do_mask = active & (roll < 0.15)
    targets[do_mask] = ids[do_mask]
    as_mask = do_mask & (rng.random(ids.shape) < 0.8)
    as_rand = do_mask & ~as_mask & (rng.random(ids.shape) < 0.5)
    work[as_mask] = mask_id
    rand_positions = np.argwhere(as_rand)
    work[as_rand] = rng.integers(3, vocab_size, size=len(rand_positions))
    return work, targets


@torch.no_grad()
def evaluate(model: MaskModel, ids_all: np.ndarray, mask_id: int, vocab_size: int,
             device: str, max_batches: int = 8) -> dict:
    """Chunked top-k eval (never materializes the [B,T,V] logit cube)."""
    model.eval()
    rng = np.random.default_rng(99)
    top1 = top5 = total = 0
    weight = model.mlm.weight.detach()
    bias = model.mlm.bias.detach()
    for start in range(0, min(len(ids_all), max_batches * 256), 256):
        batch = ids_all[start:start + 256]
        masked, targets = apply_mask(batch, mask_id, vocab_size, rng)
        hidden = backbone_hidden(model, torch.from_numpy(masked).to(device))
        valid = torch.from_numpy(targets != -100).to(device)
        if not valid.any():
            continue
        hm = hidden[valid]
        count = int(valid.sum())
        best_vals = torch.full((count, 5), -1e30, device=device)
        best_idx = torch.zeros((count, 5), dtype=torch.long, device=device)
        for s in range(0, vocab_size, 2048):
            e = min(s + 2048, vocab_size)
            chunk = hm @ weight[s:e].T + bias[s:e]
            vals, idx = torch.topk(chunk, min(5, e - s), dim=1)
            merged_vals = torch.cat([best_vals, vals], dim=1)
            merged_idx = torch.cat([best_idx, idx + s], dim=1)
            sel = torch.topk(merged_vals, 5, dim=1).indices
            best_vals = merged_vals.gather(1, sel)
            best_idx = merged_idx.gather(1, sel)
        best_idx = best_idx.cpu().numpy()
        tgt = targets[targets != -100]
        top1 += int((best_idx[:, 0] == tgt).sum())
        top5 += sum(1 for t, row in zip(tgt, best_idx) if t in row)
        total += count
    return {"mlm_top1": top1 / max(total, 1), "mlm_top5": top5 / max(total, 1), "positions": total}


@torch.no_grad()
def csc_coverage(model: MaskModel, stoi: dict, maxlen: int, device: str) -> dict:
    """Mask each CSC error position: is the true char in top-k proposals?"""
    items = json.loads(CSC_TEST.read_text(encoding="utf-8"))
    top1 = top5 = top10 = n = 0
    for item in items:
        wrong, correct = item["original_text"], item["correct_text"]
        positions = [p for p in item.get("wrong_ids", []) if 0 <= p < len(wrong)]
        if not positions or len(wrong) > maxlen - 1:
            continue
        for pos in positions[:3]:
            if wrong[pos] == correct[pos] or pos >= len(correct):
                continue
            toks = [2] + [stoi.get(c, 1) for c in wrong]
            ids = torch.tensor([toks], dtype=torch.long, device=device)
            masked = ids.clone()
            masked[0, pos + 1] = stoi["<MASK>"]
            logits = model(masked).cpu().numpy()[0, pos + 1]
            order = np.argsort(-logits)
            truth = stoi.get(correct[pos], 1)
            if order[0] == truth:
                top1 += 1
            if truth in order[:5]:
                top5 += 1
            if truth in order[:10]:
                top10 += 1
            n += 1
    return {"n": n, "coverage@1": top1 / max(n, 1),
            "coverage@5": top5 / max(n, 1), "coverage@10": top10 / max(n, 1)}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=45.0)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--preset", default="S")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--sampling", default="uniform", choices=["uniform", "unigram"])
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    device = args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    out_dir = Path(args.out_dir) if args.out_dir else ART
    out_dir.mkdir(parents=True, exist_ok=True)
    vocab = json.loads((MASK_DIR / "vocab.json").read_text(encoding="utf-8"))
    stoi, maxlen, mask_id = vocab["stoi"], vocab["maxlen"], vocab["mask_id"]

    train = np.load(MASK_DIR / "train.npz")["ids"]
    val = np.load(MASK_DIR / "val.npz")["ids"]
    print(f"[mask] train segs {len(train)}, val segs {len(val)}, vocab {len(stoi)}", flush=True)

    model = MaskModel(len(stoi), args.preset, maxlen).to(device)
    print(f"[mask] preset {args.preset}: {model.parameter_count():,} params", flush=True)

    step = 0
    if args.resume and (out_dir / "checkpoint.pt").exists():
        checkpoint = torch.load(out_dir / "checkpoint.pt", map_location=device, weights_only=False)
        model.load_state_dict(checkpoint["model"])
        step = int(checkpoint.get("step", 0))
        print(f"[mask] resumed at step {step}", flush=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-2)
    rng = np.random.default_rng(20261008)
    q_table = None
    if args.sampling == "unigram":
        q_table = torch.tensor(build_q_table(train, len(stoi)), dtype=torch.float32, device=device)
        print(f"[mask] unigram proposal built over {len(stoi)} ids", flush=True)
    deadline = time.time() + args.minutes * 60
    started = time.time()
    last_ckpt = started

    for epoch in range(args.epochs):
        if time.time() > deadline:
            break
        for start in rng.permutation(len(train))[::args.batch]:
            if time.time() > deadline:
                break
            batch_idx = np.arange(start, min(start + args.batch, len(train)))
            masked, targets = apply_mask(train[batch_idx], mask_id, len(stoi), rng)
            model.train()
            optimizer.zero_grad()
            loss = sampled_loss(model, torch.from_numpy(masked).to(device),
                                torch.from_numpy(targets.astype(np.int64)).to(device),
                                q_table=q_table)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            step += 1
            if step % 100 == 0:
                print(f"[mask] epoch {epoch} step {step} loss {float(loss.detach()):.4f}", flush=True)
            if time.time() - last_ckpt > 600:
                torch.save({"model": model.state_dict(), "step": step}, out_dir / "checkpoint.pt")
                last_ckpt = time.time()

    torch.save({"model": model.state_dict(), "preset": args.preset, "step": step}, out_dir / "model.pt")
    print(f"[mask] done: {step} steps in {(time.time() - started) / 60:.1f} min", flush=True)

    val_metrics = evaluate(model, val, mask_id, len(stoi), device)
    print(f"[mask] val: {json.dumps({k: round(v, 4) for k, v in val_metrics.items()})}", flush=True)
    coverage = csc_coverage(model, stoi, maxlen, device)
    print(f"[mask] CSC coverage: {json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in coverage.items()})}", flush=True)

    (out_dir / "metrics.json").write_text(json.dumps({
        "preset": args.preset, "params": model.parameter_count(), "steps": step,
        "val": val_metrics, "csc_coverage": coverage,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
