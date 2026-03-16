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
 * KittenNote - IndexedDB Database Manager
 * Handles all data storage operations
 */

import { OPFSBlockStorage } from './opfs-storage.js';

const DB_NAME = 'KittenNoteDB';
const DB_VERSION = 3;

export class Database {
    constructor() {
        this.db = null;
        this.storageEngine = 'indexeddb'; // 'indexeddb' or 'opfs'
        this.opfs = null;
    }
    
    async init() {
        await new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = () => {
                reject(new Error('Failed to open database'));
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Folders store
                if (!db.objectStoreNames.contains('folders')) {
                    const foldersStore = db.createObjectStore('folders', { keyPath: 'id' });
                    foldersStore.createIndex('parentId', 'parentId', { unique: false });
                    foldersStore.createIndex('order', 'order', { unique: false });
                }
                
                // Notebooks store
                if (!db.objectStoreNames.contains('notebooks')) {
                    const notebooksStore = db.createObjectStore('notebooks', { keyPath: 'id' });
                    notebooksStore.createIndex('folderId', 'folderId', { unique: false });
                    notebooksStore.createIndex('order', 'order', { unique: false });
                }
                
                // Notes store (log-based content for ink support)
                if (!db.objectStoreNames.contains('notes')) {
                    const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
                    notesStore.createIndex('notebookId', 'notebookId', { unique: false });
                    notesStore.createIndex('type', 'type', { unique: false });
                    notesStore.createIndex('order', 'order', { unique: false });
                    notesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
                
                // Devices store (for sync)
                if (!db.objectStoreNames.contains('devices')) {
                    const devicesStore = db.createObjectStore('devices', { keyPath: 'id' });
                    devicesStore.createIndex('lastSync', 'lastSync', { unique: false });
                }
                
                // Sync log store
                if (!db.objectStoreNames.contains('syncLog')) {
                    const syncLogStore = db.createObjectStore('syncLog', { keyPath: 'id', autoIncrement: true });
                    syncLogStore.createIndex('timestamp', 'timestamp', { unique: false });
                    syncLogStore.createIndex('noteId', 'noteId', { unique: false });
                }
                
                // Settings store
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
                
                // Model chunks store (for AI model storage)
                if (!db.objectStoreNames.contains('modelChunks')) {
                    const modelStore = db.createObjectStore('modelChunks', { keyPath: 'id' });
                    modelStore.createIndex('modelName', 'modelName', { unique: false });
                }

                // Image blobs store (for ink note images)
                if (!db.objectStoreNames.contains('imageBlobs')) {
                    const imageStore = db.createObjectStore('imageBlobs', { keyPath: 'id' });
                    imageStore.createIndex('noteId', 'noteId', { unique: false });
                }
            };
        });

