/*
 * KittenNote
 * Copyright (C) 2026 Author of KittenNote
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * KittenNote - EFT-v1 encoder engine (on-device next-edit predictor).
 *
 * One forward pass tags every gap of the document (gap i = "before char i"):
 *   FIX_CHAR / DEL_CHAR @ gap i (i>=1)  -> char at i-1
 *   INS_CHAR @ gap i                    -> insertion point i
 *   DEL_SPAN over consecutive gaps      -> merged into one span
 *   NO_EDIT                             -> nothing
 *
 * Payloads come from the shared copy-only content layer (EftEngine helper),
 * every suggestion passes the apply_atom type check. Structural classes
 * (INS_SPAN_COPY / FMT_BULLET) stay disabled until span tables exist.
 */

import { EncModel } from '../assets/enc/enc.js';
import { EftEngine, applyAtom, describeAtom, atomEditRange } from './eft-engine.js';

const DISABLED_CLASSES = new Set(['INS_SPAN_COPY', 'FMT_BULLET']);
const MIN_DOCUMENT_LENGTH = 24;
const WINDOW_LEFT = 200;
const WINDOW_RIGHT = 40;
const SUPPRESS_DISTANCE = 5;
// Deletions destroy text: DEL_SPAN needs a higher bar than the gate.
const DEL_SPAN_EXTRA = 4.0;

export { applyAtom, describeAtom, atomEditRange };

/** Build a bidirectional confusion map {char -> [alternatives]}. */
function buildConfusion(raw) {
    const map = new Map();
    const add = (a, b) => {
        if (typeof a !== 'string' || typeof b !== 'string' || a === b) return;
        if (Array.from(a).length !== 1 || Array.from(b).length !== 1) return;
        if (!map.has(a)) map.set(a, []);
        if (!map.get(a).includes(b)) map.get(a).push(b);
    };
    for (const [char, alts] of Object.entries(raw || {})) {
        for (const alt of alts || []) {
            add(char, alt);
            add(alt, char);
        }
    }
    return map;
}

export class EncEngine {
    constructor(model, contentHelper, confusion) {
        this.model = model;
        this.content = contentHelper;
        this.confusion = confusion || new Map();
    }

    static async load(prefix = './assets/enc/') {
        const model = await EncModel.load(prefix);
        let content = { uni: {}, bi: {} };
        try {
            content = await (await fetch('./assets/eft/content.json')).json();
        } catch (error) {
            console.warn('ENC content tables unavailable; payload proposals limited.', error);
        }
        let confusion = new Map();
        try {
            confusion = buildConfusion(await (await fetch('./assets/eft/confusion.json')).json());
        } catch (error) {
            console.warn('ENC confusion table unavailable.', error);
        }
        return new EncEngine(model, new EftEngine(null, content), confusion);
    }

    static fromBuffers(meta, stoi, weightsBuffer, content) {
        const model = EncModel.fromBuffers(meta, stoi, weightsBuffer);
        const confusion = buildConfusion(content && content.confusion);
        return new EncEngine(model, new EftEngine(null, content || { uni: {}, bi: {} }), confusion);
    }

    /** Candidate payloads for FIX_CHAR (confusion table only). */
    fixPayload(document, pos) {
        const alts = this.confusion.get(document[pos]) || [];
        return alts.length ? alts[0] : null;
    }

