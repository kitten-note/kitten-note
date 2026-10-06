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
 * KittenNote - vector text layout for PDF
 *
 * Pure computation (no DOM, no canvas): lays a Markdown note out into A4
 * pages of drawing ops using the embedded TrueType metrics, so the exported
 * PDF keeps selectable text. When the font subset cannot cover every
 * character the function returns null and the caller falls back to the
 * raster renderer (js/pdf-text.js).
 */

import { parseInline, parseBlocks } from './pdf-text.js';

export const LAYOUT_PAGE = { widthPt: 595.28, heightPt: 841.89 };

const MARGIN = 52;
const CONTENT_W = LAYOUT_PAGE.widthPt - MARGIN * 2;
const FOOTER_ZONE = 30;

const COLORS = {
    text: '#24292f',
    quote: '#57606a',
    code: '#24292f',
    codeBg: '#f0f1f3',
    rule: '#d8dee4',
    meta: '#8a8f98',
    footer: '#8a8f98'
};

const TITLE_SIZE = 22;
const HEADING_SIZES = [20, 17, 15, 14, 13, 12];
const BODY_SIZE = 12.5;
const BODY_LINE = 22;
const META_SIZE = 10.5;
const META_LINE = 16;
const FOOTER_SIZE = 10.5;

/**
 * @param {{title?:string, content?:string, updatedAt?:string}} note
 * @param {{hasGlyph:(c:string)=>boolean, gidFor:(c:string)=>number,
 *          advanceWidth1000:(gid:number)=>number, textWidth:(t:string,s:number)=>number}} font
 * @returns {{pages: Array<{ops: Array}>} | null} null when font coverage is incomplete
 */
