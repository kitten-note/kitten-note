/*
 * Smoke test for the app-side EFT engine (js/eft-engine.js) under Node.
 *
 * Reads the app bundle from assets/eft/ and runs suggestions on held-out
 * synthetic samples, verifying that every returned suggestion passes the
 * type check (apply_atom mirror). Run from the repo root:
 *
 *     node research/nes/browser/test_app_engine.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EftEngine, applyAtom, atomEditRange } from '../../../js/eft-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const appEft = join(here, '../../../assets/eft');

const toArrayBuffer = (buffer) =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const meta = JSON.parse(readFileSync(join(appEft, 'model.json'), 'utf8'));
const prototypes = toArrayBuffer(readFileSync(join(appEft, 'prototypes.bin')));
const base = toArrayBuffer(readFileSync(join(appEft, 'base.bin')));
const softmax = toArrayBuffer(readFileSync(join(appEft, 'softmax.bin')));
const content = JSON.parse(readFileSync(join(appEft, 'content.json'), 'utf8'));

const engine = EftEngine.fromBuffers(meta, prototypes, base, softmax, content);

const rows = readFileSync(join(here, '..', 'data', 'samples', 'test.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const edits = rows.filter((row) => row.label !== 0).slice(0, 120);
let fired = 0;
let applied = 0;
let classMatch = 0;

for (const row of edits) {
    const document = row.left + row.span + row.right;
    const cursor = row.left.length + 1;
    const suggestions = engine.suggest(document, cursor, { maxResults: 1 });
    if (!suggestions.length) continue;

    fired += 1;
    const suggestion = suggestions[0];
    const range = atomEditRange(suggestion.atom);
    if (range && applyAtom(document, suggestion.atom) !== null) {
        applied += 1;
    }
    if (suggestion.className === meta.classes[row.label]) {
        classMatch += 1;
    }
}

console.log(`rows=${edits.length} fired=${fired} applied=${applied} classMatch=${classMatch}`);

if (fired < 5) {
    throw new Error(`expected at least 5 fired suggestions, got ${fired}`);
}
if (applied !== fired) {
    throw new Error(`type check failed for ${fired - applied} fired suggestions`);
}
console.log('PASS: app EFT engine produces typed suggestions');
