/*
 * EFT-v1 encoder - dependency-free JS inference (mirrors enc_model.py bit-near).
 *
 * Mirrors torch.nn.TransformerEncoderLayer (norm_first=True, batch_first):
 *   x = x + MHA(norm1(x)) ; x = x + FFN(norm2(x)) ; logits = head(x)
 * with ReLU feedforward (torch TransformerEncoderLayer default),
 * (token id 0 = <PAD> masked with -inf before attention softmax).
 *
 * Usage (browser or Node):
 *   const model = await EncModel.load('./artifacts/enc-s-full/browser/');
 *   model.tagDocument('...'); -> [{ logodds, class, confidence }, ...] per gap
 */
export const ATOM_CLASSES = [
    'NO_EDIT', 'FIX_CHAR', 'DEL_CHAR', 'INS_CHAR', 'DEL_SPAN', 'INS_SPAN_COPY', 'FMT_BULLET',
];

const relu = (x) => (x > 0 ? x : 0);

// Row-major matmul with transposed weight:
//   C[M,N] = A[M,K] @ W.t()  where W is [N,K] row-major (torch Linear layout).
function matmulInto(C, A, W, M, K, N) {
    for (let i = 0; i < M; i++) {
        const aRow = i * K;
        const cRow = i * N;
        for (let k = 0; k < K; k++) {
            const a = A[aRow + k];
            if (a === 0) continue;
            for (let j = 0; j < N; j++) {
                C[cRow + j] += a * W[j * K + k];
            }
        }
    }
}

function addBiasInPlace(X, bias, M, N) {
    for (let i = 0; i < M; i++) {
        const row = i * N;
        for (let j = 0; j < N; j++) X[row + j] += bias[j];
    }
}

function layerNormInto(out, X, weight, bias, T, D, eps = 1e-5) {
    for (let t = 0; t < T; t++) {
        const row = t * D;
        let mean = 0;
        for (let j = 0; j < D; j++) mean += X[row + j];
        mean /= D;
        let variance = 0;
        for (let j = 0; j < D; j++) {
            const d = X[row + j] - mean;
            variance += d * d;
        }
        variance /= D;
        const inv = 1 / Math.sqrt(variance + eps);
        for (let j = 0; j < D; j++) {
            out[row + j] = (X[row + j] - mean) * inv * weight[j] + bias[j];
        }
    }
}

export class EncModel {
    constructor(meta, stoi, tensors) {
        this.meta = meta;
        this.stoi = stoi;
        this.t = tensors; // name -> Float32Array
        this.d = meta.d;
        this.heads = meta.heads;
        this.dh = meta.d / meta.heads;
        this.scale = 1 / Math.sqrt(this.dh);
    }

    static async load(prefix) {
        const meta = await (await fetch(`${prefix}model.json`)).json();
        const stoi = await (await fetch(`${prefix}vocab.json`)).json();
        const buffer = await (await fetch(`${prefix}weights.bin`)).arrayBuffer();
        return EncModel.fromBuffers(meta, stoi, buffer);
    }

    static fromBuffers(meta, stoi, buffer) {
        const tensors = {};
        for (const [name, spec] of Object.entries(meta.tensors)) {
            const count = spec.shape.reduce((a, b) => a * b, 1);
            tensors[name] = new Float32Array(buffer, spec.offset, count);
        }
        return new EncModel(meta, stoi, tensors);
    }

    encode(text) {
        const ids = [2]; // <S>
        const chars = Array.from(text);
        const limit = Math.min(chars.length, this.meta.maxlen - 1);
        for (let i = 0; i < limit; i++) {
            const id = this.stoi[chars[i]];
            ids.push(id === undefined ? 1 : id);
        }
        return ids;
    }