        // Load storage engine preference and initialize OPFS if needed
        await this._initStorageEngine();
    }

    async _initStorageEngine() {
        try {
            const engineSetting = await this.getSetting('storageEngine');
            if (engineSetting === 'opfs' && OPFSBlockStorage.isSupported()) {
                this.opfs = new OPFSBlockStorage();
                await this.opfs.init();
                this.storageEngine = 'opfs';

                // Check for incomplete migration and attempt auto-repair
                const checkpoint = await this.opfs.loadCheckpoint();
                if (checkpoint && checkpoint.status === 'in_progress') {
                    console.warn('[Storage] Found incomplete migration checkpoint, attempting repair...');
                    await this._repairMigration(checkpoint);
                }
            }
        } catch (e) {
            console.warn('[Storage] Failed to init OPFS, falling back to IndexedDB:', e);
            this.storageEngine = 'indexeddb';
            this.opfs = null;
        }
    }

    /**
     * Attempt to repair an interrupted migration using the checkpoint.
     */
    async _repairMigration(checkpoint) {
        try {
            const { direction, completedNoteIds = [], totalNoteIds = [] } = checkpoint;
            const remainingIds = totalNoteIds.filter(id => !completedNoteIds.includes(id));

            if (direction === 'to_opfs') {
                // Continue migrating remaining notes to OPFS
                for (const noteId of remainingIds) {
                    const note = await this.get('notes', noteId);
                    if (note && note.content) {
                        await this.opfs.writeNoteContent(noteId, note.content);
                    }
                }
                this.storageEngine = 'opfs';
            } else if (direction === 'to_indexeddb') {
                // Continue migrating remaining notes back to IndexedDB
                for (const noteId of remainingIds) {
                    const content = await this.opfs.readNoteContent(noteId);
                    if (content !== null) {
                        const note = await this.get('notes', noteId);
                        if (note) {
                            let parsedContent = content;
                            try { parsedContent = JSON.parse(content); } catch { /* keep as string */ }
                            await this.update('notes', { ...note, content: parsedContent });
                        }
                    }
                }
                this.storageEngine = 'indexeddb';
                await this.setSetting('storageEngine', 'indexeddb');
            }

            await this.opfs.clearCheckpoint();
            console.log('[Storage] Migration repair completed successfully');
        } catch (e) {
            console.error('[Storage] Migration repair failed:', e);
        }
    }

    /**
     * Migrate all note content between IndexedDB and OPFS.
     * @param {'opfs'|'indexeddb'} targetEngine
     * @param {function} onProgress - callback(current, total)
     * @returns {object} { success, migratedCount, errors }
     */
    async migrateStorage(targetEngine, onProgress) {
        if (targetEngine === this.storageEngine) {
            return { success: true, migratedCount: 0, errors: [] };
        }

        const notes = await this.getAll('notes');
        const totalNoteIds = notes.map(n => n.id);
        const completedNoteIds = [];
        const errors = [];

        if (targetEngine === 'opfs') {
            if (!OPFSBlockStorage.isSupported()) {
                throw new Error('OPFS is not supported in this browser');
            }

            // Initialize OPFS if not already
            if (!this.opfs) {
                this.opfs = new OPFSBlockStorage();
                await this.opfs.init();
            }

            // Save checkpoint
            await this.opfs.saveCheckpoint({
                status: 'in_progress',
                direction: 'to_opfs',
                completedNoteIds: [],
                totalNoteIds,
                startedAt: new Date().toISOString()
            });

            // Migrate each note's content to OPFS
            for (let i = 0; i < notes.length; i++) {
                try {
                    const note = notes[i];
                    if (note.content) {
                        await this.opfs.writeNoteContent(note.id, note.content);
                    }
                    completedNoteIds.push(note.id);

                    // Update checkpoint
                    await this.opfs.saveCheckpoint({
                        status: 'in_progress',
                        direction: 'to_opfs',
                        completedNoteIds: [...completedNoteIds],
                        totalNoteIds,
                        startedAt: new Date().toISOString()
                    });
                } catch (e) {
                    errors.push({ noteId: notes[i].id, error: e.message });
                }
                if (onProgress) onProgress(i + 1, notes.length);
            }

            this.storageEngine = 'opfs';
            await this.setSetting('storageEngine', 'opfs');
            await this.opfs.clearCheckpoint();

        } else if (targetEngine === 'indexeddb') {
            if (!this.opfs) {
                return { success: true, migratedCount: 0, errors: [] };
            }

            // Save checkpoint
            await this.opfs.saveCheckpoint({
                status: 'in_progress',
                direction: 'to_indexeddb',
                completedNoteIds: [],
                totalNoteIds,
                startedAt: new Date().toISOString()
            });

            // Migrate each note's content from OPFS back to IndexedDB
            for (let i = 0; i < notes.length; i++) {
                try {
                    const note = notes[i];
                    const content = await this.opfs.readNoteContent(note.id);
                    if (content !== null) {
                        let parsedContent = content;
                        try { parsedContent = JSON.parse(content); } catch { /* keep as string */ }
                        await this.update('notes', { ...note, content: parsedContent });
                    }
                    completedNoteIds.push(note.id);

                    await this.opfs.saveCheckpoint({
                        status: 'in_progress',
                        direction: 'to_indexeddb',
                        completedNoteIds: [...completedNoteIds],
                        totalNoteIds,
                        startedAt: new Date().toISOString()
                    });
                } catch (e) {
                    errors.push({ noteId: notes[i].id, error: e.message });
                }
                if (onProgress) onProgress(i + 1, notes.length);
            }

            // Clean up OPFS data
            await this.opfs.clearAll();
            this.opfs = null;
            this.storageEngine = 'indexeddb';
            await this.setSetting('storageEngine', 'indexeddb');
        }

        return { success: errors.length === 0, migratedCount: completedNoteIds.length, errors };
    }

    /**
     * Recover note data from OPFS into IndexedDB after accidental IndexedDB loss.
     * This only restores notes/notebooks/folders metadata minimally; app settings stay in IndexedDB.
     */
    async recoverFromOPFS(onProgress) {
        const result = {
            success: true,
            recoveredCount: 0,
            skippedCount: 0,
            errors: []
        };

        let recoveryOpfs = this.opfs;
        let tempInitialized = false;

        try {
            if (!recoveryOpfs) {
                recoveryOpfs = new OPFSBlockStorage();
                await recoveryOpfs.init();
                tempInitialized = true;
            }
        } catch (e) {
            throw new Error('无法访问 OPFS 数据：' + (e?.message || e));
        }

        const indexedIds = recoveryOpfs.getAllNoteIds?.() || [];
        const dirIds = await recoveryOpfs.listNoteDirectories?.() || [];
        const noteIds = Array.from(new Set([...indexedIds, ...dirIds]));

        if (!noteIds.length) {
            return { ...result, success: false, errors: [{ noteId: null, error: '未发现可恢复的 OPFS 笔记文件' }] };
        }

        // Create a deterministic recovery notebook to hold recovered notes
        const recoveryNotebookId = 'opfs-recovery-notebook';
        const now = new Date().toISOString();
        await this.update('notebooks', {
            id: recoveryNotebookId,
            name: 'OPFS 恢复笔记本',
            folderId: null,
            order: Date.now(),
            pageStyle: { pattern: 'blank', color: '#ffffff' },
            createdAt: now,
            updatedAt: now
        });

        for (let i = 0; i < noteIds.length; i++) {
            const noteId = noteIds[i];
            onProgress?.(i + 1, noteIds.length);
            try {
                const raw = await recoveryOpfs.readNoteContentBestEffort(noteId);
                if (raw === null || raw === undefined || raw === '') {
                    result.skippedCount++;
                    continue;
                }

                let content = raw;
                let type = 'text';
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        content = parsed;
                        // Heuristic: ink note payload usually contains strokes/images
                        if (Array.isArray(parsed.strokes) || Array.isArray(parsed.images) || parsed.version) {
                            type = 'ink';
                        }
                    }
                } catch {
                    // Keep plain text content
                }

                const existing = await this.get('notes', noteId);
                const restored = {
                    id: noteId,
                    title: existing?.title || `恢复笔记 ${result.recoveredCount + 1}`,
                    type: existing?.type || type,
                    content,
                    notebookId: existing?.notebookId || recoveryNotebookId,
                    order: existing?.order || (Date.now() + i),
                    createdAt: existing?.createdAt || now,
                    updatedAt: now
                };

                await this.update('notes', restored);
                result.recoveredCount++;
            } catch (e) {
                result.errors.push({ noteId, error: e?.message || String(e) });
            }
        }

        result.success = result.recoveredCount > 0;

        // Recovery target is IndexedDB mode
        this.storageEngine = 'indexeddb';
        await this.setSetting('storageEngine', 'indexeddb');

        // If OPFS was only created for recovery, release instance references
        if (tempInitialized && !this.opfs) {
            recoveryOpfs = null;
        }

        return result;
    }
    
    // Generic CRUD helpers
    async add(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.add(data);
            
            request.onsuccess = () => resolve(data);
            request.onerror = () => reject(request.error);
        });
    }
    
    async get(storeName, id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(id);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    
    async update(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            
            request.onsuccess = () => resolve(data);
            request.onerror = () => reject(request.error);
        });
    }
    
    async delete(storeName, id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(id);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    
    async getByIndex(storeName, indexName, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const index = store.index(indexName);
            const request = index.getAll(value);
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    
    // Utility
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
    }
    
    // Folders
    async createFolder(data) {
        const folder = {
            id: this.generateId(),
            name: data.name || '新建文件夹',
            parentId: data.parentId || null,
            order: data.order || Date.now(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        return this.add('folders', folder);
    }
    
    async getFolder(id) {
        return this.get('folders', id);
    }
    
    async getAllFolders() {
        return this.getAll('folders');
    }
    
    async getFolderChildren(parentId) {
        return this.getByIndex('folders', 'parentId', parentId);
    }
    
    async updateFolder(id, updates) {
        const folder = await this.getFolder(id);
        if (!folder) throw new Error('Folder not found');
        
        const updated = {
            ...folder,
            ...updates,
            updatedAt: new Date().toISOString()
        };
        return this.update('folders', updated);
    }

    /**
     * Upsert a folder: create if not exists, update if exists.
     * Used by sync to import remote folders.
     */
    async upsertFolder(data) {
        const existing = await this.getFolder(data.id);
        if (existing) {
            const updated = { ...existing, ...data, updatedAt: data.updatedAt || new Date().toISOString() };
            return this.update('folders', updated);
        } else {
            // Ensure required fields
            const folder = {
                id: data.id,
                name: data.name || '新建文件夹',
                parentId: data.parentId ?? null,
                order: data.order || Date.now(),
                createdAt: data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt || new Date().toISOString(),
                ...data
            };
            return this.update('folders', folder);
        }
    }
    
    async deleteFolder(id) {
        // Delete all child folders recursively
        const children = await this.getFolderChildren(id);
        for (const child of children) {
            await this.deleteFolder(child.id);
        }
        
        // Delete all notebooks in this folder
        const notebooks = await this.getByIndex('notebooks', 'folderId', id);
        for (const notebook of notebooks) {
            await this.deleteNotebook(notebook.id);
        }
        
        return this.delete('folders', id);
    }
    
    // Notebooks
    async createNotebook(data) {
        const notebook = {
            id: this.generateId(),
            name: data.name || '新建笔记本',
            folderId: data.folderId || null,
            order: data.order || Date.now(),
            pageStyle: data.pageStyle || { pattern: 'blank', color: '#ffffff' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        return this.add('notebooks', notebook);
    }
    
    async getNotebook(id) {
        return this.get('notebooks', id);
    }
    
    async getAllNotebooks() {
        return this.getAll('notebooks');
    }
    
    async getNotebooksInFolder(folderId) {
        return this.getByIndex('notebooks', 'folderId', folderId);
    }
    
    async updateNotebook(id, updates) {
        const notebook = await this.getNotebook(id);
        if (!notebook) throw new Error('Notebook not found');
        
        const updated = {
            ...notebook,
            ...updates,
            updatedAt: new Date().toISOString()
        };
        return this.update('notebooks', updated);
    }

    /**
     * Upsert a notebook: create if not exists, update if exists.
     * Used by sync to import remote notebooks.
     */
    async upsertNotebook(data) {
        const existing = await this.getNotebook(data.id);
        if (existing) {
            const updated = { ...existing, ...data, updatedAt: data.updatedAt || new Date().toISOString() };
            return this.update('notebooks', updated);
        } else {
            const notebook = {
                id: data.id,
                name: data.name || '新建笔记本',
                folderId: data.folderId ?? null,
                order: data.order || Date.now(),
                pageStyle: data.pageStyle || { pattern: 'blank', color: '#ffffff' },
                createdAt: data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt || new Date().toISOString(),
                ...data
            };
            return this.update('notebooks', notebook);
        }
    }
    
    async deleteNotebook(id) {
        // Delete all notes in this notebook
        const notes = await this.getByIndex('notes', 'notebookId', id);
        for (const note of notes) {
            await this.deleteNote(note.id);
        }
        
        return this.delete('notebooks', id);
    }
    
    // Notes
    async createNote(data) {
        const note = {
            id: this.generateId(),
            title: data.title || '新建笔记',
            type: data.type || 'text', // 'text' or 'ink'
            content: data.content || (data.type === 'ink' ? { version: 1, strokes: [] } : ''),
            notebookId: data.notebookId,
            order: data.order || Date.now(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // If OPFS is active, write content to block storage
        if (this.storageEngine === 'opfs' && this.opfs) {
            await this.opfs.writeNoteContent(note.id, note.content);
            const idbNote = { ...note, content: '__opfs__' };
            await this.add('notes', idbNote);
            return note; // Return with full content
        }

        return this.add('notes', note);
    }
    
    async getNote(id) {
        const note = await this.get('notes', id);
        if (!note) return note;

        // If OPFS is active, read content from block storage
        if (this.storageEngine === 'opfs' && this.opfs && note.content === '__opfs__') {
            const content = await this.opfs.readNoteContent(id);
            if (content !== null) {
                let parsed = content;
                try { parsed = JSON.parse(content); } catch { /* keep as string */ }
                return { ...note, content: parsed };
            }
        }

        return note;
    }
    
    async getAllNotes() {
        const notes = await this.getAll('notes');
        if (this.storageEngine === 'opfs' && this.opfs) {
            return Promise.all(notes.map(async (note) => {
                if (note.content === '__opfs__') {
                    const content = await this.opfs.readNoteContent(note.id);
                    if (content !== null) {
                        let parsed = content;
                        try { parsed = JSON.parse(content); } catch { /* keep as string */ }
                        return { ...note, content: parsed };
                    }
                }
                return note;
            }));
        }
        return notes;
    }
    
    async getNotesInNotebook(notebookId) {
        const notes = await this.getByIndex('notes', 'notebookId', notebookId);
        if (this.storageEngine === 'opfs' && this.opfs) {
            return Promise.all(notes.map(async (note) => {
                if (note.content === '__opfs__') {
                    const content = await this.opfs.readNoteContent(note.id);
                    if (content !== null) {
                        let parsed = content;
                        try { parsed = JSON.parse(content); } catch { /* keep as string */ }
                        return { ...note, content: parsed };
                    }
                }
                return note;
            }));
        }
        return notes;
    }
    
    async updateNote(id, updates) {
        const note = await this.get('notes', id); // Raw IDB get (no OPFS content load)
        if (!note) throw new Error('Note not found');
        
        const updated = {
            ...note,
            ...updates,
            updatedAt: new Date().toISOString()
        };

        // If OPFS is active and content changed, write to OPFS
        if (this.storageEngine === 'opfs' && this.opfs && updates.content !== undefined) {
            await this.opfs.writeNoteContent(id, updates.content);
            const idbUpdated = { ...updated, content: '__opfs__' };
            return this.update('notes', idbUpdated);
        }

        return this.update('notes', updated);
    }

    /**
     * Upsert a note: create if not exists, update if exists.
     * Used by sync to import remote notes.
     */
    async upsertNote(data) {
        const existing = await this.get('notes', data.id); // Raw IDB get
        if (existing) {
            const updated = { ...existing, ...data, updatedAt: data.updatedAt || new Date().toISOString() };

            if (this.storageEngine === 'opfs' && this.opfs && data.content !== undefined) {
                await this.opfs.writeNoteContent(data.id, data.content);
                return this.update('notes', { ...updated, content: '__opfs__' });
            }

            return this.update('notes', updated);
        } else {
            const note = {
                id: data.id,
                title: data.title || '新建笔记',
                type: data.type || 'text',
                content: data.content || '',
                notebookId: data.notebookId,
                order: data.order || Date.now(),
                createdAt: data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt || new Date().toISOString(),
                ...data
            };

            if (this.storageEngine === 'opfs' && this.opfs) {
                await this.opfs.writeNoteContent(note.id, note.content);
                return this.update('notes', { ...note, content: '__opfs__' });
            }

            return this.update('notes', note);
        }
    }
    
    async deleteNote(id) {
        // Also delete from OPFS if active
        if (this.storageEngine === 'opfs' && this.opfs) {
            await this.opfs.deleteNoteContent(id);
        }
        return this.delete('notes', id);
    }
    
    // Settings
    async getSetting(key) {
        const result = await this.get('settings', key);
        return result?.value;
    }
    
    async setSetting(key, value) {
        return this.update('settings', { key, value });
    }

    // Image blobs (for ink note images)
    async saveImageBlob(imageBlob) {
        return this.update('imageBlobs', imageBlob);
    }

    async getImageBlob(id) {
        return this.get('imageBlobs', id);
    }

    async deleteImageBlob(id) {
        return this.delete('imageBlobs', id);
    }

    async getImageBlobsByNote(noteId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('imageBlobs', 'readonly');
            const store = tx.objectStore('imageBlobs');
            const index = store.index('noteId');
            const request = index.getAll(noteId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteImageBlobsByNote(noteId) {
        const blobs = await this.getImageBlobsByNote(noteId);
        for (const blob of blobs) {
            await this.delete('imageBlobs', blob.id);
        }
    }

    async exportAllData() {
        const [folders, notebooks, notes, devices, syncLog, settings, modelChunks] = await Promise.all([
            this.getAll('folders'),
            this.getAll('notebooks'),
            this.getAllNotes(), // Use OPFS-aware method to export full note content
            this.getAll('devices'),
            this.getAll('syncLog'),
            this.getAll('settings'),
            this.getAll('modelChunks')
        ]);

        const result = {
            version: DB_VERSION,
            exportedAt: new Date().toISOString(),
            stores: {
                folders,
                notebooks,
                notes,
                devices,
                syncLog,
                settings,
                modelChunks
            }
        };

        // If OPFS is active, include OPFS mirror data
        if (this.storageEngine === 'opfs' && this.opfs) {
            result.opfsMirror = await this.opfs.exportMirror();
        }

        return result;
    }

    async importAllData(payload) {
        if (!payload?.stores) {
            throw new Error('Invalid backup data');
        }

        const storeNames = ['folders', 'notebooks', 'notes', 'devices', 'syncLog', 'settings', 'modelChunks'];
        await new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeNames, 'readwrite');

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Import failed'));

            storeNames.forEach((name) => {
                const store = transaction.objectStore(name);
                store.clear();
                const entries = payload.stores[name] || [];
                entries.forEach((item) => {
                    store.put(item);
                });
            });
        });

        // Re-detect storage engine from imported settings
        await this._initStorageEngine();

        // Import OPFS mirror if present
        if (payload.opfsMirror && this.storageEngine === 'opfs' && this.opfs) {
            await this.opfs.importMirror(payload.opfsMirror);
        }
    }
    
    // Devices
    async createDevice(data) {
        const device = {
            id: data.id || this.generateId(),
            publicKey: data.publicKey,
            name: data.name || 'Unknown Device',
            lastSync: data.lastSync || null,
            createdAt: new Date().toISOString()
        };
        return this.add('devices', device);
    }
    
    async getDevice(id) {
        return this.get('devices', id);
    }
    
    async getAllDevices() {
        return this.getAll('devices');
    }
    
    async updateDevice(id, updates) {
        const device = await this.getDevice(id);
        if (!device) throw new Error('Device not found');
        
        return this.update('devices', { ...device, ...updates });
    }
    
    async deleteDevice(id) {
        return this.delete('devices', id);
    }
    
    // Sync Log
    async addSyncLog(data) {
        const log = {
            operation: data.operation, // 'create', 'update', 'delete'
            noteId: data.noteId,
            timestamp: new Date().toISOString(),
            hash: data.hash || null,
            deviceId: data.deviceId || null
        };
        return this.add('syncLog', log);
    }
    
    async getSyncLogSince(timestamp) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction('syncLog', 'readonly');
            const store = transaction.objectStore('syncLog');
            const index = store.index('timestamp');
            const range = IDBKeyRange.lowerBound(timestamp, true);
            const request = index.getAll(range);
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    
    async clearSyncLog() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction('syncLog', 'readwrite');
            const store = transaction.objectStore('syncLog');
            const request = store.clear();
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    
    // Model storage
    async saveModelChunk(modelName, chunkIndex, data) {
        const chunk = {
            id: `${modelName}_${chunkIndex}`,
            modelName,
            chunkIndex,
            data,
            savedAt: new Date().toISOString()
        };
        return this.update('modelChunks', chunk);
    }
    
    async getModelChunk(modelName, chunkIndex) {
        return this.get('modelChunks', `${modelName}_${chunkIndex}`);
    }
    
    async getModelChunks(modelName) {
        return this.getByIndex('modelChunks', 'modelName', modelName);
    }
    
    async deleteModelChunks(modelName) {
        const chunks = await this.getModelChunks(modelName);
        for (const chunk of chunks) {
            await this.delete('modelChunks', chunk.id);
        }
    }
    
    async isModelDownloaded(modelName) {
        const chunks = await this.getModelChunks(modelName);
        return chunks.length > 0;
    }
}
