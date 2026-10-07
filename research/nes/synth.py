"""
EFT / NES v0 - Synthetic edit-stream generator.

Synthesis principle: perturbations define ground truth. We take clean Chinese
prose, *inject* realistic user mistakes, and the label is the typed atom that
repairs the noisy document back to clean. This yields perfectly labelled
(context, atom) pairs without any teacher model.

Perturbation families (each maps to a repair atom):
    homophone / punctuation swap -> FIX_CHAR
    stray duplicate char          -> DEL_CHAR
    filler word insertion         -> DEL_SPAN
    missing punctuation           -> INS_CHAR
    phrase omission               -> INS_SPAN_COPY (payload = the omitted phrase)
    list-marker removal           -> FMT_BULLET(add)
    (clean positions & near misses) -> NO_EDIT

Output: JSONL samples with the context window (left/span/right) and the atom.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from atoms import CLASS_TO_ID, apply_atom, make_atom

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
SAMPLES_DIR = DATA_DIR / "samples"

LEFT_WINDOW = 64
RIGHT_WINDOW = 32
MIN_DISTANCE = 6          # between two perturbations in one doc
EDGE = 16                 # keep edits away from doc edges

HOMOPHONE_PUNCT_SWAPS = {
    "，": ",", "。": ".", "！": "!", "？": "?", "：": ":", "；": ";",
    "、": ",", "（": "(", "）": ")",
}
FILLERS = ["其实", "基本上", "然后", "也就是说", "说实话"]
CJK_PUNCT = set("，。！？；：、（）《》“”‘’—…·")


def build_homophone_map(corpus: List[str], max_chars: int = 5000) -> Dict[str, List[str]]:
    from pypinyin import Style, pinyin

    counts: Counter = Counter()
    for line in corpus:
        counts.update(line)
    groups: Dict[str, set] = {}
    for char, _count in counts.most_common(max_chars):
        if "\u4e00" <= char <= "\u9fff":
            reading = pinyin(char, style=Style.NORMAL)[0][0]
            groups.setdefault(reading, set()).add(char)
    return {reading: sorted(chars) for reading, chars in groups.items() if len(chars) >= 2}


def _after_colon(meta: str) -> str:
    return meta.split(":", 1)[1] if ":" in meta else ""


def _char_class(char: str) -> str:
    if char in CJK_PUNCT:
        return "cjk_punct"
    if char.isspace():
        return "space"
    if "\u4e00" <= char <= "\u9fff":
        return "cjk"
    if char.isdigit():
        return "digit"
    if char.isalpha():
        return "latin"
    return "other"


class Synthesizer:
    def __init__(self, corpus: List[str], seed: int = 20261006):
        self.rng = random.Random(seed)
        self.homophones = build_homophone_map(corpus)

    def _pick_phrase_omission(self, doc: str, blocked: List[Tuple[int, int]]) -> Optional[Tuple[int, str, str, Tuple[int, int]]]:
        """Find a phrase occurring twice; protect BOTH occurrences from other edits."""
        def safe(span: Tuple[int, int]) -> bool:
            return all(
                span[1] + MIN_DISTANCE <= p or e + MIN_DISTANCE <= span[0]
                for p, e in blocked
            )

        for _ in range(80):
            n = self.rng.choice([2, 3, 4])
            start_region = self.rng.randint(EDGE, max(EDGE + 1, len(doc) - n - EDGE))
            phrase = doc[start_region:start_region + n]
            if len(phrase) != n or any(ch.isspace() for ch in phrase):
                continue
            if not ("\u4e00" <= phrase[0] <= "\u9fff"):
                continue
            first = doc.find(phrase)
            second = doc.find(phrase, first + 1)
            if second < 0 or second - first > 250:
                continue
            if not (EDGE <= first <= len(doc) - EDGE - n):
                continue
            first_span = (first, first + n)
            second_span = (second, second + n)
            if safe(first_span) and safe(second_span):
                return first, "", f"omit:{phrase}", second_span
        return None

    # ---------- single perturbations on a clean doc ----------
    def _pick_homophone(self, doc: str) -> Optional[Tuple[int, str, str]]:
        candidates = [
            i for i in range(EDGE, len(doc) - EDGE)
            if "\u4e00" <= doc[i] <= "\u9fff"
            and doc[i] in self.homophones.get(self.homophones_reading(doc[i]), [])
            and len(self.homophones.get(self.homophones_reading(doc[i]), [])) >= 2
        ]
        if not candidates:
            return None
        pos = self.rng.choice(candidates)
        clean_char = doc[pos]
        reading = self.homophones_reading(clean_char)
        alternatives = [c for c in self.homophones[reading] if c != clean_char]
        if not alternatives:
            return None
        return pos, self.rng.choice(alternatives), clean_char

    def homophones_reading(self, char: str) -> str:
        if not hasattr(self, "_reading_cache"):
            self._reading_cache = {}
        if char not in self._reading_cache:
            from pypinyin import Style, pinyin
            self._reading_cache[char] = pinyin(char, style=Style.NORMAL)[0][0]
        return self._reading_cache[char]

    def _pick_punct_swap(self, doc: str) -> Optional[Tuple[int, str, str]]:
        candidates = [i for i in range(EDGE, len(doc) - EDGE) if doc[i] in HOMOPHONE_PUNCT_SWAPS]
        if not candidates:
            return None
        pos = self.rng.choice(candidates)
        return pos, HOMOPHONE_PUNCT_SWAPS[doc[pos]], doc[pos]

    def _pick_duplicate(self, doc: str) -> Optional[Tuple[int, str, str]]:
        candidates = [
            i for i in range(EDGE, len(doc) - EDGE)
            if doc[i] not in "\n" and (i == 0 or doc[i] != doc[i - 1])
        ]
        if not candidates:
            return None
        pos = self.rng.choice(candidates)
        return pos, doc[pos], f"dup:{doc[pos]}"  # one stray duplicate; repair deletes it

    def _pick_missing_punct(self, doc: str) -> Optional[Tuple[int, str, str]]:
        candidates = [i for i in range(EDGE, len(doc) - EDGE) if doc[i] in CJK_PUNCT]
        if not candidates:
            return None
        pos = self.rng.choice(candidates)
        return pos, "", f"missing:{doc[pos]}"  # delete the punct; repair inserts it

    def _pick_filler(self, doc: str) -> Optional[Tuple[int, str, str]]:
        candidates = [i for i in range(EDGE, len(doc) - EDGE) if "\u4e00" <= doc[i] <= "\u9fff"]
        if not candidates:
            return None
        return self.rng.choice(candidates), self.rng.choice(FILLERS), "filler"

    def _pick_phrase_omission_legacy(self, doc: str) -> Optional[Tuple[int, str, str]]:
        return None

    # ---------- compose perturbations ----------
    def make_doc_samples(self, doc: str, bullet_doc: bool = False,
                         return_noisy: bool = False):
        doc = doc.strip()
        if len(doc) < 2 * EDGE + 10:
            return []

        kinds = [
            ("homophone", self._pick_homophone, 0.26),
            ("punct", self._pick_punct_swap, 0.12),
            ("dup", self._pick_duplicate, 0.18),
            ("missing", self._pick_missing_punct, 0.14),
            ("filler", self._pick_filler, 0.16),
            ("omit", self._pick_phrase_omission, 0.14),
        ]
        if any(doc.startswith("- ", m) for m in range(len(doc))):
            kinds.append(("bullet", None, 0.18))

        n_edits = self.rng.choices([1, 2, 3], weights=[0.55, 0.33, 0.12])[0]
        chosen: List[Dict] = []
        positions: List[Tuple[int, int]] = []  # blocked regions (edits + protected occurrences)

        for _ in range(n_edits):
            for _attempt in range(12):
                kind, picker, _w = self.rng.choices(kinds, weights=[k[2] for k in kinds])[0]
                if kind == "bullet":
                    lines = [m for m in range(len(doc)) if doc.startswith("- ", m)]
                    if not lines:
                        continue
                    line_start = self.rng.choice(lines)
                    if any(abs(line_start - p) < MIN_DISTANCE for p, _e in positions):
                        continue
                    chosen.append({"kind": "bullet", "pos": line_start, "payload": "- ", "meta": "bullet"})
                    positions.append((line_start, line_start + 2))
                    break
                picked = self._pick_phrase_omission(doc, positions) if kind == "omit" else (picker(doc) if picker else None)
                if not picked:
                    continue
                extra_span = None
                if len(picked) == 4:
                    pos, replacement, meta, extra_span = picked
                else:
                    pos, replacement, meta = picked
                if meta.startswith("omit:"):
                    phrase = meta.split(":", 1)[1]
                    span = (pos, pos + len(phrase))
                elif meta.startswith("missing:"):
                    span = (pos, pos + 1)
                else:
                    span = (pos, pos + 1)
                if any(not (span[1] + MIN_DISTANCE <= p or e + MIN_DISTANCE <= span[0]) for p, e in positions):
                    continue
                chosen.append({"kind": kind, "pos": pos, "payload": replacement, "meta": meta})
                positions.append(span)
                if extra_span:
                    positions.append(extra_span)
                break

        if not chosen:
            return ([], doc) if return_noisy else []

        # Build noisy doc by applying edits right-to-left (left positions stay valid).
        chosen.sort(key=lambda e: e["pos"], reverse=True)
        noisy = doc
        for edit in chosen:
            pos, kind, payload, meta = edit["pos"], edit["kind"], edit["payload"], edit["meta"]
            if kind in ("homophone", "punct"):
                noisy = noisy[:pos] + payload + noisy[pos + 1:]
            elif kind == "dup":
                noisy = noisy[:pos] + payload + noisy[pos:]
            elif kind == "missing":
                noisy = noisy[:pos] + noisy[pos + 1:]
            elif kind == "filler":
                noisy = noisy[:pos] + payload + noisy[pos:]
            elif kind == "omit":
                phrase = _after_colon(meta)
                noisy = noisy[:pos] + noisy[pos + len(phrase):]
            elif kind == "bullet":
                noisy = noisy[:pos] + noisy[pos + 2:]

        # Compute each edit's position in the *noisy* doc and its repair atom.
        chosen.sort(key=lambda e: e["pos"])
        left_delta = 0
        samples: List[Dict] = []
        for edit in chosen:
            pos, kind, payload, meta = edit["pos"], edit["kind"], edit["payload"], edit["meta"]
            noisy_pos = pos + left_delta
            atom: Optional[Dict] = None
            delta = 0

            if kind == "homophone" or kind == "punct":
                clean_char = doc[pos]
                atom = make_atom("FIX_CHAR", pos=noisy_pos, char=clean_char)
                delta = 0
            elif kind == "dup":
                atom = make_atom("DEL_CHAR", pos=noisy_pos)
                delta = 1
            elif kind == "missing":
                char = _after_colon(meta)
                atom = make_atom("INS_CHAR", pos=noisy_pos, char=char)
                delta = -1
            elif kind == "filler":
                atom = make_atom("DEL_SPAN", start=noisy_pos, end=noisy_pos + len(payload))
                delta = len(payload)
            elif kind == "omit":
                phrase = _after_colon(meta)
                atom = make_atom("INS_SPAN_COPY", pos=noisy_pos, payload=phrase)
                delta = -len(phrase)
            elif kind == "bullet":
                atom = make_atom("FMT_BULLET", line_start=noisy_pos, action="add")
                delta = -2

            if atom is not None:
                repaired = apply_atom(noisy, atom)
                if repaired is None:
                    raise AssertionError(f"ill-typed fix atom: {atom}")
                samples.append(self._window(noisy, atom, noisy_pos))
            left_delta += delta

        # Verify multi-edit consistency (descending application must return clean).
        if samples:
            test = noisy
            for atom in sorted((s["atom"] for s in samples), key=lambda a: self._atom_key(a), reverse=True):
                test = apply_atom(test, atom)
                if test is None:
                    raise AssertionError("multi-edit repair failed")
            if test != doc:
                raise AssertionError("synthesised repairs do not reconstruct the clean doc")

        # NO_EDIT samples: near misses + random clean positions.
        noisy_spans = []
        for sample in samples:
            span = self._span_of(sample["atom"])
            if span is not None:
                noisy_spans.append(span)
        samples.extend(self._no_edit_samples(noisy, noisy_spans, len(chosen)))
        return (samples, noisy) if return_noisy else samples

    @staticmethod
    def _span_of(atom: Dict) -> Optional[Tuple[int, int]]:
        kind = atom["type"]
        if kind == "DEL_SPAN":
            return atom["start"], atom["end"]
        if kind in ("FIX_CHAR", "DEL_CHAR"):
            return atom["pos"], atom["pos"] + 1
        if kind in ("INS_CHAR", "INS_SPAN_COPY"):
            return atom["pos"], atom["pos"]
        if kind == "FMT_BULLET":
            return atom["line_start"], atom["line_start"]
        return None

    @staticmethod
    def _atom_key(atom: Dict) -> int:
        if atom["type"] in ("FIX_CHAR", "DEL_CHAR", "INS_CHAR"):
            return atom["pos"]
        if atom["type"] == "DEL_SPAN":
            return atom["start"]
        if atom["type"] == "INS_SPAN_COPY":
            return atom["pos"]
        if atom["type"] == "FMT_BULLET":
            return atom["line_start"]
        return 0

    def _window(self, noisy: str, atom: Dict, pos: int) -> Dict:
        span_start, span_end = pos, pos + 1
        if atom["type"] == "DEL_SPAN":
            span_start, span_end = atom["start"], atom["end"]
        elif atom["type"] == "INS_CHAR":
            span_start, span_end = atom["pos"], atom["pos"]
        elif atom["type"] == "INS_SPAN_COPY":
            span_start, span_end = atom["pos"], atom["pos"]
        elif atom["type"] == "FMT_BULLET":
            span_start = span_end = atom["line_start"]

        left = noisy[max(0, span_start - LEFT_WINDOW):span_start]
        span = noisy[span_start:span_end]
        right = noisy[span_end:span_end + RIGHT_WINDOW]
        return {
            "left": left,
            "span": span,
            "right": right,
            "atom": atom,
            "label": CLASS_TO_ID[atom["type"]],
            "kind": "edit",
        }

    def _geometry_window(self, noisy: str, pos: int, span_len: int) -> Dict:
        """A NO_EDIT window with a specific span geometry (kills geometry leakage)."""
        left = noisy[max(0, pos - LEFT_WINDOW):pos]
        span = noisy[pos:pos + span_len]
        right = noisy[pos + span_len:pos + span_len + RIGHT_WINDOW]
        return {
            "left": left,
            "span": span,
            "right": right,
            "atom": make_atom("NO_EDIT"),
            "label": CLASS_TO_ID["NO_EDIT"],
            "kind": "no_edit",
        }

    def _no_edit_samples(self, noisy: str, edit_spans: List[Tuple[int, int]], n_edits: int) -> List[Dict]:
        out: List[Dict] = []
        if len(noisy) < LEFT_WINDOW + RIGHT_WINDOW + 8:
            return out

        def near_miss() -> Optional[int]:
            if not edit_spans:
                return None
            start, end = self.rng.choice(edit_spans)
            width = max(end - start, 1)
            offset = self.rng.choice([
                -(width + 1), -(width + 2), -(width + 3),
                width + 1, width + 2, width + 3,
            ])
            pos = start + offset
            if LEFT_WINDOW <= pos <= len(noisy) - RIGHT_WINDOW:
                return pos
            return None

        def clear(pos: int) -> bool:
            return all(not (s - 2 <= pos <= e + 2) for s, e in edit_spans)

        n_near = min(n_edits + 1, 3)
        for _ in range(n_near):
            pos = near_miss()
            if pos is not None:
                out.append(self._window(noisy, make_atom("NO_EDIT"), pos))

        n_random = self.rng.choices([2, 3, 4], weights=[0.4, 0.4, 0.2])[0]
        for _ in range(n_random):
            pos = self.rng.randint(LEFT_WINDOW, len(noisy) - RIGHT_WINDOW - 1)
            if not clear(pos):
                continue
            out.append(self._window(noisy, make_atom("NO_EDIT"), pos))

        # Geometry-matched negatives: empty-span and multi-char-span windows at
        # clean positions. Without these, span length alone predicts the label
        # (every empty/multi-char span in the data was an edit), which breaks
        # candidate-sweep localisation at inference time.
        for _ in range(2):
            pos = self.rng.randint(LEFT_WINDOW, len(noisy) - RIGHT_WINDOW - 1)
            if not clear(pos):
                continue
            out.append(self._geometry_window(noisy, pos, span_len=0))
        for _ in range(2):
            width = self.rng.choice([2, 3, 4])
            if len(noisy) < LEFT_WINDOW + RIGHT_WINDOW + width + 8:
                continue
            pos = self.rng.randint(LEFT_WINDOW, len(noisy) - RIGHT_WINDOW - width - 1)
            if not clear(pos):
                continue
            out.append(self._geometry_window(noisy, pos, span_len=width))
        return out


def make_bullet_doc(rng: random.Random, doc: str) -> str:
    sentences = [s.strip() for s in doc.replace("\n", "。").split("。") if len(s.strip()) >= 12]
    if len(sentences) < 4:
        return doc
    picked = sentences[:4]
    return "\n".join("- " + s for s in picked)


def build_samples(corpus: List[str], out_dir: Path, n_docs: int, seed: int,
                  passes: int = 6, bullet_ratio: float = 0.35,
                  max_train_samples: int = 200_000) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    synthesizer = Synthesizer(corpus, seed=seed)
    rng = random.Random(seed + 1)
    bullet_rng = random.Random(seed + 2)

    docs = [d for d in corpus if len(d) >= 60]
    rng.shuffle(docs)
    docs = docs[:n_docs]

    n_holdout = max(8, int(len(docs) * 0.06))
    train_docs = docs[: len(docs) - 2 * n_holdout]
    val_docs = docs[len(docs) - 2 * n_holdout: len(docs) - n_holdout]
    test_docs = docs[len(docs) - n_holdout:]

    def augment(doc_pool: List[str], n_passes: int) -> Tuple[List[Dict], int]:
        out: List[Dict] = []
        rejected = 0
        for doc in doc_pool:
            if bullet_rng.random() < bullet_ratio:
                doc = make_bullet_doc(bullet_rng, doc)
            for _ in range(n_passes):
                try:
                    out.extend(synthesizer.make_doc_samples(doc))
                except AssertionError:
                    rejected += 1
        return out, rejected

    train_samples, r_train = augment(train_docs, passes)
    val_samples, r_val = augment(val_docs, 1)
    test_samples, r_test = augment(test_docs, 1)

    # Cap NO_EDIT in the training split (deployment-style class balance).
    def cap_no_edit(rows: List[Dict], target_ratio: float) -> List[Dict]:
        edits = [r for r in rows if r["label"] != 0]
        no_edits = [r for r in rows if r["label"] == 0]
        keep = int(len(edits) * target_ratio / max(1e-9, 1 - target_ratio))
        if keep < len(no_edits):
            rng.shuffle(no_edits)
            no_edits = no_edits[:keep]
        return edits + no_edits

    train_samples = cap_no_edit(train_samples, 0.45)
    if len(train_samples) > max_train_samples:
        rng.shuffle(train_samples)
        train_samples = train_samples[:max_train_samples]
        print(f"[synth] train capped to {max_train_samples} samples", flush=True)

    print(
        f"[synth] docs={len(docs)} (train {len(train_docs)}x{passes}, val {len(val_docs)}, test {len(test_docs)}); "
        f"rejected passes: train={r_train} val={r_val} test={r_test}",
        flush=True,
    )

    splits = {"train": train_samples, "val": val_samples, "test": test_samples}
    for name, rows in splits.items():
        rng.shuffle(rows)
        path = out_dir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for i, row in enumerate(rows):
                row = dict(row)
                row["id"] = f"{name}-{i:07d}"
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        class_counts = Counter(r["label"] for r in rows)
        print(f"[synth] {name}: {len(rows)} samples, classes={dict(class_counts)}", flush=True)

    return out_dir


def load_samples(path: Path) -> List[Dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            rows.append(json.loads(line))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docs", type=int, default=8000)
    parser.add_argument("--passes", type=int, default=6)
    parser.add_argument("--seed", type=int, default=20261006)
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    from corpus import load_corpus
    corpus = load_corpus()
    build_samples(corpus, SAMPLES_DIR, args.docs, args.seed, passes=args.passes)


if __name__ == "__main__":
    main()
