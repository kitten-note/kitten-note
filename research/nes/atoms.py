"""
EFT / NES v0 - Typed edit atoms (the "edit algebra").

An atom is a partial injective map on strings. `apply_atom` returns None for
ill-typed applications, which makes the type system enforceable at runtime:
a predictor can only emit atoms that pass `apply_atom`.

Classes (v0, 7-way):
    NO_EDIT         - no change at this position (gate negative)
    FIX_CHAR        - replace one char (typo / punctuation fix)
    DEL_CHAR        - delete one char
    INS_CHAR        - insert one char (e.g. missing punctuation)
    DEL_SPAN        - delete a span of >= 2 chars (trim)
    INS_SPAN_COPY   - insert a span copied from elsewhere in the document
    FMT_BULLET      - add/remove a list marker at a line start
"""
from __future__ import annotations

from typing import Optional, Dict, List

ATOM_CLASSES = [
    "NO_EDIT",
    "FIX_CHAR",
    "DEL_CHAR",
    "INS_CHAR",
    "DEL_SPAN",
    "INS_SPAN_COPY",
    "FMT_BULLET",
]
CLASS_TO_ID = {c: i for i, c in enumerate(ATOM_CLASSES)}
ID_TO_CLASS = {i: c for c, i in CLASS_TO_ID.items()}

# Insert/replace payload whitelist for single characters:
# punctuation + digits + latin letters + fullwidth forms (format/typing fixes).
LITERAL_CHARS = set(
    "，。！？；：、（）《》〈〉【】“”‘’—…·,.!?;:()[]{}<>'\"`-–~/\\|+=*&^%$#@! \n"
    "0123456789"
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "＋－＝＊／％＃＠＆～｜"
)
BULLET_MARKERS = ["- ", "* ", "+ "]


def make_atom(kind: str, **kwargs) -> Dict:
    atom = {"type": kind}
    atom.update(kwargs)
    return atom


def apply_atom(text: str, atom: Dict) -> Optional[str]:
    """Apply an atom; return the new text or None when ill-typed."""
    if not isinstance(text, str):
        return None
    kind = atom.get("type")
    if kind == "NO_EDIT":
        return text

    if kind == "FIX_CHAR":
        pos, char = atom.get("pos"), atom.get("char", "")
        if not isinstance(pos, int) or len(char) != 1:
            return None
        if not (0 <= pos < len(text)) or text[pos] == char:
            return None
        return text[:pos] + char + text[pos + 1:]

    if kind == "DEL_CHAR":
        pos = atom.get("pos")
        if not isinstance(pos, int) or not (0 <= pos < len(text)):
            return None
        return text[:pos] + text[pos + 1:]

    if kind == "INS_CHAR":
        pos, char = atom.get("pos"), atom.get("char", "")
        if not isinstance(pos, int) or len(char) != 1:
            return None
        if not (0 <= pos <= len(text)):
            return None
        if char not in LITERAL_CHARS:
            return None
        return text[:pos] + char + text[pos:]

    if kind == "DEL_SPAN":
        start, end = atom.get("start"), atom.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            return None
        if not (0 <= start < end <= len(text)) or (end - start) < 2:
            return None
        return text[:start] + text[end:]

    if kind == "INS_SPAN_COPY":
        pos, payload = atom.get("pos"), atom.get("payload", "")
        if not isinstance(pos, int) or not (0 <= pos <= len(text)) or not payload:
            return None
        if payload not in text:
            return None  # grounding: payload must be a substring of the text (or corpus)
        return text[:pos] + payload + text[pos:]

    if kind == "FMT_BULLET":
        line_start = atom.get("line_start")
        action = atom.get("action")
        if not isinstance(line_start, int) or not (0 <= line_start <= len(text)):
            return None
        if action == "remove":
            for marker in BULLET_MARKERS:
                if text.startswith(marker, line_start):
                    return text[:line_start] + text[line_start + len(marker):]
            return None
        if action == "add":
            return text[:line_start] + BULLET_MARKERS[0] + text[line_start:]
        return None

    return None


def is_valid_atom(text: str, atom: Dict) -> bool:
    return apply_atom(text, atom) is not None


def atom_class(atom: Dict) -> int:
    return CLASS_TO_ID.get(atom.get("type", "NO_EDIT"), 0)


def expand_span(text: str, pos: int, max_len: int = 24) -> str:
    """Grab a natural span around `pos` for DEL_SPAN proposals (whitespace-stopped)."""
    if not (0 <= pos < len(text)):
        return ""
    start = pos
    while start > 0 and text[start - 1] not in " \n\t，。！？；：、（）":
        start -= 1
        if pos - start > max_len:
            break
    end = pos
    while end < len(text) and text[end] not in " \n\t，。！？；：、（）":
        end += 1
        if end - pos > max_len:
            break
    return text[start:end]


def diff_to_atoms(old: str, new: str, max_ops: int = 12) -> List[Dict]:
    """
    Convert a string edit into typed atoms (best-effort; used for future
    edit-stream corpora such as wiki revisions, not needed by synthesis).
    """
    import difflib

    if old == new:
        return []
    atoms: List[Dict] = []
    matcher = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if len(atoms) >= max_ops:
            break
        seg_old, seg_new = old[i1:i2], new[j1:j2]
        if tag == "delete":
            if len(seg_old) == 1:
                atoms.append(make_atom("DEL_CHAR", pos=i1))
            else:
                atoms.append(make_atom("DEL_SPAN", start=i1, end=i2))
        elif tag == "insert":
            if len(seg_new) == 1 and seg_new in LITERAL_CHARS:
                atoms.append(make_atom("INS_CHAR", pos=i1, char=seg_new))
            elif seg_new and seg_new in new:
                atoms.append(make_atom("INS_SPAN_COPY", pos=i1, payload=seg_new))
        elif tag == "replace":
            if len(seg_old) == 1 and len(seg_new) == 1:
                atoms.append(make_atom("FIX_CHAR", pos=i1, char=seg_new))
            else:
                if len(seg_old) >= 2:
                    atoms.append(make_atom("DEL_SPAN", start=i1, end=i2))
                if seg_new:
                    atoms.append(make_atom("INS_SPAN_COPY", pos=i1, payload=seg_new))
    return atoms
