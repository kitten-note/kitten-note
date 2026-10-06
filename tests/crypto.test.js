/*
 * KittenNote - Sync Crypto Tests
 *
 * Validates js/crypto.js in Node (WebCrypto via node:crypto when the
 * runtime does not expose globalThis.crypto, e.g. Node 18).
 *
 * Run with:
 *   node tests/crypto.test.js
 */

// ============================================================
// WebCrypto bootstrap for Node
// ============================================================

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
}

const {
    SyncCrypto,
    buildHandshakeBinding,
    randomNonce,
    bytesToBase64,
    base64ToBytes
} = await import('../js/crypto.js');

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

async function assertThrows(fn, message) {
    try {
        await fn();
    } catch {
        return;
    }
    throw new Error('Expected an exception: ' + message);
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

console.log('\n🔐 Sync Crypto Tests\n');

// ---- Identity ----

console.log('🪪 Identity keys');

await test('generateIdentity returns usable sign+ecdh pairs', async () => {
    const id = await SyncCrypto.generateIdentity();
    assert(id.sign?.publicKey && id.sign?.privateKey, 'sign key pair exists');
    assert(id.ecdh?.publicKey && id.ecdh?.privateKey, 'ecdh key pair exists');
    assertEqual(id.sign.publicKey.type, 'public', 'sign public key type');
    assertEqual(id.sign.privateKey.type, 'private', 'sign private key type');
});

await test('export/import round-trip preserves key material', async () => {
    const id = await SyncCrypto.generateIdentity();
    const signPair = await SyncCrypto.exportPair(id.sign);
    const ecdhPair = await SyncCrypto.exportPair(id.ecdh);
    assert(typeof signPair.publicKey === 'string' && signPair.publicKey.length > 0, 'sign pub exported');
    assert(typeof ecdhPair.privateKey === 'string' && ecdhPair.privateKey.length > 0, 'ecdh priv exported');

    const sign2 = await SyncCrypto.importSignPair(signPair);
    const ecdh2 = await SyncCrypto.importEcdhPair(ecdhPair);

    // A signature made with the original key must verify with the re-imported one.
    const sig = await SyncCrypto.sign(id.sign.privateKey, 'round-trip payload');
    assert(await SyncCrypto.verify(sign2.publicKey, sig, 'round-trip payload'), 're-imported sign key verifies');
    // And the re-imported ECDH private key must still derive (checked implicitly: no throw).
    const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: ecdh2.publicKey }, ecdh2.privateKey, 256
    );
    assert(bits.byteLength === 32, 're-imported ecdh key derives 256 bits');
});

// ---- Signatures ----

console.log('\n✍️  Handshake signatures');

await test('sign/verify handshake binding', async () => {
    const id = await SyncCrypto.generateIdentity();
    const binding = buildHandshakeBinding('offer', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n', [
        { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    ]);
    const sig = await SyncCrypto.sign(id.sign.privateKey, binding);
    assert(await SyncCrypto.verify(id.sign.publicKey, sig, binding), 'valid signature verifies');
});

await test('tampered SDP fails verification', async () => {
    const id = await SyncCrypto.generateIdentity();
    const original = buildHandshakeBinding('offer', 'sdp-A', []);
    const tampered = buildHandshakeBinding('offer', 'sdp-B', []);
    const sig = await SyncCrypto.sign(id.sign.privateKey, original);
    assert(!(await SyncCrypto.verify(id.sign.publicKey, sig, tampered)), 'tampered binding must not verify');
});

await test('signature from another key fails verification', async () => {
    const a = await SyncCrypto.generateIdentity();
    const b = await SyncCrypto.generateIdentity();
    const binding = buildHandshakeBinding('answer', 'sdp', []);
    const sig = await SyncCrypto.sign(a.sign.privateKey, binding);
    assert(!(await SyncCrypto.verify(b.sign.publicKey, sig, binding)), 'foreign signature must not verify');
});

await test('malformed signature returns false instead of throwing', async () => {
    const id = await SyncCrypto.generateIdentity();
    assert(!(await SyncCrypto.verify(id.sign.publicKey, 'not-base64!!', 'x')), 'garbage signature → false');
});