export function renderTextNoteToPages(note, font) {
    const covered = (value) => {
        for (const char of String(value || '')) {
            if (/\s/.test(char)) continue;
            if (!font.hasGlyph(char)) return false;
        }
        return true;
    };
    if (!covered(note?.title) || !covered(note?.content)) {
        return null;
    }

    const pages = [];
    let ops = null;
    let y = 0;

    const bottom = LAYOUT_PAGE.heightPt - MARGIN - FOOTER_ZONE;
    const newPage = () => {
        ops = [];
        pages.push({ ops });
        y = MARGIN;
    };
    const ensure = (height) => {
        if (y + height > bottom) newPage();
    };
    const measure = (text, size) => font.textWidth(text, size);
    newPage();

    const addText = (text, x, baseline, size, style = {}) => {
        if (!text) return;
        ops.push({
            type: 'text',
            text,
            x,
            y: baseline,
            size,
            bold: !!style.bold,
            italic: !!style.italic,
            color: style.color || COLORS.text
        });
    };
    const addRect = (x, top, w, h, color) => {
        ops.push({ type: 'rect', x, y: top, w, h, color });
    };
    const addLine = (x1, top1, x2, top2, width, color) => {
        ops.push({ type: 'line', x1, y1: top1, x2, y2: top2, width, color });
    };

    const wrapRuns = (runs, maxWidth, size) => {
        const atoms = [];
        for (const run of runs) {
            for (const char of Array.from(run.text)) {
                atoms.push({ char, run, width: measure(char, size) });
            }
        }

        const lines = [];
        let line = [];
        let width = 0;
        let lastSpace = -1;

        const flush = (end) => {
            const head = line.slice(0, end);
            while (head.length && head[head.length - 1].char === ' ') head.pop();
            if (head.length) lines.push(head);
            line = end < line.length ? line.slice(end) : [];
            width = line.reduce((sum, atom) => sum + atom.width, 0);
            lastSpace = -1;
        };

        for (const atom of atoms) {
            if (atom.char === ' ') lastSpace = line.length;
            line.push(atom);
            width += atom.width;
            if (width > maxWidth && line.length > 1) {
                flush(lastSpace > 0 ? lastSpace : line.length - 1);
            }
        }
        if (line.length) {
            while (line.length && line[line.length - 1].char === ' ') line.pop();
            if (line.length) lines.push(line);
        }
        return lines;
    };

    const drawAtoms = (atoms, x, baseline, size, forcedColor = null) => {
        let cursor = x;
        let index = 0;
        while (index < atoms.length) {
            const style = atoms[index].run;
            let end = index;
            let groupWidth = 0;
            while (end < atoms.length && atoms[end].run === style) {
                groupWidth += atoms[end].width;
                end++;
            }

            const text = atoms.slice(index, end).map((atom) => atom.char).join('');
            const color = style.code ? COLORS.code : (forcedColor || COLORS.text);

            if (style.code) {
                addRect(cursor - size * 0.15, baseline - size * 0.72, groupWidth + size * 0.3, size * 1.35, COLORS.codeBg);
            }
            addText(text, cursor, baseline, size, {
                bold: !!style.b,
                italic: !!style.i,
                color
            });
            if (style.u) {
                addLine(cursor, baseline + size * 0.14, cursor + groupWidth, baseline + size * 0.14, Math.max(0.7, size * 0.06), color);
            }
            if (style.s) {
                addLine(cursor, baseline - size * 0.28, cursor + groupWidth, baseline - size * 0.28, Math.max(0.7, size * 0.06), color);
            }

            cursor += groupWidth;
            index = end;
        }
    };

    const layoutRuns = (runs, options = {}) => {
        const {
            size = BODY_SIZE,
            lineHeight = BODY_LINE,
            bold = false,
            color = null,
            indent = 0,
            before = 0,
            after = 0,
            bar = null,
            prefix = null,
            prefixWidth = 0
        } = options;

        y += before;
        const styled = bold ? runs.map((run) => ({ ...run, b: 1 })) : runs;
        const lines = wrapRuns(styled, CONTENT_W - indent - prefixWidth, size);
        const effective = lines.length ? lines : [[]];

        effective.forEach((atoms, lineIndex) => {
            ensure(lineHeight);
            const baseline = y + lineHeight * 0.78;

            if (bar) addRect(MARGIN + 7, y + 1, 3, lineHeight - 2, bar);
            if (lineIndex === 0 && prefix) {
                addText(prefix, MARGIN + indent, baseline, size, { color: color || COLORS.text });
            }
            drawAtoms(atoms, MARGIN + indent + prefixWidth, baseline, size, color);

            y += lineHeight;
        });

        y += after;
    };

    // ---- Header ----
    layoutRuns(parseInline(note?.title || '未命名笔记'), {
        size: TITLE_SIZE,
        lineHeight: TITLE_SIZE * 1.6,
        bold: true,
        before: 4,
        after: 6
    });

    ensure(20);
    addLine(MARGIN, y + 6, MARGIN + CONTENT_W, y + 6, 1, COLORS.rule);
    y += 16;

    if (note?.updatedAt) {
        const date = new Date(note.updatedAt);
        if (!Number.isNaN(date.getTime())) {
            const meta = `更新于 ${date.toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            })}`;
            layoutRuns([{ text: meta, b: 0, i: 0, u: 0, s: 0, code: 0 }], {
                size: META_SIZE,
                lineHeight: META_LINE,
                before: 0,
                after: 6,
                color: COLORS.meta
            });
        }
    }

    // ---- Body ----
    const blocks = parseBlocks(note?.content);
    let orderedCounter = 0;

    for (const block of blocks) {
        switch (block.type) {
            case 'space':
                y += 9;
                break;
            case 'heading': {
                const size = HEADING_SIZES[block.level - 1];
                layoutRuns(block.runs, {
                    size,
                    lineHeight: size * 1.7,
                    bold: true,
                    before: block.level === 1 ? 16 : 12,
                    after: 6
                });
                break;
            }
            case 'hr':
                ensure(16);
                addLine(MARGIN, y + 8, MARGIN + CONTENT_W, y + 8, 1, COLORS.rule);
                y += 18;
                break;
            case 'quote':
                layoutRuns(block.runs, {
                    indent: 16,
                    before: 3,
                    after: 5,
                    color: COLORS.quote,
                    bar: '#d0d7de'
                });
                break;
            case 'list': {
                if (block.ordered) {
                    orderedCounter++;
                    const prefix = `${block.index || orderedCounter}.`;
                    layoutRuns(block.runs, {
                        indent: 22,
                        prefix,
                        prefixWidth: measure(prefix + ' ', BODY_SIZE),
                        before: 2,
                        after: 2
                    });
                } else {
                    layoutRuns(block.runs, {
                        indent: 22,
                        prefix: '•',
                        prefixWidth: measure('• ', BODY_SIZE),
                        before: 2,
                        after: 2
                    });
                }
                break;
            }
            default:
                layoutRuns(block.runs, { before: 3, after: 3 });
        }
    }

    // ---- Footers ----
    const total = pages.length;
    pages.forEach((page, index) => {
        const text = `第 ${index + 1} / ${total} 页`;
        const width = measure(text, FOOTER_SIZE);
        page.ops.push({
            type: 'text',
            text,
            x: (LAYOUT_PAGE.widthPt - width) / 2,
            y: LAYOUT_PAGE.heightPt - MARGIN / 2 - 4,
            size: FOOTER_SIZE,
            bold: false,
            italic: false,
            color: COLORS.footer
        });
    });

    return { pages };
}
