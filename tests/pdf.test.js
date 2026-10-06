/*
 * KittenNote - Minimal PDF writer tests
 *
 * Validates the DOM-free PdfBuilder: object graph, xref offsets, trailer,
 * JPEG pass-through, font embedding (CIDFontType2 / ToUnicode) and text
 * content streams. Run with:
 *   node tests/pdf.test.js
 */

import { readFileSync } from 'node:fs';
import { PdfBuilder, A4_WIDTH_PT, A4_HEIGHT_PT } from '../js/pdf.js';
import { TrueTypeFont } from '../js/truetype.js';

// ============================================================
// Test framework
// ============================================================

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

function assertThrows(fn, message) {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error('Expected an exception: ' + message);
}

async function assertRejects(fn, message) {
    try {
        await fn();
    } catch {
        return;
    }
    throw new Error('Expected a rejection: ' + message);
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

// 1x1 pixel JPEG (classic minimal sample)
const TINY_JPEG = Uint8Array.from(
    atob(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
        'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
        'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
        'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
        'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
        'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
        'AAIRAxEAPwD3+iiigD//2Q=='
    ),
    (c) => c.charCodeAt(0)
);

const fontBytes = new Uint8Array(
    readFileSync(new URL('../assets/fonts/NotoSansSC-Regular-subset.ttf', import.meta.url))
);
const testFont = TrueTypeFont.parse(fontBytes);

const text = (bytes) => new TextDecoder('latin1').decode(bytes);
const ascii = (str) => new TextEncoder().encode(str);

function assertText(bytes, needle, message) {
    assert(text(bytes).includes(needle), message || needle);
}

function findSubarray(haystack, needle) {
    const target = needle instanceof Uint8Array ? needle : ascii(needle);
    const n = target.length;
    outer: for (let i = 0; i <= haystack.length - n; i++) {
        for (let j = 0; j < n; j++) {
            if (haystack[i + j] !== target[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function parseXref(bytes) {
    const marker = findSubarray(bytes, ascii('startxref\n'));
    assert(marker >= 0, 'startxref present');
    const offset = parseInt(text(bytes.slice(marker + 10, marker + 30)).trim(), 10);
    assert(Number.isFinite(offset), 'startxref offset is a number');
    assert(text(bytes.slice(offset, offset + 4)) === 'xref', 'startxref points at xref table');

    const tableText = text(bytes.slice(offset, offset + 8192));
    const lines = tableText.split('\n');
    assertEqual(lines[0], 'xref', 'first xref line');
    const total = parseInt(lines[1].split(' ')[1], 10);

    const entries = [];
    for (let i = 0; i < total; i++) {
        const line = lines[i + 2];
        assertEqual(line.length, 19, `xref entry ${i} is 19 chars + EOL = 20 bytes`);
        entries.push({ offset: parseInt(line.slice(0, 10), 10), type: line[17] });
    }
    return { total, entries };
}

console.log('\n📄 PDF Writer Tests\n');

// ---- Structure ----

console.log('🧱 Structure');

await test('rejects building an empty document', async () => {
    await assertRejects(() => new PdfBuilder().build(), 'empty document');
});

await test('rejects invalid image pages', () => {
    const builder = new PdfBuilder();
    assertThrows(() => builder.addImagePage({ jpegBytes: new Uint8Array(0), pixelWidth: 1, pixelHeight: 1 }), 'empty bytes');
    assertThrows(() => builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 0, pixelHeight: 1 }), 'zero width');
});

await test('single image page document has a valid header and EOF', async () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = await builder.build();

    assert(bytes instanceof Uint8Array, 'build returns Uint8Array');
    assertEqual(text(bytes.slice(0, 8)), '%PDF-1.4', 'header');
    assertText(bytes, '/Type /Catalog', 'catalog object');
    assertText(bytes, '/Type /Pages', 'pages object');
    assertText(bytes, '/Count 1', 'page count');
    assertText(bytes, '/Filter /DCTDecode', 'JPEG filter');
    assertText(bytes, 'trailer', 'trailer');
    assert(text(bytes.slice(-6)) === '%%EOF\n', 'EOF marker');
});

await test('every xref entry points at its object', async () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = await builder.build({ compress: false });
    const { total, entries } = parseXref(bytes);

    assertEqual(total, 9, 'two image pages → 8 objects + free entry');
    assertEqual(entries[0].type, 'f', 'first entry is free');
    for (let i = 1; i < total; i++) {
        assertEqual(entries[i].type, 'n', `entry ${i} is in-use`);
        const at = text(bytes.slice(entries[i].offset, entries[i].offset + 20));
        assert(at.startsWith(`${i} 0 obj`), `entry ${i} points at "${i} 0 obj" (got "${at.slice(0, 12)}")`);
    }
});

await test('trailer declares the correct size and root', async () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = await builder.build({ compress: false });
    const { total } = parseXref(bytes);
    assertText(bytes, `/Size ${total}`, 'trailer size');
    assertText(bytes, '/Root 1 0 R', 'trailer root');
});

await test('three image pages produce three kids', async () => {
    const builder = new PdfBuilder();
    for (let i = 0; i < 3; i++) {
        builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    }
    const bytes = await builder.build({ compress: false });
    assertText(bytes, '/Count 3', 'page count');
    // Objects: 1 catalog, 2 pages, 3-5 JPEG XObjects, then pages at 6,8,10.
    assertText(bytes, '/Kids [ 6 0 R 8 0 R 10 0 R ]', 'kids references');
    assertEqual(builder.pageCount, 3, 'pageCount getter');
});

// ---- JPEG pass-through ----

console.log('\n🖼️  Image embedding');

await test('JPEG bytes are embedded losslessly after a DCTDecode stream', async () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = await builder.build({ compress: false });

    const markerText = `/Filter /DCTDecode /Length ${TINY_JPEG.byteLength} >>\nstream\n`;
    const start = findSubarray(bytes, ascii(markerText));
    assert(start >= 0, 'image stream header found');

    const dataStart = start + ascii(markerText).length;
    const embedded = bytes.slice(dataStart, dataStart + TINY_JPEG.byteLength);
    for (let i = 0; i < TINY_JPEG.length; i++) {
        if (embedded[i] !== TINY_JPEG[i]) throw new Error(`JPEG byte mismatch at ${i}`);
    }
    assertEqual(
        text(bytes.slice(dataStart + TINY_JPEG.byteLength, dataStart + TINY_JPEG.byteLength + 11)),
        '\nendstream\n',
        'stream terminator'
    );
});

