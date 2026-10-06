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
 * KittenNote - minimal PDF writer
 *
 * Generates real .pdf files without any dependency:
 *   • text pages   – embedded TrueType font (CIDFontType2 / Identity-H) plus a
 *                    ToUnicode CMap, so text is selectable, searchable and
 *                    copyable in every viewer
 *   • image pages  – JPEG (DCTDecode) full-page XObjects for ink notes and
 *                    for the raster fallback when the font subset lacks a char
 *   • inline RGB images (FlateDecode) for rendered formulas
 *
 * Object numbering is pre-allocated and serialized in one deterministic pass.
 * The core is DOM-free (canvas helpers live at the bottom) and unit-tested.
 */

export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

const textEncoder = new TextEncoder();

function encodeAscii(text) {
    return textEncoder.encode(text);
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

function num(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? '0' : String(rounded);
}

function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function hex4(value) {
    return value.toString(16).toUpperCase().padStart(4, '0');
}

function utf16BeHex(codePoint) {
    if (codePoint <= 0xffff) return hex4(codePoint);
    const adjusted = codePoint - 0x10000;
    return hex4(0xd800 + (adjusted >> 10)) + hex4(0xdc00 + (adjusted & 0x3ff));
}

function colorToComponents(hex) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!match) return [0, 0, 0];
    const value = parseInt(match[1], 16);
    return [
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255
    ];
}

/** zlib deflate via CompressionStream (browsers, Node ≥ 18). */
async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        return null;
    }
}

function buildToUnicodeCmap(glyphUnicodes) {
    // glyphUnicodes: Map<gid, codePoint>
    const entries = [...glyphUnicodes.entries()].sort((a, b) => a[0] - b[0]);
    const lines = [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange'
    ];
    for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        lines.push(`${chunk.length} beginbfchar`);
        for (const [gid, codePoint] of chunk) {
            lines.push(`<${hex4(gid)}> <${utf16BeHex(codePoint)}>`);
        }
        lines.push('endbfchar');
    }
    lines.push(
        'endcmap',
        'CMapName currentdict /CMap defineresource pop',
        'end',
        'end'
    );
    return lines.join('\n') + '\n';
}

export class PdfBuilder {
    /**
     * @param {object} [options]
     * @param {number} [options.marginPt=0] - margin used when fitting full-page images
     */
    constructor(options = {}) {
        this.marginPt = options.marginPt || 0;
        this._pages = [];
        this._fonts = [];
        this._images = [];
    }

    get pageCount() {
        return this._pages.length;
    }

    /**
     * Register an embedded TrueType font.
     *
     * @param {Uint8Array} ttfBytes
     * @param {{unitsPerEm:number, ascender:number, descender:number, capHeight:number,
     *          bbox:number[], italicAngle:number, gidFor:(c:string)=>number,
     *          advanceWidth1000:(gid:number)=>number}} metrics
     * @returns {number} font reference
     */
    addFont(ttfBytes, metrics) {
        this._fonts.push({ bytes: ttfBytes, metrics });
        return this._fonts.length - 1;
    }

    /**
     * Add a full-page JPEG image page (ink notes / raster fallback).
     */
    addImagePage({ jpegBytes, pixelWidth, pixelHeight, marginPt }) {
        if (!(jpegBytes instanceof Uint8Array) || jpegBytes.byteLength === 0) {
            throw new Error('addImagePage requires non-empty JPEG bytes');
        }
        if (!pixelWidth || !pixelHeight) {
            throw new Error('addImagePage requires pixel dimensions');
        }

        const margin = marginPt !== undefined ? marginPt : this.marginPt;
        const scale = Math.min(
            (A4_WIDTH_PT - margin * 2) / pixelWidth,
            (A4_HEIGHT_PT - margin * 2) / pixelHeight
        );
        const drawW = pixelWidth * scale;
        const drawH = pixelHeight * scale;

        this._pages.push({
            kind: 'image',
            jpegBytes,
            pixelWidth,
            pixelHeight,
            drawWidthPt: drawW,
            drawHeightPt: drawH,
            offsetX: (A4_WIDTH_PT - drawW) / 2,
            offsetY: (A4_HEIGHT_PT - drawH) / 2
        });
        return this._pages.length - 1;
    }

