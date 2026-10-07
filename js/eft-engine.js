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
 * KittenNote - EFT engine (v0 on-device next-edit predictor).
 *
 * Wraps assets/eft/eft.js, which is bit-identical to the Python research
 * pipeline (golden vectors in research/nes/browser/test_infer.mjs):
 *
 *   typed candidate sweep -> gate (softmax, calibrated) -> per-class thresholds
 *   -> content-layer payload (char n-grams, copy-only grounding)
 *   -> type check (apply_atom mirror) -> at most one suggestion per window
 *
 * v0 only enables classes whose payload can be grounded on-device:
 *   FIX_CHAR / DEL_CHAR / INS_CHAR / DEL_SPAN
 * INS_SPAN_COPY and FMT_BULLET are structural operations and stay disabled
 * until they get rule-based candidate generation (they misfire as local
 * classifiers - a documented v0 limitation).
 */

import { EftModel } from '../assets/eft/eft.js';

const DESTRUCTIVE = new Set(['DEL_CHAR', 'DEL_SPAN']);
const DESTRUCTIVE_MIN_CONFIDENCE = 0.55;
const DISABLED_CLASSES = new Set(['FMT_BULLET', 'INS_SPAN_COPY']);
const FEATURE_MODEL = 'softmax';

const MIN_DOCUMENT_LENGTH = 24;   // shorter text is out of the training distribution
const SWEEP_LEFT = 180;           // chars before cursor to scan
const SWEEP_RIGHT = 24;           // chars after cursor to scan

// Mirror of atoms.py LITERAL_CHARS (INS_CHAR payload whitelist).
const LITERAL_CHARS = new Set(Array.from(
    '，。！？；：、（）《》〈〉【】“”‘’—…·,.!?;:()[]{}<>\'"`-–~/\\|+=*&^%$#@! \n' +
    '0123456789' +
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    '＋－＝＊／％＃＠＆～｜'
));

/** Mirror of atoms.py apply_atom (type system). Returns new text or null. */
export function applyAtom(text, atom) {
    if (typeof text !== 'string' || !atom) return null;
    const kind = atom.type;
    if (kind === 'NO_EDIT') return text;

    if (kind === 'FIX_CHAR') {
        const { pos, char } = atom;
        if (!Number.isInteger(pos) || typeof char !== 'string' || Array.from(char).length !== 1) return null;
        if (pos < 0 || pos >= text.length || text[pos] === char) return null;
        return text.slice(0, pos) + char + text.slice(pos + 1);
    }
    if (kind === 'DEL_CHAR') {
        const { pos } = atom;
        if (!Number.isInteger(pos) || pos < 0 || pos >= text.length) return null;
        return text.slice(0, pos) + text.slice(pos + 1);
    }
    if (kind === 'INS_CHAR') {
        const { pos, char } = atom;
        if (!Number.isInteger(pos) || typeof char !== 'string' || Array.from(char).length !== 1) return null;
        if (pos < 0 || pos > text.length || !LITERAL_CHARS.has(char)) return null;
        return text.slice(0, pos) + char + text.slice(pos);
    }
    if (kind === 'DEL_SPAN') {
        const { start, end } = atom;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
        if (start < 0 || end > text.length || start >= end || end - start < 2) return null;
        return text.slice(0, start) + text.slice(end);
    }
    if (kind === 'INS_SPAN_COPY') {
        const { pos, payload } = atom;
        if (!Number.isInteger(pos) || pos < 0 || pos > text.length || !payload) return null;
        if (!text.includes(payload)) return null;
        return text.slice(0, pos) + payload + text.slice(pos);
    }
    if (kind === 'FMT_BULLET') {
        const { line_start: lineStart, action } = atom;
        if (!Number.isInteger(lineStart) || lineStart < 0 || lineStart > text.length) return null;
        if (action === 'remove') {
            for (const marker of ['- ', '* ', '+ ']) {
                if (text.startsWith(marker, lineStart)) {
                    return text.slice(0, lineStart) + text.slice(lineStart + marker.length);
                }
            }
            return null;
        }
        if (action === 'add') return text.slice(0, lineStart) + '- ' + text.slice(lineStart);
        return null;
    }
    return null;
}

