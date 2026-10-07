/*
 * Realistic-text probe: calibrate the app operating threshold on
 * human-like text (notes/chat/essay styles) instead of synthetic windows.
 *
 * Texts with planted natural typos (expectFire=true) vs clean texts.
 * Reports per-threshold fired counts end-to-end (with content layer +
 * type check, exactly like the app path).
 *
 * Run from the repo root:
 *     node research/nes/browser/probe_realistic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EncEngine, applyAtom } from '../../../js/enc-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundleName = process.argv[2] || 'enc-s-full';
const bundle = join(here, '..', 'artifacts', bundleName, 'browser');
const appEft = join(here, '../../../assets/eft');

const toArrayBuffer = (buffer) =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const meta = JSON.parse(readFileSync(join(bundle, 'model.json'), 'utf8'));
const stoi = JSON.parse(readFileSync(join(bundle, 'vocab.json'), 'utf8'));
const weights = toArrayBuffer(readFileSync(join(bundle, 'weights.bin')));
const content = JSON.parse(readFileSync(join(appEft, 'content.json'), 'utf8'));
content.confusion = JSON.parse(readFileSync(join(appEft, 'confusion.json'), 'utf8'));

const engine = EncEngine.fromBuffers(meta, stoi, weights, content);

// Planted typos are the kind real users make (not synthetic homophone swaps).
const TYPO_TEXTS = [
    '今天开会讨论了下个季度的目标，老板说的很对，我们确实需要在效率上在下功夫。',
    '这本书我已经看完了，写的非常好，尤其是最后一章，让人回味无穷。',
    '明天早上八点在公司楼下集合，不要迟到了，记得带好身份证和电脑。',
    '他做事总是这么认真，每一个细节都不放过，难怪大家都服他。',
    '这个方案还有几个问题需要解决，特别是预算的部分，超出了我们的预期。',
    '孩子们在操场上开心的玩耍着，笑声传的很远很远。',
    '我昨天去超市买了很多东西，有水果蔬菜，还有一些日常用品。',
    '这部电影的剧情非常的紧凑，演员的表演也很到位，值得一看。',
    '学习计划已经制定好了，接下来就是要严格的执行，不能三天打鱼两天晒网。',
    '窗外的雨下的很大，路上的行人匆匆忙忙的赶着回家。',
];

const CLEAN_TEXTS = [
    '今天开会讨论了下个季度的目标，老板说得很对，我们确实需要在效率上下功夫。',
    '这本书我已经看完了，写得非常好，尤其是最后一章，让人回味无穷。',
    '明天早上八点在公司楼下集合，不要迟到，记得带好身份证和电脑。',
    '他做事总是这么认真，每一个细节都不放过，难怪大家都服他。',
    '孩子们在操场上开心地玩耍着，笑声传得很远很远。',
    '窗外的雨下得很大，路上的行人匆匆忙忙地赶着回家。',
];

for (const threshold of [2, 3, 4, 5, 6, 8]) {
    let typoFired = 0;
    let cleanFired = 0;
    const typoHits = [];
    for (const text of TYPO_TEXTS) {
        const suggestions = engine.suggest(text, text.length, { maxResults: 1, threshold });
        if (suggestions.length && applyAtom(text, suggestions[0].atom) !== null) {
            typoFired += 1;
            typoHits.push(`${suggestions[0].className}@${suggestions[0].pos}:${suggestions[0].description}`);
        }
    }
    for (const text of CLEAN_TEXTS) {
        const suggestions = engine.suggest(text, text.length, { maxResults: 1, threshold });
        if (suggestions.length && applyAtom(text, suggestions[0].atom) !== null) {
            cleanFired += 1;
        }
    }
    console.log(`T=${threshold}: typo texts fired ${typoFired}/${TYPO_TEXTS.length}, clean texts fired ${cleanFired}/${CLEAN_TEXTS.length}`);
    for (const hit of typoHits.slice(0, 4)) {
        console.log(`    ${hit}`);
    }
}
