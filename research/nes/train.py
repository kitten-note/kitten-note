"""
EFT / NES v0 - End-to-end unattended training pipeline.

    corpus -> synthesis -> feature field -> predictors -> gate tuning -> eval -> artifacts

Usage (unattended default):
    python train.py --docs 8000 --fetch-articles 5000

Artifacts land in research/nes/artifacts/v0/:
    hdc.npz, softmax.npz, config.json, metrics.json, REPORT.md
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
SAMPLES_DIR = DATA_DIR / "samples"
FEATURE_DIR = DATA_DIR / "features"

from atoms import ATOM_CLASSES, ID_TO_CLASS  # noqa: E402
from content import build_index_from_lines  # noqa: E402
from evaluate import (  # noqa: E402
    class_distribution,
    evaluate_model,
    grounding_rates,
    local_sweep_metrics,
    write_report,
)
from features import FEATURE_DIM, FEATURE_VERSION, extract_feature_ids  # noqa: E402
from predictors import (  # noqa: E402
    HashedSoftmax,
    HDCPredictor,
    MarkovBaseline,
    PriorBaseline,
    tune_gate_threshold,
)
from synth import build_samples, load_samples  # noqa: E402


def _stdout_utf8() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def ensure_samples(corpus: List[str], docs: int, seed: int, passes: int = 6, rebuild: bool = False) -> None:
    train_path = SAMPLES_DIR / "train.jsonl"
    if train_path.exists() and not rebuild:
        print(f"[pipeline] reusing samples in {SAMPLES_DIR}", flush=True)
        return
    print(f"[pipeline] synthesising samples from {docs} docs x{passes} passes ...", flush=True)
    started = time.time()
    build_samples(corpus, SAMPLES_DIR, n_docs=docs, seed=seed, passes=passes)
    print(f"[pipeline] synthesis done in {time.time() - started:.1f}s", flush=True)


def _file_hash(path: Path) -> str:
    import hashlib

    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_features(splits: Dict[str, List[Dict]], rebuild: bool = False) -> Dict[str, Dict[str, np.ndarray]]:
    FEATURE_DIR.mkdir(parents=True, exist_ok=True)
    cache: Dict[str, Dict[str, np.ndarray]] = {}
    for name, rows in splits.items():
        path = FEATURE_DIR / f"{name}.npz"
        sample_path = SAMPLES_DIR / f"{name}.jsonl"
        source_hash = f"{_file_hash(sample_path) if sample_path.exists() else ''}:v{FEATURE_VERSION}"

        if path.exists() and not rebuild:
            data = np.load(path)
            cached_hash = str(data["source_hash"][0]) if "source_hash" in data.files else ""
            if cached_hash == source_hash and len(data["labels"]) == len(rows):
                cache[name] = {
                    "ids": data["ids"],
                    "lengths": data["lengths"],
                    "packed": data["packed"],
                    "labels": data["labels"],
                }
                print(f"[pipeline] loaded cached features: {name} ({len(rows)} samples)", flush=True)
                continue
            print(f"[pipeline] feature cache stale for {name}; rebuilding ...", flush=True)

        print(f"[pipeline] extracting features: {name} ({len(rows)} samples) ...", flush=True)
        started = time.time()
        all_ids: List[int] = []
        lengths: List[int] = []
        packed = np.zeros((len(rows), FEATURE_DIM // 8), dtype=np.uint8)
        labels = np.zeros(len(rows), dtype=np.int64)

        for i, row in enumerate(rows):
            ids = extract_feature_ids(row["left"], row["span"], row["right"])
            all_ids.extend(ids.tolist())
            lengths.append(len(ids))
            bits = np.zeros(FEATURE_DIM, dtype=np.uint8)
            bits[ids] = 1
            packed[i] = np.packbits(bits)
            labels[i] = row["label"]
            if (i + 1) % 20000 == 0:
                print(f"    {i + 1}/{len(rows)}", flush=True)

        cache[name] = {
            "ids": np.asarray(all_ids, dtype=np.int32),
            "lengths": np.asarray(lengths, dtype=np.int32),
            "packed": packed,
            "labels": labels,
        }
        np.savez_compressed(path, **cache[name], source_hash=np.array([source_hash]))
        print(f"[pipeline] features {name} done in {time.time() - started:.1f}s", flush=True)

        # Sanity: alignment between rows and features
        assert len(cache[name]["lengths"]) == len(rows), "feature/sample count mismatch"
    return cache


def ids_of(entry: Dict[str, np.ndarray], index: int) -> np.ndarray:
    offset = int(entry["lengths"][:index].sum())
    length = int(entry["lengths"][index])
    return entry["ids"][offset:offset + length]


def train_hdc(train: Dict, val: Dict, iterations: int = 1) -> Tuple[HDCPredictor, Dict]:
    predictor = HDCPredictor()
    n = len(train["labels"])
    started = time.time()
    order = np.random.default_rng(7).permutation(n)
    for step, index in enumerate(order):
        predictor.partial_fit(ids_of(train, int(index)), int(train["labels"][index]))
        if (step + 1) % 30000 == 0:
            print(f"[hdc] trained {step + 1}/{n}", flush=True)
    val_vectors = [predictor.encoder.vector(ids_of(val, i)) for i in range(min(len(val["labels"]), 4000))]
    scale = predictor.set_temperature(val_vectors, val["labels"][:len(val_vectors)])
    print(f"[hdc] done in {time.time() - started:.1f}s, scale={scale}", flush=True)
    return predictor, {"train_seconds": time.time() - started, "scale": scale}


def predict_all(model_kind: str, model, entry: Dict, rows: List[Dict]) -> np.ndarray:
    n = len(rows)
    out = np.zeros((n, len(ATOM_CLASSES)), dtype=np.float32)
    if model_kind == "hdc":
        for i in range(n):
            out[i] = model.predict_proba(ids_of(entry, i))
    elif model_kind == "softmax":
        out[:] = model.predict_proba_batch([ids_of(entry, i) for i in range(n)])
    elif model_kind == "markov":
        for i, row in enumerate(rows):
            out[i] = model.predict_proba(row["left"], row["right"])
    elif model_kind == "prior":
        out[:] = model.predict_proba()
    return out


def main() -> None:
    _stdout_utf8()
    parser = argparse.ArgumentParser()
    parser.add_argument("--docs", type=int, default=8000)
    parser.add_argument("--fetch-articles", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20261006)
    parser.add_argument("--passes", type=int, default=6)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--target-precision", type=float, default=0.88)
    parser.add_argument("--rebuild-samples", action="store_true")
    parser.add_argument("--rebuild-features", action="store_true")
    args = parser.parse_args()

    from corpus import build as build_corpus, load_corpus

    started_all = time.time()
    build_corpus(args.fetch_articles)
    corpus = load_corpus()
    corpus_chars = sum(len(line) for line in corpus)
    print(f"[pipeline] corpus: {len(corpus)} articles, {corpus_chars} chars", flush=True)

    ensure_samples(corpus, args.docs, args.seed, passes=args.passes, rebuild=args.rebuild_samples)
    splits = {
        name: load_samples(SAMPLES_DIR / f"{name}.jsonl")
        for name in ("train", "val", "test")
    }
    print(f"[pipeline] samples: " + ", ".join(f"{k}={len(v)}" for k, v in splits.items()), flush=True)

    features = ensure_features(splits, rebuild=args.rebuild_features)

    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
    print(f"[pipeline] device for softmax training: {device}", flush=True)

    # ---- models ----
    markov = MarkovBaseline()
    markov.fit(splits["train"])
    prior = PriorBaseline()
    prior.fit(splits["train"])

    hdc, hdc_info = train_hdc(features["train"], features["val"])

    softmax = HashedSoftmax()
    softmax.fit(
        features["train"]["packed"],
        features["train"]["labels"],
        epochs=args.epochs,
        device=device,
        val=(features["val"]["packed"][:20000], features["val"]["labels"][:20000]),
    )
    # calibrate: first fit a provisional temperature on a val subset, then re-tune with probs
    subset = min(len(features["val"]["labels"]), 4000)
    softmax.set_temperature([ids_of(features["val"], i) for i in range(subset)], features["val"]["labels"][:subset])
    print(f"[softmax] temperature={softmax.temperature}", flush=True)

    # ---- gate thresholds on validation ----
    thresholds: Dict[str, float] = {}
    for name, kind, model in (("hdc", "hdc", hdc), ("softmax", "softmax", softmax), ("markov", "markov", markov), ("prior", "prior", prior)):
        val_probs = predict_all(kind, model, features["val"], splits["val"])
        gate = tune_gate_threshold(1.0 - val_probs[:, 0], features["val"]["labels"] != 0, args.target_precision)
        thresholds[name] = gate["threshold"]
        print(f"[gate] {name}: threshold={gate['threshold']:.4f} val precision={gate['precision']:.3f} recall={gate['recall']:.3f}", flush=True)

    # ---- evaluate on test ----
    results: Dict[str, Dict] = {}
    for name, kind, model in (("hdc", "hdc", hdc), ("softmax", "softmax", softmax), ("markov", "markov", markov), ("prior", "prior", prior)):
        probs = predict_all(kind, model, features["test"], splits["test"])
        results[name] = evaluate_model(name, probs, features["test"]["labels"], threshold=thresholds[name])

    # ---- per-class confidence thresholds (softmax, validation) ----
    val_probs = predict_all("softmax", softmax, features["val"], splits["val"])
    predicted = val_probs.argmax(axis=1)
    labels_val = features["val"]["labels"]
    class_thresholds = {}
    for c in range(1, len(ATOM_CLASSES)):
        mask = predicted == c
        if mask.sum() < 20:
            class_thresholds[ATOM_CLASSES[c]] = 0.50
            continue
        confidence = val_probs[mask, c]
        correct = labels_val[mask] == c
        order = np.argsort(-confidence)
        cumulative = np.cumsum(correct[order])
        precision = cumulative / np.arange(1, len(order) + 1)
        ok = np.where(precision >= 0.9)[0]
        class_thresholds[ATOM_CLASSES[c]] = (
            float(confidence[order[int(ok[-1])]]) if len(ok) else float(confidence.max() + 0.01)
        )
    print("[thresholds] per-class: " + str({k: round(v, 3) for k, v in class_thresholds.items()}), flush=True)

    # ---- local end-to-end sweep on held-out windows ----
    def sweep_predictor(model):
        return lambda left, span, right: model.predict_proba(extract_feature_ids(left, span, right))

    sweep = {
        "softmax": local_sweep_metrics(sweep_predictor(softmax), splits["test"], thresholds["softmax"],
                                       max_rows=1200, class_thresholds=class_thresholds),
        "hdc": local_sweep_metrics(sweep_predictor(hdc), splits["test"], thresholds["hdc"], max_rows=300),
    }
    for name, metrics in sweep.items():
        print(f"[sweep] {name}: hit={metrics['hit_rate']:.3f} class={metrics['class_hit_rate']:.3f} "
              f"false_fire={metrics['false_fire_rate']:.3f}", flush=True)

    # ---- grounding check ----
    index = build_index_from_lines(corpus)
    grounding = grounding_rates(splits["test"], index)

    # ---- latency (reference implementation) ----
    latency = {}
    sample_rows = splits["test"][:1000]
    t0 = time.time()
    sample_ids = [extract_feature_ids(r["left"], r["span"], r["right"]) for r in sample_rows]
    latency["feature_extraction"] = (time.time() - t0) / len(sample_rows) * 1000

    t0 = time.time()
    for ids in sample_ids:
        hdc.predict_proba(ids)
    latency["hdc_scoring"] = (time.time() - t0) / len(sample_rows) * 1000

    t0 = time.time()
    for ids in sample_ids:
        softmax.predict_proba(ids)
    latency["softmax_scoring"] = (time.time() - t0) / len(sample_rows) * 1000

    # ---- artifacts ----
    art_dir = BASE / "artifacts" / "v0"
    art_dir.mkdir(parents=True, exist_ok=True)
    hdc.save(art_dir / "hdc.npz")
    softmax.save(art_dir / "softmax.npz")

    config = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "corpus_articles": len(corpus),
        "corpus_chars": corpus_chars,
        "sample_counts": {k: len(v) for k, v in splits.items()},
        "docs_used": args.docs,
        "seed": args.seed,
        "device": device,
        "feature_dim": FEATURE_DIM,
        "hdc_info": hdc_info,
        "thresholds": thresholds,
        "class_thresholds": class_thresholds,
        "sweep": sweep,
        "target_precision": args.target_precision,
    }
    (art_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    (art_dir / "metrics.json").write_text(
        json.dumps({"results": results, "grounding": grounding, "latency_ms": latency, "sweep": sweep},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_report(
        art_dir / "REPORT.md",
        config=config,
        results=results,
        class_counts={k: class_distribution(v) for k, v in splits.items()},
        grounding=grounding,
        latency_ms=latency,
        sweep=sweep,
    )

    print("\n===== EFT / NES v0 summary =====", flush=True)
    for name, result in results.items():
        gate = result.get("gate_at_threshold", {})
        print(
            f"{name:8s} top1={result['top1']:.4f} top3={result['top3']:.4f} "
            f"gateP={gate.get('precision', 0):.3f} gateR={gate.get('recall', 0):.3f} auc={result.get('gate', {}).get('auc', 0):.4f}",
            flush=True,
        )
    print(f"artifacts: {art_dir}", flush=True)
    print(f"total time: {time.time() - started_all:.1f}s", flush=True)


if __name__ == "__main__":
    main()
