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
 * KittenNote - Sync cryptography
 *
 * Application-layer end-to-end encryption for the WebRTC sync channel:
 *
 *   • Identity        – long-term ECDSA P-256 key pair (signing) +
 *                       ECDH P-256 key pair (key agreement) per device.
 *   • Handshake       – the QR-exchanged offer/answer payloads carry each
 *                       side's public keys, a random nonce and an ECDSA
 *                       signature over the SDP + ICE candidates. Because the
 *                       payload itself travels out-of-band (QR), this binds
 *                       the DTLS fingerprint to the device keys and blocks
 *                       man-in-the-middle tampering of the handshake.
 *   • Session key     – HKDF-SHA256 over the ECDH shared secret with the
 *                       concatenated nonces as salt → AES-256-GCM.
 *   • Messages        – every sync message is encrypted with a fresh random
 *                       96-bit IV; envelope format `KTNENC1:<ivB64>:<ctB64>`.
 *
 * WebCrypto only — no dependencies. Runs in the browser and in Node ≥ 18
 * (globalThis.crypto is used; tests polyfill it from node:crypto).
 */

const ECDSA_ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH_ALGO = { name: 'ECDH', namedCurve: 'P-256' };
const AES_ALGO = { name: 'AES-GCM', length: 256 };
const HKDF_INFO = 'KittenNote-Sync-v1';
const ENVELOPE_PREFIX = 'KTNENC1:';
const IV_BYTES = 12;

function subtleCrypto() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) {
        throw new Error('WebCrypto (crypto.subtle) is not available');
    }
    return c;
}

/** base64-encode an ArrayBuffer/TypedArray (safe for large buffers). */
export function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** base64-decode into a Uint8Array. */
export function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** Random bytes as base64. */
export function randomNonce(byteLength = 16) {
    const bytes = new Uint8Array(byteLength);
    subtleCrypto().getRandomValues(bytes);
    return bytesToBase64(bytes);
}

/**
 * Stable serialization of the handshake material that gets signed.
 * Both peers must compute the exact same string from the received payload.
 */
export function buildHandshakeBinding(type, sdp, candidates) {
    const canonicalCandidates = (Array.isArray(candidates) ? candidates : []).map((c) => ({
        candidate: c?.candidate ?? '',
        sdpMid: c?.sdpMid ?? null,
        sdpMLineIndex: c?.sdpMLineIndex ?? 0
    }));
    return JSON.stringify({ t: type, s: sdp || '', c: canonicalCandidates });
}

export class SyncCrypto {
    static get ENVELOPE_PREFIX() {
        return ENVELOPE_PREFIX;
    }

    static isEnvelope(data) {
        return typeof data === 'string' && data.startsWith(ENVELOPE_PREFIX);
    }

    /** Generate a fresh identity (signing + key-agreement key pairs). */
    static async generateIdentity() {
        const { subtle } = subtleCrypto();
        const sign = await subtle.generateKey(ECDSA_ALGO, true, ['sign', 'verify']);
        const ecdh = await subtle.generateKey(ECDH_ALGO, true, ['deriveKey', 'deriveBits']);
        return { sign, ecdh };
    }

    /** Export a key pair to base64 (SPKI public / PKCS#8 private). */
    static async exportPair(pair) {
        const { subtle } = subtleCrypto();
        const [publicKey, privateKey] = await Promise.all([
            subtle.exportKey('spki', pair.publicKey),
            subtle.exportKey('pkcs8', pair.privateKey)
        ]);
        return {
            publicKey: bytesToBase64(publicKey),
            privateKey: bytesToBase64(privateKey)
        };
    }

    /** Import a signing key pair from base64. */
    static async importSignPair({ publicKey, privateKey }) {
        const { subtle } = subtleCrypto();
        const pub = await subtle.importKey(
            'spki', base64ToBytes(publicKey), ECDSA_ALGO, true, ['verify']
        );
        const priv = await subtle.importKey(
            'pkcs8', base64ToBytes(privateKey), ECDSA_ALGO, true, ['sign']
        );
        return { publicKey: pub, privateKey: priv };
    }

