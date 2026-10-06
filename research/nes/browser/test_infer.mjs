/*
 * Golden-vector test: JS reference runtime vs Python training pipeline.
 * Run: node browser/test_infer.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EftModel, extractFeatureIds } from './eft.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'artifacts', 'v0', 'browser');

function fetchLocal(prefix) {
    // Minimal fetch shim so EftModel.load works under Node
    return async (url) => {
        const name = String(url).replace(prefix, '').replace(/^\.\//, '');
        const buffer = readFileSync(path.join(bundle, name));
        return {
            ok: true,
            json: async () => JSON.parse(buffer.toString('utf-8')),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        };
    };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = fetchLocal(bundle);

const model = await EftModel.load(`${bundle}/`);
const vectors = JSON.parse(readFileSync(path.join(bundle, 'test_vectors.json'), 'utf-8'));

globalThis.fetch = originalFetch;

let maxHdc = 0;
let maxSoftmax = 0;
let classMatches = 0;

for (const row of vectors) {
    const prediction = model.predict(row.left, row.span, row.right, { model: 'hdc' });
    const softmaxPrediction = model.predict(row.left, row.span, row.right, { model: 'softmax' });
    for (let c = 0; c < row.hdc_probs.length; c++) {
        maxHdc = Math.max(maxHdc, Math.abs(prediction.probs[c] - row.hdc_probs[c]));
        maxSoftmax = Math.max(maxSoftmax, Math.abs(softmaxPrediction.probs[c] - row.softmax_probs[c]));
    }
    const expected = row.hdc_probs.indexOf(Math.max(...row.hdc_probs));
    if (prediction.probs.indexOf(Math.max(...prediction.probs)) === expected) classMatches++;
}

console.log(`vectors: ${vectors.length}`);
console.log(`max |Δ| HDC probs:     ${maxHdc.toExponential(3)}`);
console.log(`max |Δ| softmax probs: ${maxSoftmax.toExponential(3)}`);
console.log(`top-1 agreement (HDC): ${classMatches}/${vectors.length}`);

const tolerance = 1e-4;
if (maxHdc > tolerance || maxSoftmax > tolerance || classMatches !== vectors.length) {
    console.error('FAIL: JS runtime does not match the Python pipeline');
    process.exit(1);
}
console.log('PASS: browser runtime matches the training pipeline');
