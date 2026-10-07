"""
EFT / NES - dataset discovery and acquisition (for the 256M-parameter run).

Finds Chinese corpora / spelling-correction datasets on the Hugging Face Hub
(via the public API), downloads a bounded amount of text and consolidates it
under data/external/. Everything is time- and size-capped so the run stays
unattended-safe; provenance and licenses are recorded in manifest.json.

No authentication, no `datasets` dependency: plain HTTP + (optional) pyarrow.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterator, List

BASE = Path(__file__).resolve().parent
EXTERNAL = BASE / "data" / "external"
HF_API = "https://huggingface.co/api"
HF_RESOLVE = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"
UA = "KittenNoteResearch/0.1 (offline notes NES research)"

EXPLICIT_CANDIDATES = [
    "wikimedia/wikipedia",          # config 20231101.zh (shards)
    "pleisto/wikipedia-cn-20230720-filtered",
    "liwu/MNBVC",                   # likely too large; size filter will skip
    "shibing624/CSC",
    "p208p2002/sighan-2015-csc",
]

DISCOVERY_QUERIES = [
    "chinese spelling correction",
    "chinese text corpus",
    "中文 语料",
    "LCSTS weibo",
    "chinese dialogue corpus",
    "chinese forum qa corpus",
]

TEXT_KEYS = ["text", "content", "sentence", "document", "completion", "zh", "paragraph", "output", "target"]
PAIR_LEFT_KEYS = ["original", "wrong", "src", "source", "mistake", "original_text", "incorrect", "error"]
PAIR_RIGHT_KEYS = ["correct", "right", "tgt", "target", "correction", "corrected", "correct_text", "fixed"]


def _get_json(url: str, timeout: int = 30):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def discover(query: str, limit: int = 15) -> List[str]:
    url = f"{HF_API}/datasets?search={urllib.parse.quote(query)}&limit={limit}&sort=downloads&direction=-1"
    try:
        return [item["id"] for item in _get_json(url) if item.get("id")]
    except Exception as error:  # noqa: BLE001
        print(f"[sources] discovery failed for '{query}': {error}")
        return []


def dataset_files(repo: str) -> List[str]:
    try:
        info = _get_json(f"{HF_API}/datasets/{repo}")
    except Exception as error:  # noqa: BLE001
        print(f"[sources] cannot list {repo}: {error}")
        return []
    files = [sibling.get("rfilename", "") for sibling in info.get("siblings", [])]
    wanted = [f for f in files if f.endswith((".parquet", ".jsonl", ".json", ".txt"))]
    if repo == "wikimedia/wikipedia":
        wanted = [f for f in wanted if "zh" in f.lower()]
    # smallest-first heuristics: shards like train-00000 first, skip index files
    wanted = [f for f in wanted if "index" not in f.lower()]
    return wanted


def download(repo: str, filename: str, dest: Path, max_bytes: int = 1_000_000_000) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = HF_RESOLVE.format(repo=repo, path=urllib.parse.quote(filename))
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    total = 0
    with urllib.request.urlopen(request, timeout=120) as response, dest.open("wb") as handle:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
            total += len(chunk)
            if total > max_bytes:
                break
    return total


def iter_texts(path: Path) -> Iterator[str]:
    suffix = path.suffix.lower()
    try:
        if suffix == ".parquet":
            import pyarrow.parquet as pq

            table = pq.read_table(path)
            columns = [name for name in table.column_names if name.lower() in TEXT_KEYS]
            columns = columns or [name for name in table.column_names if "text" in name.lower()]
            if not columns:
                columns = table.column_names[:1]
            for column in columns:
                for value in table.column(column).to_pylist():
                    if isinstance(value, str) and value.strip():
                        yield " ".join(value.split())
        elif suffix in (".jsonl", ".json"):
            if suffix == ".jsonl":
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        yield from _json_texts(line)
            else:
                raw = path.read_text(encoding="utf-8", errors="replace")
                yield from _json_texts(raw)
        else:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    line = line.strip()
                    if line:
                        yield line
    except Exception as error:  # noqa: BLE001
        print(f"[sources] extract failed for {path.name}: {error}; deleting partial file")
        try:
            path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


def iter_pairs(path: Path) -> Iterator[tuple[str, str]]:
    """Yield (wrong, correct) pairs from spelling-correction style files."""
    suffix = path.suffix.lower()

    def from_dict(item: dict) -> Iterator[tuple[str, str]]:
        left = next((item[key] for key in PAIR_LEFT_KEYS if isinstance(item.get(key), str) and item[key].strip()), None)
        right = next((item[key] for key in PAIR_RIGHT_KEYS if isinstance(item.get(key), str) and item[key].strip()), None)
        if left and right and left != right and len(left) >= 8:
            yield (" ".join(left.split()), " ".join(right.split()))

    try:
        if suffix == ".parquet":
            import pyarrow.parquet as pq

            table = pq.read_table(path)
            for row in table.to_pylist():
                if isinstance(row, dict):
                    yield from from_dict(row)
        elif suffix == ".jsonl":
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        payload = json.loads(line)
                    except Exception:  # noqa: BLE001
                        continue
                    if isinstance(payload, dict):
                        yield from from_dict(payload)
                    elif isinstance(payload, list):
                        for item in payload:
                            if isinstance(item, dict):
                                yield from from_dict(item)
        elif suffix == ".json":
            raw = path.read_text(encoding="utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except Exception as error:  # noqa: BLE001
                print(f"[sources] json parse failed for {path.name}: {error}")
                return
            stack = [payload]
            while stack:
                item = stack.pop()
                if isinstance(item, dict):
                    yield from from_dict(item)
                elif isinstance(item, list):
                    stack.extend(item)
    except Exception as error:  # noqa: BLE001
        print(f"[sources] pair extract failed for {path.name}: {error}")


def _json_texts(raw: str) -> Iterator[str]:
    try:
        payload = json.loads(raw)
    except Exception:  # noqa: BLE001
        return
    stack = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if len(item.strip()) >= 8:
                yield " ".join(item.split())
        elif isinstance(item, dict):
            stack.extend(item.get(key) for key in TEXT_KEYS if key in item)
        elif isinstance(item, list):
            stack.extend(item)


def collect(minutes: float = 40.0, max_total_chars: int = 250_000_000,
            per_dataset_chars: int = 60_000_000) -> Path:
    """Fetch bounded text from as many accessible datasets as possible."""
    EXTERNAL.mkdir(parents=True, exist_ok=True)
    consolidated = EXTERNAL / "all_text.txt"
    pairs_path = EXTERNAL / "csc_pairs.jsonl"
    manifest_path = EXTERNAL / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"datasets": []}
    done_repos = {entry["repo"] for entry in manifest["datasets"]}

    candidates = list(EXPLICIT_CANDIDATES)
    for query in DISCOVERY_QUERIES:
        candidates.extend(discover(query))

    seen = set()
    queue = [repo for repo in candidates if not (repo in seen or seen.add(repo))]

    deadline = time.time() + minutes * 60
    preexisting = consolidated.stat().st_size if consolidated.exists() else 0
    total_chars = preexisting
    new_chars = 0
    print(f"[sources] starting collection: {len(queue)} candidates, budget {minutes:.0f} min / {max_total_chars/1e6:.0f}M NEW chars (file already has {preexisting/1e6:.1f}M)")

    with consolidated.open("a", encoding="utf-8") as out, pairs_path.open("a", encoding="utf-8") as pairs_out:
        for repo in queue:
            if time.time() > deadline or new_chars >= max_total_chars:
                break
            if repo in done_repos:
                continue

            files = dataset_files(repo)[:4]
            if not files:
                continue
            repo_chars = 0
            repo_pairs = 0
            repo_dir = EXTERNAL / repo.replace("/", "__")
            used_files = []
            for filename in files:
                if time.time() > deadline or repo_chars >= per_dataset_chars or new_chars >= max_total_chars:
                    break
                target = repo_dir / Path(filename).name
                if not target.exists():
                    try:
                        size = download(repo, filename, target)
                        print(f"[sources] {repo} :: {filename} ({size/1e6:.1f} MB)")
                    except Exception as error:  # noqa: BLE001
                        print(f"[sources] download failed {repo}/{filename}: {error}")
                        continue
                before = repo_chars
                for text in iter_texts(target):
                    if len(text) < 16:
                        continue
                    out.write(text + "\n")
                    repo_chars += len(text)
                    total_chars += len(text)
                    new_chars += len(text)
                    if repo_chars - before > per_dataset_chars or new_chars >= max_total_chars or time.time() > deadline:
                        break
                # spelling-correction pairs (real edit streams)
                for wrong, correct in iter_pairs(target):
                    pairs_out.write(json.dumps({"wrong": wrong, "correct": correct}, ensure_ascii=False) + "\n")
                    repo_pairs += 1
                    if repo_pairs >= 200_000:
                        break
                if not target.exists():
                    continue  # extract failed and deleted the partial file
                used_files.append(filename)
                if repo_chars - before > 0:
                    print(f"[sources] {repo}: +{(repo_chars - before)/1e6:.1f}M chars (total {total_chars/1e6:.1f}M)")
                if repo_pairs:
                    print(f"[sources] {repo}: +{repo_pairs} correction pairs")
            if repo_chars > 0 or repo_pairs > 0:
                manifest["datasets"].append({
                    "repo": repo,
                    "files": used_files,
                    "chars": repo_chars,
                    "pairs": repo_pairs,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "license": "see dataset card on huggingface.co/datasets/" + repo,
                })
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[sources] collected {total_chars/1e6:.1f}M chars into {consolidated}")
    return consolidated


if __name__ == "__main__":
    try:
        import sys
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    collect()
