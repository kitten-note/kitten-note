/*
 * KittenNote - OPFS Block Storage Tests
 * 
 * These tests validate the OPFS block storage engine, migration logic,
 * and JSON import detection. Run with Node.js:
 *   node tests/opfs-storage.test.js
 * 
 * Uses a mock OPFS filesystem for testing outside the browser.
 */

// ============================================================
// Mock OPFS Environment for Node.js
// ============================================================

class MockFileHandle {
    constructor(name, parent) {
        this.kind = 'file';
        this.name = name;
        this._parent = parent;
        this._data = new Uint8Array(0);
    }

    async getFile() {
        const data = this._data;
        return {
            text: async () => new TextDecoder().decode(data),
            arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        };
    }

    async createWritable() {
        const handle = this;
        const chunks = [];
        return {
            async write(data) {
                if (typeof data === 'string') {
                    chunks.push(new TextEncoder().encode(data));
                } else if (data instanceof Uint8Array) {
                    chunks.push(data);
                } else if (data instanceof ArrayBuffer) {
                    chunks.push(new Uint8Array(data));
                } else {
                    chunks.push(new TextEncoder().encode(String(data)));
                }
            },
            async close() {
                const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
                const combined = new Uint8Array(totalLen);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                handle._data = combined;
            }
        };
    }
}

class MockDirectoryHandle {
    constructor(name) {
        this.kind = 'directory';
        this.name = name;
        this._entries = new Map();
    }

    async getDirectoryHandle(name, options = {}) {
        if (this._entries.has(name) && this._entries.get(name).kind === 'directory') {
            return this._entries.get(name);
        }
        if (options.create) {
            const dir = new MockDirectoryHandle(name);
            this._entries.set(name, dir);
            return dir;
        }
        throw new DOMException('Not found', 'NotFoundError');
    }

    async getFileHandle(name, options = {}) {
        if (this._entries.has(name) && this._entries.get(name).kind === 'file') {
            return this._entries.get(name);
        }
        if (options.create) {
            const file = new MockFileHandle(name, this);
            this._entries.set(name, file);
            return file;
        }
        throw new DOMException('Not found', 'NotFoundError');
    }

    async removeEntry(name, options = {}) {
        if (!this._entries.has(name)) {
            throw new DOMException('Not found', 'NotFoundError');
        }
        this._entries.delete(name);
    }

    async *entries() {
        for (const [name, handle] of this._entries) {
            yield [name, handle];
        }
    }
}

// Set up global mocks
let mockOpfsRoot = new MockDirectoryHandle('root');

if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = {};
}
if (!globalThis.navigator.storage) {
    globalThis.navigator.storage = {};
}
globalThis.navigator.storage.getDirectory = async () => mockOpfsRoot;

if (typeof globalThis.crypto === 'undefined') {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
}

if (typeof globalThis.TextEncoder === 'undefined') {
    const { TextEncoder, TextDecoder } = await import('node:util');
    globalThis.TextEncoder = TextEncoder;
    globalThis.TextDecoder = TextDecoder;
}

// ============================================================
// Import the module
// ============================================================

const { OPFSBlockStorage } = await import('../js/opfs-storage.js');

// ============================================================
// Test Framework
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (!condition) {
        throw new Error('Assertion failed: ' + message);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

// ============================================================
// Tests
// ============================================================

console.log('\n🧪 OPFS Block Storage Tests\n');

// Reset OPFS mock before each test group
function resetMockFS() {
    mockOpfsRoot = new MockDirectoryHandle('root');
    globalThis.navigator.storage.getDirectory = async () => mockOpfsRoot;
}

// ---- Basic Operations ----

console.log('📦 Basic Operations');

await test('isSupported returns true when navigator.storage.getDirectory exists', () => {
    assert(OPFSBlockStorage.isSupported(), 'Should be supported with mock');
});

await test('BLOCK_SIZE is 128KB', () => {
    assertEqual(OPFSBlockStorage.BLOCK_SIZE, 128 * 1024, 'Block size should be 128KB');
});

await test('init creates root directory structure', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();
    assert(storage._root !== null, 'Root should be initialized');
    assert(storage._notesDir !== null, 'Notes dir should be initialized');
    assert(storage._masterIndex !== null, 'Master index should be initialized');
});

// ---- Write/Read Operations ----

console.log('\n📝 Write/Read Operations');

