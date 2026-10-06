#!/usr/bin/env python3
"""Build the OFL-licensed PDF text font used by KittenNote.

Takes the variable Noto Sans SC font, pins weight 400 and subsets it to a
practical PDF charset:

  * ASCII + Latin-1
  * General punctuation / CJK punctuation / fullwidth forms
  * arrows (U+2190–21FF) and mathematical operators (U+2200–22FF)
  * every character encodable in GB2312 (covers ~6,763 common hanzi)
  * a small curated extra set (physics/chemistry helpers)

The result is committed to assets/fonts/ so the app stays offline-first.
Regenerate with:

    py tools/build-font-subset.py <NotoSansSC[wght].ttf> assets/fonts/NotoSansSC-Regular-subset.ttf

Noto Sans SC is licensed under the SIL Open Font License 1.1 (see
assets/fonts/OFL.txt). This script itself is GPL-3.0 like the rest of
KittenNote.
"""

import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def ranges(*pairs):
    for start, end in pairs:
        for code in range(start, end + 1):
            yield chr(code)


def gb2312_chars():
    """All hanzi that GB2312 can encode (the pragmatic common set)."""
    chars = []
    for code in range(0x4E00, 0xA000):
        ch = chr(code)
        try:
            ch.encode("gb2312")
        except UnicodeEncodeError:
            continue
        chars.append(ch)
    return chars


def build_charset():
    chars = set()
    # Latin basics
    chars.update(ranges((0x20, 0x7E), (0xA0, 0xFF)))
    # Punctuation & fullwidth
    chars.update(ranges((0x2000, 0x206F), (0x3000, 0x303F), (0xFF00, 0xFFEF)))
    # Arrows & math operators (for \ce{} style plain text as well)
    chars.update(ranges((0x2190, 0x21FF), (0x2200, 0x22FF)))
    # Curated extras: long arrows, equilibrium, accents, units
    chars.update("⟶⟵⇌⇀↼ℏℓ℮℃℉№™©®±×÷≈≠≤≥∞∑∏√∂∇′″°Ωµ")
    chars.update(gb2312_chars())
    return "".join(sorted(chars))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]

    text = build_charset()
    print(f"charset: {len(text)} characters")

    font = TTFont(src)
    print(f"source: {font['maxp'].numGlyphs} glyphs, upem {font['head'].unitsPerEm}")

    # Pin the variable axis so the subset is a static Regular.
    instantiateVariableFont(font, {"wght": 400}, inplace=True, updateFontNames=True)

    options = subset.Options()
    options.layout_features = []  # plain glyph placement only – no shaping needed
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["GSUB", "GPOS", "GDEF", "vhea", "vmtx", "VORG", "gasp"]
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font.save(out)

    import os
    print(f"output: {out} ({os.path.getsize(out) / 1024 / 1024:.2f} MiB, {font['maxp'].numGlyphs} glyphs)")


if __name__ == "__main__":
    main()
