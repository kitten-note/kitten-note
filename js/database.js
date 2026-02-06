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

const DB_NAME = 'KittenNoteDB';
const DB_VERSION = 2;

export class Database {
    constructor() {
        this.db = null;
    }
    
    async init() {
        return new Promise((resolve, reject) => {
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
            };
        });
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
        return this.add('notes', note);
    }
    
    async getNote(id) {
        return this.get('notes', id);
    }
    
    async getAllNotes() {
        return this.getAll('notes');
    }
    
    async getNotesInNotebook(notebookId) {
        return this.getByIndex('notes', 'notebookId', notebookId);
    }
    
    async updateNote(id, updates) {
        const note = await this.getNote(id);
        if (!note) throw new Error('Note not found');
        
        const updated = {
            ...note,
            ...updates,
            updatedAt: new Date().toISOString()
        };
        return this.update('notes', updated);
    }

    /**
     * Upsert a note: create if not exists, update if exists.
     * Used by sync to import remote notes.
     */
    async upsertNote(data) {
        const existing = await this.getNote(data.id);
        if (existing) {
            const updated = { ...existing, ...data, updatedAt: data.updatedAt || new Date().toISOString() };
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
            return this.update('notes', note);
        }
    }
    
    async deleteNote(id) {
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

    async exportAllData() {
        const [folders, notebooks, notes, devices, syncLog, settings, modelChunks] = await Promise.all([
            this.getAll('folders'),
            this.getAll('notebooks'),
            this.getAll('notes'),
            this.getAll('devices'),
            this.getAll('syncLog'),
            this.getAll('settings'),
            this.getAll('modelChunks')
        ]);

        return {
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
    }

    async importAllData(payload) {
        if (!payload?.stores) {
            throw new Error('Invalid backup data');
        }

        const storeNames = ['folders', 'notebooks', 'notes', 'devices', 'syncLog', 'settings', 'modelChunks'];
        return new Promise((resolve, reject) => {
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
