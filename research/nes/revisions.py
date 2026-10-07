"""
Fetch consecutive Wikipedia revision pairs (real human edits) for NES training.

For each article: take recent revisions, diff consecutive contents with
atoms.diff_to_atoms, keep small focused edits (1-3 atoms, small char delta)
as (wrong=older, correct=newer) pairs. Polite (2s delay + backoff), resumable
(progress file), bounded by wall-clock minutes.

Usage: python revisions.py [--minutes 40] [--max-pairs 3000]
Writes: data/external/rev_pairs.jsonl + data/external/rev_progress.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Optional

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from atoms import diff_to_atoms  # noqa: E402

API = "https://zh.wikipedia.org/w/api.php"
UA = "KittenNoteResearch/0.1 (NES research; contact via repo)"
OUT = BASE / "data" / "external" / "rev_pairs.jsonl"
PROGRESS = BASE / "data" / "external" / "rev_progress.json"
DELAY = 2.0


def api(params: dict, retries: int = 4):
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for attempt in range(retries):
        try:
            request = urllib.request.Request(API + "?" + query, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            wait = DELAY * (2 ** attempt)
            print(f"[revisions] api error ({error}); waiting {wait:.0f}s", flush=True)
            time.sleep(wait)
    return None


def random_titles(batch: int = 10) -> list:
    payload = api({"action": "query", "list": "random", "rnnamespace": "0", "rnlimit": batch})
    if not payload:
        return []
    return [item["title"] for item in payload.get("query", {}).get("random", [])]


def revisions(title: str, limit: int = 6) -> list:
    payload = api({
        "action": "query", "prop": "revisions", "titles": title,
        "rvprop": "content|ids", "rvslots": "main", "rvlimit": limit, "rvdir": "older",
    })
    if not payload:
        return []
    pages = payload.get("query", {}).get("pages", [])
    if not pages:
        return []
    texts = []
    for revision in pages[0].get("revisions", []):
        try:
            texts.append(revision["slots"]["main"]["content"])
        except KeyError:
            continue
    return texts


def accept_pair(old: str, new: str):
    if not (60 <= len(old) <= 3000 and 60 <= len(new) <= 3000):
        return None
    if old == new:
        return None
    if abs(len(old) - len(new)) > 60:
        return None
    try:
        atoms = diff_to_atoms(old, new, max_ops=3)
    except Exception:  # noqa: BLE001
        return None
    if not (1 <= len(atoms) <= 3):
        return None
    if any(atom.get("type") == "NO_EDIT" for atom in atoms):
        return None
    return {"wrong": old, "correct": new,
            "atoms": [atom.get("type") for atom in atoms]}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=40.0)
    parser.add_argument("--max-pairs", type=int, default=3000)
    args = parser.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    progress = json.loads(PROGRESS.read_text(encoding="utf-8")) if PROGRESS.exists() else {
        "done_titles": [], "pairs": 0}
    done = set(progress["done_titles"])
    pairs = progress["pairs"]

    deadline = time.time() + args.minutes * 60
    handle = OUT.open("a", encoding="utf-8")
    try:
        while time.time() < deadline and pairs < args.max_pairs:
            titles = [t for t in random_titles() if t not in done]
            if not titles:
                time.sleep(DELAY)
                continue
            for title in titles:
                if time.time() > deadline or pairs >= args.max_pairs:
                    break
                done.add(title)
                texts = revisions(title)
                time.sleep(DELAY)
                for old, new in zip(texts[1:], texts[:-1]):
                    item = accept_pair(old, new)
                    if item:
                        handle.write(json.dumps(item, ensure_ascii=False) + "\n")
                        pairs += 1
                        if pairs % 50 == 0:
                            print(f"[revisions] pairs={pairs}", flush=True)
                        if pairs >= args.max_pairs:
                            break
            progress = {"done_titles": sorted(done)[-2000:], "pairs": pairs}
            PROGRESS.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")
    finally:
        handle.close()
        progress = {"done_titles": sorted(done)[-2000:], "pairs": pairs}
        PROGRESS.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")

    print(f"[revisions] done: {pairs} pairs", flush=True)


if __name__ == "__main__":
    main()
