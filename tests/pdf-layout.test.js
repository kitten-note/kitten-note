/*
 * KittenNote - vector PDF layout tests
 *
 * Uses a stub font (no DOM, no canvas) to validate pagination, block
 * handling and the missing-glyph fallback contract.
 *   node tests/pdf-layout.test.js
 */

import { renderTextNoteToPages, LAYOUT_PAGE } from '../js/pdf-layout.js';

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

const stubFont = {
    hasGlyph: (char) => char !== '🦄',
    gidFor: (char) => (char === '🦄' ? 0 : 1),
    advanceWidth1000: () => 550,
    textWidth: (text, size) => Array.from(String(text)).length * size * 0.55,
    unitsPerEm: 1000
};

console.log('\n📄 Vector PDF Layout Tests\n');

const basicNote = {
    title: '测试笔记',
    updatedAt: '2026-10-06T10:00:00.000Z',
    content: [
        '# 一级标题',
        '',
        '正文段落，包含 **加粗**、*斜体*、++下划线++、~~删除线~~ 和 `code`。',
        '',
        '> 引用内容',
        '',
        '- 列表项甲',
        '- 列表项乙',
        '',
        '1. 有序一',
        '2. 有序二',
        '',
        '---',
        '',
        '结尾段落。'
    ].join('\n')
};

console.log('📦 Structure');

await test('produces a single page of ops for a short note', () => {
    const result = renderTextNoteToPages(basicNote, stubFont);
    assert(result !== null, 'layout succeeds');
    assertEqual(result.pages.length, 1, 'page count');
    assert(result.pages[0].ops.length > 10, 'ops emitted');
});

await test('keeps title, headings, bold and bullets as ops', () => {
    const result = renderTextNoteToPages(basicNote, stubFont);
    const ops = result.pages[0].ops;
    const texts = ops.filter((op) => op.type === 'text');

    assert(texts.some((op) => op.text === '测试笔记'), 'title op');
    assert(texts.some((op) => op.text === '一级标题' && op.bold), 'heading op is bold');
    assert(texts.some((op) => op.text.includes('加粗') && op.bold), 'bold run');
    assert(texts.some((op) => op.text.includes('斜体') && op.italic), 'italic run');
    assert(texts.some((op) => op.text === '•'), 'bullet prefix');
    assert(texts.some((op) => op.text === '1.'), 'ordered prefix');
    assert(ops.some((op) => op.type === 'line'), 'rules / underlines emitted');
    assert(ops.some((op) => op.type === 'rect'), 'quote bar / code background emitted');
});

console.log('📄 Pagination');

await test('long content flows onto multiple pages with footers', () => {
    const longNote = {
        title: '长文',
        content: '这是一段测试文字。'.repeat(600)
    };
    const result = renderTextNoteToPages(longNote, stubFont);
    assert(result.pages.length >= 3, `page count ${result.pages.length}`);

    result.pages.forEach((page, index) => {
        assert(page.ops.length > 0, `page ${index} has ops`);
        const footer = page.ops[page.ops.length - 1];
        assert(footer.type === 'text' && /^第 \d+ \/ \d+ 页$/.test(footer.text), `footer on page ${index}`);
        for (const op of page.ops) {
            const ys = op.type === 'line' ? [op.y1, op.y2] : [op.y];
            for (const y of ys) {
                assert(y >= 0 && y < LAYOUT_PAGE.heightPt, `op y ${y} inside page ${index}`);
            }
        }
    });
});

await test('every page has content above the footer zone', () => {
    const longNote = { title: '长文', content: '句子内容。'.repeat(900) };
    const result = renderTextNoteToPages(longNote, stubFont);
    for (const page of result.pages) {
        const content = page.ops.filter((op) => op.type === 'text' && !/^第 \d+/.test(op.text));
        assert(content.length > 0, 'page not empty');
    }
});

console.log('🛟 Fallback contract');

await test('returns null when a character is not covered by the font', () => {
    const note = { title: 'emoji', content: '这是 🦄 一匹马' };
    assertEqual(renderTextNoteToPages(note, stubFont), null, 'null signals raster fallback');
});

await test('empty note still yields a page', () => {
    const result = renderTextNoteToPages({ title: '空', content: '' }, stubFont);
    assert(result !== null && result.pages.length === 1, 'single page');
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
