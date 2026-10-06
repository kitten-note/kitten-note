/* Dump JS feature names for the first rows of the test split (debug). */
import { readFileSync } from 'node:fs';
import { extractFeatureNames } from './eft.mjs';

const rows = readFileSync(new URL('../data/samples/test.jsonl', import.meta.url), 'utf-8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const only = process.argv[2] ? Number(process.argv[2]) : null;
const picked = only === null ? rows.slice(0, 3) : [rows[only]];

const out = picked.map((r, i) => ({
    row: only === null ? i : only,
    left: r.left,
    span: r.span,
    right: r.right,
    names: extractFeatureNames(r.left, r.span, r.right),
}));
console.log(JSON.stringify(out));
