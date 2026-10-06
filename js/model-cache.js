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
 * KittenNote - NES model storage
 *
 * Streams ONNX model files into IndexedDB as fixed-size chunks (with a
 * per-chunk SHA-256 for integrity), and exposes them to transformers.js
 * through its custom-cache hook (`env.useCustomCache` / `env.customCache`).
 *
 * The cache object implements the two members transformers.js requires
 * (`match` and `put`) with Web Cache API-compatible signatures.
 */

import { SyncCrypto } from './crypto.js';

export const MODEL_CHUNK_SIZE = 1024 * 1024; // 1 MiB

export class ModelChunkCache {
    /**
     * @param {import('./database.js').Database} db
     * @param {string} modelName - logical model id, e.g. 'nes-model'
     */
    constructor(db, modelName) {
        this.db = db;
        this.modelName = modelName;
    }

    /**
     * Cache-API compatible `match`.
     * Returns a Response assembled from IndexedDB chunks, or undefined when
     * the requested file is not part of the stored model (transformers.js
     * then falls back to its normal local/HTTP resolution).
     */
    async match(requestOrUrl) {
        try {
            const manifest = await this.db.getModelManifest(this.modelName);
            if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
                return undefined;
            }

            const rawUrl = typeof requestOrUrl === 'string'
                ? requestOrUrl
                : (requestOrUrl?.url || String(requestOrUrl));
            const normalized = String(rawUrl).split('?')[0].replace(/^\.\//, '');

            const file = manifest.files.find((f) => {
                if (!f?.path) return false;
                const basename = f.path.split('/').pop();
                return normalized.endsWith(f.path) || normalized.endsWith(basename);
            });
            if (!file) return undefined;

            const chunks = await this.db.getModelChunks(this.modelName, file.path);
            if (!chunks || chunks.length !== file.totalChunks) {
                console.warn(`[ModelCache] Incomplete model chunks for ${file.path}: ${chunks?.length || 0}/${file.totalChunks}`);
                return undefined;
            }

            const parts = chunks
                .sort((a, b) => a.chunkIndex - b.chunkIndex)
                .map((c) => {
                    const data = c.data;
                    if (data instanceof Uint8Array) return data;
                    if (data instanceof ArrayBuffer) return new Uint8Array(data);
                    return new Uint8Array(data?.buffer || data || []);
                });

            const blob = new Blob(parts, { type: 'application/octet-stream' });
            return new Response(blob, {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(blob.size)
                }
            });
        } catch (error) {
            console.warn('[ModelCache] match() failed:', error);
            return undefined;
        }
    }

    /**
     * Cache-API compatible `put`. Model storage is managed explicitly by
     * `downloadModelFile()` (streaming + integrity), so this is a no-op.
     */
    async put() {
        return undefined;
    }

    /** Cache-API compatible `delete`. */
    async delete() {
        return false;
    }
}

/**
 * Download a model file into IndexedDB as chunks.
 *
 * @param {object}   options
 * @param {object}   options.db        - Database instance
 * @param {string}   options.modelName - logical model id
 * @param {string}   options.url       - URL of the .onnx file
 * @param {function} [options.onProgress] - ({ received, total, percent })
 * @returns {Promise<{totalBytes:number,totalChunks:number}>}
 */
export async function downloadModelFile({ db, modelName, url, onProgress }) {
    const filePath = new URL(url, location.href).pathname.replace(/^\//, '').split('/').slice(-2).join('/') || 'onnx/model_q4.onnx';

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`模型文件不存在或无法访问 (HTTP ${response.status})：${url}`);
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? parseInt(totalHeader, 10) : 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('此浏览器不支持流式下载');

    // Clear any previous download for this model (including legacy chunks)
    await db.deleteModelChunks(modelName);

    let pending = new Uint8Array(0);
    let received = 0;
    let chunkIndex = 0;

    const flushChunks = async (force) => {
        while (pending.length >= MODEL_CHUNK_SIZE || (force && pending.length > 0)) {
            const size = Math.min(MODEL_CHUNK_SIZE, pending.length);
            const chunkData = pending.slice(0, size);
            pending = pending.slice(size);
            const sha256 = await SyncCrypto.sha256Base64(chunkData);
            await db.saveModelChunk(modelName, filePath, chunkIndex, chunkData, sha256);
            chunkIndex++;
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.length === 0) continue;

            const merged = new Uint8Array(pending.length + value.length);
            merged.set(pending);
            merged.set(value, pending.length);
            pending = merged;
            received += value.length;

            await flushChunks(false);
            onProgress?.({ received, total, percent: total > 0 ? Math.round((received / total) * 100) : 0 });
        }
        await flushChunks(true);

        if (chunkIndex === 0) {
            throw new Error('模型文件为空');
        }

        await db.setModelManifest(modelName, {
            modelName,
            files: [{
                path: filePath,
                url,
                totalChunks: chunkIndex,
                totalBytes: received,
                savedAt: new Date().toISOString()
            }],
            savedAt: new Date().toISOString()
        });

        return { totalBytes: received, totalChunks: chunkIndex };
    } catch (error) {
        // Roll back partial chunks so we never leave a half model behind
        await db.deleteModelChunks(modelName, filePath).catch(() => {});
        throw error;
    }
}
