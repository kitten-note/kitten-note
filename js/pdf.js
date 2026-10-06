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
 * Generates real .pdf files (no print dialog) without any dependency.
 * Pages embed JPEG images (DCTDecode XObjects), which keeps CJK text and
 * ink strokes pixel-perfect without bundling a multi-megabyte CJK font.
 *
 * The core (`PdfBuilder`) is DOM-free and unit-tested in Node; the canvas
 * helpers are browser-only conveniences.
 */

export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

function encodeAscii(text) {
    return new TextEncoder().encode(text);
}

function round2(value) {
    return Math.round(value * 100) / 100;
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

export class PdfBuilder {
    /**
     * @param {object} [options]
     * @param {number} [options.marginPt=0] - uniform margin used when fitting images
     */
    constructor(options = {}) {
        this.marginPt = options.marginPt || 0;
        this._pages = [];
    }

    get pageCount() {
        return this._pages.length;
    }

    /**
     * Add a page displaying a JPEG image.
     *
     * @param {object} page
     * @param {Uint8Array} page.jpegBytes  - full JPEG file bytes
     * @param {number} page.pixelWidth     - JPEG pixel width (not points)
     * @param {number} page.pixelHeight    - JPEG pixel height (not points)
     * @param {number} [page.marginPt]     - override the builder margin
     * @returns {number} page index
     */
    addImagePage({ jpegBytes, pixelWidth, pixelHeight, marginPt }) {
        if (!(jpegBytes instanceof Uint8Array) || jpegBytes.byteLength === 0) {
            throw new Error('addImagePage requires non-empty JPEG bytes');
        }
        if (!pixelWidth || !pixelHeight) {
            throw new Error('addImagePage requires pixel dimensions');
        }

        const margin = marginPt !== undefined ? marginPt : this.marginPt;
        const availW = A4_WIDTH_PT - margin * 2;
        const availH = A4_HEIGHT_PT - margin * 2;
        const scale = Math.min(availW / pixelWidth, availH / pixelHeight);
        const drawW = pixelWidth * scale;
        const drawH = pixelHeight * scale;

        this._pages.push({
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
     * Serialize the document. Object layout:
     *   1 Catalog · 2 Pages · per page: Page/Contents/Image XObject
     */
    build() {
        if (this._pages.length === 0) {
            throw new Error('Cannot build a PDF without pages');
        }

        const chunks = [];
        let offset = 0;
        const pushBytes = (bytes) => {
            chunks.push(bytes);
            offset += bytes.byteLength;
        };
        const pushText = (text) => pushBytes(encodeAscii(text));

        // %PDF header + binary comment so it survives byte-order detection
        pushBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A])); // %PDF-1.4\n
        pushBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

        const totalObjects = 2 + this._pages.length * 3;
        const offsets = new Array(totalObjects + 1).fill(0);

        // 1: Catalog
        offsets[1] = offset;
        pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

        // 2: Pages
        offsets[2] = offset;
        const kids = this._pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
        pushText(`2 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${this._pages.length} >>\nendobj\n`);

        // Per-page objects
        this._pages.forEach((page, index) => {
            const pageObj = 3 + index * 3;
            const contentObj = pageObj + 1;
            const imageObj = pageObj + 2;

            const pageW = round2(A4_WIDTH_PT);
            const pageH = round2(A4_HEIGHT_PT);
            const drawW = round2(page.drawWidthPt);
            const drawH = round2(page.drawHeightPt);
            const offX = round2(page.offsetX);
            const offY = round2(page.offsetY);

            offsets[pageObj] = offset;
            pushText(
                `${pageObj} 0 obj\n` +
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
                `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> ` +
                `/Contents ${contentObj} 0 R >>\nendobj\n`
            );

            const content = (
                'q\n' +
                `1 1 1 rg\n0 0 ${pageW} ${pageH} re f\n` +  // opaque white page
                `q\n${drawW} 0 0 ${drawH} ${offX} ${offY} cm\n/Im0 Do\nQ\n` +
                'Q\n'
            );
            offsets[contentObj] = offset;
            pushText(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

            offsets[imageObj] = offset;
            pushText(
                `${imageObj} 0 obj\n` +
                `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
                `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\n` +
                'stream\n'
            );
            pushBytes(page.jpegBytes);
            pushText('\nendstream\nendobj\n');
        });

        // Cross-reference table + trailer
        const xrefOffset = offset;
        let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
        for (let i = 1; i <= totalObjects; i++) {
            xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        }
        xref += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
        pushText(xref);

        return concatBytes(chunks);
    }
}

/**
 * Browser helper: canvas → JPEG bytes (quality 0..1).
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

/**
 * Browser helper: render canvases into a downloadable PDF Blob.
 *
 * @param {HTMLCanvasElement[]} canvases
 * @param {object} [options]
 * @param {number} [options.marginPt=0] - margin used to fit images on the A4 page
 * @param {number} [options.quality=0.92] - JPEG quality
 * @returns {Promise<Blob>}
 */
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
    const bytes = builder.build();
    return new Blob([bytes], { type: 'application/pdf' });
}
