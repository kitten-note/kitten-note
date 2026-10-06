/*
 * KittenNote - Minimal PDF writer tests
 *
 * Validates the DOM-free PdfBuilder: header, object graph, xref offsets,
 * trailer and JPEG pass-through. Run with:
 *   node tests/pdf.test.js
 */

import { PdfBuilder, A4_WIDTH_PT, A4_HEIGHT_PT } from '../js/pdf.js';

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
const TINY_JPEG_B64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
    'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
    'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
    'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
    'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
    'AAIRAxEAPwD3+iiigD//2Q==';

const TINY_JPEG = Uint8Array.from(atob(TINY_JPEG_B64), (c) => c.charCodeAt(0));

const text = (bytes) => new TextDecoder('latin1').decode(bytes);
const ascii = (str) => new TextEncoder().encode(str);

function findSubarray(haystack, needle) {
    const n = needle.length ?? needle.byteLength;
    const target = needle instanceof Uint8Array ? needle : ascii(needle);
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
    const tail = text(bytes.slice(marker + 10, marker + 30));
    const offset = parseInt(tail.trim(), 10);
    assert(Number.isFinite(offset), 'startxref offset is a number');
    assert(text(bytes.slice(offset, offset + 4)) === 'xref', 'startxref points at xref table');

    const tableText = text(bytes.slice(offset, offset + 4096));
    const lines = tableText.split('\n');
    assertEqual(lines[0], 'xref', 'first xref line');
    const [countStart, countTotal] = lines[1].split(' ');
    assertEqual(countStart, '0', 'xref subsection start');
    const total = parseInt(countTotal, 10);

    const entries = [];
    for (let i = 0; i < total; i++) {
        const line = lines[i + 2]; // lines[2] is entry 0 (the free entry)
        assertEqual(line.length, 19, `xref entry ${i} is 19 chars + EOL = 20 bytes`);
        entries.push({
            offset: parseInt(line.slice(0, 10), 10),
            type: line[17]
        });
    }
    return { xrefOffset: offset, total, entries, trailer: tableText };
}

console.log('\n📄 PDF Writer Tests\n');

// ---- Structure ----

console.log('🧱 Structure');

await test('rejects building an empty document', () => {
    assertThrows(() => new PdfBuilder().build(), 'empty document');
});

await test('rejects invalid image pages', () => {
    const builder = new PdfBuilder();
    assertThrows(() => builder.addImagePage({ jpegBytes: new Uint8Array(0), pixelWidth: 1, pixelHeight: 1 }), 'empty bytes');
    assertThrows(() => builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 0, pixelHeight: 1 }), 'zero width');
});

await test('single page document has a valid header and EOF', () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = builder.build();

    assert(bytes instanceof Uint8Array, 'build returns Uint8Array');
    assertEqual(text(bytes.slice(0, 8)), '%PDF-1.4', 'header');
    assertText(bytes, '/Type /Catalog', 'catalog object');
    assertText(bytes, '/Type /Pages', 'pages object');
    assertText(bytes, '/Count 1', 'page count');
    assertText(bytes, 'trailer', 'trailer');
    assert(text(bytes.slice(-6)) === '%%EOF\n', 'EOF marker');
});

await test('every xref entry points at its object', () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = builder.build();
    const { total, entries } = parseXref(bytes);

    assertEqual(total, 9, 'two pages → 8 objects + free entry');
    assertEqual(entries[0].type, 'f', 'first entry is free');
    for (let i = 1; i < total; i++) {
        assertEqual(entries[i].type, 'n', `entry ${i} is in-use`);
        const at = text(bytes.slice(entries[i].offset, entries[i].offset + 20));
        assert(at.startsWith(`${i} 0 obj`), `entry ${i} points at "${i} 0 obj" (got "${at.slice(0, 12)}")`);
    }
});

await test('trailer declares the correct size and root', () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = builder.build();
    const { total, trailer } = parseXref(bytes);
    assertText(bytes, `/Size ${total}`, 'trailer size');
    assertText(bytes, '/Root 1 0 R', 'trailer root');
    assert(trailer.includes('/Size'), 'trailer parse sanity');
});

await test('three pages produce three kids', () => {
    const builder = new PdfBuilder();
    for (let i = 0; i < 3; i++) {
        builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    }
    const bytes = builder.build();
    assertText(bytes, '/Count 3', 'page count');
    assertText(bytes, '/Kids [ 3 0 R 6 0 R 9 0 R ]', 'kids references');
    assertEqual(builder.pageCount, 3, 'pageCount getter');
});

// ---- JPEG pass-through ----

console.log('\n🖼️  Image embedding');

await test('JPEG bytes are embedded losslessly after a DCTDecode stream', () => {
    const builder = new PdfBuilder();
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1, pixelHeight: 1 });
    const bytes = builder.build();

    const markerText = `/Filter /DCTDecode /Length ${TINY_JPEG.byteLength} >>\nstream\n`;
    const start = findSubarray(bytes, ascii(markerText));
    assert(start >= 0, 'image stream header found');

    const dataStart = start + ascii(markerText).length;
    const embedded = bytes.slice(dataStart, dataStart + TINY_JPEG.byteLength);
    assertEqual(embedded.length, TINY_JPEG.length, 'embedded length');
    for (let i = 0; i < TINY_JPEG.length; i++) {
        if (embedded[i] !== TINY_JPEG[i]) {
            throw new Error(`JPEG byte mismatch at offset ${i}`);
        }
    }
    assertEqual(text(bytes.slice(dataStart + TINY_JPEG.byteLength, dataStart + TINY_JPEG.byteLength + 11)), '\nendstream\n', 'stream terminator');
});

await test('page content scales images into the A4 box', () => {
    const builder = new PdfBuilder({ marginPt: 36 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 4000, pixelHeight: 1000 });
    const page = builder._pages[0];

    assert(page.drawWidthPt <= A4_WIDTH_PT - 72 + 0.01, 'fits width');
    assert(page.drawHeightPt <= A4_HEIGHT_PT - 72 + 0.01, 'fits height');
    const ratioBefore = 4000 / 1000;
    const ratioAfter = page.drawWidthPt / page.drawHeightPt;
    assert(Math.abs(ratioBefore - ratioAfter) < 0.001, 'aspect ratio preserved');
    assert(Math.abs(page.offsetX - (A4_WIDTH_PT - page.drawWidthPt) / 2) < 0.01, 'horizontally centred');
});

await test('canvas-proportioned page fills the full A4 width', () => {
    const builder = new PdfBuilder({ marginPt: 0 });
    builder.addImagePage({ jpegBytes: TINY_JPEG, pixelWidth: 1191, pixelHeight: 1684 });
    const page = builder._pages[0];
    assert(Math.abs(page.drawWidthPt - A4_WIDTH_PT) < 0.5, 'full width');
});

// ============================================================
// Results
// ============================================================

function assertText(bytes, needle, message) {
    assert(text(bytes).includes(needle), message || needle);
}

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
}
console.log('═'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
