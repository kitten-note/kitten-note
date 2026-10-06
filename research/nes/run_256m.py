"""
EFT / NES - unattended 256M-parameter run.

Chain (all bounded, fails loudly):
    dependency check -> dataset discovery/download -> shard building
    -> training (A2000, wall-clock capped) -> int8 export -> STATUS report
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOG = BASE / "run-256m.log"

FETCH_MINUTES = 35.0
FETCH_MAX_CHARS = 200_000_000
SHARD_MINUTES = 25.0
SHARD_MAX_SAMPLES = 16_000_000
TRAIN_MINUTES = 80.0


def log(message: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def run(command: list[str]) -> None:
    log("RUN " + " ".join(command))
    started = time.time()
    process = subprocess.run(
        command, cwd=BASE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(process.stdout or "")
    for line in (process.stdout or "").strip().split("\n")[-12:]:
        log("   " + line)
    if process.returncode != 0:
        raise SystemExit(f"stage failed ({process.returncode}): {' '.join(command)}")
    log(f"DONE {command[1]} in {time.time() - started:.1f}s")


def ensure_pyarrow() -> None:
    try:
        import pyarrow  # noqa: F401
        log("pyarrow present")
        return
    except ImportError:
        pass
    log("installing pyarrow (parquet support) ...")
    process = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pyarrow"],
                             cwd=BASE, capture_output=True, text=True)
    if process.returncode != 0:
        log("pyarrow install failed; parquet datasets will be skipped")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    log("=" * 72)
    log("EFT / NES unattended 256M run started")

    ensure_pyarrow()

    sys.path.insert(0, str(BASE))

    from sources import collect
    log(f"dataset acquisition (<= {FETCH_MINUTES:.0f} min, <= {FETCH_MAX_CHARS/1e6:.0f}M chars)")
    collect(minutes=FETCH_MINUTES, max_total_chars=FETCH_MAX_CHARS, per_dataset_chars=50_000_000)

    from big_data import build as build_shards
    log(f"shard building (<= {SHARD_MINUTES:.0f} min, <= {SHARD_MAX_SAMPLES:,} samples)")
    stats = build_shards(minutes=SHARD_MINUTES, max_samples=SHARD_MAX_SAMPLES)
    log(f"shards: {json.dumps(stats, ensure_ascii=False)[:300]}")

    run([sys.executable, "train_big.py", "--minutes", str(TRAIN_MINUTES)])

    art = BASE / "artifacts" / "big"
    metrics = json.loads((art / "metrics.json").read_text(encoding="utf-8"))
    status = [
        "# EFT / NES 256M run - status",
        f"- finished: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
        f"- wall clock: {(time.time() - started) / 60:.1f} min",
        f"- parameters: {metrics['parameters']:,}",
        f"- training: {metrics['steps']} steps / {metrics['samples']:,} samples / {metrics['training_minutes']:.1f} min",
        f"- eval: {metrics.get('eval')}",
        f"- int8 export: {metrics.get('int8_export')}",
        "- artifacts: artifacts/big/ (model.pt, embedding_int8.npz, REPORT.md, metrics.json)",
    ]
    (BASE / "STATUS-256M.md").write_text("\n".join(status) + "\n", encoding="utf-8")
    log("STATUS-256M.md written")
    log(f"256M run finished in {(time.time() - started) / 60:.1f} min")
    log("=" * 72)


if __name__ == "__main__":
    main()
