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
 * KittenNote - LaTeX support (MathJax)
 *
 * Pure front-end LaTeX rendering built on the vendored MathJax 3
 * `tex-svg-full` bundle (Apache-2.0, fully offline). Provides:
 *   • lazy MathJax loading with inline/display math configured
 *   • a small LaTeX-document → HTML converter (sections, lists, quotes,
 *     emphasis …) so a whole document can be previewed, not just formulas
 *   • per-note macro support (\newcommand / \def …) injected into every
 *     math expression so definitions work without a global config reload
 *   • physics / mhchem / color / bbox packages (bundled in tex-svg-full)
 */

import { escapeHtml } from './utils.js';

export const DEFAULT_LATEX_SNIPPETS = [
    { label: '行内公式', insert: '$x$', cursorOffset: -1 },
    { label: '公式块', insert: '$$\n\\n$$', cursorOffset: -3, },
    { label: '分数', insert: '\\frac{a}{b}' },
    { label: '根号', insert: '\\sqrt{x}' },
    { label: '求和', insert: '\\sum_{i=1}^{n}' },
    { label: '积分', insert: '\\int_{a}^{b}' },
    { label: '化学式', insert: '\\ce{H2O}' },
    { label: '物理量', insert: '\\qty{9.8}{m/s^2}' },
    { label: '矩阵', insert: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
    { label: '分段函数', insert: '\\begin{cases} x & x > 0 \\\\ 0 & x \\le 0 \\end{cases}' },
    { label: '章节', insert: '\\section{标题}' },
    { label: '列表', insert: '\\begin{itemize}\n\\item 第一项\n\\end{itemize}' }
];

let mathjaxPromise = null;

/**
 * Load MathJax once (vendored classic script, works offline).
 */
export function ensureMathJax() {
    if (mathjaxPromise) return mathjaxPromise;

    mathjaxPromise = new Promise((resolve, reject) => {
        if (window.MathJax?.startup?.promise) {
            window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
            return;
        }

        window.MathJax = {
            tex: {
                inlineMath: [['$', '$'], ['\\(', '\\)']],
                displayMath: [['$$', '$$'], ['\\[', '\\]']],
                processEscapes: true,
                tags: 'ams',
                packages: { '[+]': ['physics', 'mhchem', 'ams', 'color', 'textcolor', 'bbox'] },
                macros: {
                    R: '\\mathbb{R}',
                    N: '\\mathbb{N}',
                    Z: '\\mathbb{Z}',
                    Q: '\\mathbb{Q}',
                    C: '\\mathbb{C}'
                }
            },
            svg: { fontCache: 'local' },
            options: { enableMenu: false },
            startup: { typeset: false }
        };

        const script = document.createElement('script');
        script.src = './assets/mathjax/tex-svg-full.js';
        script.onload = () => {
            if (!window.MathJax?.startup?.promise) {
                reject(new Error('MathJax 初始化失败'));
                return;
            }
            window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
        };
        script.onerror = () => {
            mathjaxPromise = null;
            reject(new Error('MathJax 资源加载失败'));
        };
        document.head.appendChild(script);
    });

    return mathjaxPromise;
}

const MATH_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<![\$\\])\$(?!\$)[^\n$]*?\$)/g;

/** Escape a plain-text fragment for HTML. */
const esc = (value) => escapeHtml(value);

/** Extract the first `\cmd{...}` argument. */
function firstArg(source, command) {
    const match = new RegExp(`\\\\${command}\\s*\\{([^{}]*)\\}`).exec(source);
    return match ? match[1] : '';
}

/**
 * Normalize a macro block: keep only definition commands, drop comments
 * and package/document noise, so it can be re-injected safely.
 */
export function normalizeMacroBlock(macrosText) {
    return String(macrosText || '')
        .replace(/(^|[^\\])%[^\n]*/g, '$1')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\\(newcommand|renewcommand|providecommand|def|let|DeclareMathOperator)\b/.test(line))
        .join('\n');
}

/**
 * Convert a LaTeX document (or a fragment) into simple HTML for preview.
 * Math segments are left untouched for MathJax. Returns HTML string.
 */
