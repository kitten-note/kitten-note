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
 * KittenNote - text-note → PDF page renderer
 *
 * Lays out a Markdown subset (headings, bold/italic/underline/strike,
 * inline code, quotes, lists, rules) onto A4-proportioned canvases with
 * proper CJK-aware line wrapping and pagination. The canvases are then
 * embedded into a real PDF by js/pdf.js.
 */

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const SCALE = 2; // canvas pixels per PDF point

const PAGE_W = Math.round(A4_WIDTH_PT * SCALE);
const PAGE_H = Math.round(A4_HEIGHT_PT * SCALE);
const MARGIN = Math.round(52 * SCALE);
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_ZONE = Math.round(34 * SCALE);

const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,-apple-system,"Segoe UI",sans-serif';
const MONO_STACK = '"SFMono-Regular",Consolas,"Courier New",monospace';

const COLORS = {
    text: '#24292f',
    quote: '#57606a',
    code: '#24292f',
    codeBg: '#f0f1f3',
    rule: '#d8dee4',
    meta: '#8a8f98',
    footer: '#8a8f98'
};

const HEADING_SIZES = [40, 34, 30, 28, 26, 24];
const BODY_SIZE = 25;
const BODY_LINE = 44;

function fontFor(style, sizePx) {
    const family = style?.code ? MONO_STACK : FONT_STACK;
    const weight = style?.b ? 700 : 400;
    const italic = style?.i ? 'italic ' : '';
    return `${italic}${weight} ${sizePx}px ${family}`;
}

