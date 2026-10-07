"""
EFT-v1 encoder - export the champion (S-full) for the browser JS runtime.

Writes assets-ready bundle into artifacts/enc-s-full/browser/:
    model.json  - config + tensor offsets + class list
    weights.bin - fp32 tensors (embedding, positions, 4x encoder layers, head)
    vocab.json  - char stoi (copied from data/seq)
    test_vectors.json - 20 windows with torch logits (parity check input)

fp32 keeps the JS runtime bit-comparable with torch (argmax agreement is the
deployment metric; int8 comes later if bundle size demands it).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from enc_model import PRESETS, TinyEditEncoder  # noqa: E402
from synth import load_samples  # noqa: E402

BASE_ART = BASE / "artifacts"
SEQ = BASE / "data" / "seq"
ATOM_CLASSES = ["NO_EDIT", "FIX_CHAR", "DEL_CHAR", "INS_CHAR", "DEL_SPAN", "INS_SPAN_COPY", "FMT_BULLET"]


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--art", default="enc-s-full")
    art_name = parser.parse_args().art
    ART = BASE_ART / art_name
    OUT = ART / "browser"

    device = "cuda" if torch.cuda.is_available() else "cpu"
    checkpoint = torch.load(ART / "model.pt", map_location=device, weights_only=False)
    preset = checkpoint.get("preset", "S")
    vocab = json.loads((SEQ / "vocab.json").read_text(encoding="utf-8"))
    stoi, maxlen = vocab["stoi"], vocab["maxlen"]
    config = PRESETS[preset]

    model = TinyEditEncoder(len(stoi), d=config["d"], layers=config["layers"],
                            heads=config["heads"], ffn=config["ffn"], maxlen=maxlen).to(device)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    state = {k: v.detach().cpu().float().numpy() for k, v in model.state_dict().items()}

    OUT.mkdir(parents=True, exist_ok=True)

    tensors = [("tok", state["tok.weight"]), ("pos", state["pos.weight"])]
    for i in range(config["layers"]):
        p = f"enc.layers.{i}."
        tensors += [
            (f"L{i}.norm1w", state[p + "norm1.weight"]),
            (f"L{i}.norm1b", state[p + "norm1.bias"]),
            (f"L{i}.inprojw", state[p + "self_attn.in_proj_weight"]),
            (f"L{i}.inprojb", state[p + "self_attn.in_proj_bias"]),
            (f"L{i}.outw", state[p + "self_attn.out_proj.weight"]),
            (f"L{i}.outb", state[p + "self_attn.out_proj.bias"]),
            (f"L{i}.norm2w", state[p + "norm2.weight"]),
            (f"L{i}.norm2b", state[p + "norm2.bias"]),
            (f"L{i}.ff1w", state[p + "linear1.weight"]),
            (f"L{i}.ff1b", state[p + "linear1.bias"]),
            (f"L{i}.ff2w", state[p + "linear2.weight"]),
            (f"L{i}.ff2b", state[p + "linear2.bias"]),
        ]
    tensors += [("headw", state["head.weight"]), ("headb", state["head.bias"])]

    manifest, offset = {}, 0
    with (OUT / "weights.bin").open("wb") as handle:
        for name, array in tensors:
            blob = np.ascontiguousarray(array, dtype=np.float32).tobytes()
            handle.write(blob)
            manifest[name] = {"offset": offset, "shape": list(array.shape)}
            offset += len(blob)

    (OUT / "model.json").write_text(json.dumps({
        "version": "eft-enc-v1",
        "preset": preset,
        "classes": ATOM_CLASSES,
        "d": config["d"],
        "layers": config["layers"],
        "heads": config["heads"],
        "ffn": config["ffn"],
        "maxlen": maxlen,
        "vocab_size": len(stoi),
        "activation": "relu",
        "tensors": manifest,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (OUT / "vocab.json").write_text(json.dumps(stoi, ensure_ascii=False), encoding="utf-8")

    rows = [row for row in load_samples(BASE / "data" / "samples" / "test.jsonl") if row["label"] != 0][:20]
    vectors = []
    with torch.no_grad():
        for row in rows:
            document = row["left"] + row["span"] + row["right"]
            tokens = [2] + [stoi.get(char, 1) for char in document[:maxlen - 1]]
            logits = model(torch.tensor([tokens], dtype=torch.long, device=device)).cpu().numpy()[0]
            vectors.append({"document": document, "tokens": tokens, "label": row["label"],
                            "logits": logits.tolist()})
    (OUT / "test_vectors.json").write_text(json.dumps(vectors, ensure_ascii=False), encoding="utf-8")

    total_mb = sum(v["shape"] and 1 for v in manifest.values())
    print(f"[export-enc] wrote {OUT} "
          f"({(OUT / 'weights.bin').stat().st_size / 1e6:.1f} MB weights, {len(manifest)} tensors)")


if __name__ == "__main__":
    main()