await test('write and read small text content', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-note-1';
    const content = 'Hello, KittenNote! This is a test note.';
    const stats = await storage.writeNoteContent(noteId, content);

    assertEqual(stats.totalBlocks, 1, 'Small content should fit in 1 block');
    assertEqual(stats.blocksWritten, 1, 'Should write 1 block');
    assertEqual(stats.blocksUnchanged, 0, 'No unchanged blocks on first write');

    const readContent = await storage.readNoteContent(noteId);
    assertEqual(readContent, content, 'Read content should match written content');
});

await test('write and read object content (JSON)', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-ink-1';
    const content = { version: 1, strokes: [{ points: [1, 2, 3] }] };
    await storage.writeNoteContent(noteId, content);

    const readContent = await storage.readNoteContent(noteId);
    assertEqual(readContent, JSON.stringify(content), 'Should read back JSON string of object');
});

await test('write large content splits into multiple blocks', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-large-1';
    // Create content larger than 128KB
    const content = 'A'.repeat(200 * 1024); // 200KB
    const stats = await storage.writeNoteContent(noteId, content);

    assertEqual(stats.totalBlocks, 2, 'Should split into 2 blocks');
    assertEqual(stats.blocksWritten, 2, 'Should write 2 blocks');

    const readContent = await storage.readNoteContent(noteId);
    assertEqual(readContent, content, 'Should read back complete content');
});

// ---- Incremental Writes ----

console.log('\n🔄 Incremental Write Detection');

await test('unchanged content does not rewrite blocks', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-incr-1';
    const content = 'Some content for incremental test';
    await storage.writeNoteContent(noteId, content);

    // Write same content again
    const stats = await storage.writeNoteContent(noteId, content);
    assertEqual(stats.blocksWritten, 0, 'No blocks should be rewritten');
    assertEqual(stats.blocksUnchanged, 1, '1 block should be unchanged');
});

await test('modified content rewrites only changed blocks', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-incr-2';
    // Create 3-block content
    const block1 = 'A'.repeat(128 * 1024);
    const block2 = 'B'.repeat(128 * 1024);
    const block3 = 'C'.repeat(50 * 1024);
    const content = block1 + block2 + block3;

    const firstStats = await storage.writeNoteContent(noteId, content);
    assertEqual(firstStats.totalBlocks, 3, 'Initial write should have 3 blocks');

    // Modify only the last block
    const newContent = block1 + block2 + 'D'.repeat(50 * 1024);
    const secondStats = await storage.writeNoteContent(noteId, newContent);
    assertEqual(secondStats.blocksWritten, 1, 'Only 1 block should be rewritten');
    assertEqual(secondStats.blocksUnchanged, 2, '2 blocks should be unchanged');
});

await test('shrinking content removes extra blocks', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-incr-3';
    // Write 3-block content
    const content = 'A'.repeat(300 * 1024);
    await storage.writeNoteContent(noteId, content);

    // Shrink to 1 block
    const smallContent = 'B'.repeat(50 * 1024);
    const stats = await storage.writeNoteContent(noteId, smallContent);
    assertEqual(stats.totalBlocks, 1, 'Should have 1 block after shrinking');
    assertEqual(stats.blocksRemoved, 2, 'Should remove 2 blocks');

    const readContent = await storage.readNoteContent(noteId);
    assertEqual(readContent, smallContent, 'Should read shrunk content');
});

// ---- Delete Operations ----

console.log('\n🗑️ Delete Operations');

await test('delete removes note content', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const noteId = 'test-del-1';
    await storage.writeNoteContent(noteId, 'Content to delete');
    assert(storage.hasNote(noteId), 'Note should exist before delete');

    await storage.deleteNoteContent(noteId);
    assert(!storage.hasNote(noteId), 'Note should not exist after delete');

    const readContent = await storage.readNoteContent(noteId);
    assertEqual(readContent, null, 'Read should return null after delete');
});

// ---- Health & Diagnostics ----

console.log('\n❤️ Health & Diagnostics');

await test('getHealthInfo returns correct stats', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.writeNoteContent('note-a', 'Content A');
    await storage.writeNoteContent('note-b', 'B'.repeat(200 * 1024));

    const health = await storage.getHealthInfo();
    assertEqual(health.noteCount, 2, 'Should have 2 notes');
    assertEqual(health.blockSize, 128 * 1024, 'Block size should be 128KB');
    assert(health.totalSize > 0, 'Total size should be > 0');
    assert(health.totalBlocks >= 2, 'Should have at least 2 blocks');
});