/** Human-readable description of an atom for the suggestion card. */
export function describeAtom(atom, document) {
    if (!atom) return '';
    if (atom.type === 'FIX_CHAR') return `将「${document[atom.pos] || ''}」改为「${atom.char}」`;
    if (atom.type === 'DEL_CHAR') return `删除多余的「${document[atom.pos] || ''}」`;
    if (atom.type === 'INS_CHAR') {
        const next = document[atom.pos] || '';
        return next ? `在「${next}」前插入「${atom.char}」` : `在末尾插入「${atom.char}」`;
    }
    if (atom.type === 'DEL_SPAN') return `删除「${document.slice(atom.start, atom.end)}」`;
    if (atom.type === 'INS_SPAN_COPY') return `插入「${atom.payload}」`;
    if (atom.type === 'FMT_BULLET') return '行首加「- 」';
    return '';
}

/** Plain-text edit range for the editor ({start, end, replacement}). */
export function atomEditRange(atom) {
    if (atom.type === 'FIX_CHAR') return { start: atom.pos, end: atom.pos + 1, replacement: atom.char };
    if (atom.type === 'DEL_CHAR') return { start: atom.pos, end: atom.pos + 1, replacement: '' };
    if (atom.type === 'INS_CHAR') return { start: atom.pos, end: atom.pos, replacement: atom.char };
    if (atom.type === 'DEL_SPAN') return { start: atom.start, end: atom.end, replacement: '' };
    if (atom.type === 'INS_SPAN_COPY') return { start: atom.pos, end: atom.pos, replacement: atom.payload };
    return null;
}

function expandSpan(text, pos, maxLen = 4) {
    // Bounded word chunk starting at pos (no left expansion): DEL_SPAN
    // proposals must stay small - the v0 filler-deletion spans are 2-4 chars.
    if (pos < 0 || pos >= text.length) return '';
    const stop = ' \n\t，。！？；：、（）';
    let end = pos;
    while (end < text.length && !stop.includes(text[end]) && end - pos < maxLen) {
        end += 1;
    }
    return text.slice(pos, end);
}

export class EftEngine {
    constructor(model, content) {
        this.model = model;
        this.content = content || { uni: {}, bi: {} };
    }

    static async load(prefix = './assets/eft/') {
        const model = await EftModel.load(prefix);
        let content = { uni: {}, bi: {} };
        try {
            content = await (await fetch(`${prefix}content.json`)).json();
        } catch (error) {
            console.warn('EFT content tables unavailable; payload proposals limited.', error);
        }
        return new EftEngine(model, content);
    }

    static fromBuffers(meta, prototypesBuffer, baseBuffer, softmaxBuffer, content) {
        const prototypes = new Float64Array(prototypesBuffer);
        const basePacked = new Uint8Array(baseBuffer);
        const weights = new Float64Array(softmaxBuffer, 0, meta.feature_dim * meta.classes.length);
        const bias = new Float64Array(softmaxBuffer, weights.byteLength, meta.classes.length);
        const model = new EftModel(meta, prototypes, basePacked, weights, bias);
        return new EftEngine(model, content);
    }

    /** Copy-only payload proposals: longest char n-gram suffix match. */
    proposeNext(context) {
        const chars = Array.from(context);
        for (let k = 2; k >= 1; k--) {
            if (chars.length < k) continue;
            const key = chars.slice(-k).join('');
            const table = k === 2 ? this.content.bi : this.content.uni;
            const next = table && table[key];
            if (next) return Array.from(next);
        }
        return [];
    }

