/*
 * App-level test for the encoder engine + threshold calibration.
 *
 * Sweeps held-out samples at several operating thresholds and reports
 * fired / type-check-passed / class-match counts.
 *
 * Run from the repo root:
 *     node research/nes/browser/test_enc_app.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EncEngine, applyAtom } from '../../../js/enc-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'artifacts', 'enc-s-full', 'browser');
const appEft = join(here, '../../../assets/eft');

const toArrayBuffer = (buffer) =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const meta = JSON.parse(readFileSync(join(bundle, 'model.json'), 'utf8'));
const stoi = JSON.parse(readFileSync(join(bundle, 'vocab.json'), 'utf8'));
const weights = toArrayBuffer(readFileSync(join(bundle, 'weights.bin')));
const content = JSON.parse(readFileSync(join(appEft, 'content.json'), 'utf8'));

const engine = EncEngine.fromBuffers(meta, stoi, weights, content);

const rows = readFileSync(join(here, '..', 'data', 'samples', 'test.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const edits = rows.filter((row) => row.label !== 0).slice(0, 120);

for (const threshold of [4, 6, 8, 10, 12]) {
    let fired = 0;
    let applied = 0;
    let classMatch = 0;
    for (const row of edits) {
        const document = row.left + row.span + row.right;
        const suggestions = engine.suggest(document, row.left.length + 1, { maxResults: 1, threshold });
        if (!suggestions.length) continue;
        fired += 1;
        const suggestion = suggestions[0];
        if (applyAtom(document, suggestion.atom) !== null) applied += 1;
        if (suggestion.className === meta.classes[row.label]) classMatch += 1;
    }
    console.log(`threshold=${threshold}: fired=${fired} applied=${applied} classMatch=${classMatch}`);
}