await test('verifyIntegrity on clean storage returns no issues', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.writeNoteContent('note-check', 'Integrity test content');

    const issues = await storage.verifyIntegrity();
    assertEqual(issues.length, 0, 'Should have no integrity issues');
});

await test('getAllNoteIds returns all stored note IDs', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.writeNoteContent('note-x', 'X');
    await storage.writeNoteContent('note-y', 'Y');
    await storage.writeNoteContent('note-z', 'Z');

    const ids = storage.getAllNoteIds();
    assertEqual(ids.length, 3, 'Should have 3 note IDs');
    assert(ids.includes('note-x'), 'Should include note-x');
    assert(ids.includes('note-y'), 'Should include note-y');
    assert(ids.includes('note-z'), 'Should include note-z');
});

// ---- Checkpoint Operations ----

console.log('\n💾 Checkpoint Operations');

await test('save and load checkpoint', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    const checkpoint = {
        status: 'in_progress',
        direction: 'to_opfs',
        completedNoteIds: ['a', 'b'],
        totalNoteIds: ['a', 'b', 'c'],
        startedAt: '2026-01-01T00:00:00.000Z'
    };
    await storage.saveCheckpoint(checkpoint);

    const loaded = await storage.loadCheckpoint();
    assertEqual(loaded.status, 'in_progress', 'Status should match');
    assertEqual(loaded.direction, 'to_opfs', 'Direction should match');
    assertEqual(loaded.completedNoteIds.length, 2, 'Should have 2 completed');
    assertEqual(loaded.totalNoteIds.length, 3, 'Should have 3 total');
});

await test('clearCheckpoint removes checkpoint', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.saveCheckpoint({ status: 'test' });
    await storage.clearCheckpoint();
    const loaded = await storage.loadCheckpoint();
    assertEqual(loaded, null, 'Checkpoint should be null after clear');
});

// ---- Mirror Export/Import ----

console.log('\n📦 Mirror Export/Import');

await test('exportMirror and importMirror round-trip', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.writeNoteContent('mirror-1', 'Mirror content 1');
    await storage.writeNoteContent('mirror-2', 'Mirror content 2');

    const mirror = await storage.exportMirror();
    assert(Object.keys(mirror).length > 0, 'Mirror should have files');

    // Create new storage and import
    resetMockFS();
    const storage2 = new OPFSBlockStorage();
    await storage2.init();

    await storage2.importMirror(mirror);

    const content1 = await storage2.readNoteContent('mirror-1');
    const content2 = await storage2.readNoteContent('mirror-2');
    assertEqual(content1, 'Mirror content 1', 'Mirror-1 should be restored');
    assertEqual(content2, 'Mirror content 2', 'Mirror-2 should be restored');
});

// ---- clearAll ----

console.log('\n🧹 Clear All');

await test('clearAll removes all OPFS data', async () => {
    resetMockFS();
    const storage = new OPFSBlockStorage();
    await storage.init();

    await storage.writeNoteContent('clear-1', 'To be cleared');
    assert(storage.hasNote('clear-1'), 'Note should exist');

    await storage.clearAll();
    assertEqual(Object.keys(storage._masterIndex).length, 0, 'Master index should be empty');
});

// ---- JSON Import Detection ----

console.log('\n📄 JSON Import Detection');

await test('detect ktnt format in JSON file', () => {
    // Simulate the detection logic from app.js
    const ktntJson = JSON.stringify({ format: 'ktnt', content: { version: 1, strokes: [] } });
    const parsed = JSON.parse(ktntJson);
    const isKtnt = parsed?.format === 'ktnt' || parsed?.content?.strokes;
    assert(isKtnt, 'Should detect ktnt format');
});

await test('detect ktnt by strokes field', () => {
    const strokesJson = JSON.stringify({ content: { strokes: [{ points: [1, 2] }] } });
    const parsed = JSON.parse(strokesJson);
    const isKtnt = parsed?.format === 'ktnt' || parsed?.content?.strokes;
    assert(isKtnt, 'Should detect strokes-based ktnt');
});

await test('non-ktnt JSON is not detected as ktnt', () => {
    const plainJson = JSON.stringify({ name: 'test', value: 42 });
    const parsed = JSON.parse(plainJson);
    const isKtnt = parsed?.format === 'ktnt' || parsed?.content?.strokes;
    assert(!isKtnt, 'Should not detect plain JSON as ktnt');
});

// ============================================================
// Results
// ============================================================

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
}
console.log('═'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
