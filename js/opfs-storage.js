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
 * KittenNote - OPFS Block Storage Engine
 * 
 * Stores note content in the Origin Private File System using
 * fixed-size blocks (1MB) with an index table for incremental writes.
 * 
 * Directory structure:
 *   /kittennote/
 *     _index.json            - Master index mapping noteId -> block metadata
 *     _checkpoint.json       - Migration checkpoint for crash recovery
 *     notes/
 *       <noteId>/
 *         index.json          - Per-note block index
 *         block_0.bin         - Block 0
 *         block_1.bin         - Block 1
 *         ...
 */

const BLOCK_SIZE = 1024 * 1024; // 1MB
const ROOT_DIR = 'kittennote';
const NOTES_DIR = 'notes';
const INDEX_FILE = '_index.json';
const CHECKPOINT_FILE = '_checkpoint.json';

export class OPFSBlockStorage {
    constructor() {
        this._root = null;
        this._notesDir = null;
        this._masterIndex = null;
    }

    /**
     * Check if OPFS is available in this browser.
     */
    static isSupported() {
        return typeof navigator !== 'undefined' &&
            navigator.storage &&
            typeof navigator.storage.getDirectory === 'function';
    }

    /**
     * Initialize the OPFS storage, creating directories as needed.
     */
    async init() {
        if (!OPFSBlockStorage.isSupported()) {
            throw new Error('OPFS is not supported in this browser');
        }

        const opfsRoot = await navigator.storage.getDirectory();
        this._root = await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true });
        this._notesDir = await this._root.getDirectoryHandle(NOTES_DIR, { create: true });
        this._masterIndex = await this._loadMasterIndex();
    }

    // -------------------------------------------------------------------------
    // Master Index
    // -------------------------------------------------------------------------

    async _loadMasterIndex() {
        try {
            const fileHandle = await this._root.getFileHandle(INDEX_FILE, { create: false });
            const file = await fileHandle.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    async _saveMasterIndex() {
        const fileHandle = await this._root.getFileHandle(INDEX_FILE, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(this._masterIndex));
        await writable.close();
    }

    // -------------------------------------------------------------------------
    // Per-note block index
    // -------------------------------------------------------------------------

    async _getNoteDir(noteId, create = false) {
        return this._notesDir.getDirectoryHandle(noteId, { create });
    }

    async _loadNoteIndex(noteDir) {
        try {
            const fh = await noteDir.getFileHandle('index.json', { create: false });
            const file = await fh.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch {
            return { blocks: [], totalSize: 0, hash: '' };
        }
    }

    async _saveNoteIndex(noteDir, indexData) {
        const fh = await noteDir.getFileHandle('index.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(JSON.stringify(indexData));
        await writable.close();
    }

    // -------------------------------------------------------------------------
    // Block operations
    // -------------------------------------------------------------------------

    /**
     * Split data into BLOCK_SIZE chunks.
     */
    _splitIntoBlocks(data) {
        const blocks = [];
        for (let offset = 0; offset < data.byteLength; offset += BLOCK_SIZE) {
            blocks.push(data.slice(offset, Math.min(offset + BLOCK_SIZE, data.byteLength)));
        }
        return blocks;
    }

    /**
     * Compute a simple hash for a block (fast, for change detection).
     */
    async _hashBlock(blockData) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', blockData);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Write a single block to OPFS.
     */
    async _writeBlock(noteDir, blockIndex, data) {
        const filename = `block_${blockIndex}.bin`;
        const fh = await noteDir.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(data);
        await writable.close();
    }

    /**
     * Read a single block from OPFS.
     */
    async _readBlock(noteDir, blockIndex) {
        const filename = `block_${blockIndex}.bin`;
        try {
            const fh = await noteDir.getFileHandle(filename, { create: false });
            const file = await fh.getFile();
            return new Uint8Array(await file.arrayBuffer());
        } catch {
            return null;
        }
    }

    /**
     * Delete a single block file from OPFS.
     */
    async _deleteBlock(noteDir, blockIndex) {
        const filename = `block_${blockIndex}.bin`;
        try {
            await noteDir.removeEntry(filename);
        } catch {
            // Block may not exist; ignore
        }
    }

    // -------------------------------------------------------------------------
    // Public API: Write note content (incremental)
    // -------------------------------------------------------------------------

    /**
     * Write note content with incremental block updates.
     * Only changed blocks are rewritten.
     *
     * @param {string} noteId - The note identifier
     * @param {string|object} content - The note content (string or object)
     * @returns {object} Write stats { blocksWritten, blocksUnchanged, blocksRemoved, totalBlocks }
     */
    async writeNoteContent(noteId, content) {
        const encoder = new TextEncoder();
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
        const data = encoder.encode(contentStr);

        const noteDir = await this._getNoteDir(noteId, true);
        const oldIndex = await this._loadNoteIndex(noteDir);

        const newBlocks = this._splitIntoBlocks(data);
        const newBlockMeta = [];
        let blocksWritten = 0;
        let blocksUnchanged = 0;

        // Write or skip each block
        for (let i = 0; i < newBlocks.length; i++) {
            const hash = await this._hashBlock(newBlocks[i]);
            const oldBlockInfo = oldIndex.blocks?.[i];

            if (oldBlockInfo && oldBlockInfo.hash === hash) {
                // Block unchanged, skip write
                newBlockMeta.push(oldBlockInfo);
                blocksUnchanged++;
            } else {
                // Block changed or new, write it
                await this._writeBlock(noteDir, i, newBlocks[i]);
                newBlockMeta.push({
                    index: i,
                    size: newBlocks[i].byteLength,
                    hash
                });
                blocksWritten++;
            }
        }

        // Remove extra old blocks if content shrank
        let blocksRemoved = 0;
        const oldBlockCount = oldIndex.blocks?.length || 0;
        for (let i = newBlocks.length; i < oldBlockCount; i++) {
            await this._deleteBlock(noteDir, i);
            blocksRemoved++;
        }

        // Compute total content hash
        const totalHash = await this._hashBlock(data);

        // Save per-note index
        const noteIndexData = {
            blocks: newBlockMeta,
            totalSize: data.byteLength,
            hash: totalHash,
            updatedAt: new Date().toISOString()
        };
        await this._saveNoteIndex(noteDir, noteIndexData);

        // Update master index
        this._masterIndex[noteId] = {
            totalSize: data.byteLength,
            blockCount: newBlocks.length,
            hash: totalHash,
            updatedAt: noteIndexData.updatedAt
        };
        await this._saveMasterIndex();

        return {
            blocksWritten,
            blocksUnchanged,
            blocksRemoved,
            totalBlocks: newBlocks.length
        };
    }

    // -------------------------------------------------------------------------
    // Public API: Read note content
    // -------------------------------------------------------------------------

    /**
     * Read note content from OPFS, reassembling blocks.
     *
     * @param {string} noteId - The note identifier
     * @returns {string|null} The note content, or null if not found
     */
    async readNoteContent(noteId) {
        let noteDir;
        try {
            noteDir = await this._getNoteDir(noteId, false);
        } catch {
            return null;
        }

        const noteIndex = await this._loadNoteIndex(noteDir);
        if (!noteIndex.blocks || noteIndex.blocks.length === 0) {
            return null;
        }

        const chunks = [];
        for (let i = 0; i < noteIndex.blocks.length; i++) {
            const block = await this._readBlock(noteDir, i);
            if (!block) {
                console.warn(`[OPFS] Missing block ${i} for note ${noteId}`);
                return null; // Corrupted
            }
            chunks.push(block);
        }

        // Reassemble
        const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return new TextDecoder().decode(combined);
    }

    // -------------------------------------------------------------------------
    // Public API: Delete note content
    // -------------------------------------------------------------------------

    /**
     * Delete all blocks and metadata for a note.
     *
     * @param {string} noteId - The note identifier
     */
    async deleteNoteContent(noteId) {
        try {
            await this._notesDir.removeEntry(noteId, { recursive: true });
        } catch {
            // Directory may not exist
        }

        delete this._masterIndex[noteId];
        await this._saveMasterIndex();
    }

    // -------------------------------------------------------------------------
    // Public API: Check if note exists
    // -------------------------------------------------------------------------

    /**
     * Check whether content exists for a note.
     */
    hasNote(noteId) {
        return !!this._masterIndex[noteId];
    }

    /**
     * Get all note IDs stored in OPFS.
     */
    getAllNoteIds() {
        return Object.keys(this._masterIndex || {});
    }

    /**
     * List note directories from OPFS directly (works even when master index is stale/missing).
     */
    async listNoteDirectories() {
        const noteIds = [];
        try {
            for await (const [name, handle] of this._notesDir.entries()) {
                if (handle.kind === 'directory') {
                    noteIds.push(name);
                }
            }
        } catch {
            // Ignore scan errors and return what we have
        }
        return noteIds;
    }

    /**
     * Best-effort read for recovery scenarios.
     * Tries indexed block metadata first, then falls back to sequential block scan.
     */
    async readNoteContentBestEffort(noteId) {
        const normal = await this.readNoteContent(noteId);
        if (normal !== null) return normal;

        let noteDir;
        try {
            noteDir = await this._getNoteDir(noteId, false);
        } catch {
            return null;
        }

        const chunks = [];
        for (let i = 0; i < 65536; i++) {
            const block = await this._readBlock(noteDir, i);
            if (!block) {
                if (i === 0) return null;
                break;
            }
            chunks.push(block);
        }

        if (!chunks.length) return null;

        const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(combined);
    }

    // -------------------------------------------------------------------------
    // Health & diagnostics
    // -------------------------------------------------------------------------

    /**
     * Get health information about the OPFS storage.
     * Returns stats on each note file and overall fragmentation.
     */
    async getHealthInfo() {
        const notes = [];
        let totalSize = 0;
        let totalBlocks = 0;
        let fragmentedNotes = 0;

        for (const [noteId, meta] of Object.entries(this._masterIndex || {})) {
            const expectedBlocks = Math.ceil((meta.totalSize || 1) / BLOCK_SIZE);
            const actualBlocks = meta.blockCount || 0;
            const isFragmented = actualBlocks > expectedBlocks;

            if (isFragmented) fragmentedNotes++;

            notes.push({
                noteId,
                totalSize: meta.totalSize || 0,
                blockCount: actualBlocks,
                expectedBlocks,
                isFragmented,
                updatedAt: meta.updatedAt || null
            });

            totalSize += meta.totalSize || 0;
            totalBlocks += actualBlocks;
        }

        return {
            noteCount: notes.length,
            totalSize,
            totalBlocks,
            fragmentedNotes,
            blockSize: BLOCK_SIZE,
            notes
        };
    }

    /**
     * Verify integrity of all stored notes.
     * Returns a list of issues found.
     */
    async verifyIntegrity() {
        const issues = [];

        for (const noteId of Object.keys(this._masterIndex || {})) {
            try {
                const noteDir = await this._getNoteDir(noteId, false);
                const noteIndex = await this._loadNoteIndex(noteDir);

                // Verify each block exists and has correct hash
                for (let i = 0; i < (noteIndex.blocks?.length || 0); i++) {
                    const blockMeta = noteIndex.blocks[i];
                    const blockData = await this._readBlock(noteDir, i);

                    if (!blockData) {
                        issues.push({
                            noteId,
                            type: 'missing_block',
                            blockIndex: i,
                            message: `Block ${i} missing for note ${noteId}`
                        });
                        continue;
                    }

                    const hash = await this._hashBlock(blockData);
                    if (hash !== blockMeta.hash) {
                        issues.push({
                            noteId,
                            type: 'hash_mismatch',
                            blockIndex: i,
                            message: `Block ${i} hash mismatch for note ${noteId}`
                        });
                    }
                }
            } catch (e) {
                issues.push({
                    noteId,
                    type: 'read_error',
                    message: `Cannot read note directory for ${noteId}: ${e.message}`
                });
            }
        }

        return issues;
    }

    // -------------------------------------------------------------------------
    // Migration checkpoints
    // -------------------------------------------------------------------------

    /**
     * Save a migration checkpoint for crash recovery.
     */
    async saveCheckpoint(checkpoint) {
        const fh = await this._root.getFileHandle(CHECKPOINT_FILE, { create: true });
        const writable = await fh.createWritable();
        await writable.write(JSON.stringify(checkpoint));
        await writable.close();
    }

    /**
     * Load a migration checkpoint.
     */
    async loadCheckpoint() {
        try {
            const fh = await this._root.getFileHandle(CHECKPOINT_FILE, { create: false });
            const file = await fh.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    /**
     * Clear a migration checkpoint (called when migration completes).
     */
    async clearCheckpoint() {
        try {
            await this._root.removeEntry(CHECKPOINT_FILE);
        } catch {
            // File may not exist
        }
    }

    // -------------------------------------------------------------------------
    // Mirror export (for backup)
    // -------------------------------------------------------------------------

    /**
     * Export all OPFS content as a flat map of { path: Uint8Array } for inclusion in backup ZIP.
     */
    async exportMirror() {
        const files = {};

        // Export master index
        try {
            const fh = await this._root.getFileHandle(INDEX_FILE, { create: false });
            const file = await fh.getFile();
            files[`${ROOT_DIR}/${INDEX_FILE}`] = new Uint8Array(await file.arrayBuffer());
        } catch {
            // No master index
        }

        // Export each note directory
        for (const noteId of Object.keys(this._masterIndex || {})) {
            try {
                const noteDir = await this._getNoteDir(noteId, false);

                // Export note index
                try {
                    const indexFh = await noteDir.getFileHandle('index.json', { create: false });
                    const indexFile = await indexFh.getFile();
                    files[`${ROOT_DIR}/${NOTES_DIR}/${noteId}/index.json`] = new Uint8Array(await indexFile.arrayBuffer());
                } catch { /* no index */ }

                // Export all block files
                const noteIndex = await this._loadNoteIndex(noteDir);
                for (let i = 0; i < (noteIndex.blocks?.length || 0); i++) {
                    const blockData = await this._readBlock(noteDir, i);
                    if (blockData) {
                        files[`${ROOT_DIR}/${NOTES_DIR}/${noteId}/block_${i}.bin`] = blockData;
                    }
                }
            } catch {
                // Note directory may not exist
            }
        }

        return files;
    }

    /**
     * Import an OPFS mirror from backup data.
     * @param {Object} mirrorFiles - Map of { path: Uint8Array }
     */
    async importMirror(mirrorFiles) {
        for (const [path, data] of Object.entries(mirrorFiles)) {
            // Path format: kittennote/notes/<noteId>/block_0.bin etc.
            const parts = path.split('/');
            if (parts[0] !== ROOT_DIR) continue;

            if (parts.length === 2) {
                // Root-level file (e.g., _index.json)
                const fh = await this._root.getFileHandle(parts[1], { create: true });
                const writable = await fh.createWritable();
                await writable.write(data);
                await writable.close();
            } else if (parts[1] === NOTES_DIR && parts.length >= 4) {
                // Note file
                const noteId = parts[2];
                const filename = parts[3];
                const noteDir = await this._getNoteDir(noteId, true);
                const fh = await noteDir.getFileHandle(filename, { create: true });
                const writable = await fh.createWritable();
                await writable.write(data);
                await writable.close();
            }
        }

        // Reload master index
        this._masterIndex = await this._loadMasterIndex();
    }

    // -------------------------------------------------------------------------
    // Defragmentation
    // -------------------------------------------------------------------------

    /**
     * Defragment OPFS storage:
     * 1. For each note, re-read content and rewrite blocks cleanly
     * 2. Remove orphaned block files beyond what the index expects
     * 3. Remove orphaned note directories not in master index
     * 
     * @param {function} onProgress - Optional callback(percent, message)
     * @returns {object} Stats { notesProcessed, blocksRemoved, orphanDirsRemoved, spaceSaved }
     */
    async defragment(onProgress) {
        const stats = { notesProcessed: 0, blocksRemoved: 0, orphanDirsRemoved: 0, spaceSaved: 0 };
        const noteIds = Object.keys(this._masterIndex || {});
        const total = noteIds.length;

        // Phase 1: Clean up each known note
        for (let i = 0; i < noteIds.length; i++) {
            const noteId = noteIds[i];
            onProgress?.(Math.round((i / Math.max(total, 1)) * 80), `整理笔记 ${i + 1}/${total}`);

            try {
                const noteDir = await this._getNoteDir(noteId, false);
                const noteIndex = await this._loadNoteIndex(noteDir);
                const expectedBlocks = noteIndex.blocks?.length || 0;

                // Remove any block files beyond the expected count
                let extraIdx = expectedBlocks;
                while (true) {
                    try {
                        const filename = `block_${extraIdx}.bin`;
                        const fh = await noteDir.getFileHandle(filename, { create: false });
                        const file = await fh.getFile();
                        stats.spaceSaved += file.size;
                        await noteDir.removeEntry(filename);
                        stats.blocksRemoved++;
                        extraIdx++;
                    } catch {
                        break; // No more extra blocks
                    }
                }

                // Re-read and re-write content for compaction
                const content = await this.readNoteContent(noteId);
                if (content !== null) {
                    const writeResult = await this.writeNoteContent(noteId, content);
                    if (writeResult.blocksRemoved > 0) {
                        stats.blocksRemoved += writeResult.blocksRemoved;
                    }
                }

                stats.notesProcessed++;
            } catch (e) {
                console.warn(`[OPFS] Defrag: error processing note ${noteId}:`, e);
            }
        }

        // Phase 2: Remove orphaned note directories
        onProgress?.(85, '清理孤立目录...');
        try {
            for await (const [name, handle] of this._notesDir.entries()) {
                if (handle.kind === 'directory' && !this._masterIndex[name]) {
                    try {
                        await this._notesDir.removeEntry(name, { recursive: true });
                        stats.orphanDirsRemoved++;
                    } catch (e) {
                        console.warn(`[OPFS] Defrag: failed to remove orphan dir ${name}:`, e);
                    }
                }
            }
        } catch (e) {
            console.warn('[OPFS] Defrag: error scanning for orphan dirs:', e);
        }

        onProgress?.(100, '碎片整理完成');
        return stats;
    }

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    /**
     * Remove all OPFS data (used when switching back to IndexedDB).
     */
    async clearAll() {
        try {
            const opfsRoot = await navigator.storage.getDirectory();
            await opfsRoot.removeEntry(ROOT_DIR, { recursive: true });
        } catch {
            // Directory may not exist
        }
        this._masterIndex = {};
        this._root = null;
        this._notesDir = null;
    }

    /**
     * Get the block size constant.
     */
    static get BLOCK_SIZE() {
        return BLOCK_SIZE;
    }
}