    /**
     * Register an inline RGB image (rendered formulas).
     * @param {{rgb:Uint8Array, width:number, height:number}} image - 3 bytes/pixel, top-down
     * @returns {number} image reference
     */
    addRgbImage({ rgb, width, height }) {
        if (!(rgb instanceof Uint8Array) || rgb.byteLength !== width * height * 3) {
            throw new Error('addRgbImage requires width*height*3 bytes');
        }
        this._images.push({ rgb, width, height });
        return this._images.length - 1;
    }

    /**
     * Add a text/vector page.
     *
     * Ops (top-down coordinates, points):
     *   { type:'text',  text, x, y, size, bold?, italic?, color? }
     *   { type:'rect',  x, y, w, h, color }
     *   { type:'line',  x1, y1, x2, y2, width, color }
     *   { type:'image', ref, x, y, w, h }
     */
    addTextPage({ ops, fontRef = 0 }) {
        if (!Array.isArray(ops) || ops.length === 0) {
            throw new Error('addTextPage requires ops');
        }
        this._pages.push({ kind: 'text', ops, fontRef });
        return this._pages.length - 1;
    }

    /**
     * Serialize the document.
     * @param {{compress?:boolean}} [options]
     * @returns {Promise<Uint8Array>}
     */
    async build(options = {}) {
        if (this._pages.length === 0) {
            throw new Error('Cannot build a PDF without pages');
        }

        const compress = options.compress !== undefined
            ? options.compress
            : typeof CompressionStream !== 'undefined';

        // ---- 1. Collect font usage across all text pages ----
        const fontUsage = this._fonts.map(() => new Map()); // Map<gid, codePoint>
        for (const page of this._pages) {
            if (page.kind !== 'text') continue;
            const metrics = this._fonts[page.fontRef || 0]?.metrics;
            if (!metrics) continue;
            for (const op of page.ops) {
                if (op.type !== 'text') continue;
                for (const char of String(op.text)) {
                    const gid = metrics.gidFor(char);
                    if (gid && !fontUsage[page.fontRef || 0].has(gid)) {
                        fontUsage[page.fontRef || 0].set(gid, char.codePointAt(0));
                    }
                }
            }
        }

        // ---- 2. Pre-allocate object numbers ----
        // 1 Catalog · 2 Pages · fonts (5 each) · inline images (1 each) ·
        // image-page XObjects (1 each) · pages (2 each)
        let next = 3;
        const fontObjs = this._fonts.map(() => {
            const base = next;
            next += 5;
            return {
                font: base,
                descendant: base + 1,
                descriptor: base + 2,
                file: base + 3,
                toUnicode: base + 4
            };
        });
        const inlineImageObjs = this._images.map(() => next++);
        const pageImageObjs = this._pages.map((page) => (page.kind === 'image' ? next++ : 0));
        const pageObjs = this._pages.map(() => {
            const base = next;
            next += 2;
            return { page: base, contents: base + 1 };
        });
        const totalObjects = next - 1;

        // ---- 3. Serialize ----
        const chunks = [];
        let offset = 0;
        const pushBytes = (bytes) => {
            chunks.push(bytes);
            offset += bytes.byteLength;
        };
        const pushText = (text) => pushBytes(encodeAscii(text));
        const offsets = new Array(totalObjects + 1).fill(0);

        pushBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A])); // %PDF-1.4\n
        pushBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

        offsets[1] = offset;
        pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

        offsets[2] = offset;
        const kids = pageObjs.map((o) => `${o.page} 0 R`).join(' ');
        pushText(`2 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${this._pages.length} >>\nendobj\n`);

        // ---- Fonts ----
        for (let i = 0; i < this._fonts.length; i++) {
            const font = this._fonts[i];
            const objs = fontObjs[i];
            const usage = fontUsage[i];
            const m = font.metrics;
            const scaleTo1000 = 1000 / m.unitsPerEm;
            const fontName = `KittenNoteFont${i}`;
            const usedGids = [...usage.keys()].sort((a, b) => a - b);

            offsets[objs.font] = offset;
            pushText(
                `${objs.font} 0 obj\n` +
                `<< /Type /Font /Subtype /Type0 /BaseFont /${fontName} /Encoding /Identity-H ` +
                `/DescendantFonts [ ${objs.descendant} 0 R ] /ToUnicode ${objs.toUnicode} 0 R >>\nendobj\n`
            );

            const widths = usedGids.map((gid) => `${gid} [${m.advanceWidth1000(gid)}]`).join(' ');
            offsets[objs.descendant] = offset;
            pushText(
                `${objs.descendant} 0 obj\n` +
                `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fontName} ` +
                `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
                `/FontDescriptor ${objs.descriptor} 0 R /CIDToGIDMap /Identity /DW 1000 ` +
                `/W [ ${widths} ] >>\nendobj\n`
            );

            const bbox = m.bbox.map((v) => Math.round(v * scaleTo1000)).join(' ');
            offsets[objs.descriptor] = offset;
            pushText(
                `${objs.descriptor} 0 obj\n` +
                `<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 ` +
                `/FontBBox [ ${bbox} ] /ItalicAngle ${num(m.italicAngle || 0)} ` +
                `/Ascent ${Math.round(m.ascender * scaleTo1000)} /Descent ${Math.round(m.descender * scaleTo1000)} ` +
                `/CapHeight ${Math.round((m.capHeight || m.ascender) * scaleTo1000)} /StemV 80 ` +
                `/FontFile2 ${objs.file} 0 R >>\nendobj\n`
            );

            let fileBytes = font.bytes;
            let fileFilter = '';
            if (compress) {
                const compressed = await deflate(font.bytes);
                if (compressed && compressed.byteLength < font.bytes.byteLength) {
                    fileBytes = compressed;
                    fileFilter = ' /Filter /FlateDecode';
                }
            }
            offsets[objs.file] = offset;
            pushText(
                `${objs.file} 0 obj\n` +
                `<< /Length ${fileBytes.byteLength} /Length1 ${font.bytes.byteLength}${fileFilter} >>\nstream\n`
            );
            pushBytes(fileBytes);
            pushText('\nendstream\nendobj\n');

            const cmap = buildToUnicodeCmap(usage);
            offsets[objs.toUnicode] = offset;
            pushText(
                `${objs.toUnicode} 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}endstream\nendobj\n`
            );
        }

        // ---- Inline images ----
        for (let i = 0; i < this._images.length; i++) {
            const image = this._images[i];
            const objNum = inlineImageObjs[i];

            let imageBytes = image.rgb;
            let filter = '';
            if (compress) {
                const compressed = await deflate(image.rgb);
                if (compressed) {
                    imageBytes = compressed;
                    filter = ' /Filter /FlateDecode';
                }
            }

            offsets[objNum] = offset;
            pushText(
                `${objNum} 0 obj\n` +
                `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
                `/ColorSpace /DeviceRGB /BitsPerComponent 8${filter} /Length ${imageBytes.byteLength} >>\nstream\n`
            );
            pushBytes(imageBytes);
            pushText('\nendstream\nendobj\n');
        }

        // ---- Page XObjects (JPEG) ----
        for (let i = 0; i < this._pages.length; i++) {
            const page = this._pages[i];
            if (page.kind !== 'image') continue;
            const objNum = pageImageObjs[i];
            offsets[objNum] = offset;
            pushText(
                `${objNum} 0 obj\n` +
                `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
                `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\nstream\n`
            );
            pushBytes(page.jpegBytes);
            pushText('\nendstream\nendobj\n');
        }

        // ---- Pages ----
        for (let i = 0; i < this._pages.length; i++) {
            const page = this._pages[i];
            const pageObj = pageObjs[i].page;
            const contentObj = pageObjs[i].contents;
            const pageW = round2(A4_WIDTH_PT);
            const pageH = round2(A4_HEIGHT_PT);

            let content;
            let resourceDict;

            if (page.kind === 'image') {
                const imageObj = pageImageObjs[i];
                resourceDict = `/XObject << /Im0 ${imageObj} 0 R >>`;
                content =
                    'q\n' +
                    `1 1 1 rg\n0 0 ${pageW} ${pageH} re f\n` +
                    `q\n${round2(page.drawWidthPt)} 0 0 ${round2(page.drawHeightPt)} ` +
                    `${round2(page.offsetX)} ${round2(page.offsetY)} cm\n/Im0 Do\nQ\n` +
                    'Q\n';
            } else {
                const fontRefs = new Set([page.fontRef || 0]);
                const imageRefs = new Set();
                for (const op of page.ops) {
                    if (op.type === 'image') imageRefs.add(op.ref);
                }
                resourceDict = `/Font << ${[...fontRefs]
                    .map((f) => `/F${f} ${fontObjs[f].font} 0 R`)
                    .join(' ')} >>`;
                const xobjectDict = [...imageRefs]
                    .map((r) => `/Im${r} ${inlineImageObjs[r]} 0 R`)
                    .join(' ');
                if (xobjectDict) resourceDict += ` /XObject << ${xobjectDict} >>`;

                const metrics = this._fonts[page.fontRef || 0]?.metrics;
                content = buildTextPageContent(page, metrics, pageH);
            }

            offsets[pageObj] = offset;
            pushText(
                `${pageObj} 0 obj\n` +
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
                `/Resources << ${resourceDict} >> /Contents ${contentObj} 0 R >>\nendobj\n`
            );

            offsets[contentObj] = offset;
            pushText(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
        }

        // ---- Cross-reference table + trailer ----
        const xrefOffset = offset;
        let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
        for (let i = 1; i <= totalObjects; i++) {
            xref += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
        }
        xref += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
        pushText(xref);

        return concatBytes(chunks);
    }
}

/** Emit the content stream for a text page (ops are top-down, PDF is bottom-up). */
function buildTextPageContent(page, metrics, pageH) {
    const out = [];
    const fontRef = page.fontRef || 0;

    for (const op of page.ops) {
        if (op.type === 'rect') {
            const [r, g, b] = colorToComponents(op.color);
            out.push(
                `q\n${num(r)} ${num(g)} ${num(b)} rg\n` +
                `${round2(op.x)} ${round2(pageH - op.y - op.h)} ${round2(op.w)} ${round2(op.h)} re f\nQ`
            );
        } else if (op.type === 'line') {
            const [r, g, b] = colorToComponents(op.color);
            out.push(
                `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(op.width || 1)} w\n` +
                `${round2(op.x1)} ${round2(pageH - op.y1)} m ${round2(op.x2)} ${round2(pageH - op.y2)} l S\nQ`
            );
        } else if (op.type === 'text') {
            const line = emitTextOp(op, metrics, fontRef, pageH);
            if (line) out.push(line);
        } else if (op.type === 'image') {
            out.push(
                `q\n${round2(op.w)} 0 0 ${round2(op.h)} ${round2(op.x)} ${round2(pageH - op.y - op.h)} cm\n/Im${op.ref} Do\nQ`
            );
        }
    }

    return out.length ? out.join('\n') + '\n' : '';
}

function emitTextOp(op, metrics, fontRef, pageH) {
    if (!metrics) return '';
    const glyphs = [];
    for (const char of String(op.text)) {
        const gid = metrics.gidFor(char);
        if (gid) glyphs.push(hex4(gid));
    }
    if (glyphs.length === 0) return '';

    const [r, g, b] = colorToComponents(op.color || '#000000');
    const color = `${num(r)} ${num(g)} ${num(b)}`;
    const skew = op.italic ? 0.2126 : 0;

    const parts = ['BT', `/F${fontRef} ${num(op.size)} Tf`, `${color} rg`];
    if (op.bold) {
        parts.push(`${color} RG`, `${num(op.size * 0.03)} w`, '2 Tr');
    } else {
        parts.push('0 Tr');
    }
    parts.push(
        `${skew ? `1 0 ${num(skew)} 1` : '1 0 0 1'} ${round2(op.x)} ${round2(pageH - op.y)} Tm`,
        `<${glyphs.join('')}> Tj`,
        'ET'
    );
    return parts.join('\n');
}

/**
 * Browser helpers
 */

export async function canvasToJpegBytes(canvas, quality = 0.92) {
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob failed'))),
            'image/jpeg',
            quality
        );
    });
    return new Uint8Array(await blob.arrayBuffer());
}

export async function buildPdfFromCanvases(canvases, options = {}) {
    const builder = new PdfBuilder({ marginPt: options.marginPt || 0 });
    for (const canvas of canvases) {
        const jpegBytes = await canvasToJpegBytes(canvas, options.quality || 0.92);
        builder.addImagePage({
            jpegBytes,
            pixelWidth: canvas.width,
            pixelHeight: canvas.height
        });
    }
    const bytes = await builder.build();
    return new Blob([bytes], { type: 'application/pdf' });
}
