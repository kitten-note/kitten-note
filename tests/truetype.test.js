/*
 * KittenNote - TrueType parser tests
 *
 * Runs against the bundled OFL subset font (assets/fonts).
 *   node tests/truetype.test.js
 */

import { readFileSync } from 'node:fs';
import { TrueTypeFont } from '../js/truetype.js';

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

console.log('\n🔤 TrueType Parser Tests\n');

const fontBytes = new Uint8Array(
    readFileSync(new URL('../assets/fonts/NotoSansSC-Regular-subset.ttf', import.meta.url))
);
const font = TrueTypeFont.parse(fontBytes);

console.log('📐 Metrics');

await test('parses the bundled subset font', () => {
    assert(fontBytes.byteLength > 1_000_000, 'font file is committed and non-trivial');
    assertEqual(font.unitsPerEm, 1000, 'unitsPerEm');
    assert(font.numGlyphs > 6000, `glyph count (${font.numGlyphs})`);
});

await test('vertical metrics are sane', () => {
    assert(font.ascender > 500, `ascender ${font.ascender}`);
    assert(font.descender < 0, `descender ${font.descender}`);
    assert(font.capHeight > 400, `capHeight ${font.capHeight}`);
    assert(font.bbox[2] > 0 && font.bbox[0] < font.bbox[2], 'bbox width positive');
    assert(Math.abs(font.italicAngle) < 1, 'upright font');
});

console.log('\n🗺️  Coverage');

await test('maps latin, hanzi and punctuation', () => {
    assert(font.gidFor('A') > 0, 'A');
    assert(font.gidFor('中') > 0, '中');
    assert(font.gidFor('猫') > 0, '猫');
    assert(font.gidFor('，') > 0, '，');
    assert(font.gidFor('→') > 0, '→');
    assert(font.gidFor('Ω') > 0, 'Ω');
});

await test('reports emoji as uncovered', () => {
    assertEqual(font.gidFor('🦄'), 0, 'emoji gid');
    assert(!font.hasGlyph('🦄'), 'hasGlyph(emoji)');
});

await test('coversText works on mixed content', () => {
    assert(font.coversText('中文 English 123，。(→Ω)'), 'mixed text covered');
    assert(!font.coversText('带 emoji 🦄'), 'emoji detected');
});

console.log('\n📏 Widths');

await test('advance widths are positive and scaled to 1000', () => {
    const latin = font.advanceWidth1000(font.gidFor('A'));
    const han = font.advanceWidth1000(font.gidFor('中'));
    assert(latin > 200 && latin < 1000, `latin width ${latin}`);
    assert(han > 800 && han <= 1000, `han width ${han}`);
});

await test('textWidth scales linearly with size', () => {
    const at12 = font.textWidth('中文abc', 12);
    const at24 = font.textWidth('中文abc', 24);
    assert(at12 > 0, 'positive width');
    assert(Math.abs(at24 - at12 * 2) < 0.01, 'linear scaling');
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
