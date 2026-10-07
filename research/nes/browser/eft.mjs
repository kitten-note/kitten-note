/*
 * EFT / NES v0 - browser reference inference (dependency-free ESM).
 *
 * Mirrors the Python feature field and predictors bit-for-bit:
 *   fnv1a64 hashing -> feature ids -> {HDC bundle, sparse softmax} -> gate.
 *
 * Usage (browser or Node):
 *   const model = await EftModel.load('./artifacts/v0/browser/');
 *   model.predict(left, span, right);
 *     -> { class, confidence, probs, fire }
 */

export const ATOM_CLASSES = [
    'NO_EDIT', 'FIX_CHAR', 'DEL_CHAR', 'INS_CHAR', 'DEL_SPAN', 'INS_SPAN_COPY', 'FMT_BULLET',
];

const MASK64 = 0xFFFFFFFFFFFFFFFFn;
const FNV_OFFSET = 0xCBF29CE484222325n;
const FNV_PRIME = 0x100000001B3n;

const CJK_PUNCT = new Set(Array.from('，。！？；：、（）《》“”‘’—…·'));
const PUNCT = new Set(Array.from('，。！？；：、,.!?;:;\"\'“”‘’（）()《》〈〉【】[]—…·'));

function charClass(ch) {
    if (!ch) return 'none';
    if (CJK_PUNCT.has(ch)) return 'cp';
    if (/\s/.test(ch)) return 'sp';
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) return 'cjk';
    // Mirror Python's Unicode-aware str.isdigit()/str.isalpha().
    if (/[\p{Nd}]/u.test(ch)) return 'dig';
    if (/[\p{L}]/u.test(ch)) return 'lat';
    return 'oth';
}

function distanceToPunct(side, cap = 8) {
    const chars = Array.from(side);
    let distance = 1;
    for (let i = chars.length - 1; i >= 0; i--, distance++) {
        if (distance > cap) break;
        const ch = chars[i];
        if (PUNCT.has(ch) || ch === '\n') return distance;
    }
    return cap + 1;
}

function fnv1a64(text) {
    const bytes = new TextEncoder().encode(text);
    let h = FNV_OFFSET;
    for (const byte of bytes) {
        h ^= BigInt(byte);
        h = (h * FNV_PRIME) & MASK64;
    }
    return h;
}

function runLength(left, span, right, cap = 32) {
    // Mirror of features.py _run_length: punctuation-free run at the boundary.
    const stop = (ch) => PUNCT.has(ch) || ch === ' ' || ch === '\n' || ch === '\t';
    let count = 0;
    const lchars = Array.from(left);
    for (let i = lchars.length - 1; i >= 0; i--) {
        if (stop(lchars[i])) break;
        count++;
        if (count >= cap) return cap;
    }
    const schars = Array.from(span);
    if (schars.length > 0) {
        let spanOk = true;
        for (const ch of schars) {
            if (stop(ch)) { spanOk = false; break; }
        }
        if (spanOk) {
            count += schars.length;
            if (count >= cap) return cap;
        }
    }
    const rchars = Array.from(right);
    for (const ch of rchars) {
        if (stop(ch)) break;
        count++;
        if (count >= cap) return cap;
    }
    return Math.min(count, cap);
}

// Code-point aware slicing (mirror of Python's str slicing, which counts code points).
const toChars = (s) => Array.from(s);
const lastN = (s, n) => (n >= s.length ? s : toChars(s).slice(-n).join(''));
const firstN = (s, n) => (n >= s.length ? s : toChars(s).slice(0, n).join(''));

export function extractFeatureNames(left, span, right, lastAtom = 'NONE') {
    const names = [];
    for (let k = 1; k <= 4; k++) {
        if (Array.from(left).length >= k) names.push(`L${k}:${lastN(left, k)}`);
    }
    for (let k = 1; k <= 3; k++) {
        if (Array.from(right).length >= k) names.push(`R${k}:${firstN(right, k)}`);
    }
    names.push(span ? `S:${span}` : 'S:∅');
    names.push(`SL:${Math.min(Array.from(span).length, 8)}`);
    const prev = lastN(left, 1);
    const next = firstN(right, 1);
    names.push(`PC:${charClass(prev)}`);
    names.push(`NC:${charClass(next)}`);
    names.push(`PB:${PUNCT.has(prev) ? 'True' : 'False'}`);
    names.push(`NB:${PUNCT.has(next) ? 'True' : 'False'}`);
    names.push(`PN:${prev === '\n' ? 'True' : 'False'}`);
    names.push(`NN:${next === '\n' ? 'True' : 'False'}`);
    names.push(`PD:${distanceToPunct(left)}`);
    names.push(`ND:${distanceToPunct(right)}`);
    names.push(`CTX:${lastN(left, 8)}→${firstN(right, 4)}`);
    names.push(`TAIL:${lastN(left, 16)}`);
    names.push(`HEAD:${firstN(right, 12)}`);
    // Boundary-crossing features (mirror of features.py)
    const spanChar = span ? firstN(span, 1) : '∅';
    names.push(`BLC:${lastN(left, 1)}${spanChar}`);
    names.push(`BRC:${spanChar}${firstN(right, 1)}`);
    names.push(`B2L:${lastN(left, 2)}${spanChar}`);
    names.push(`B2R:${spanChar}${firstN(right, 2)}`);
    names.push(`XC:${charClass(prev)}${charClass(span ? spanChar : '')}${charClass(next)}`);
    names.push(`CPLEN:${Math.min(Math.floor(runLength(left, span, right) / 4), 6)}`);
    names.push(`BND:${charClass(prev)}${charClass(next)}`);
    names.push(`LA:${lastAtom}`);
    return names;
}

