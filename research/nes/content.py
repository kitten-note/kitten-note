"""
EFT / NES v0 - Grounding content layer.

Copy-only payloads: any inserted/replaced span must be a substring of the
document or of the user corpus (zero hallucination by construction). v0 uses
a fast "longest-match over the corpus string" (infini-gram-lite):

    query  = rightmost k characters before the cursor (k = 8..2)
    answer = next characters observed after that context in the corpus,
             with occurrence counts.

The paper version will replace this with a suffix automaton / suffix array;
the interface (propose_next / can_ground / propose_span) stays the same.
"""
from __future__ import annotations

from collections import Counter
from typing import Dict, List, Optional, Tuple


class ContentIndex:
    def __init__(self, corpus_text: str, max_hits: int = 64):
        self.text = corpus_text
        self.max_hits = max_hits
        self._next_cache: Dict[str, Counter] = {}
        self._span_cache: Dict[str, bool] = {}
        self._occurrences_cache: Dict[str, int] = {}

    # ---------------- statistics ----------------

    def _count_occurrences(self, needle: str, cap: int = 200) -> int:
        cached = self._occurrences_cache.get(needle)
        if cached is not None:
            return cached
        count, start = 0, 0
        while count < cap:
            found = self.text.find(needle, start)
            if found < 0:
                break
            count += 1
            start = found + 1
        self._occurrences_cache[needle] = count
        return count

    def _next_char_distribution(self, context: str) -> Counter:
        cached = self._next_cache.get(context)
        if cached is not None:
            return cached

        counter: Counter = Counter()
        start = 0
        hits = 0
        while hits < self.max_hits:
            found = self.text.find(context, start)
            if found < 0:
                break
            after = found + len(context)
            if after < len(self.text):
                counter[self.text[after]] += 1
            hits += 1
            start = found + 1
        self._next_cache[context] = counter
        return counter

    # ---------------- public API ----------------

    def longest_match_stats(self, context: str, k_min: int = 2, k_max: int = 10) -> Tuple[int, str, Counter]:
        """Longest suffix of `context` that occurs in the corpus, with next-char counts."""
        for k in range(min(k_max, len(context)), k_min - 1, -1):
            needle = context[-k:]
            distribution = self._next_char_distribution(needle)
            if distribution:
                return k, needle, distribution
        return 0, "", Counter()

    def propose_next(self, context: str, top: int = 5) -> List[Tuple[str, int]]:
        """Top next-character continuations aggregated over the longest match."""
        k, _needle, distribution = self.longest_match_stats(context)
        if k == 0:
            return []
        return distribution.most_common(top)

    def can_ground(self, payload: str, document: str = "") -> str:
        """Where can a payload be grounded: 'doc', 'corpus', or 'none'."""
        if not payload:
            return "none"
        if document and payload in document:
            return "doc"
        allowed = self._span_cache.get(payload)
        if allowed is None:
            allowed = self._count_occurrences(payload, cap=5) > 0
            self._span_cache[payload] = allowed
        return "corpus" if allowed else "none"

    def propose_span(self, context: str, max_len: int = 8, top: int = 3) -> List[str]:
        """Grounded span proposals: corpus continuations of length 2..max_len."""
        k, needle, distribution = self.longest_match_stats(context)
        if k == 0:
            return []
        proposals: List[str] = []
        for char, _count in distribution.most_common(6):
            if char.isspace():
                continue
            found = self.text.find(needle + char)
            if found < 0:
                continue
            start = found + len(needle)
            end = start
            while end < len(self.text) and end - start < max_len and not self.text[end].isspace():
                end += 1
            span = self.text[start:end]
            if len(span) >= 2 and span not in proposals:
                proposals.append(span)
            if len(proposals) >= top:
                break
        return proposals


def build_index_from_lines(lines: List[str], max_chars: int = 24_000_000) -> ContentIndex:
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = text[:max_chars]
    return ContentIndex(text)
