"""
EFT / NES - unattended 256M run v2 (after fixing data acquisition + batching).

Fixes over v1:
  * no more silent truncation of large parquet/json downloads (1GB cap,
    corrupted partials deleted and re-fetched)
  * spelling-correction pairs (CSC) extracted into real edit samples
  * fixed batch pooling across shards (v1 trained with ~1.7k-sample batches
    and 2500 redundant passes over 381k samples)
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOG = BASE / "run-256m-v2.log"
EXTERNAL = BASE / "data" / "external"

FETCH_MINUTES = 40.0
FETCH_MAX_CHARS = 400_000_000
PER_DATASET_CHARS = 120_000_000
SHARD_MINUTES = 30.0
SHARD_MAX_SAMPLES = 16_000_000
TRAIN_MINUTES = 90.0


def log(message: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def run(command: list[str]) -> None:
    log("RUN " + " ".join(command))
    started = time.time()
    process = subprocess.run(command, cwd=BASE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding="utf-8", errors="replace")
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(process.stdout or "")
    for line in (process.stdout or "").strip().split("\n")[-12:]:
        log("   " + line)
    if process.returncode != 0:
        raise SystemExit(f"stage failed ({process.returncode}): {' '.join(command)}")
    log(f"DONE {command[1]} in {time.time() - started:.1f}s")


def clean_corrupted() -> None:
    """Remove partially-downloaded parquet/json files from the v1 run."""
    removed = 0
    if not EXTERNAL.exists():
        return
    for path in EXTERNAL.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.suffix == ".parquet":
                with path.open("rb") as handle:
                    handle.seek(-4, 2)
                    if handle.read(4) != b"PAR1":
                        path.unlink()
                        removed += 1
            elif path.suffix in (".json", ".jsonl"):
                if path.stat().st_size > 350_000_000:
                    with path.open("rb") as handle:
                        handle.seek(-64, 2)
                        tail = handle.read().decode("utf-8", errors="ignore").strip()
                    if tail and tail[-1] not in "]}":
                        path.unlink()
                        removed += 1
        except Exception:  # noqa: BLE001
            continue
    log(f"removed {removed} corrupted/truncated downloads")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    log("=" * 72)
    log("EFT / NES 256M run v2 started")

    sweep_v1 = BASE / "artifacts" / "big" / "sweep.json"
    if sweep_v1.exists():
        shutil.copy(sweep_v1, BASE / "artifacts" / "big" / "sweep-v1.json")

    clean_corrupted()

    sys.path.insert(0, str(BASE))
    from sources import collect
    log(f"dataset acquisition (<= {FETCH_MINUTES:.0f} min, <= {FETCH_MAX_CHARS/1e6:.0f}M chars)")
    collect(minutes=FETCH_MINUTES, max_total_chars=FETCH_MAX_CHARS, per_dataset_chars=PER_DATASET_CHARS)

    from big_data import build as build_shards
    log(f"shard building (<= {SHARD_MINUTES:.0f} min, <= {SHARD_MAX_SAMPLES:,} samples)")
    stats = build_shards(minutes=SHARD_MINUTES, max_samples=SHARD_MAX_SAMPLES)
    log(f"shards: {json.dumps(stats, ensure_ascii=False)[:400]}")

    run([sys.executable, "train_big.py", "--minutes", str(TRAIN_MINUTES)])
    run([sys.executable, "eval_big_sweep.py", "--rows", "400"])

    art = BASE / "artifacts" / "big"
    metrics = json.loads((art / "metrics.json").read_text(encoding="utf-8"))
    sweep = json.loads((art / "sweep.json").read_text(encoding="utf-8"))
    status = [
        "# EFT / NES 256M run v2 - status",
        f"- finished: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
        f"- wall clock: {(time.time() - started) / 60:.1f} min",
        f"- parameters: {metrics['parameters']:,}",
        f"- training: {metrics['steps']} steps / {metrics['samples']:,} samples / {metrics['training_minutes']:.1f} min",
        f"- eval (val shards): {metrics.get('eval')}",
        f"- sweep: {json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in sweep['sweep'].items()})}",
        f"- int8 export: {metrics.get('int8_export')}",
        "- artifacts: artifacts/big/ (model.pt, embedding_int8.npz, REPORT.md, metrics.json, sweep.json)",
    ]
    (BASE / "STATUS-256M-v2.md").write_text("\n".join(status) + "\n", encoding="utf-8")
    log(f"v2 finished in {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
