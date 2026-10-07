/*
 * Parity test: JS encoder runtime vs torch logits on held-out windows.
 *
 * Run from the repo root:
 *     node research/nes/browser/test_enc_parity.mjs
 *
 * Checks max |logit| drift and argmax agreement per gap.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EncModel } from './enc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'artifacts', 'enc-s-full', 'browser');

const toArrayBuffer = (buffer) =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const meta = JSON.parse(readFileSync(join(bundle, 'model.json'), 'utf8'));
const stoi = JSON.parse(readFileSync(join(bundle, 'vocab.json'), 'utf8'));
const weights = toArrayBuffer(readFileSync(join(bundle, 'weights.bin')));
const vectors = JSON.parse(readFileSync(join(bundle, 'test_vectors.json'), 'utf8'));

const model = EncModel.fromBuffers(meta, stoi, weights);

let maxDrift = 0;
let gaps = 0;
let agreed = 0;

for (const vector of vectors) {
    const logits = model.forward(vector.tokens);
    const expected = vector.logits;
    for (let i = 0; i < vector.tokens.length; i++) {
        let best = 0;
        let bestExpected = 0;
        for (let c = 0; c < 7; c++) {
            const drift = Math.abs(logits[i * 7 + c] - expected[i][c]);
            if (drift > maxDrift) maxDrift = drift;
            if (logits[i * 7 + c] > logits[i * 7 + best]) best = c;
            if (expected[i][c] > expected[i][bestExpected]) bestExpected = c;
        }
        gaps += 1;
        if (best === bestExpected) agreed += 1;
    }
}

console.log(`windows=${vectors.length} gaps=${gaps}`);
console.log(`max |logit drift| = ${maxDrift.toExponential(3)}`);
console.log(`argmax agreement   = ${agreed}/${gaps}`);

if (!(maxDrift < 5e-3)) {
    throw new Error(`logit drift too large: ${maxDrift}`);
}
if (agreed !== gaps) {
    throw new Error(`argmax mismatch on ${gaps - agreed} gaps`);
}
console.log('PASS: JS encoder runtime matches torch');