    /**
     * @returns {Array<{pos:number, className:string, editProbability:number,
     *                  confidence:number, atom:object, description:string}>}
     */
    suggest(document, cursorOffset, { maxResults = 1, threshold = 4.0 } = {}) {
        if (typeof document !== 'string' || document.length < MIN_DOCUMENT_LENGTH) return [];
        if (!this.model) return [];

        const from = Math.max(0, cursorOffset - WINDOW_LEFT);
        const to = Math.min(document.length, cursorOffset + WINDOW_RIGHT);
        const slice = document.slice(from, to);
        if (!slice) return [];

        const tags = this.model.tagDocument(slice);
        const results = [];

        // Merge consecutive DEL_SPAN gaps into single spans first.
        let spanStart = -1;
        const flushSpan = (endGap) => {
            if (spanStart < 1) {
                spanStart = -1;
                return;
            }
            const start = from + spanStart - 1;
            const end = from + endGap;
            if (end - start < 2) {
                spanStart = -1;
                return;
            }
            // Score = max log-odds over the merged gaps.
            let best = null;
            for (let g = spanStart; g <= endGap; g++) {
                const tag = tags[g];
                if (!best || tag.logodds > best.logodds) {
                    best = { ...tag, gap: g };
                }
            }
            // DEL_SPAN bypassed the gate before; enforce a higher bar here.
            if (!best || best.logodds < threshold + DEL_SPAN_EXTRA) {
                spanStart = -1;
                return;
            }
            const atom = { type: 'DEL_SPAN', start, end };
            if (applyAtom(document, atom) !== null) {
                results.push({
                    pos: start,
                    className: 'DEL_SPAN',
                    editProbability: 1 - 1 / (1 + Math.exp(best.logodds)),
                    confidence: best.confidence,
                    atom,
                    description: describeAtom(atom, document),
                    score: best.logodds,
                });
            }
            spanStart = -1;
        };

        for (let gap = 0; gap < tags.length; gap++) {
            const tag = tags[gap];
            if (tag.class === 4 && !DISABLED_CLASSES.has('DEL_SPAN')) {
                if (spanStart < 0) spanStart = gap;
                continue;
            }
            if (spanStart >= 0) flushSpan(gap - 1);

            if (tag.class === 0) continue;
            const className = ['NO_EDIT', 'FIX_CHAR', 'DEL_CHAR', 'INS_CHAR', 'DEL_SPAN', 'INS_SPAN_COPY', 'FMT_BULLET'][tag.class];
            if (className === 'NO_EDIT' || DISABLED_CLASSES.has(className)) continue;
            if (tag.logodds < threshold) continue;

            let atom = null;
            let pos = -1;
            if ((className === 'FIX_CHAR' || className === 'DEL_CHAR') && gap >= 1) {
                pos = from + gap - 1;
                if (className === 'FIX_CHAR') {
                    // Confusion table only: every FIX suggestion is a known
                    // common confusion (high precision by construction). No
                    // n-gram fallback (it proposes rare-char garbage OOD).
                    const payload = this.fixPayload(document, pos);
                    if (payload === null || payload === document[pos]) continue;
                    atom = { type: 'FIX_CHAR', pos, char: payload };
                } else {
                    atom = { type: 'DEL_CHAR', pos };
                }
            } else if (className === 'INS_CHAR') {
                pos = from + gap;
                if (pos > document.length) continue;
                atom = this.content.resolveAtom('INS_CHAR', document, pos);
            } else {
                continue;
            }

            if (!atom || applyAtom(document, atom) === null) continue;
            results.push({
                pos,
                className,
                editProbability: 1 - 1 / (1 + Math.exp(tag.logodds)),
                confidence: tag.confidence,
                atom,
                description: describeAtom(atom, document),
                score: tag.logodds,
            });
        }
        if (spanStart >= 0) flushSpan(tags.length - 1);

        results.sort((a, b) => b.score - a.score);
        const accepted = [];
        for (const candidate of results) {
            if (accepted.length >= Math.max(1, maxResults)) break;
            if (accepted.some((item) => Math.abs(item.pos - candidate.pos) < SUPPRESS_DISTANCE)) continue;
            accepted.push(candidate);
        }
        return accepted;
    }

    /**
     * Full sweep trace for diagnostics (log overlay / console / self-test).
     */
    suggestDetailed(document, cursorOffset, options = {}) {
        const { maxResults = 1, threshold = 4.0 } = options;
        const details = {
            engine: 'enc-v1',
            documentLength: typeof document === 'string' ? document.length : 0,
            window: null,
            positions: 0,
            gateFired: 0,
            passedFilters: 0,
            best: null,
            suggestions: [],
            ms: 0,
        };
        if (typeof document !== 'string' || document.length < MIN_DOCUMENT_LENGTH) return details;
        if (!this.model) return details;

        const clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
        const started = clock.now();
        const from = Math.max(0, cursorOffset - WINDOW_LEFT);
        const to = Math.min(document.length, cursorOffset + WINDOW_RIGHT);
        const slice = document.slice(from, to);
        if (!slice) return details;
        details.window = { from, to };

        const tags = this.model.tagDocument(slice);
        details.positions = tags.length;
        const suggestions = this.suggest(document, cursorOffset, { maxResults, threshold });
        details.suggestions = suggestions;
        details.passedFilters = suggestions.length;

        let above = 0;
        let best = null;
        for (let gap = 0; gap < tags.length; gap++) {
            const tag = tags[gap];
            if (tag.logodds >= threshold && tag.class !== 0) {
                above += 1;
                if (!best || tag.logodds > best.logodds) {
                    best = { gap, logodds: tag.logodds, class: tag.class, confidence: tag.confidence };
                }
            }
        }
        details.gateFired = above;
        if (best) {
            const classNames = ['NO_EDIT', 'FIX_CHAR', 'DEL_CHAR', 'INS_CHAR', 'DEL_SPAN', 'INS_SPAN_COPY', 'FMT_BULLET'];
            details.best = {
                pos: from + best.gap,
                className: classNames[best.class],
                editProbability: 1 - 1 / (1 + Math.exp(best.logodds)),
                confidence: best.confidence,
            };
        }
        details.ms = Math.round(clock.now() - started);
        return details;
    }
}