    /** Full forward pass. ids: number[] (batch 1). Returns Float64Array [T*7]. */
    forward(ids) {
        const { d, heads, dh, ffn } = { d: this.d, heads: this.heads, dh: this.dh, ffn: this.meta.ffn };
        const T = ids.length;
        const t = this.t;

        // token + position embedding
        let x = new Float32Array(T * d);
        for (let i = 0; i < T; i++) {
            const tokRow = ids[i] * d;
            const posRow = i * d;
            const outRow = i * d;
            for (let j = 0; j < d; j++) x[outRow + j] = t.tok[tokRow + j] + t.pos[posRow + j];
        }

        const normed = new Float32Array(T * d);
        const qkv = new Float32Array(T * 3 * d);
        const attOut = new Float32Array(T * d);
        const ffHidden = new Float32Array(T * ffn);
        const scores = new Float32Array(heads * T * T);

        for (let l = 0; l < this.meta.layers; l++) {
            const P = `L${l}.`;
            // --- self attention block (pre-norm) ---
            layerNormInto(normed, x, t[P + 'norm1w'], t[P + 'norm1b'], T, d);
            qkv.fill(0);
            matmulInto(qkv, normed, t[P + 'inprojw'], T, d, 3 * d);
            addBiasInPlace(qkv, t[P + 'inprojb'], T, 3 * d);

            // per-head attention
            for (let h = 0; h < heads; h++) {
                const sBase = h * T * T;
                for (let i = 0; i < T; i++) {
                    const qBase = (i * 3 * d) + h * dh;
                    for (let j = 0; j < T; j++) {
                        if (ids[j] === 0) {
                            scores[sBase + i * T + j] = -Infinity;
                            continue;
                        }
                        const kBase = (j * 3 * d) + d + h * dh;
                        let dot = 0;
                        for (let k = 0; k < dh; k++) dot += qkv[qBase + k] * qkv[kBase + k];
                        scores[sBase + i * T + j] = dot * this.scale;
                    }
                    // softmax row i
                    let max = -Infinity;
                    for (let j = 0; j < T; j++) {
                        const s = scores[sBase + i * T + j];
                        if (s > max) max = s;
                    }
                    let total = 0;
                    for (let j = 0; j < T; j++) {
                        const s = Math.exp(scores[sBase + i * T + j] - max);
                        scores[sBase + i * T + j] = s;
                        total += s;
                    }
                    for (let j = 0; j < T; j++) scores[sBase + i * T + j] /= total;
                }
            }

            // attention @ V -> per-head outputs concatenated
            attOut.fill(0);
            for (let i = 0; i < T; i++) {
                for (let h = 0; h < heads; h++) {
                    const sBase = h * T * T + i * T;
                    const oBase = i * d + h * dh;
                    for (let j = 0; j < T; j++) {
                        const s = scores[sBase + j];
                        if (s === 0) continue;
                        const vBase = (j * 3 * d) + 2 * d + h * dh;
                        for (let k = 0; k < dh; k++) attOut[oBase + k] += s * qkv[vBase + k];
                    }
                }
            }
            // out_proj + residual
            const proj = new Float32Array(T * d);
            matmulInto(proj, attOut, t[P + 'outw'], T, d, d);
            addBiasInPlace(proj, t[P + 'outb'], T, d);
            for (let i = 0; i < T * d; i++) x[i] += proj[i];

            // --- feedforward block (pre-norm) ---
            layerNormInto(normed, x, t[P + 'norm2w'], t[P + 'norm2b'], T, d);
            ffHidden.fill(0);
            matmulInto(ffHidden, normed, t[P + 'ff1w'], T, d, ffn);
            addBiasInPlace(ffHidden, t[P + 'ff1b'], T, ffn);
            for (let i = 0; i < T * ffn; i++) ffHidden[i] = relu(ffHidden[i]);
            const ffOut = new Float32Array(T * d);
            matmulInto(ffOut, ffHidden, t[P + 'ff2w'], T, ffn, d);
            addBiasInPlace(ffOut, t[P + 'ff2b'], T, d);
            for (let i = 0; i < T * d; i++) x[i] += ffOut[i];
        }

        // head
        const logits = new Float64Array(T * 7);
        for (let i = 0; i < T; i++) {
            for (let c = 0; c < 7; c++) {
                let sum = t.headb[c];
                const wRow = c * d;
                const xRow = i * d;
                for (let j = 0; j < d; j++) sum += t.headw[wRow + j] * x[xRow + j];
                logits[i * 7 + c] = sum;
            }
        }
        return logits;
    }

    /** Tag every gap of a document. Returns [{logodds, class, confidence}]. */
    tagDocument(document) {
        const ids = this.encode(document);
        const logits = this.forward(ids);
        const out = [];
        for (let i = 0; i < ids.length; i++) {
            let max = -Infinity;
            let argmax = 0;
            for (let c = 0; c < 7; c++) {
                const v = logits[i * 7 + c];
                if (v > max) { max = v; argmax = c; }
            }
            // edit log-odds = logsumexp(edit) - logit(no_edit)
            let editMax = -Infinity;
            for (let c = 1; c < 7; c++) {
                const v = logits[i * 7 + c];
                if (v > editMax) editMax = v;
            }
            let editSum = 0;
            for (let c = 1; c < 7; c++) editSum += Math.exp(logits[i * 7 + c] - editMax);
            const logodds = editMax + Math.log(editSum) - logits[i * 7];
            // confidence = softmax probability of argmax
            let total = 0;
            for (let c = 0; c < 7; c++) total += Math.exp(logits[i * 7 + c] - max);
            out.push({ logodds, class: argmax, confidence: 1 / total });
        }
        return out;
    }
}
