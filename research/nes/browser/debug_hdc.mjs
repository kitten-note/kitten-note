/* Dump JS HDC cosines for row 94 (debug). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EftModel, extractFeatureIds } from './eft.mjs';

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
const rows = readFileSync(new URL('../data/samples/test.jsonl', import.meta.url), 'utf-8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const row = rows[94];
const ids = extractFeatureIds(row.left, row.span, row.right);
const { vector, norm } = model.bundle(ids);

const dim = model.dim;
const cosines = [];
for (let c = 0; c < model.classCount; c++) {
    let dot = 0;
    let protoNorm = 0;
    const offset = c * dim;
    for (let i = 0; i < dim; i++) {
        const p = model.prototypes[offset + i];
        dot += p * vector[i];
        protoNorm += p * p;
    }
    cosines.push(dot / Math.max(Math.sqrt(protoNorm) * norm, 1e-9));
}

const probs = Array.from(model.hdcProbs(ids));
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../data/vec_js.txt', import.meta.url),
    vector.map((v) => (v > 0 ? '1' : '0')).join(''));

const sortedIds = [...ids].sort((a, b) => a - b);
const rowBytes = model.dim / 8;
const bitAt = (id, pos) => {
    const byteIndex = Math.floor(pos / 8);
    const bit = pos % 8;
    const byte = model.basePacked[(id % model.meta.hdc_bins) * rowBytes + byteIndex];
    return (byte >> (7 - bit)) & 1;
};
const bits861 = sortedIds.map((id) => bitAt(id, 861));

console.log(JSON.stringify({
    id_count: sortedIds.length,
    bits_at_861: bits861,
    ids: [...ids].sort((a, b) => a - b),
    cosines,
    probs,
    scale: model.meta.hdc_scale,
    prototype_row0: Array.from(model.prototypes.slice(0, 8)),
}));