export function latexToHtml(source) {
    const tokens = [];
    const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
    let text = String(source ?? '');

    // Drop comments (but keep escaped \%)
    text = text.replace(/(^|[^\\])%[^\n]*/g, '$1');

    // Stash math first so command rewriting never touches formulas
    text = text.replace(MATH_RE, (match) => stash(esc(match)));

    // Document noise
    text = text.replace(/\\(documentclass|usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\}/g, '');
    text = text.replace(/\\(begin|end)\{document\}/g, '');

    // Title block
    const title = firstArg(text, 'title');
    const author = firstArg(text, 'author');
    text = text
        .replace(/\\title\s*\{[^{}]*\}/g, '')
        .replace(/\\author\s*\{[^{}]*\}/g, '')
        .replace(/\\date\s*\{[^{}]*\}/g, '')
        .replace(/\\maketitle/g, () => {
            if (!title && !author) return '';
            return stash(
                '<header class="latex-title">' +
                (title ? `<h1>${esc(title)}</h1>` : '') +
                (author ? `<p>${esc(author)}</p>` : '') +
                '</header>'
            );
        });

    // Sections
    text = text.replace(/\\(subsub|sub)?section\*?\s*\{([^{}]*)\}/g, (match, sub, heading) => {
        const level = 2 + (sub === 'subsub' ? 2 : sub === 'sub' ? 1 : 0);
        return stash(`<h${level}>${esc(heading)}</h${level}>`);
    });
    text = text.replace(/\\paragraph\s*\{([^{}]*)\}/g, (match, heading) => stash(`<p><strong>${esc(heading)}</strong></p>`));

    // Inline formatting
    text = text.replace(/\\textbf\s*\{([^{}]*)\}/g, (m, inner) => stash(`<strong>${esc(inner)}</strong>`));
    text = text.replace(/\\(emph|textit)\s*\{([^{}]*)\}/g, (m, cmd, inner) => stash(`<em>${esc(inner)}</em>`));
    text = text.replace(/\\underline\s*\{([^{}]*)\}/g, (m, inner) => stash(`<u>${esc(inner)}</u>`));
    text = text.replace(/(\\texttt|\\verb)\s*\{?([^{}\s]*)\}?/g, (m, cmd, inner) => stash(`<code>${esc(inner)}</code>`));
    text = text.replace(/\\href\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, url, label) => stash(`<a href="${esc(url)}" rel="noreferrer noopener">${esc(label)}</a>`));

    // Environments
    text = text.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (m, body) => {
        const items = body.split(/\\item\s*/).slice(1);
        return stash(`<ul>${items.map((item) => `<li>${esc(item.trim().replace(/\s*\n\s*/g, ' '))}</li>`).join('')}</ul>`);
    });
    text = text.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, (m, body) => {
        const items = body.split(/\\item\s*/).slice(1);
        return stash(`<ol>${items.map((item) => `<li>${esc(item.trim().replace(/\s*\n\s*/g, ' '))}</li>`).join('')}</ol>`);
    });
    text = text.replace(/\\begin\{(center)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => stash(`<div class="latex-center">${esc(body.trim())}</div>`));
    text = text.replace(/\\begin\{(quote|quotation|abstract)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => stash(`<blockquote>${esc(body.trim()).replace(/\n/g, '<br>')}</blockquote>`));

    // Paragraphs: blocks of remaining text, tokens pass through untouched
    const blocks = text.split(/\n\s*\n/);
    const html = blocks
        .map((block) => {
            const trimmed = block.trim();
            if (!trimmed) return '';
            const onlyTokens = /^(\s*\u0000\d+\u0000\s*)+$/.test(trimmed);
            const rendered = esc(trimmed).replace(/\n/g, '<br>');
            return onlyTokens ? rendered : `<p>${rendered}</p>`;
        })
        .filter(Boolean)
        .join('\n');

    // Restore stashed HTML
    return html.replace(/\u0000(\d+)\u0000/g, (m, index) => tokens[Number(index)] ?? '');
}

/** Inject macro definitions into every math expression (per-expression scope). */
function injectMacros(source, macroDefs) {
    if (!macroDefs) return source;
    return String(source).replace(MATH_RE, (match) => {
        if (match.startsWith('$$')) return `$$${macroDefs}\n${match.slice(2, -2)}$$`;
        if (match.startsWith('\\[')) return `\\[${macroDefs}\n${match.slice(2, -2)}\\]`;
        if (match.startsWith('\\(')) return `\\(${macroDefs} ${match.slice(2, -2)}\\)`;
        return `$${macroDefs} ${match.slice(1, -1)}$`;
    });
}

/**
 * Render a LaTeX note into a container.
 *
 * @param {HTMLElement} container
 * @param {string} source - LaTeX source
 * @param {string} [macros] - macro definitions from the note preamble
 * @returns {Promise<{errors: string[]}>}
 */
export async function renderLatexPreview(container, source, macros = '') {
    await ensureMathJax();

    const macroDefs = normalizeMacroBlock(macros);
    const withMacros = injectMacros(source, macroDefs);
    container.innerHTML = latexToHtml(withMacros);
    container.classList.add('latex-preview');

    await window.MathJax.typesetPromise([container]);

    const errors = [...container.querySelectorAll('merror')].map((el) => el.textContent.trim());
    return { errors };
}

/** Strip a LaTeX document down to body content (used by .tex import). */
export function extractDocumentBody(source) {
    const text = String(source ?? '');
    const bodyMatch = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(text);
    return (bodyMatch ? bodyMatch[1] : text).trim();
}