    resolveAtom(className, document, pos) {
        if (className === 'FIX_CHAR') {
            for (const char of this.proposeNext(document.slice(0, pos))) {
                if (char !== document[pos] && char.trim()) return { type: 'FIX_CHAR', pos, char };
            }
            return null;
        }
        if (className === 'INS_CHAR') {
            for (const char of this.proposeNext(document.slice(0, pos))) {
                if (char.trim()) return { type: 'INS_CHAR', pos, char };
            }
            return null;
        }
        if (className === 'DEL_CHAR') return { type: 'DEL_CHAR', pos };
        if (className === 'DEL_SPAN') {
            const span = expandSpan(document, pos, 4);
            if (Array.from(span).length >= 2) {
                return { type: 'DEL_SPAN', start: pos, end: pos + span.length };
            }
            return null;
        }
        return null;
    }

    /**
     * Sweep positions around the cursor and return the best typed suggestions
     * plus full diagnostics (for the log overlay / console).
     */
    suggestDetailed(document, cursorOffset, { maxResults = 1 } = {}) {
        const details = {
            documentLength: typeof document === 'string' ? document.length : 0,
            window: null,
            positions: 0,
            gateFired: 0,
            passedFilters: 0,
            rejected: { gate: 0, disabledClass: 0, classThreshold: 0, destructive: 0, noPayload: 0, typeCheck: 0 },
            best: null,
            suggestions: [],
        };
        if (typeof document !== 'string' || document.length < MIN_DOCUMENT_LENGTH) return details;
        if (!this.model) return details;

        const from = Math.max(0, cursorOffset - SWEEP_LEFT);
        const to = Math.min(document.length, cursorOffset + SWEEP_RIGHT);
        details.window = { from, to };

        for (let pos = from; pos < to; pos++) {
            details.positions += 1;
            const span = document[pos];
            if (!span || span === '\n') continue;

            const left = document.slice(Math.max(0, pos - 64), pos);
            const right = document.slice(pos + 1, pos + 33);
            const prediction = this.model.predict(left, span, right, { model: FEATURE_MODEL });

            if (!details.best || prediction.editProbability > details.best.editProbability) {
                details.best = {
                    pos,
                    className: prediction.class,
                    editProbability: prediction.editProbability,
                    confidence: prediction.confidence,
                };
            }

            if (!prediction.fire) {
                details.rejected.gate += 1;
                continue;
            }
            details.gateFired += 1;

            const className = prediction.class;
            if (className === 'NO_EDIT' || DISABLED_CLASSES.has(className)) {
                details.rejected.disabledClass += 1;
                continue;
            }

            const classThreshold = this.model.meta.class_thresholds?.[className] ?? 0;
            if (prediction.confidence < classThreshold) {
                details.rejected.classThreshold += 1;
                continue;
            }
            if (DESTRUCTIVE.has(className) && prediction.confidence < DESTRUCTIVE_MIN_CONFIDENCE) {
                details.rejected.destructive += 1;
                continue;
            }

            const atom = this.resolveAtom(className, document, pos);
            if (!atom) {
                details.rejected.noPayload += 1;
                continue;
            }
            if (applyAtom(document, atom) === null) {
                details.rejected.typeCheck += 1;
                continue;
            }

            details.passedFilters += 1;
            details.suggestions.push({
                pos,
                className,
                editProbability: prediction.editProbability,
                confidence: prediction.confidence,
                atom,
                description: describeAtom(atom, document),
            });
        }

        details.suggestions.sort((a, b) => b.editProbability - a.editProbability);
        details.suggestions = details.suggestions.slice(0, Math.max(1, maxResults));
        return details;
    }

    /**
     * Sweep positions around the cursor and return the best typed suggestions.
     * @returns {Array<{pos:number, className:string, editProbability:number,
     *                  confidence:number, atom:object, description:string}>}
     */
    suggest(document, cursorOffset, options) {
        return this.suggestDetailed(document, cursorOffset, options).suggestions;
    }
}
