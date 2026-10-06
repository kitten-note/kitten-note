"""
EFT / NES - unattended v0.1 pipeline.

Runs the whole chain to completion without any human interaction:

    corpus expansion -> synthesis (24 passes) -> features -> training
    -> export for browser -> golden-vector test -> model card -> demo -> status

Everything is logged to `run-unattended.log` next to this file. The script
fails loudly (non-zero exit) if any stage fails, so a broken run is never
silently accepted.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOG = BASE / "run-unattended.log"

CORPUS_TARGET = 8000          # politely expand the wiki corpus up to this many articles
CORPUS_MINUTES = 50.0
SYNTH_PASSES = 24
EPOCHS = 10


def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    line = f"[{stamp}] {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def run(command: list[str], allowed: tuple[int, ...] = (0,)) -> None:
    log("RUN " + " ".join(command))
    started = time.time()
    process = subprocess.run(
        command,
        cwd=BASE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    tail = (process.stdout or "").strip().split("\n")[-15:]
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(process.stdout or "")
    for line in tail:
        log("   " + line)
    if process.returncode not in allowed:
        raise SystemExit(f"stage failed ({process.returncode}): {' '.join(command)}")
    log(f"DONE {command[1]} in {time.time() - started:.1f}s")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    started_all = time.time()
    log("=" * 72)
    log("EFT / NES unattended v0.1 pipeline started")

    # Stage 1: corpus expansion (politely, bounded by wall-clock deadline)
    sys.path.insert(0, str(BASE))
    from corpus import expand
    log(f"expanding wiki corpus to {CORPUS_TARGET} articles (<= {CORPUS_MINUTES:.0f} min)")
    expand(CORPUS_TARGET, minutes=CORPUS_MINUTES)

    # Stage 2-8: synthesis -> training -> evaluation
    run([sys.executable, "train.py", "--docs", "100000", "--fetch-articles", str(CORPUS_TARGET),
         "--passes", str(SYNTH_PASSES), "--epochs", str(EPOCHS), "--rebuild-samples"])

    # Stage 9: browser bundle + golden test
    run([sys.executable, "export_for_browser.py"])
    run(["node", "browser/test_infer.mjs"])  # must pass: JS == Python

    # Stage 10: deliverables
    run([sys.executable, "make_model_card.py"])
    run([sys.executable, "demo.py"])

    art = BASE / "artifacts" / "v0"
    metrics = json.loads((art / "metrics.json").read_text(encoding="utf-8"))
    best = max(metrics["results"].values(), key=lambda r: r["top1"])

    status = [
        "# EFT / NES unattended run - status",
        f"- finished: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
        f"- total wall clock: {(time.time() - started_all) / 60:.1f} min",
        f"- best model: **{best['name']}** (top1 {best['top1']:.4f}, edit-top1 {best.get('edit_top1', 0):.4f}, "
        f"AUC {best.get('gate', {}).get('auc', 0):.4f})",
        f"- sweep (softmax): {metrics.get('sweep', {}).get('softmax', {})}",
        f"- grounding: {metrics.get('grounding', {})}",
        "- artifacts: artifacts/v0/ (models, browser bundle, REPORT.md, MODEL_CARD.md)",
    ]
    (BASE / "STATUS.md").write_text("\n".join(status) + "\n", encoding="utf-8")
    log("STATUS.md written")
    log(f"pipeline finished in {(time.time() - started_all) / 60:.1f} min")
    log("=" * 72)


if __name__ == "__main__":
    main()
