"""
8B-corpus intake: SkyPile-150B shards ({"text"}) -> clean line corpus.

Cleaning (documented for the paper; SkyPile is already globally deduped,
so we only do light filtering + within-file exact dedup):
  * split documents on newlines; strip whitespace
  * keep 20..2000 chars, CJK ratio >= 0.30
  * diversity: unique/total chars >= 0.05 (kills boilerplate repetition)
  * within-file exact-dup removal (blake2b); cross-file dups left as-is
    (upstream already deduped; our samplers shuffle anyway)

Writes: data/bigcorpus/clean/<shard>.txt + data/bigcorpus/manifest.json
Token convention: tokens ~= CJK chars + latin words (reported separately).

Usage: python bigcorpus.py [--minutes 60]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
SRC = BASE / "data" / "bigcorpus" / "skypile" / "data"
OUT = BASE / "data" / "bigcorpus" / "clean"
MANIFEST = BASE / "data" / "bigcorpus" / "manifest.json"


def is_cjk(char: str) -> bool:
    return "\u4e00" <= char <= "\u9fff"


def clean_line(line: str):
    text = " ".join(line.split())
    if not (20 <= len(text) <= 2000):
        return None
    cjk = sum(1 for c in text if is_cjk(c))
    if cjk / len(text) < 0.30:
        return None
    if len(set(text)) / len(text) < 0.05:
        return None
    return text


def count_tokens(text: str):
    cjk = sum(1 for c in text if is_cjk(c))
    latin_words = sum(1 for w in text.split() if w and not is_cjk(w[0]))
    return cjk, latin_words


def process_shard(path: Path):
    out_path = OUT / (path.stem + ".txt")
    if out_path.exists():
        return None
    kept = dropped = errors = 0
    cjk_total = latin_total = 0
    seen = set()
    with path.open("r", encoding="utf-8", errors="replace") as src, \
            out_path.open("w", encoding="utf-8") as dst:
        for line in src:
            line = line.strip()
            if not line:
                continue
            try:
                text = json.loads(line).get("text", "")
            except Exception:  # noqa: BLE001
                errors += 1
                continue
            if not isinstance(text, str):
                dropped += 1
                continue
            for piece in text.split("\n"):
                cleaned = clean_line(piece)
                if cleaned is None:
                    dropped += 1
                    continue
                digest = hashlib.blake2b(cleaned.encode("utf-8"), digest_size=8).digest()
                if digest in seen:
                    dropped += 1
                    continue
                seen.add(digest)
                c, l = count_tokens(cleaned)
                cjk_total += c
                latin_total += l
                dst.write(cleaned + "\n")
                kept += 1
    return {"file": path.name, "kept": kept, "dropped": dropped, "errors": errors,
            "cjk_tokens": cjk_total, "latin_tokens": latin_total}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=60.0)
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"shards": []}
    done = {entry["file"] for entry in manifest["shards"]}

    deadline = time.time() + args.minutes * 60
    started = time.time()
    for path in sorted(SRC.glob("*.jsonl")):
        if time.time() > deadline:
            break
        if path.name in done:
            continue
        result = process_shard(path)
        if result is None:
            continue
        manifest["shards"].append(result)
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[bigcorpus] {path.name}: kept {result['kept']:,} "
              f"(~{(result['cjk_tokens'] + result['latin_tokens']) / 1e6:.1f}M tokens)", flush=True)

    total_tokens = sum(s["cjk_tokens"] + s["latin_tokens"] for s in manifest["shards"])
    total_kept = sum(s["kept"] for s in manifest["shards"])
    print(f"[bigcorpus] TOTAL: {len(manifest['shards'])} shards, {total_kept:,} lines, "
          f"~{total_tokens / 1e9:.2f}B tokens in {(time.time() - started) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