    /** Import a key-agreement key pair from base64. */
    static async importEcdhPair({ publicKey, privateKey }) {
        const { subtle } = subtleCrypto();
        const pub = await subtle.importKey(
            'spki', base64ToBytes(publicKey), ECDH_ALGO, true, []
        );
        const priv = await subtle.importKey(
            'pkcs8', base64ToBytes(privateKey), ECDH_ALGO, true, ['deriveKey', 'deriveBits']
        );
        return { publicKey: pub, privateKey: priv };
    }

    /** Import a peer's ECDSA public key (SPKI, base64). */
    static async importSignPublicKey(publicKeyBase64) {
        const { subtle } = subtleCrypto();
        return subtle.importKey(
            'spki', base64ToBytes(publicKeyBase64), ECDSA_ALGO, true, ['verify']
        );
    }

    /** Sign a UTF-8 string with an ECDSA private key → base64 signature. */
    static async sign(privateKey, dataString) {
        const { subtle } = subtleCrypto();
        const data = new TextEncoder().encode(dataString);
        const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
        return bytesToBase64(signature);
    }

    /** Verify a base64 ECDSA signature over a UTF-8 string. Never throws. */
    static async verify(publicKey, signatureBase64, dataString) {
        try {
            const { subtle } = subtleCrypto();
            const data = new TextEncoder().encode(dataString);
            const signature = base64ToBytes(signatureBase64);
            return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data);
        } catch {
            return false;
        }
    }

    /**
     * Derive the AES-GCM session key.
     *
     * @param {CryptoKey} ecdhPrivateKey   – our ECDH private key
     * @param {string}    peerPublicKeyB64 – peer ECDH public key (SPKI, base64)
     * @param {string}    saltString       – e.g. `${offerNonce}|${answerNonce}`
     */
    static async deriveSessionKey(ecdhPrivateKey, peerPublicKeyB64, saltString) {
        const { subtle } = subtleCrypto();
        const peerPublicKey = await subtle.importKey(
            'spki', base64ToBytes(peerPublicKeyB64), ECDH_ALGO, false, []
        );
        const sharedBits = await subtle.deriveBits(
            { name: 'ECDH', public: peerPublicKey }, ecdhPrivateKey, 256
        );
        const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
        return subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new TextEncoder().encode(saltString),
                info: new TextEncoder().encode(HKDF_INFO)
            },
            hkdfKey,
            AES_ALGO,
            false,
            ['encrypt', 'decrypt']
        );
    }

    /** Encrypt a UTF-8 string → `KTNENC1:<ivB64>:<ciphertextB64>`. */
    static async encryptString(sessionKey, plaintext) {
        const { subtle } = subtleCrypto();
        const iv = subtleCrypto().getRandomValues(new Uint8Array(IV_BYTES));
        const data = new TextEncoder().encode(plaintext);
        const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, data);
        return `${ENVELOPE_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
    }

    /**
     * Decrypt an envelope produced by encryptString.
     * Throws when the envelope is malformed, tampered with, or the key is wrong.
     */
    static async decryptString(sessionKey, envelope) {
        if (!this.isEnvelope(envelope)) {
            throw new Error('Not a KittenNote encrypted envelope');
        }
        const payload = envelope.slice(ENVELOPE_PREFIX.length);
        const separator = payload.indexOf(':');
        if (separator <= 0) {
            throw new Error('Malformed encrypted envelope');
        }
        const iv = base64ToBytes(payload.slice(0, separator));
        const ciphertext = base64ToBytes(payload.slice(separator + 1));
        const { subtle } = subtleCrypto();
        const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, sessionKey, ciphertext);
        return new TextDecoder().decode(plaintext);
    }

    /** SHA-256 over bytes → base64. Used for chunk integrity checks. */
    static async sha256Base64(bytes) {
        const { subtle } = subtleCrypto();
        const digest = await subtle.digest('SHA-256', bytes);
        return bytesToBase64(digest);
    }
}
