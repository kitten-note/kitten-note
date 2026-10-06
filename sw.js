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

const SHELL_CACHE = 'kitten-note-shell-v3';
const RUNTIME_CACHE = 'kitten-note-runtime-v3';

// Core shell assets precached on install.
// Individual failures are tolerated by the per-asset allSettled below.
const SHELL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    // CSS
    './css/styles.css',
    './css/themes.css',
    './css/editor.css',
    './css/ink-editor.css',
    // JavaScript
    './js/app.js',
    './js/database.js',
    './js/directory-tree.js',
    './js/export.js',
    './js/ink-editor.js',
    './js/nes.js',
    './js/opfs-storage.js',
    './js/settings.js',
    './js/sync.js',
    './js/text-editor.js',
    './js/toast.js',
    './js/crypto.js',
    './js/utils.js',
    './js/model-cache.js',
    './js/pdf.js',
    './js/pdf-text.js',
    // Icons
    './icons/favicon.ico',
    './icons/icon.svg',
    './icons/round.png',
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
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
    // FontAwesome
    './assets/fontawesome/css/all.min.css',
    './assets/fontawesome/webfonts/fa-solid-900.woff2',
    './assets/fontawesome/webfonts/fa-regular-400.woff2',
    './assets/fontawesome/webfonts/fa-brands-400.woff2',
    // QR Code libraries
    './assets/qrcode/qrcode-generator.min.js',
    './assets/qrcode/jsQR.min.js'
];

const COI_PARAM = 'coi';

// Locally bundled AI runtime/model directories served cache-first from the runtime cache.
const RUNTIME_PREFIXES = ['/assets/transformers.js/', '/assets/nes-model/'];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KittenNote - 离线</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#333;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-align:center}
main{padding:2rem}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{margin:0;color:#666;line-height:1.6}
</style>
</head>
<body>
<main>
<h1>当前处于离线状态</h1>
<p>无法连接到网络，且本地缓存不可用。<br>请检查网络连接后刷新页面重试。</p>
</main>
</body>
</html>`;

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

// Install event - precache the app shell, tolerating individual failures
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(async (cache) => {
            const results = await Promise.allSettled(
                SHELL_ASSETS.map((url) => cache.add(url))
            );
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.warn('[SW] Failed to precache:', SHELL_ASSETS[index], result.reason);
                }
            });
        })
    );
});

// Activate event - remove stale caches, then take control of open clients
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => Promise.all(
                cacheNames
                    .filter((name) => {
                        return name.startsWith('kitten-note-') &&
                               name !== SHELL_CACHE &&
                               name !== RUNTIME_CACHE;
                    })
                    .map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch event - route same-origin GET requests to the right strategy
self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }

    if (url.origin !== self.location.origin) return;

    // Navigations: network-first, cached index.html as fallback, offline page as last resort
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    // Bundled AI runtime / model files: runtime cache-first
    if (RUNTIME_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
        // .onnx model weights are persisted in IndexedDB by the page; never cache them here
        if (url.pathname.endsWith('.onnx')) return;
        event.respondWith(runtimeCacheFirst(request));
        return;
    }

    // Shell-ish static assets: cache-first, network fallback
    if (isShellAsset(url.pathname)) {
        event.respondWith(shellCacheFirst(request));
        return;
    }

    // Everything else same-origin: stale-while-revalidate
    event.respondWith(staleWhileRevalidate(request));
});

function isShellAsset(pathname) {
    return pathname.endsWith('.js') ||
           pathname.endsWith('.css') ||
           pathname.endsWith('.woff2') ||
           pathname.endsWith('.svg') ||
           pathname.endsWith('.png') ||
           pathname.endsWith('.ico') ||
           pathname.endsWith('.json');
}

// Network-first navigation with COI header support
async function handleNavigation(request) {
    const applyCoi = shouldApplyCoi(request);

    try {
        const response = await fetch(request);
        return applyCoi ? withCoiHeaders(response) : response;
    } catch (error) {
        console.warn('[SW] Navigation request failed:', request.url, error);
    }

    try {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('./index.html');
        if (cached) {
            return applyCoi ? withCoiHeaders(cached) : cached;
        }
    } catch (error) {
        console.warn('[SW] Failed to read cached shell:', error);
    }

    const offline = new Response(OFFLINE_HTML, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
    return applyCoi ? withCoiHeaders(offline) : offline;
}

// Cache-first for runtime assets (transformers.js runtime, NES model metadata)
async function runtimeCacheFirst(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            try {
                await cache.put(request, response.clone());
            } catch (error) {
                console.warn('[SW] Failed to cache runtime asset:', request.url, error);
            }
        }
        return response;
    } catch (error) {
        console.warn('[SW] Runtime asset fetch failed:', request.url, error);
        return new Response('', { status: 504 });
    }
}

// Cache-first for shell-ish static assets, always resolving to a Response
async function shellCacheFirst(request) {
    try {
        const cached = await caches.match(request);
        if (cached) return cached;
    } catch (error) {
        console.warn('[SW] Cache lookup failed:', request.url, error);
    }

    try {
        const response = await fetch(request);
        if (response.ok) {
            try {
                const cache = await caches.open(SHELL_CACHE);
                await cache.put(request, response.clone());
            } catch (error) {
                console.warn('[SW] Failed to cache shell asset:', request.url, error);
            }
        }
        return response;
    } catch (error) {
        console.warn('[SW] Shell asset fetch failed:', request.url, error);
        return new Response('', { status: 504 });
    }
}

// Stale-while-revalidate for all remaining same-origin requests
async function staleWhileRevalidate(request) {
    let cached;
    try {
        cached = await caches.match(request);
    } catch (error) {
        console.warn('[SW] Cache lookup failed:', request.url, error);
    }

    const fetchPromise = (async () => {
        try {
            const response = await fetch(request);
            if (response.ok) {
                try {
                    const cache = await caches.open(RUNTIME_CACHE);
                    await cache.put(request, response.clone());
                } catch (error) {
                    console.warn('[SW] Failed to cache response:', request.url, error);
                }
            }
            return response;
        } catch (error) {
            console.warn('[SW] Fetch failed:', request.url, error);
            return null;
        }
    })();

    if (cached) return cached;

    const response = await fetchPromise;
    return response || new Response('', { status: 504 });
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
                caches.open(RUNTIME_CACHE)
                    .then((cache) => cache.addAll(data.urls));
            }
            break;

        case 'CLEAR_CACHE':
            caches.keys()
                .then((names) => Promise.all(names.map(name => caches.delete(name))));
            break;
    }
});

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