export function extractFeatureIds(left, span, right, lastAtom = 'NONE', featureDim = 16384) {
    const names = extractFeatureNames(left, span, right, lastAtom);
    const ids = new Set();
    for (const name of names) {
        ids.add(Number(fnv1a64(name) % BigInt(featureDim)));
    }
    return Array.from(ids);
}

export class EftModel {
    constructor(meta, prototypes, basePacked, softmaxWeights, softmaxBias) {
        this.meta = meta;
        this.prototypes = prototypes;         // Float64Array (C * D)
        this.basePacked = basePacked;         // Uint8Array (F * D/8)
        this.weights = softmaxWeights;        // Float64Array (D * C)
        this.bias = softmaxBias;              // Float64Array (C)
        this.classes = meta.classes || ATOM_CLASSES;
        this.classCount = this.classes.length;
        this.dim = meta.hdc_dim;
        this.featureDim = meta.feature_dim;
    }

    static async load(prefix) {
        const meta = await (await fetch(`${prefix}model.json`)).json();
        const prototypes = new Float64Array(await (await fetch(`${prefix}${meta.files.prototypes}`)).arrayBuffer());
        const basePacked = new Uint8Array(await (await fetch(`${prefix}${meta.files.base}`)).arrayBuffer());
        const buffer = await (await fetch(`${prefix}${meta.files.softmax}`)).arrayBuffer();
        const weights = new Float64Array(buffer, 0, meta.feature_dim * meta.classes.length);
        const bias = new Float64Array(buffer, weights.byteLength, meta.classes.length);
        return new EftModel(meta, prototypes, basePacked, weights, bias);
    }

    /** Bundle active features into a bipolar hypervector (+-1). */
    bundle(ids) {
        const dim = this.dim;
        const bins = this.meta.hdc_bins || ids.length;
        const votes = new Int32Array(dim);
        const rowBytes = dim / 8;
        for (const id of ids) {
            const rowOffset = (id % bins) * rowBytes;
            for (let byteIndex = 0; byteIndex < rowBytes; byteIndex++) {
                const byte = this.basePacked[rowOffset + byteIndex];
                const bitBase = byteIndex * 8;
                if (byte === 0) {
                    // all zero bits still cast -1 votes
                    for (let bit = 0; bit < 8; bit++) votes[bitBase + bit] -= 1;
                    continue;
                }
                if (byte === 255) {
                    for (let bit = 0; bit < 8; bit++) votes[bitBase + bit] += 1;
                    continue;
                }
                for (let bit = 0; bit < 8; bit++) {
                    // numpy.packbits is MSB-first
                    if (byte & (1 << (7 - bit))) votes[bitBase + bit] += 1;
                    else votes[bitBase + bit] -= 1;
                }
            }
        }
        const vector = new Float64Array(dim);
        let norm = 0;
        for (let i = 0; i < dim; i++) {
            const value = votes[i] > 0 ? 1 : votes[i] < 0 ? -1 : 1;
            vector[i] = value;
            norm += value * value;
        }
        return { vector, norm: Math.sqrt(norm) };
    }

    hdcProbs(ids) {
        const { vector, norm } = this.bundle(ids);
        const dim = this.dim;
        const logits = new Float64Array(this.classCount);
        for (let c = 0; c < this.classCount; c++) {
            let dot = 0;
            let protoNorm = 0;
            const offset = c * dim;
            for (let i = 0; i < dim; i++) {
                const p = this.prototypes[offset + i];
                dot += p * vector[i];
                protoNorm += p * p;
            }
            logits[c] = (this.meta.hdc_scale * dot) / Math.max(Math.sqrt(protoNorm) * norm, 1e-9);
        }
        return softmax(logits);
    }

    softmaxLogits(ids) {
        const logits = new Float64Array(this.classCount);
        for (let c = 0; c < this.classCount; c++) logits[c] = this.bias[c];
        for (const id of ids) {
            const rowOffset = id * this.classCount;
            for (let c = 0; c < this.classCount; c++) {
                logits[c] += this.weights[rowOffset + c];
            }
        }
        return logits;
    }

    softmaxProbs(ids) {
        const logits = this.softmaxLogits(ids);
        for (let c = 0; c < this.classCount; c++) logits[c] *= this.meta.softmax_temperature;
        return softmax(logits);
    }

    predict(left, span, right, { model = 'hdc' } = {}) {
        const ids = extractFeatureIds(left, span, right, 'NONE', this.featureDim);
        const probs = model === 'softmax' ? this.softmaxProbs(ids) : this.hdcProbs(ids);
        const ranked = Array.from(probs)
            .map((p, index) => ({ p, index }))
            .sort((a, b) => b.p - a.p);
        const threshold = this.meta.gate_thresholds?.[model] ?? 1.1;
        const editProbability = 1 - probs[0];
        return {
            model,
            class: this.classes[ranked[0].index],
            confidence: ranked[0].p,
            probs: Array.from(probs),
            editProbability,
            fire: editProbability >= threshold,
        };
    }
}

function softmax(logits) {
    let max = -Infinity;
    for (const value of logits) if (value > max) max = value;
    let total = 0;
    const out = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i++) {
        out[i] = Math.exp(logits[i] - max);
        total += out[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}
