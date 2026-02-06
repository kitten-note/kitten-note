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
 * KittenNote Service Worker
 * Handles offline caching and PWA functionality
 */

const CACHE_NAME = 'kitten-note-v1-u2';
const STATIC_CACHE = 'kitten-note-static-v1-u2';
const DYNAMIC_CACHE = 'kitten-note-dynamic-v1-u2';

// Core assets to cache immediately
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './LICENSE',
    // CSS
    './css/styles.css',
    './css/themes.css',
    './css/editor.css',
    './css/ink-editor.css',
    // JavaScript
    './js/app.js',
    './js/database.js',
    './js/directory-tree.js',
    './js/text-editor.js',
    './js/ink-editor.js',
    './js/settings.js',
    './js/sync.js',
    './js/nes.js',
    './js/export.js',
    './js/toast.js',
    // Icons
    './icons/favicon.ico',
    './icons/icon.svg',
    './icons/icon-32.png',
    './icons/icon-72.png',
    './icons/icon-96.png',
    './icons/icon-128.png',
    './icons/icon-144.png',
    './icons/icon-152.png',
    './icons/icon-192.png',
    './icons/icon-256.png',
    './icons/icon-384.png',
    './icons/icon-512.png',
    './icons/round.png',
    // FontAwesome
    './assets/fontawesome/css/all.min.css',
    './assets/fontawesome/webfonts/fa-solid-900.woff2',
    './assets/fontawesome/webfonts/fa-regular-400.woff2',
    './assets/fontawesome/webfonts/fa-brands-400.woff2',
    // QR Code libraries
    './assets/qrcode/qrcode-generator.min.js',
    './assets/qrcode/jsQR.min.js',
    // Transformers.js for AI features
    './assets/transformers.js/transformers.js',
    './assets/transformers.js/ort-wasm-simd-threaded.jsep.mjs',
    './assets/transformers.js/ort-wasm-simd-threaded.jsep.wasm',
    // NES model metadata (for offline readiness)
    './assets/nes-model/added_tokens.json',
    './assets/nes-model/chat_template.jinja',
    './assets/nes-model/config.json',
    './assets/nes-model/generation_config.json',
    './assets/nes-model/merges.txt',
    './assets/nes-model/package-lock.json',
    './assets/nes-model/package.json',
    './assets/nes-model/run_onnx.js',
    './assets/nes-model/special_tokens_map.json',
    './assets/nes-model/tokenizer.json',
    './assets/nes-model/tokenizer_config.json',
    './assets/nes-model/vocab.json'
];

const COI_PARAM = 'coi';

function shouldApplyCoi(request) {
    if (request.mode !== 'navigate') return false;
    try {
        const url = new URL(request.url);
        return url.searchParams.get(COI_PARAM) === '1';
    } catch {
        return false;
    }
}

function withCoiHeaders(response) {
    if (!response || response.type === 'opaque') return response;

    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    // Clone the response first to avoid "body already used" error
    const cloned = response.clone();
    return new Response(cloned.body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers
    });
}

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('[SW] Static assets cached');
                // Notify all clients about the new version
                return self.clients.matchAll().then((clients) => {
                    clients.forEach((client) => {
                        client.postMessage({ type: 'SW_UPDATE_AVAILABLE' });
                    });
                });
            })
            .catch((error) => {
                console.error('[SW] Failed to cache static assets:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            return name !== STATIC_CACHE && 
                                   name !== DYNAMIC_CACHE &&
                                   name.startsWith('kitten-note-');
                        })
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Service Worker activated');
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    
    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }
    
    // Skip cross-origin requests
    if (url.origin !== location.origin) {
        return;
    }
    
    // Handle model file separately (large file)
    if (url.pathname.includes('nes-model')) {
        event.respondWith(handleModelRequest(request));
        return;
    }
    
    // Handle WASM files
    if (url.pathname.includes('llama-cpp-wasm')) {
        event.respondWith(handleWasmRequest(request));
        return;
    }
    
    // Cache-first strategy for static assets
    if (isStaticAsset(url.pathname)) {
        event.respondWith(cacheFirst(request));
        return;
    }
    
    // Network-first strategy for HTML
    if (request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(networkFirst(request));
        return;
    }
    
    // Stale-while-revalidate for other assets
    event.respondWith(staleWhileRevalidate(request));
});

// Check if URL is a static asset
function isStaticAsset(pathname) {
    return pathname.endsWith('.js') ||
           pathname.endsWith('.css') ||
           pathname.endsWith('.woff2') ||
           pathname.endsWith('.svg') ||
           pathname.endsWith('.png') ||
           pathname.endsWith('.ico');
}

// Cache-first strategy
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }
    
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        console.error('[SW] Fetch failed:', error);
        return new Response('Offline', { status: 503 });
    }
}

// Network-first strategy
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            const finalResponse = shouldApplyCoi(request) ? withCoiHeaders(response) : response;
            cache.put(request, finalResponse.clone());
            return finalResponse;
        }
        return shouldApplyCoi(request) ? withCoiHeaders(response) : response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) {
            return shouldApplyCoi(request) ? withCoiHeaders(cached) : cached;
        }
        return new Response('Offline', { status: 503 });
    }
}

// Stale-while-revalidate strategy
async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
    
    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                caches.open(DYNAMIC_CACHE)
                    .then((cache) => cache.put(request, response.clone()));
            }
            return response;
        })
        .catch(() => cached);
    
    return cached || fetchPromise;
}

// Handle WASM requests
async function handleWasmRequest(request) {
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }
    
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        return new Response('WASM not available', { status: 503 });
    }
}

// Handle model file requests (large files with progress)
async function handleModelRequest(request) {
    // Don't cache the model file in Service Worker
    // It's stored in IndexedDB for better control
    try {
        return await fetch(request);
    } catch (error) {
        return new Response('Model not available', { status: 503 });
    }
}

// Message handling for cache control
self.addEventListener('message', (event) => {
    const { type, data } = event.data || {};
    
    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;
            
        case 'CACHE_URLS':
            if (data?.urls) {
                caches.open(DYNAMIC_CACHE)
                    .then((cache) => cache.addAll(data.urls));
            }
            break;
            
        case 'CLEAR_CACHE':
            caches.keys()
                .then((names) => Promise.all(names.map(name => caches.delete(name))));
            break;
    }
});

// Background sync for offline changes
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-notes') {
        event.waitUntil(syncNotes());
    }
});

async function syncNotes() {
    // This would sync pending changes when back online
    // The actual implementation is in the main app
    console.log('[SW] Background sync triggered');
}

// Push notifications (for future use)
self.addEventListener('push', (event) => {
    const data = event.data?.json() || {};
    
    const options = {
        body: data.body || 'New notification',
        icon: './icons/icon-192.png',
        badge: './icons/icon-72.png',
        vibrate: [100, 50, 100],
        data: data
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'KittenNote', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    event.waitUntil(
        clients.matchAll({ type: 'window' })
            .then((clientList) => {
                if (clientList.length > 0) {
                    return clientList[0].focus();
                }
                return clients.openWindow('./');
            })
    );
});

console.log('[SW] Service Worker loaded');
