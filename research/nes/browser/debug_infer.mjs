/* Locate test vectors where JS and Python disagree (debug). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EftModel } from './eft.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'artifacts', 'v0', 'browser');

globalThis.fetch = async (url) => {
    const name = String(url).replace(`${bundle}/`, '');
    const buffer = readFileSync(path.join(bundle, name));
    return {
        ok: true,
        json: async () => JSON.parse(buffer.toString('utf-8')),
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
};

const model = await EftModel.load(`${bundle}/`);
const vectors = JSON.parse(readFileSync(path.join(bundle, 'test_vectors.json'), 'utf-8'));

const hasAstral = (s) => /[\u{10000}-\u{10FFFF}]/u.test(s);

const rowsWithDelta = vectors.map((row, index) => {
    const hdc = model.predict(row.left, row.span, row.right, { model: 'hdc' });
    const softmax = model.predict(row.left, row.span, row.right, { model: 'softmax' });
    const dHdc = Math.max(...row.hdc_probs.map((p, c) => Math.abs(p - hdc.probs[c])));
    const dSoft = Math.max(...row.softmax_probs.map((p, c) => Math.abs(p - softmax.probs[c])));
    return { index, row, hdc, softmax, dHdc, dSoft };
});

const worst = [...rowsWithDelta].sort((a, b) => Math.max(b.dHdc, b.dSoft) - Math.max(a.dHdc, a.dSoft)).slice(0, 3);
let bad = 0;
for (const item of rowsWithDelta) {
    if (item.dHdc > 1e-4 || item.dSoft > 1e-4) bad++;
}

for (const item of worst) {
    const { row } = item;
    console.log(`#${item.index} dHdc=${item.dHdc.toExponential(2)} dSoft=${item.dSoft.toExponential(2)} astral=${hasAstral(row.left + row.span + row.right)}`);
    console.log(`   left =${JSON.stringify(row.left.slice(-24))}`);
    console.log(`   span =${JSON.stringify(row.span)}`);
    console.log(`   right=${JSON.stringify(row.right.slice(0, 24))}`);
    console.log(`   pySoft=${row.softmax_probs.map((p) => p.toFixed(4)).join(',')}`);
    console.log(`   jsSoft=${Array.from(item.softmax.probs).map((p) => p.toFixed(4)).join(',')}`);
}
console.log(`bad vectors: ${bad}/${vectors.length}`);