/** Parse inline markdown into styled runs (same subset as the editor). */
function parseInline(text) {
    const runs = [];
    const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\+\+[^+]+\+\+|~~[^~]+~~|`[^`]+`)/g;
    let last = 0;
    let match;
    const pushPlain = (value) => {
        if (value) runs.push({ text: value, b: 0, i: 0, u: 0, s: 0, code: 0 });
    };

    while ((match = pattern.exec(text)) !== null) {
        pushPlain(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), b: 1, i: 0, u: 0, s: 0, code: 0 });
        else if (token.startsWith('__')) runs.push({ text: token.slice(2, -2), b: 1, i: 0, u: 0, s: 0, code: 0 });
        else if (token.startsWith('++')) runs.push({ text: token.slice(2, -2), b: 0, i: 0, u: 1, s: 0, code: 0 });
        else if (token.startsWith('~~')) runs.push({ text: token.slice(2, -2), b: 0, i: 0, u: 0, s: 1, code: 0 });
        else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), b: 0, i: 0, u: 0, s: 0, code: 1 });
        else if (token.startsWith('*')) runs.push({ text: token.slice(1, -1), b: 0, i: 1, u: 0, s: 0, code: 0 });
        else runs.push({ text: token.slice(1, -1), b: 0, i: 1, u: 0, s: 0, code: 0 });
        last = match.index + token.length;
    }
    pushPlain(text.slice(last));
    return runs;
}

/** Split markdown into simple blocks. */
function parseBlocks(markdown) {
    const blocks = [];
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) {
            blocks.push({ type: 'space' });
            continue;
        }

        let match;
        if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
            blocks.push({ type: 'heading', level: match[1].length, runs: parseInline(match[2]) });
            continue;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) && line.trim().length >= 3) {
            blocks.push({ type: 'hr' });
            continue;
        }
        if ((match = line.match(/^>\s?(.*)$/))) {
            blocks.push({ type: 'quote', runs: parseInline(match[1]) });
            continue;
        }
        if ((match = line.match(/^\s*[-*+]\s+(.*)$/))) {
            blocks.push({ type: 'list', ordered: false, runs: parseInline(match[1]) });
            continue;
        }
        if ((match = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
            blocks.push({ type: 'list', ordered: true, index: parseInt(match[1], 10), runs: parseInline(match[2]) });
            continue;
        }
        blocks.push({ type: 'paragraph', runs: parseInline(line) });
    }
    return blocks;
}

function createMeasurer(ctx) {
    const cache = new Map();
    return (char, font) => {
        const key = `${font}|${char}`;
        let width = cache.get(key);
        if (width === undefined) {
            ctx.font = font;
            width = ctx.measureText(char).width;
            cache.set(key, width);
        }
        return width;
    };
}

/** Greedy wrap with CJK-friendly per-character breaks. */
function wrapRuns(ctx, runs, maxWidth, sizePx) {
    const measure = createMeasurer(ctx);
    const atoms = [];
    for (const run of runs) {
        const font = fontFor(run, sizePx);
        for (const char of Array.from(run.text)) {
            atoms.push({ char, run, font, width: measure(char, font) });
        }
    }

    const lines = [];
    let line = [];
    let width = 0;
    let lastSpace = -1;

    const flush = (endIndex) => {
        const head = line.slice(0, endIndex);
        while (head.length && head[head.length - 1].char === ' ') head.pop();
        if (head.length) lines.push(head);
        line = endIndex < line.length ? line.slice(endIndex) : [];
        width = line.reduce((sum, atom) => sum + atom.width, 0);
        lastSpace = -1;
    };

    for (const atom of atoms) {
        if (atom.char === ' ') lastSpace = line.length;
        line.push(atom);
        width += atom.width;

        if (width > maxWidth && line.length > 1) {
            if (lastSpace > 0) {
                flush(lastSpace);
            } else {
                flush(line.length - 1);
            }
        }
    }
    if (line.length) {
        while (line.length && line[line.length - 1].char === ' ') line.pop();
        if (line.length) lines.push(line);
    }
    return lines;
}

/**
 * Render a text note to one or more A4-proportioned canvases.
 *
 * @param {{title?:string, content?:string, updatedAt?:string}} note
 * @returns {HTMLCanvasElement[]}
 */
export function renderTextNoteToCanvases(note) {
    const pages = [];
    let ctx = null;
    let y = 0;

    const contentBottom = () => PAGE_H - MARGIN - FOOTER_ZONE;

    const newPage = () => {
        const canvas = document.createElement('canvas');
        canvas.width = PAGE_W;
        canvas.height = PAGE_H;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, PAGE_W, PAGE_H);
        context.textBaseline = 'middle';
        pages.push(canvas);
        ctx = context;
        y = MARGIN;
    };
    newPage();

    const ensureSpace = (needed) => {
        if (y + needed > contentBottom()) {
            newPage();
        }
    };

    const drawLine = (atoms, x, baseline, sizePx) => {
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

            ctx.font = fontFor(style, sizePx);
            ctx.textAlign = 'left';

            if (style.code) {
                ctx.fillStyle = COLORS.codeBg;
                const pad = sizePx * 0.16;
                ctx.fillRect(cursor - pad, baseline - sizePx * 0.62, groupWidth + pad * 2, sizePx * 1.24);
                ctx.fillStyle = COLORS.code;
            } else {
                ctx.fillStyle = COLORS.text;
            }

            const text = atoms.slice(index, end).map((atom) => atom.char).join('');
            ctx.fillText(text, cursor, baseline);

            if (style.u) {
                ctx.fillStyle = ctx.fillStyle;
                ctx.fillRect(cursor, baseline + sizePx * 0.42, groupWidth, Math.max(1, sizePx * 0.06));
            }
            if (style.s) {
                ctx.fillRect(cursor, baseline, groupWidth, Math.max(1, sizePx * 0.06));
            }

            cursor += groupWidth;
            index = end;
        }
    };

    const layoutRuns = (runs, {
        sizePx = BODY_SIZE,
        lineHeight = BODY_LINE,
        weight = 400,
        color = null,
        indent = 0,
        before = 0,
        after = 0,
        bar = null,
        prefix = null,
        prefixWidth = 0
    } = {}) => {
        y += before;
        const styledRuns = weight === 700
            ? runs.map((run) => ({ ...run, b: 1 }))
            : runs;

        const available = CONTENT_W - indent - prefixWidth;
        const lines = wrapRuns(ctx, styledRuns, available, sizePx);
        const effective = lines.length ? lines : [[]];

        effective.forEach((atoms, lineIndex) => {
            ensureSpace(lineHeight);
            const baseline = y + lineHeight / 2;

            if (bar) {
                ctx.fillStyle = bar;
                ctx.fillRect(MARGIN + 8, y + 2, 6, lineHeight - 4);
            }

            if (lineIndex === 0 && prefix) {
                ctx.font = fontFor({ b: 0, code: 0 }, sizePx);
                ctx.textAlign = 'left';
                ctx.fillStyle = color || COLORS.text;
                ctx.fillText(prefix, MARGIN + indent, baseline);
            }

            if (color) {
                // Quote text color for all non-code runs
                const recolored = atoms.map((atom) =>
                    atom.run.code ? atom : { ...atom, run: { ...atom.run } }
                );
                ctx.save();
                ctx.filter = 'none';
                drawLineColored(recolored, MARGIN + indent + prefixWidth, baseline, sizePx, color);
                ctx.restore();
            } else {
                drawLine(atoms, MARGIN + indent + prefixWidth, baseline, sizePx);
            }

            y += lineHeight;
        });

        y += after;
    };

    const drawLineColored = (atoms, x, baseline, sizePx, color) => {
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

            ctx.font = fontFor(style, sizePx);
            ctx.textAlign = 'left';
            ctx.fillStyle = style.code ? COLORS.code : color;

            if (style.code) {
                const pad = sizePx * 0.16;
                ctx.fillStyle = COLORS.codeBg;
                ctx.fillRect(cursor - pad, baseline - sizePx * 0.62, groupWidth + pad * 2, sizePx * 1.24);
                ctx.fillStyle = COLORS.code;
            }

            const text = atoms.slice(index, end).map((atom) => atom.char).join('');
            ctx.fillText(text, cursor, baseline);

            if (style.u) ctx.fillRect(cursor, baseline + sizePx * 0.42, groupWidth, Math.max(1, sizePx * 0.06));
            if (style.s) ctx.fillRect(cursor, baseline, groupWidth, Math.max(1, sizePx * 0.06));

            cursor += groupWidth;
            index = end;
        }
    };

    // ---- Header: title + meta ----
    layoutRuns(parseInline(note?.title || '未命名笔记'), {
        sizePx: 44,
        lineHeight: 62,
        weight: 700,
        before: 6,
        after: 6
    });

    y += 4;
    ctx.fillStyle = COLORS.rule;
    ctx.fillRect(MARGIN, y, CONTENT_W, 2);
    y += 14;

    if (note?.updatedAt) {
        const date = new Date(note.updatedAt);
        const metaText = Number.isNaN(date.getTime())
            ? ''
            : `更新于 ${date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
        if (metaText) {
            layoutRuns([{ text: metaText, b: 0, i: 0, u: 0, s: 0, code: 0 }], {
                sizePx: 21,
                lineHeight: 34,
                before: 0,
                after: 8,
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
                y += Math.round(BODY_LINE * 0.45);
                break;
            case 'heading':
                layoutRuns(block.runs, {
                    sizePx: HEADING_SIZES[block.level - 1],
                    lineHeight: HEADING_SIZES[block.level - 1] * 1.7,
                    weight: 700,
                    before: block.level === 1 ? 30 : 22,
                    after: 10
                });
                break;
            case 'hr':
                ensureSpace(30);
                y += 12;
                ctx.fillStyle = COLORS.rule;
                ctx.fillRect(MARGIN, y, CONTENT_W, 2);
                y += 18;
                break;
            case 'quote':
                layoutRuns(block.runs, {
                    indent: 30,
                    before: 6,
                    after: 8,
                    color: COLORS.quote,
                    bar: '#d0d7de'
                });
                break;
            case 'list': {
                if (block.ordered) {
                    orderedCounter++;
                    const prefix = `${block.index || orderedCounter}.`;
                    ctx.font = fontFor({ b: 0, code: 0 }, BODY_SIZE);
                    const prefixWidth = ctx.measureText(prefix + ' ').width || 34;
                    layoutRuns(block.runs, {
                        indent: 40,
                        prefix,
                        prefixWidth,
                        before: 3,
                        after: 3
                    });
                } else {
                    layoutRuns(block.runs, {
                        indent: 40,
                        prefix: '•',
                        prefixWidth: 26,
                        before: 3,
                        after: 3
                    });
                }
                break;
            }
            default:
                layoutRuns(block.runs, { before: 5, after: 5 });
        }
    }

    // ---- Footers ----
    const total = pages.length;
    pages.forEach((canvas, index) => {
        const footerCtx = canvas.getContext('2d');
        footerCtx.font = `400 21px ${FONT_STACK}`;
        footerCtx.fillStyle = COLORS.footer;
        footerCtx.textAlign = 'center';
        footerCtx.textBaseline = 'middle';
        footerCtx.fillText(`第 ${index + 1} / ${total} 页`, PAGE_W / 2, PAGE_H - MARGIN / 2 - 6);
    });

    return pages;
}