await test('page content scales images into the A4 box', () => {
    const builder = new PdfBuilder({ marginPt: 36 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 4000, pixelHeight: 1000 });
    const page = builder._pages[0];

    assert(page.drawWidthPt <= A4_WIDTH_PT - 72 + 0.01, 'fits width');
    assert(page.drawHeightPt <= A4_HEIGHT_PT - 72 + 0.01, 'fits height');
    assert(Math.abs(4000 / 1000 - page.drawWidthPt / page.drawHeightPt) < 0.001, 'aspect preserved');
    assert(Math.abs(page.offsetX - (A4_WIDTH_PT - page.drawWidthPt) / 2) < 0.01, 'centred');
});

await test('canvas-proportioned page fills the full A4 width', () => {
    const builder = new PdfBuilder({ marginPt: 0 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1191, pixelHeight: 1684 });
    assert(Math.abs(builder._pages[0].drawWidthPt - A4_WIDTH_PT) < 0.5, 'full width');
});

// ---- Text & fonts ----

console.log('\n🔤 Text pages & font embedding');

await test('text pages embed a CIDFontType2 with ToUnicode', async () => {
    const builder = new PdfBuilder();
    const fontRef = builder.addFont(fontBytes, testFont);
    builder.addTextPage({
        ops: [{ type: 'text', text: '中文Test A', x: 72, y: 120, size: 12.5, color: '#24292f' }],
        fontRef
    });
    const bytes = await builder.build({ compress: false });

    assertText(bytes, '/Subtype /Type0', 'Type0 font');
    assertText(bytes, '/Encoding /Identity-H', 'Identity-H encoding');
    assertText(bytes, '/Subtype /CIDFontType2', 'descendant font');
    assertText(bytes, '/FontFile2', 'embedded font program');
    assertText(bytes, `/Length1 ${fontBytes.byteLength}`, 'uncompressed font length');
    assertText(bytes, 'beginbfchar', 'ToUnicode CMap');
    assertText(bytes, `<4E2D>`, 'ToUnicode maps 中');
    assertText(bytes, `/W [ `, 'width array');
});

await test('text content stream references glyph ids', async () => {
    const builder = new PdfBuilder();
    const fontRef = builder.addFont(fontBytes, testFont);
    builder.addTextPage({
        ops: [{ type: 'text', text: '中', x: 72, y: 120, size: 12.5 }],
        fontRef
    });
    const bytes = await builder.build({ compress: false });

    const gidHex = testFont.gidFor('中').toString(16).toUpperCase().padStart(4, '0');
    assertText(bytes, `/F0 12.5 Tf`, 'font resource selected');
    assertText(bytes, `<${gidHex}> Tj`, 'glyph id drawn');
    assertText(bytes, `1 0 0 1 72 `, 'text matrix positioned');
});

await test('bold runs use text render mode 2', async () => {
    const builder = new PdfBuilder();
    const fontRef = builder.addFont(fontBytes, testFont);
    builder.addTextPage({
        ops: [{ type: 'text', text: '粗', x: 72, y: 120, size: 12.5, bold: true }],
        fontRef
    });
    const bytes = await builder.build({ compress: false });
    assertText(bytes, '2 Tr', 'fake bold render mode');
});

await test('font streams compress when requested', async () => {
    const builder = new PdfBuilder();
    const fontRef = builder.addFont(fontBytes, testFont);
    builder.addTextPage({
        ops: [{ type: 'text', text: '压缩', x: 72, y: 120, size: 12.5 }],
        fontRef
    });
    const bytes = await builder.build({ compress: true });
    assertText(bytes, '/Filter /FlateDecode', 'font stream compressed');
    assert(bytes.byteLength < fontBytes.byteLength * 1.5, 'compressed output smaller than fresh font');
});

await test('xref stays valid with text pages', async () => {
    const builder = new PdfBuilder();
    const fontRef = builder.addFont(fontBytes, testFont);
    builder.addTextPage({
        ops: [{ type: 'text', text: '一二三', x: 72, y: 120, size: 12.5 }],
        fontRef
    });
    const bytes = await builder.build({ compress: false });
    const { total, entries } = parseXref(bytes);
    // 1 catalog + 1 pages + 5 font objects + page + contents = 9 objects
    assertEqual(total, 10, 'objects + free entry');
    for (let i = 1; i < total; i++) {
        const at = text(bytes.slice(entries[i].offset, entries[i].offset + 20));
        assert(at.startsWith(`${i} 0 obj`), `entry ${i} valid`);
    }
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
