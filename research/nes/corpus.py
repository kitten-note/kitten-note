"""
EFT / NES v0 - Corpus acquisition.

Fetches Chinese prose from zh.wikipedia.org (CC BY-SA 4.0) via the public API
and stores:
    research/nes/data/corpus/corpus.txt   (one article intro per line)
    research/nes/data/corpus/manifest.json

The corpus is used for (a) synthesis source text and (b) the grounding index
(copy-only payloads). Raw text is NOT committed to git (see .gitignore).

Usage:
    python corpus.py --articles 5000
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data" / "corpus"
CORPUS_PATH = DATA_DIR / "corpus.txt"
MANIFEST_PATH = DATA_DIR / "manifest.json"

API = "https://zh.wikipedia.org/w/api.php"
UA = "KittenNoteResearch/0.1 (offline notes NES research; contact: local)"


def _api_get(params: dict, timeout: int = 30) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_articles(target: int, batch: int = 20, workers: int = 2) -> list[str]:
    """Fetch `target` unique article intros (>=80 chars), with parallel batches."""
    from concurrent.futures import ThreadPoolExecutor

    seen: set[str] = set()
    lines: list[str] = []

    def one_batch() -> list[tuple[str, str]]:
        params = {
            "action": "query",
            "generator": "random",
            "grnnamespace": "0",
            "grnlimit": str(batch),
            "prop": "extracts",
            "explaintext": "1",
            "exintro": "1",
            "exchars": "1200",
            "format": "json",
            "formatversion": "2",
        }
        for _attempt in range(3):
            try:
                payload = _api_get(params)
                out = []
                for page in (payload.get("query") or {}).get("pages") or []:
                    title = page.get("title", "")
                    extract = (page.get("extract") or "").strip()
                    if extract and len(extract) >= 80:
                        out.append((title, " ".join(extract.split())))
                return out
            except Exception as error:  # noqa: BLE001
                print(f"[corpus] batch failed ({error}); retrying...", flush=True)
                time.sleep(1.5)
        return []

    requests_done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while len(lines) < target and requests_done < max(40, target // batch * 4):
            futures = [pool.submit(one_batch) for _ in range(workers)]
            for future in futures:
                requests_done += 1
                for title, clean in future.result():
                    if title in seen:
                        continue
                    seen.add(title)
                    lines.append(clean)
            if requests_done % 40 == 0:
                print(f"[corpus] fetched {len(lines)}/{target} articles ({requests_done} requests)", flush=True)
            time.sleep(0.4)

    return lines


def build(articles: int, min_chars: int = 200_000) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if CORPUS_PATH.exists():
        existing = CORPUS_PATH.read_text(encoding="utf-8")
        n_existing = existing.count("\n")
        if len(existing) >= min_chars and n_existing >= articles * 0.7:
            print(f"[corpus] reusing cached corpus: {n_existing} articles, {len(existing)} chars")
            return

    print(f"[corpus] fetching ~{articles} articles from {API} ...", flush=True)
    lines = fetch_articles(articles)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CORPUS_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = {
        "source": "zh.wikipedia.org (random article intros, plain text)",
        "license": "CC BY-SA 4.0 (Wikimedia Foundation)",
        "attribution": "Text excerpts from Chinese Wikipedia, used for research; not redistributed in the repository.",
        "articles": len(lines),
        "chars": sum(len(line) for line in lines),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[corpus] wrote {CORPUS_PATH} ({manifest['articles']} articles, {manifest['chars']} chars)")


def load_corpus() -> list[str]:
    if not CORPUS_PATH.exists():
        raise FileNotFoundError("corpus missing; run: python corpus.py --articles 5000")
    return [line for line in CORPUS_PATH.read_text(encoding="utf-8").split("\n") if line.strip()]


def expand(target_total: int, minutes: float = 50.0) -> None:
    """Politely grow the cached corpus up to `target_total` articles.

    Appends to corpus.txt, dedupes against existing lines, honours a wall-clock
    deadline and refreshes the manifest. Safe to interrupt and re-run.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing_lines: list[str] = []
    if CORPUS_PATH.exists():
        existing_lines = [line for line in CORPUS_PATH.read_text(encoding="utf-8").split("\n") if line.strip()]
    if len(existing_lines) >= target_total:
        print(f"[corpus] already at {len(existing_lines)} articles (target {target_total}); skip")
        return

    seen = {line[:80] for line in existing_lines}
    deadline = time.time() + minutes * 60
    needed = target_total - len(existing_lines)
    print(f"[corpus] expanding {len(existing_lines)} -> {target_total} (+{needed}) with deadline {minutes:.0f} min")

    newly = []
    while len(existing_lines) + len(newly) < target_total and time.time() < deadline:
        batch = fetch_articles(min(400, needed - len(newly)))
        added = 0
        for line in batch:
            key = line[:80]
            if key in seen:
                continue
            seen.add(key)
            newly.append(line)
            added += 1
        print(f"[corpus] +{added} (total now {len(existing_lines) + len(newly)})", flush=True)
        if added == 0:
            break

    all_lines = existing_lines + newly
    CORPUS_PATH.write_text("\n".join(all_lines) + "\n", encoding="utf-8")
    manifest = {
        "source": "zh.wikipedia.org (random article intros, plain text)",
        "license": "CC BY-SA 4.0 (Wikimedia Foundation)",
        "attribution": "Text excerpts from Chinese Wikipedia, used for research; not redistributed in the repository.",
        "articles": len(all_lines),
        "chars": sum(len(line) for line in all_lines),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[corpus] wrote {CORPUS_PATH} ({manifest['articles']} articles, {manifest['chars']} chars)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--articles", type=int, default=5000)
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    build(args.articles)


if __name__ == "__main__":
    main()