await test('binding is stable across JSON round-trips', async () => {
    const candidates = [
        { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' },
        { candidate: 'c2', sdpMid: null, sdpMLineIndex: 1 }
    ];
    const direct = buildHandshakeBinding('offer', 'SDP', candidates);
    const roundTripped = buildHandshakeBinding('offer', 'SDP', JSON.parse(JSON.stringify(candidates)));
    assertEqual(roundTripped, direct, 'binding string equality');
});

// ---- Session keys / encryption ----

console.log('\n🔒 ECDH + AES-GCM');

await test('both peers derive the same session key and can talk', async () => {
    const a = await SyncCrypto.generateIdentity();
    const b = await SyncCrypto.generateIdentity();
    const aPub = (await SyncCrypto.exportPair(a.ecdh)).publicKey;
    const bPub = (await SyncCrypto.exportPair(b.ecdh)).publicKey;

    const offerNonce = randomNonce(16);
    const answerNonce = randomNonce(16);
    const salt = `${offerNonce}|${answerNonce}`;

    const keyA = await SyncCrypto.deriveSessionKey(a.ecdh.privateKey, bPub, salt);
    const keyB = await SyncCrypto.deriveSessionKey(b.ecdh.privateKey, aPub, salt);

    const envelope = await SyncCrypto.encryptString(keyA, '{"type":"sync_request","hello":"猫咪"}');
    assert(SyncCrypto.isEnvelope(envelope), 'envelope has KTNENC1 prefix');
    const plaintext = await SyncCrypto.decryptString(keyB, envelope);
    assertEqual(plaintext, '{"type":"sync_request","hello":"猫咪"}', 'B decrypted A\'s message');

    const reply = await SyncCrypto.encryptString(keyB, 'ack');
    assertEqual(await SyncCrypto.decryptString(keyA, reply), 'ack', 'A decoded B\'s reply');
});

await test('different salt produces an incompatible key', async () => {
    const a = await SyncCrypto.generateIdentity();
    const b = await SyncCrypto.generateIdentity();
    const aPub = (await SyncCrypto.exportPair(a.ecdh)).publicKey;
    const bPub = (await SyncCrypto.exportPair(b.ecdh)).publicKey;

    const keyA = await SyncCrypto.deriveSessionKey(a.ecdh.privateKey, bPub, 'salt-1');
    const keyWrong = await SyncCrypto.deriveSessionKey(b.ecdh.privateKey, aPub, 'salt-2');

    const envelope = await SyncCrypto.encryptString(keyA, 'secret');
    await assertThrows(() => SyncCrypto.decryptString(keyWrong, envelope), 'wrong key must fail decryption');
});

await test('tampered ciphertext is rejected (GCM auth tag)', async () => {
    const a = await SyncCrypto.generateIdentity();
    const b = await SyncCrypto.generateIdentity();
    const aPub = (await SyncCrypto.exportPair(a.ecdh)).publicKey;
    const bPub = (await SyncCrypto.exportPair(b.ecdh)).publicKey;
    const keyA = await SyncCrypto.deriveSessionKey(a.ecdh.privateKey, bPub, 's');
    const keyB = await SyncCrypto.deriveSessionKey(b.ecdh.privateKey, aPub, 's');

    const envelope = await SyncCrypto.encryptString(keyA, 'payload');
    const [prefixAndIv, ctB64] = [
        envelope.slice(0, envelope.lastIndexOf(':')),
        envelope.slice(envelope.lastIndexOf(':') + 1)
    ];
    const bytes = base64ToBytes(ctB64);
    bytes[0] ^= 0xff; // flip a bit
    const tampered = `${prefixAndIv}:${bytesToBase64(bytes)}`;
    await assertThrows(() => SyncCrypto.decryptString(keyB, tampered), 'tampered ciphertext must fail');
});

await test('each encryption uses a fresh IV', async () => {
    const a = await SyncCrypto.generateIdentity();
    const b = await SyncCrypto.generateIdentity();
    const aPub = (await SyncCrypto.exportPair(a.ecdh)).publicKey;
    const bPub = (await SyncCrypto.exportPair(b.ecdh)).publicKey;
    const keyA = await SyncCrypto.deriveSessionKey(a.ecdh.privateKey, bPub, 's');

    const e1 = await SyncCrypto.encryptString(keyA, 'same');
    const e2 = await SyncCrypto.encryptString(keyA, 'same');
    assert(e1 !== e2, 'ciphertexts differ (random IV)');
    const iv1 = e1.slice(SyncCrypto.ENVELOPE_PREFIX.length, e1.indexOf(':', SyncCrypto.ENVELOPE_PREFIX.length));
    const iv2 = e2.slice(SyncCrypto.ENVELOPE_PREFIX.length, e2.indexOf(':', SyncCrypto.ENVELOPE_PREFIX.length));
    assert(iv1 !== iv2, 'IVs differ');
});

await test('isEnvelope rejects plaintext and random strings', () => {
    assert(!SyncCrypto.isEnvelope('{"type":"sync_request"}'), 'JSON is not an envelope');
    assert(!SyncCrypto.isEnvelope('KTN1:1/2:data'), 'QR chunk payload is not an envelope');
    assert(!SyncCrypto.isEnvelope(null), 'null is not an envelope');
});

await test('randomNonce returns distinct 16-byte values', () => {
    const n1 = randomNonce();
    const n2 = randomNonce();
    assert(n1 !== n2, 'nonces differ');
    assertEqual(base64ToBytes(n1).length, 16, 'nonce byte length');
});

// ============================================================
// Results
// ============================================================

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
}
console.log('═'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
