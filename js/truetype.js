/*
 * KittenNote
 * Copyright (C) 2026 Author of KittenNote
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * KittenNote - minimal TrueType parser
 *
 * Reads exactly what the PDF writer needs to embed a TrueType font as a
 * CIDFontType2 / Identity-H font with working ToUnicode extraction:
 *   head, maxp, hhea, hmtx, cmap (format 4 + 12), OS/2, post.
 *
 * DOM-free and unit-tested against the bundled OFL subset font.
 */

export class TrueTypeFont {
    constructor(bytes, tables, metrics) {
        this.bytes = bytes;
        this.tables = tables;
        this.unitsPerEm = metrics.unitsPerEm;
        this.numGlyphs = metrics.numGlyphs;
        this.ascender = metrics.ascender;       // font units
        this.descender = metrics.descender;     // font units (negative)
        this.lineGap = metrics.lineGap;
        this.capHeight = metrics.capHeight;
        this.bbox = metrics.bbox;               // [xMin, yMin, xMax, yMax]
        this.italicAngle = metrics.italicAngle;
        this._cmap = metrics.cmap;              // Map<codepoint, gid>
        this._advances = metrics.advances;      // { numberOfHMetrics, offset }
    }

    static parse(arrayBuffer) {
        const bytes = arrayBuffer instanceof Uint8Array
            ? arrayBuffer
            : new Uint8Array(arrayBuffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        if (view.getUint32(0) !== 0x00010000) {
            throw new Error('Not a TrueType font (glyf outlines required)');
        }

        const tables = {};
        const numTables = view.getUint16(4);
        for (let i = 0; i < numTables; i++) {
            const o = 12 + i * 16;
            const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
            tables[tag] = {
                offset: view.getUint32(o + 8),
                length: view.getUint32(o + 12)
            };
        }

        for (const required of ['head', 'maxp', 'hhea', 'hmtx', 'cmap']) {
            if (!tables[required]) throw new Error(`Missing TrueType table: ${required}`);
        }

        const head = tables.head.offset;
        const unitsPerEm = view.getUint16(head + 18);
        const bbox = [
            view.getInt16(head + 36),
            view.getInt16(head + 38),
            view.getInt16(head + 40),
            view.getInt16(head + 42)
        ];

        const maxp = tables.maxp.offset;
        const numGlyphs = view.getUint16(maxp + 4);

        const hhea = tables.hhea.offset;
        const ascender = view.getInt16(hhea + 4);
        const descender = view.getInt16(hhea + 6);
        const lineGap = view.getInt16(hhea + 8);
        const numberOfHMetrics = view.getUint16(hhea + 34);

        let capHeight = Math.round(ascender * 0.72);
        if (tables['OS/2'] && tables['OS/2'].length >= 90) {
            const os2 = tables['OS/2'].offset;
            const version = view.getUint16(os2);
            if (version >= 2) {
                const value = view.getInt16(os2 + 88);
                if (value > 0) capHeight = value;
            }
        }

        let italicAngle = 0;
        if (tables.post && tables.post.length >= 8) {
            italicAngle = view.getInt32(tables.post.offset + 4) / 65536;
        }

        const cmap = TrueTypeFont._parseCmap(view, bytes, tables.cmap.offset);

        return new TrueTypeFont(bytes, tables, {
            unitsPerEm,
            numGlyphs,
            ascender,
            descender,
            lineGap,
            capHeight,
            bbox,
            italicAngle,
            cmap,
            advances: { numberOfHMetrics, offset: tables.hmtx.offset }
        });
    }

    static _parseCmap(view, bytes, cmapOffset) {
        const map = new Map();
        const numSubtables = view.getUint16(cmapOffset + 2);

        let best = null; // { offset, format, score }
        for (let i = 0; i < numSubtables; i++) {
            const o = cmapOffset + 4 + i * 8;
            const platformID = view.getUint16(o);
            const encodingID = view.getUint16(o + 2);
            const subOffset = cmapOffset + view.getUint32(o + 4);
            const format = view.getUint16(subOffset);

            let score = 0;
            if (format === 12) {
                if (platformID === 3 && encodingID === 10) score = 100;
                else if (platformID === 0) score = 90;
                else score = 50;
            } else if (format === 4) {
                if (platformID === 3 && encodingID === 1) score = 80;
                else if (platformID === 0) score = 70;
                else score = 40;
            }
            if (score && (!best || score > best.score)) {
                best = { offset: subOffset, format, score };
            }
        }
        if (!best) throw new Error('No usable cmap subtable (need format 4 or 12)');

        if (best.format === 12) {
            const nGroups = view.getUint32(best.offset + 12);
            let p = best.offset + 16;
            for (let g = 0; g < nGroups && p + 12 <= bytes.length; g++, p += 12) {
                const startChar = view.getUint32(p);
                const endChar = view.getUint32(p + 4);
                const startGlyph = view.getUint32(p + 8);
                for (let code = startChar; code <= endChar; code++) {
                    map.set(code, startGlyph + (code - startChar));
                }
            }
        } else {
            const segCount = view.getUint16(best.offset + 6) / 2;
            const endCodesOffset = best.offset + 14;
            const startCodesOffset = endCodesOffset + segCount * 2 + 2;
            const idDeltaOffset = startCodesOffset + segCount * 2;
            const idRangeOffsetOffset = idDeltaOffset + segCount * 2;

            for (let seg = 0; seg < segCount; seg++) {
                const endCode = view.getUint16(endCodesOffset + seg * 2);
                const startCode = view.getUint16(startCodesOffset + seg * 2);
                const idDelta = view.getInt16(idDeltaOffset + seg * 2);
                const idRangeOffset = view.getUint16(idRangeOffsetOffset + seg * 2);
                if (startCode === 0xFFFF) continue;

                for (let code = startCode; code <= endCode && code !== 0xFFFF; code++) {
                    let glyphId;
                    if (idRangeOffset === 0) {
                        glyphId = (code + idDelta) & 0xFFFF;
                    } else {
                        const glyphIndexAddr = idRangeOffsetOffset + seg * 2 + idRangeOffset + (code - startCode) * 2;
                        if (glyphIndexAddr + 2 > bytes.length) continue;
                        glyphId = view.getUint16(glyphIndexAddr);
                        if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xFFFF;
                    }
                    if (glyphId !== 0) map.set(code, glyphId);
                }
            }
        }

        if (map.size === 0) throw new Error('Empty cmap');
        return map;
    }

    /** Glyph id for a character, or 0 when the font does not cover it. */
    gidFor(char) {
        if (typeof char !== 'string' || char.length === 0) return 0;
        const code = char.codePointAt(0);
        return this._cmap.get(code) || 0;
    }

    hasGlyph(char) {
        return this.gidFor(char) !== 0;
    }

    /** Advance width in font units for a glyph id. */
    advanceWidth(gid) {
        const { numberOfHMetrics, offset } = this._advances;
        const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        const index = gid < numberOfHMetrics ? gid : numberOfHMetrics - 1;
        return view.getUint16(offset + index * 4);
    }

    /** Advance width in PDF text-space units (1/1000 em). */
    advanceWidth1000(gid) {
        return Math.round((this.advanceWidth(gid) * 1000) / this.unitsPerEm);
    }

    /** Rendered width of a string at a given font size (in points). */
    textWidth(text, sizePt) {
        let em = 0;
        for (const char of String(text)) {
            const gid = this.gidFor(char);
            if (!gid) continue;
            em += this.advanceWidth(gid);
        }
        return (em * sizePt) / this.unitsPerEm;
    }

    /** True when every character is covered by the font. */
    coversText(text) {
        for (const char of String(text)) {
            if (!this.hasGlyph(char)) return false;
        }
        return true;
    }
}
