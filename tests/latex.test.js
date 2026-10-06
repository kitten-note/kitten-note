/*
 * KittenNote - LaTeX helpers tests (pure functions)
 *   node tests/latex.test.js
 */

import {
    normalizeMacroBlock,
    latexToHtml,
    extractDocumentBody,
    DEFAULT_LATEX_SNIPPETS
} from '../js/latex.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (!condition) throw new Error('Assertion failed: ' + message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

console.log('\n🧮 LaTeX Helper Tests\n');

console.log('🧵 Macro normalization');

await test('keeps definition commands, drops noise and comments', () => {
    const input = [
        '% a comment',
        '\\documentclass{article}',
        '\\usepackage{mhchem}',
        '\\newcommand{\\R}{\\mathbb{R}}',
        '\\renewcommand{\\vec}[1]{\\mathbf{#1}}',
        '\\DeclareMathOperator{\\rank}{rank}',
        '\\def\\dd{\\mathrm{d}}',
        'just text'
    ].join('\n');
    const normalized = normalizeMacroBlock(input);
    assert(normalized.includes('\\newcommand{\\R}'), 'newcommand kept');
    assert(normalized.includes('\\renewcommand'), 'renewcommand kept');
    assert(normalized.includes('\\DeclareMathOperator'), 'DeclareMathOperator kept');
    assert(normalized.includes('\\def\\dd'), 'def kept');
    assert(!normalized.includes('usepackage'), 'usepackage dropped');
    assert(!normalized.includes('a comment'), 'comments dropped');
    assert(!normalized.includes('just text'), 'plain text dropped');
});

await test('escaped percent survives comment stripping', () => {
    const normalized = normalizeMacroBlock('\\newcommand{\\%}{\\textpercent}');
    assert(normalized.includes('\\textpercent'), 'definition kept');
});

console.log('\n📄 latexToHtml');

await test('sections become headings with correct levels', () => {
    const html = latexToHtml('\\section{一}\\subsection{二}\\subsubsection{三}');
    assert(html.includes('<h2>一</h2>'), 'section → h2');
    assert(html.includes('<h3>二</h3>'), 'subsection → h3');
    assert(html.includes('<h4>三</h4>'), 'subsubsection → h4');
});

await test('inline formatting converts', () => {
    const html = latexToHtml('A \\textbf{bold} B \\emph{it} C \\underline{u} D \\texttt{code}');
    assert(html.includes('<strong>bold</strong>'), 'textbf');
    assert(html.includes('<em>it</em>'), 'emph');
    assert(html.includes('<u>u</u>'), 'underline');
    assert(html.includes('<code>code</code>'), 'texttt');
});

await test('lists and quotes convert', () => {
    const html = latexToHtml('\\begin{itemize}\n\\item 甲\n\\item 乙\n\\end{itemize}');
    assert(html.includes('<ul>') && html.includes('<li>甲</li>') && html.includes('<li>乙</li>'), 'itemize');
    const quote = latexToHtml('\\begin{quote}引用\\end{quote}');
    assert(quote.includes('<blockquote>引用</blockquote>'), 'quote');
});

await test('math is preserved verbatim for MathJax', () => {
    const html = latexToHtml('公式 $E = mc^2$ 与 $$\\ce{H2O}$$');
    assert(html.includes('$E = mc^2$'), 'inline math preserved');
    assert(html.includes('$$\\ce{H2O}$$'), 'display math preserved');
});

await test('text is HTML-escaped (no raw tags)', () => {
    const html = latexToHtml('危险 <script>alert(1)</script> & "引号"');
    assert(!html.includes('<script>'), 'script tag escaped');
    assert(html.includes('&lt;script&gt;'), 'escaped output present');
    assert(html.includes('&amp;'), 'ampersand escaped');
});

await test('textbf arguments are escaped too', () => {
    const html = latexToHtml('\\textbf{<img src=x onerror=1>}');
    assert(!html.includes('<img'), 'no raw img tag');
    assert(html.includes('&lt;img'), 'escaped');
});

await test('title and maketitle build a header', () => {
    const html = latexToHtml('\\title{我的论文}\\author{猫}\\maketitle\n正文');
    assert(html.includes('latex-title'), 'header wrapper');
    assert(html.includes('<h1>我的论文</h1>'), 'title');
    assert(html.includes('<p>猫</p>'), 'author');
});

await test('comments are stripped but escaped percent kept', () => {
    const html = latexToHtml('100\\% 确定 % 这里被注释');
    assert(html.includes('100\\% 确定'), 'content kept');
    assert(!html.includes('注释'), 'comment removed');
});

console.log('\n✂️  extractDocumentBody');

await test('extracts body from a full document', () => {
    const body = extractDocumentBody('\\documentclass{article}\\begin{document}正文内容\\end{document}');
    assertEqual(body, '正文内容', 'body only');
});

await test('bare fragments pass through', () => {
    assertEqual(extractDocumentBody('就是一段文字 $x$'), '就是一段文字 $x$', 'fragment untouched');
});

console.log('\n🧰 Snippets');

await test('snippet catalog is populated and coherent', () => {
    assert(DEFAULT_LATEX_SNIPPETS.length >= 10, 'catalog size');
    for (const snippet of DEFAULT_LATEX_SNIPPETS) {
        assert(typeof snippet.label === 'string' && snippet.insert, `snippet ${snippet.label}`);
    }
    assert(DEFAULT_LATEX_SNIPPETS.some((s) => s.insert.includes('\\ce')), 'chemistry snippet');
    assert(DEFAULT_LATEX_SNIPPETS.some((s) => s.insert.includes('\\qty')), 'physics snippet');
});

// ============================================================

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
}
console.log('═'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
