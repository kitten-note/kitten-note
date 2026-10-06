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
 * KittenNote - Sync Manager
 * P2P sync using WebRTC with QR code signaling (no server required),
 * with application-layer E2E encryption (see js/crypto.js) and
 * tombstone-based delete propagation.
 */

import { SyncCrypto, buildHandshakeBinding, randomNonce } from './crypto.js';
import { isPlainObject, clampString, safeIsoDate } from './utils.js';

const SYNC_PROGRESS_TICKER_INTERVAL = 250;

export class SyncManager {
    constructor(db, app) {
        this.db = db;
        this.app = app;
        
        this.deviceId = null;
        this.identity = null;    // persisted { id, sign, ecdh } base64 record
        this.signKeyPair = null; // CryptoKey pair for handshake signatures
        this.ecdhKeyPair = null; // CryptoKey pair for key agreement
        this.keyPair = null;     // legacy alias (sign pair)
        this.sessionKey = null;  // AES-GCM key once the handshake completes
        this.pendingHandshake = null;
        this.peers = new Map();
        this.isInitialized = false;
        this.wizardReady = false;
        
        // QR code libs (loaded on demand)
        this.qrGenerator = null;
        this.jsQR = null;
        
        // Current wizard state
        this.currentPeerConnection = null;
        this.currentDataChannel = null;
        this.cameraStream = null;
        this.scanAnimationId = null;
        this.scanTarget = 'offer';
        this.scanChunks = new Map();
        this.scanChunkTotal = 0;
        this.lastScanTime = 0;
        this.lastScanData = '';
        this.sendQueue = [];
        this.channelReady = false;
        this.syncInProgress = false;
        this.syncBytesTransferred = 0;
        this.syncProgressTimer = null;
        this.lastSyncProgressPercent = 0;
        this.lastSyncProgressText = '';
        this.configuredDataChannels = new WeakSet();
        
        this.init();
    }
    
    async init() {
        try {
            await this.initializeDevice();
            this.isInitialized = true;
        } catch (error) {
            console.error('Sync initialization failed:', error);
        }
    }
    
    async _ensureIdentity() {
        if (!this.identity) {
            await this.initializeDevice();
        }
    }

    async initializeDevice() {
        let identity = await this.db.getSetting('deviceIdentity');

        if (!identity?.sign || !identity?.ecdh) {
            // Migrate the legacy ECDSA-only record (its key pair becomes the
            // signing pair) or create a fresh identity.
            const legacy = await this.db.getSetting('deviceInfo');
            const generated = await SyncCrypto.generateIdentity();
            identity = {
                id: legacy?.id || this.generateDeviceId(),
                sign: await SyncCrypto.exportPair(generated.sign),
                ecdh: await SyncCrypto.exportPair(generated.ecdh),
                createdAt: legacy?.createdAt || new Date().toISOString()
            };
            await this.db.setSetting('deviceIdentity', identity);
            await this.db.setSetting('deviceInfo', null);
        }

        this.deviceId = identity.id;
        this.identity = identity;
        this.signKeyPair = await SyncCrypto.importSignPair(identity.sign);
        this.ecdhKeyPair = await SyncCrypto.importEcdhPair(identity.ecdh);
        this.keyPair = this.signKeyPair; // backward-compat alias
    }

    generateDeviceId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }
    
    // ======== QR Code Libraries ========
    async loadQRLibs() {
        if (!this.qrGenerator) {
            await this.loadScript('./assets/qrcode/qrcode-generator.min.js');
            this.qrGenerator = window.qrcode;
        }
        if (!this.jsQR) {
            await this.loadScript('./assets/qrcode/jsQR.min.js');
            this.jsQR = window.jsQR;
        }
    }
    
    loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
    
    renderQRCodes(data, container, statusEl) {
        if (!this.qrGenerator || !container) return;

        container.innerHTML = '';

        const openFullscreen = (svgMarkup) => {
            if (!svgMarkup) return;
            const existing = document.querySelector('.sync-qr-fullscreen');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.className = 'sync-qr-fullscreen';

            const display = document.createElement('div');
            display.className = 'sync-qr-display';
            display.innerHTML = svgMarkup;
            overlay.appendChild(display);

            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
        };

        const compressed = this.compressSignalingData(data);
        const singleRendered = this.tryRenderSingleQRCode(compressed, container);

        if (singleRendered) {
            // The SVG is inside the sync-qr-display wrapper; capture just the inner SVG
            const svgMarkup = container.querySelector('svg')?.outerHTML || container.innerHTML;
            const controls = document.createElement('div');
            controls.className = 'sync-qr-controls';

            const fullscreenBtn = document.createElement('button');
            fullscreenBtn.className = 'btn-icon';
            fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i>';
            fullscreenBtn.title = '全屏';
            fullscreenBtn.onclick = () => openFullscreen(svgMarkup);

            controls.appendChild(fullscreenBtn);
            container.appendChild(controls);

            if (statusEl) {
                statusEl.textContent = '等待对方扫描并回复...';
            }
            return;
        }

        // Multiple QR codes - use carousel
        const chunks = this.splitIntoChunks(compressed);
        
        const wrapper = document.createElement('div');
        wrapper.className = 'sync-qr-carousel';
        
        const qrDisplay = document.createElement('div');
        qrDisplay.className = 'sync-qr-display';
        
        const controls = document.createElement('div');
        controls.className = 'sync-qr-controls';
        
        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn-icon';
        prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
        prevBtn.title = '上一个';
        
        const indicator = document.createElement('span');
        indicator.className = 'sync-qr-indicator';
        
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn-icon';
        nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
        nextBtn.title = '下一个';

        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'btn-icon';
        fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i>';
        fullscreenBtn.title = '全屏';
        
        controls.appendChild(prevBtn);
        controls.appendChild(indicator);
        controls.appendChild(nextBtn);
        controls.appendChild(fullscreenBtn);
        
        wrapper.appendChild(qrDisplay);
        wrapper.appendChild(controls);
        container.appendChild(wrapper);
        
        let currentIndex = 0;
        let currentSvgMarkup = '';
        
        const showQR = (index) => {
            currentIndex = index;
            const wrapped = this.wrapChunk(index + 1, chunks.length, chunks[index]);
            const qr = this.qrGenerator(0, 'L');
            qr.addData(wrapped);
            qr.make();
            currentSvgMarkup = qr.createSvgTag({ scalable: true });
            qrDisplay.innerHTML = currentSvgMarkup;
            const svg = qrDisplay.querySelector('svg');
            if (svg) {
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                svg.style.maxWidth = '100%';
                svg.style.maxHeight = '100%';
            }
            indicator.textContent = `${index + 1} / ${chunks.length}`;
            prevBtn.disabled = index === 0;
            nextBtn.disabled = index === chunks.length - 1;
        };
        
        prevBtn.onclick = () => { if (currentIndex > 0) showQR(currentIndex - 1); };
        nextBtn.onclick = () => { if (currentIndex < chunks.length - 1) showQR(currentIndex + 1); };
        fullscreenBtn.onclick = () => openFullscreen(currentSvgMarkup);
        
        showQR(0);

        if (statusEl) {
            statusEl.textContent = `二维码已拆分为 ${chunks.length} 个，点击切换查看`; 
        }
    }

    tryRenderSingleQRCode(compressed, container) {
        try {
            const qr = this.qrGenerator(0, 'L');
            qr.addData(compressed);
            qr.make();
            // Wrap in sync-qr-display for consistent sizing and overflow prevention
            const display = document.createElement('div');
            display.className = 'sync-qr-display';
            display.innerHTML = qr.createSvgTag({ scalable: true });
            const svg = display.querySelector('svg');
            if (svg) {
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                svg.style.maxWidth = '100%';
                svg.style.maxHeight = '100%';
            }
            container.innerHTML = '';
            container.appendChild(display);
            return true;
        } catch (error) {
            console.warn('QR overflow, fallback to chunked:', error);
            return false;
        }
    }

    splitIntoChunks(text, chunkSize = 1500) {
        const chunks = [];
        for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.slice(i, i + chunkSize));
        }
        return chunks;
    }

    wrapChunk(index, total, payload) {
        return `KTN1:${index}/${total}:${payload}`;
    }

    parseChunk(raw) {
        const match = raw.match(/^KTN1:(\d+)\/(\d+):([\s\S]+)$/);
        if (!match) return null;
        return {
            index: parseInt(match[1], 10),
            total: parseInt(match[2], 10),
            payload: match[3]
        };
    }

    resetScanChunks() {
        this.scanChunks = new Map();
        this.scanChunkTotal = 0;
        this.lastScanTime = 0;
        this.lastScanData = '';
    }

    updateScanProgress(target, current, total) {
        const statusEl = target === 'answer'
            ? document.getElementById('sync-answer-scan-status')
            : document.getElementById('sync-scan-status');

        if (statusEl) {
            statusEl.textContent = `已扫描 ${current}/${total}，请继续扫描剩余二维码...`;
        }
    }

    handleScannedPayload(raw, target) {
        const chunk = this.parseChunk(raw);
        if (!chunk) {
            return { complete: true, data: raw };
        }

        if (!this.scanChunkTotal || this.scanChunkTotal !== chunk.total) {
            this.scanChunkTotal = chunk.total;
        }

        this.scanChunks.set(chunk.index, chunk.payload);
        this.updateScanProgress(target, this.scanChunks.size, this.scanChunkTotal);

        if (this.scanChunks.size < this.scanChunkTotal) {
            return { complete: false };
        }

        const ordered = [];
        for (let i = 1; i <= this.scanChunkTotal; i++) {
            ordered.push(this.scanChunks.get(i) || '');
        }

        return { complete: true, data: ordered.join('') };
    }
    
    compressSignalingData(data) {
        const parsed = this.parseJsonSafe(data);
        if (!parsed) {
            return typeof data === 'string' ? data : JSON.stringify(data);
        }

        const compacted = this.compactSignaling(parsed, true);
        return JSON.stringify(compacted);
    }
    
    decompressSignalingData(compressed) {
        const parsed = this.parseJsonSafe(compressed);
        if (!parsed) {
            return typeof compressed === 'string' ? compressed : JSON.stringify(compressed);
        }

        const expanded = this.expandSignaling(parsed, true);
        return JSON.stringify(expanded);
    }

    parseJsonSafe(input) {
        if (input && typeof input === 'object') {
            return input;
        }
        if (typeof input !== 'string') {
            return null;
        }

        try {
            return JSON.parse(input);
        } catch (error) {
            return null;
        }
    }

    compactSignaling(data, isRoot) {
        if (!data || typeof data !== 'object') {
            return data;
        }

        if (Array.isArray(data)) {
            return data.map(item => this.compactSignaling(item, false));
        }

        const result = { ...data };

        if (isRoot) {
            if (result.type) {
                result.t = result.type;
                delete result.type;
            }
            if (result.sdp) {
                result.s = result.sdp;
                delete result.sdp;
            }
            if (result.candidates) {
                result.c = this.compactSignaling(result.candidates, false);
                delete result.candidates;
            }
        } else {
            if (result.candidate) {
                result.c = result.candidate;
                delete result.candidate;
            }
            if (result.sdpMid) {
                result.m = result.sdpMid;
                delete result.sdpMid;
            }
            if (result.sdpMLineIndex !== undefined) {
                result.i = result.sdpMLineIndex;
                delete result.sdpMLineIndex;
            }
        }

        return result;
    }

    expandSignaling(data, isRoot) {
        if (!data || typeof data !== 'object') {
            return data;
        }

        if (Array.isArray(data)) {
            return data.map(item => this.expandSignaling(item, false));
        }

        const result = { ...data };

        if (isRoot) {
            if (result.t) {
                result.type = result.t;
                delete result.t;
            }
            if (result.s) {
                result.sdp = result.s;
                delete result.s;
            }
            if (result.c) {
                result.candidates = this.expandSignaling(result.c, false);
                delete result.c;
            }
        } else {
            if (result.c) {
                result.candidate = result.c;
                delete result.c;
            }
            if (result.m) {
                result.sdpMid = result.m;
                delete result.m;
            }
            if (result.i !== undefined) {
                result.sdpMLineIndex = result.i;
                delete result.i;
            }
        }

        return result;
    }
    
    // ======== Sync Wizard UI ========
    async showSyncDialog() {
        const dialog = document.getElementById('sync-dialog');
        if (!dialog) return;
        
        await this.loadQRLibs();
        
        if (!this.wizardReady) {
            this.setupWizardHandlers();
            this.wizardReady = true;
        }
        
        this.resetWizard();
        dialog.classList.remove('hidden');
    }
    
    setupWizardHandlers() {
        const dialog = document.getElementById('sync-dialog');
        
        // Close handlers
        dialog.querySelector('.modal-close')?.addEventListener('click', () => this.closeWizard());
        dialog.querySelector('.modal-overlay')?.addEventListener('click', () => this.closeWizard());
        
        // Back button
        document.getElementById('sync-back-btn')?.addEventListener('click', () => this.wizardGoBack());
        
        // Step 1: Role selection
        document.getElementById('sync-role-initiator')?.addEventListener('click', () => this.startAsInitiator());
        document.getElementById('sync-role-joiner')?.addEventListener('click', () => this.startAsJoiner());
        
        // Step 2a: Initiator - Apply Answer
        document.getElementById('sync-apply-answer')?.addEventListener('click', () => this.applyAnswer());
        document.getElementById('sync-offer-text')?.addEventListener('click', (e) => this.copyText(e.target));

        // Step 2a: Initiator - Answer scan tabs
        document.getElementById('sync-answer-tab-camera')?.addEventListener('click', () => this.switchAnswerScanTab('camera'));
        document.getElementById('sync-answer-tab-paste')?.addEventListener('click', () => this.switchAnswerScanTab('paste'));
        
        // Step 2b: Joiner - Scan tabs
        document.getElementById('sync-tab-camera')?.addEventListener('click', () => this.switchScanTab('camera'));
        document.getElementById('sync-tab-paste')?.addEventListener('click', () => this.switchScanTab('paste'));
        document.getElementById('sync-process-offer')?.addEventListener('click', () => this.processOfferFromPaste());
        
        // Step 3: Answer - Copy
        document.getElementById('sync-answer-text')?.addEventListener('click', (e) => this.copyText(e.target));
        
        // Step 4: Start sync
        document.getElementById('sync-start-sync')?.addEventListener('click', () => this.startSync());
    }
    
    resetWizard() {
        // Hide all steps, show step 1
        document.querySelectorAll('.sync-step').forEach(step => step.classList.add('hidden'));
        document.getElementById('sync-step-role')?.classList.remove('hidden');
        document.getElementById('sync-back-btn')?.classList.add('hidden');
        
        // Cleanup
        this.stopCamera();
        this.cleanupConnection();
    }
    
    closeWizard() {
        if (this.syncInProgress) {
            this.app.Toast?.show('同步进行中，暂时不能关闭窗口', 'info');
            return;
        }
        const dialog = document.getElementById('sync-dialog');
        dialog?.classList.add('hidden');
        this.resetWizard();
    }
    
    wizardGoBack() {
        // Simple back: go to step 1
        this.resetWizard();
    }
    
    showStep(stepId) {
        document.querySelectorAll('.sync-step').forEach(step => step.classList.add('hidden'));
        document.getElementById(stepId)?.classList.remove('hidden');
        
        // Show back button except on step 1 and done
        const backBtn = document.getElementById('sync-back-btn');
        if (stepId === 'sync-step-role' || stepId === 'sync-step-done') {
            backBtn?.classList.add('hidden');
        } else {
            backBtn?.classList.remove('hidden');
        }
    }
    
    // ======== Initiator Flow ========
    async startAsInitiator() {
        this.showStep('sync-step-offer');
        
        const qrContainer = document.getElementById('sync-offer-qr');
        const statusEl = document.getElementById('sync-offer-status');
        const textArea = document.getElementById('sync-offer-text');
        
        try {
            statusEl.textContent = '正在创建连接...';
            
            // Create peer connection
            this.currentPeerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            
            // Monitor ICE connection state
            this.currentPeerConnection.addEventListener('iceconnectionstatechange', () => {
                const state = this.currentPeerConnection?.iceConnectionState;
                console.log('ICE connection state:', state);
                if (state === 'failed') {
                    this.app.Toast?.show('P2P 连接失败，请重试', 'error');
                } else if (state === 'disconnected') {
                    // Disconnected can be temporary — don't kill right away
                    console.warn('ICE disconnected — waiting for recovery...');
                }
            });
            
            // Create data channel
            this.currentDataChannel = this.currentPeerConnection.createDataChannel('sync', {
                ordered: true
            });
            this.setupDataChannel(this.currentDataChannel);
            
            // Collect ICE candidates
            const candidates = [];
            this.currentPeerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    candidates.push(event.candidate.toJSON());
                }
            };
            
            // Create offer
            const offer = await this.currentPeerConnection.createOffer();
            await this.currentPeerConnection.setLocalDescription(offer);
            
            // Wait for ICE gathering to complete
            await this.waitForICEGathering(this.currentPeerConnection);
            
            await this._ensureIdentity();

            // Package offer with candidates + crypto handshake material
            const offerNonce = randomNonce(16);
            const offerData = {
                type: 'offer',
                sdp: this.currentPeerConnection.localDescription.sdp,
                candidates: candidates,
                v: 2,
                deviceId: this.deviceId,
                signPub: this.identity.sign.publicKey,
                ecdhPub: this.identity.ecdh.publicKey,
                nonce: offerNonce
            };
            offerData.sig = await SyncCrypto.sign(
                this.signKeyPair.privateKey,
                buildHandshakeBinding('offer', offerData.sdp, offerData.candidates)
            );
            this.sessionKey = null;
            this.pendingHandshake = { role: 'initiator', offerNonce };

            const offerString = JSON.stringify(offerData);
            
            // Generate QR code
            this.renderQRCodes(offerData, qrContainer, statusEl);
            textArea.value = offerString;

            this.switchAnswerScanTab('camera');
            
        } catch (error) {
            console.error('Failed to create offer:', error);
            statusEl.textContent = '创建连接失败: ' + error.message;
        }
    }
    
    async applyAnswer() {
        const answerInput = document.getElementById('sync-answer-input');
        const answerText = answerInput?.value?.trim();
        
        if (!answerText) {
            this.app.Toast?.show('请输入对方的应答码', 'error');
            return;
        }
        
        await this.processAnswerText(answerText, true);
    }
    
    // ======== Joiner Flow ========
    async startAsJoiner() {
        this.showStep('sync-step-scan');
        this.switchScanTab('camera');
    }
    
    switchScanTab(tab) {
        const cameraTab = document.getElementById('sync-tab-camera');
        const pasteTab = document.getElementById('sync-tab-paste');
        const cameraPanel = document.getElementById('sync-scan-camera');
        const pastePanel = document.getElementById('sync-scan-paste');
        
        if (tab === 'camera') {
            cameraTab?.classList.add('active');
            pasteTab?.classList.remove('active');
            cameraPanel?.classList.remove('hidden');
            pastePanel?.classList.add('hidden');
            this.startCamera('offer');
        } else {
            cameraTab?.classList.remove('active');
            pasteTab?.classList.add('active');
            cameraPanel?.classList.add('hidden');
            pastePanel?.classList.remove('hidden');
            this.stopCamera();
        }
    }

    switchAnswerScanTab(tab) {
        const cameraTab = document.getElementById('sync-answer-tab-camera');
        const pasteTab = document.getElementById('sync-answer-tab-paste');
        const cameraPanel = document.getElementById('sync-answer-scan-camera');
        const pastePanel = document.getElementById('sync-answer-scan-paste');

        if (tab === 'camera') {
            cameraTab?.classList.add('active');
            pasteTab?.classList.remove('active');
            cameraPanel?.classList.remove('hidden');
            pastePanel?.classList.add('hidden');
            this.startCamera('answer');
        } else {
            cameraTab?.classList.remove('active');
            pasteTab?.classList.add('active');
            cameraPanel?.classList.add('hidden');
            pastePanel?.classList.remove('hidden');
            this.stopCamera();
        }
    }
    
    async startCamera(target) {
        const video = target === 'answer'
            ? document.getElementById('sync-answer-camera-video')
            : document.getElementById('sync-camera-video');
        const statusEl = target === 'answer'
            ? document.getElementById('sync-answer-scan-status')
            : document.getElementById('sync-scan-status');
        
        try {
            statusEl.textContent = '正在打开摄像头...';
            this.scanTarget = target;
            this.resetScanChunks();
            
            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            
            video.srcObject = this.cameraStream;
            await video.play();
            
            statusEl.textContent = '对准二维码进行扫描...';
            this.startScanning(video, (raw) => this.handleScannedData(raw, target));
            
        } catch (error) {
            console.error('Camera error:', error);
            statusEl.textContent = '无法打开摄像头，请使用手动输入';
            if (target === 'answer') {
                this.switchAnswerScanTab('paste');
            } else {
                this.switchScanTab('paste');
            }
        }
    }
    
    stopCamera() {
        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(track => track.stop());
            this.cameraStream = null;
        }
        if (this.scanAnimationId) {
            cancelAnimationFrame(this.scanAnimationId);
            this.scanAnimationId = null;
        }
    }
    
    startScanning(video, onScan) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        const scan = () => {
            if (!this.cameraStream) return;
            
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = this.jsQR(imageData.data, imageData.width, imageData.height);
                
                if (code) {
                    const now = Date.now();
                    if (code.data === this.lastScanData && now - this.lastScanTime < 1000) {
                        this.scanAnimationId = requestAnimationFrame(scan);
                        return;
                    }

                    this.lastScanData = code.data;
                    this.lastScanTime = now;

                    const result = onScan(code.data);
                    if (result && typeof result.then === 'function') {
                        result.then((complete) => {
                            if (complete) {
                                this.stopCamera();
                                return;
                            }
                            this.scanAnimationId = requestAnimationFrame(scan);
                        });
                        return;
                    }

                    if (result) {
                        this.stopCamera();
                        return;
                    }
                }
            }
            
            this.scanAnimationId = requestAnimationFrame(scan);
        };
        
        scan();
    }
    
    async processOfferFromPaste() {
        const input = document.getElementById('sync-offer-paste');
        const text = input?.value?.trim();
        
        if (!text) {
            this.app.Toast?.show('请输入连接信息', 'error');
            return;
        }
        
        await this.processScannedOffer(text);
    }
    
    async processScannedOffer(offerText) {
        const statusEl = document.getElementById('sync-scan-status');
        
        try {
            statusEl.textContent = '正在处理连接信息...';
            
            const result = this.handleScannedPayload(offerText, 'offer');
            if (!result.complete) {
                this.app.Toast?.show('已识别分片，请继续扫描剩余二维码', 'info');
                return false;
            }

            const decompressed = this.decompressSignalingData(result.data);
            const offerData = JSON.parse(decompressed);
            
            if (offerData.type !== 'offer') {
                throw new Error('无效的连接信息');
            }

            await this._ensureIdentity();
            const offerVerification = await this._verifyHandshake('offer', offerData);
            if (offerVerification === 'invalid') {
                throw new Error('握手签名校验失败：连接信息可能被篡改，已中止配对');
            }
            
            // Create peer connection
            this.currentPeerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            
            // Monitor ICE connection state
            this.currentPeerConnection.addEventListener('iceconnectionstatechange', () => {
                const state = this.currentPeerConnection?.iceConnectionState;
                console.log('ICE connection state (joiner):', state);
                if (state === 'failed') {
                    this.app.Toast?.show('P2P 连接失败，请重试', 'error');
                } else if (state === 'disconnected') {
                    console.warn('ICE disconnected — waiting for recovery...');
                }
            });
            
            // Handle incoming data channel
            this.currentPeerConnection.addEventListener('datachannel', (event) => {
                this.currentDataChannel = event.channel;
                this.setupDataChannel(this.currentDataChannel);
            });
            
            // Collect ICE candidates
            const candidates = [];
            this.currentPeerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    candidates.push(event.candidate.toJSON());
                }
            };
            
            // Set remote description
            await this.currentPeerConnection.setRemoteDescription({
                type: 'offer',
                sdp: offerData.sdp
            });
            
            // Add remote ICE candidates
            if (offerData.candidates) {
                for (const candidate of offerData.candidates) {
                    await this.currentPeerConnection.addIceCandidate(candidate);
                }
            }
            
            // Create answer
            const answer = await this.currentPeerConnection.createAnswer();
            await this.currentPeerConnection.setLocalDescription(answer);
            
            // Wait for ICE gathering
            await this.waitForICEGathering(this.currentPeerConnection);
            
            // Package answer with crypto handshake material
            const answerNonce = randomNonce(16);
            const answerData = {
                type: 'answer',
                sdp: this.currentPeerConnection.localDescription.sdp,
                candidates: candidates,
                v: 2,
                deviceId: this.deviceId,
                signPub: this.identity.sign.publicKey,
                ecdhPub: this.identity.ecdh.publicKey,
                nonce: answerNonce
            };
            answerData.sig = await SyncCrypto.sign(
                this.signKeyPair.privateKey,
                buildHandshakeBinding('answer', answerData.sdp, answerData.candidates)
            );

            if (offerVerification === 'verified' && offerData.ecdhPub) {
                this.sessionKey = await SyncCrypto.deriveSessionKey(
                    this.ecdhKeyPair.privateKey,
                    offerData.ecdhPub,
                    `${offerData.nonce}|${answerNonce}`
                );
                this.pendingHandshake = null;
            } else {
                this.sessionKey = null;
                this._warnLegacyPeer();
            }
            
            const answerString = JSON.stringify(answerData);
            
            // Show answer step
            this.showStep('sync-step-answer');
            
            const qrContainer = document.getElementById('sync-answer-qr');
            const textArea = document.getElementById('sync-answer-text');
            const answerStatus = document.getElementById('sync-answer-status');
            
            this.renderQRCodes(answerData, qrContainer, answerStatus);
            textArea.value = answerString;
            answerStatus.textContent = '等待对方扫描应答码...';
            
            // Wait for connection
            this.waitForConnection().then(() => {
                this.onConnected();
            }).catch((error) => {
                answerStatus.textContent = '连接超时，请重试';
            });
            
        } catch (error) {
            console.error('Failed to process offer:', error);
            statusEl.textContent = '处理失败: ' + error.message;
            this.app.Toast?.show('无效的连接信息', 'error');
            return true;
        }

        return true;
    }

    async handleScannedData(raw, target) {
        if (target === 'answer') {
            return await this.processAnswerText(raw, false);
        }
        return await this.processScannedOffer(raw);
    }

    async processAnswerText(answerText, allowToast) {
        if (!answerText) {
            if (allowToast) {
                this.app.Toast?.show('请输入对方的应答码', 'error');
            }
            return false;
        }

        try {
            const result = this.handleScannedPayload(answerText, 'answer');
            if (!result.complete) {
                if (allowToast) {
                    this.app.Toast?.show('已识别分片，请继续扫描剩余二维码', 'info');
                }
                return false;
            }

            const decompressed = this.decompressSignalingData(result.data);
            const answerData = JSON.parse(decompressed);

            if (answerData.type !== 'answer') {
                throw new Error('无效的应答数据');
            }

            const answerVerification = await this._verifyHandshake('answer', answerData);
            if (answerVerification === 'invalid') {
                throw new Error('应答签名校验失败：连接信息可能被篡改，已中止配对');
            }

            if (answerVerification === 'verified' && answerData.ecdhPub && this.pendingHandshake?.offerNonce) {
                await this._ensureIdentity();
                this.sessionKey = await SyncCrypto.deriveSessionKey(
                    this.ecdhKeyPair.privateKey,
                    answerData.ecdhPub,
                    `${this.pendingHandshake.offerNonce}|${answerData.nonce}`
                );
                this.pendingHandshake = null;
            } else if (!this.sessionKey) {
                this._warnLegacyPeer();
            }

            await this.currentPeerConnection.setRemoteDescription({
                type: 'answer',
                sdp: answerData.sdp
            });

            if (answerData.candidates) {
                for (const candidate of answerData.candidates) {
                    await this.currentPeerConnection.addIceCandidate(candidate);
                }
            }

            await this.waitForConnection();
            this.onConnected();
            return true;
        } catch (error) {
            console.error('Failed to apply answer:', error);
            if (allowToast) {
                this.app.Toast?.show('应答码无效或连接失败', 'error');
            }
            return true;
        }
    }
    
    /**
     * Inspect a QR handshake payload:
     *  - 'verified' – signatures present and valid (E2E will be enabled)
     *  - 'legacy'   – no crypto material (older peer, DTLS only)
     *  - 'invalid'  – crypto material present but the signature is bad
     */
    async _verifyHandshake(type, data) {
        if (!data?.sig || !data?.ecdhPub || !data?.signPub || !data?.nonce) {
            return 'legacy';
        }
        try {
            const publicKey = await SyncCrypto.importSignPublicKey(data.signPub);
            const binding = buildHandshakeBinding(type, data.sdp, data.candidates);
            const ok = await SyncCrypto.verify(publicKey, data.sig, binding);
            return ok ? 'verified' : 'invalid';
        } catch (error) {
            console.warn('[Sync] Handshake verification error:', error);
            return 'invalid';
        }
    }

    _warnLegacyPeer() {
        console.warn('[Sync] Peer does not support E2E encryption (legacy version).');
        this.app.Toast?.show('对方版本较旧：本次同步未启用端到端加密，建议升级后重连', 'warning', 5000);
        this.app.logger?.warn('a legacy peer connected without E2E encryption.');
    }

    // ======== Connection Utilities ========
    waitForICEGathering(pc, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                resolve(); // Proceed with what we have
            }, timeoutMs);
            
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
    }
    
    waitForConnection(timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (this.currentDataChannel?.readyState === 'open') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, timeoutMs);
            
            const checkConnection = () => {
                if (this.currentDataChannel?.readyState === 'open') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            
            if (this.currentDataChannel) {
                this.currentDataChannel.addEventListener('open', checkConnection, { once: true });
            }
            
            if (this.currentPeerConnection) {
                this.currentPeerConnection.addEventListener('datachannel', (event) => {
                    this.currentDataChannel = event.channel;
                    this.setupDataChannel(this.currentDataChannel);
                    this.currentDataChannel.addEventListener('open', checkConnection, { once: true });
                }, { once: true });
            }
        });
    }
    
    setupDataChannel(channel) {
        if (!channel || this.configuredDataChannels.has(channel)) {
            return;
        }
        this.configuredDataChannels.add(channel);

        // Chunk reassembly buffer
        const chunkBuffers = new Map();
        
        channel.addEventListener('message', (event) => {
            try {
                // Track received bytes for speed display
                this.syncBytesTransferred += (event.data?.length || 0);

                const parsed = JSON.parse(event.data);
                
                // Handle chunked messages
                if (parsed.type === '__chunk__') {
                    const { chunkId, index, total, data } = parsed;
                    
                    if (!chunkBuffers.has(chunkId)) {
                        chunkBuffers.set(chunkId, { chunks: new Array(total), received: 0, total });
                    }
                    
                    const buffer = chunkBuffers.get(chunkId);
                    if (!buffer.chunks[index]) {
                        buffer.chunks[index] = data;
                        buffer.received++;
                    }
                    
                    if (buffer.received === buffer.total) {
                        const fullMessage = buffer.chunks.join('');
                        chunkBuffers.delete(chunkId);
                        this.handleSyncMessage(fullMessage);
                    }
                    return;
                }
            } catch {
                // Not JSON or not a chunk — pass through as-is
            }
            
            this.handleSyncMessage(event.data);
        });

        channel.addEventListener('open', () => {
            this.channelReady = true;
            this.flushSendQueue();
        });
        
        channel.addEventListener('error', (error) => {
            console.error('Data channel error:', error);
        });
        
        channel.addEventListener('close', () => {
            console.log('Data channel closed');
            this.channelReady = false;
            if (this.syncInProgress) {
                this.syncInProgress = false;
                this.app.Toast?.show('连接已断开，请重新连接', 'error');
            }
        });
    }
    
    cleanupConnection() {
        if (this.currentDataChannel) {
            this.currentDataChannel.close();
            this.currentDataChannel = null;
        }
        if (this.currentPeerConnection) {
            this.currentPeerConnection.close();
            this.currentPeerConnection = null;
        }
        this.sendQueue = [];
        this.channelReady = false;
        this.syncInProgress = false;
        this.sessionKey = null;
        this.pendingHandshake = null;
        this.stopSyncProgressTicker();
    }
    
    // ======== Connection Success ========
    async onConnected() {
        this.showStep('sync-step-done');
        
        const peerInfo = document.getElementById('sync-peer-info');
        if (peerInfo) {
            peerInfo.textContent = '连接成功，正在同步数据...';
        }
        
        // Store peer for future syncs
        const peerId = 'webrtc-' + Date.now();
        this.peers.set(peerId, {
            connection: this.currentPeerConnection,
            channel: this.currentDataChannel
        });
        
        this.app.Toast?.show('连接成功！正在同步...', 'success');
        this.app.logger?.info('a peer device connected for sync.');
        
        // Auto-start sync after connection
        await this.startSync();
    }
    
    async startSync() {
        try {
            if (!this.isChannelOpen()) {
                this.app.Toast?.show('连接已断开，请重新连接', 'error');
                return;
            }

            this.syncInProgress = true;
            this.syncStartTime = Date.now();
            this.syncBytesTransferred = 0;
            this.startSyncProgressTicker();
            this.app.logger?.info('sync started. sending manifest to the peer...');

            // Hide sync button, show progress
            const syncBtn = document.getElementById('sync-start-sync');
            const progressArea = document.getElementById('sync-progress-area');
            if (syncBtn) syncBtn.classList.add('hidden');
            if (progressArea) progressArea.classList.remove('hidden');
            this.updateSyncProgress(0, '正在构建本地清单...');

            // Build local manifest (lightweight – no OPFS reads)
            const manifest = await this.buildManifest();

            this.updateSyncProgress(5, '正在发送同步请求...');

            // Send sync request with manifest so the peer can compute the delta
            await this.sendMessage({
                type: 'sync_request',
                deviceId: this.deviceId,
                manifest,
                timestamp: new Date().toISOString()
            });
            
            this.updateSyncProgress(10, '同步请求已发送，等待对方响应...');
            
        } catch (error) {
            console.error('Sync failed:', error);
            this.app.Toast?.show('同步失败: ' + error.message, 'error');
            this.syncInProgress = false;
            this.resetSyncProgressUI();
        }
    }

    updateSyncProgress(percent, text) {
        if (typeof percent === 'number') {
            this.lastSyncProgressPercent = percent;
        }
        if (typeof text === 'string' && text.length > 0) {
            this.lastSyncProgressText = text;
        }

        const bar = document.getElementById('sync-progress-bar');
        const label = document.getElementById('sync-progress-text');
        if (bar) bar.style.width = `${percent}%`;
        if (label) {
            const displayText = text || this.lastSyncProgressText;
            if (!displayText) return;
            let speedInfo = '';
            if (this.syncStartTime && percent > 0 && this.syncBytesTransferred > 0) {
                const elapsed = (Date.now() - this.syncStartTime) / 1000;
                if (elapsed > 0.3) {
                    const bps = this.syncBytesTransferred / elapsed;
                    if (bps >= 1024 * 1024) {
                        speedInfo = ` · ${(bps / 1024 / 1024).toFixed(1)} MB/s`;
                    } else if (bps >= 1024) {
                        speedInfo = ` · ${(bps / 1024).toFixed(1)} KB/s`;
                    } else {
                        speedInfo = ` · ${Math.round(bps)} B/s`;
                    }
                }
            }
            label.textContent = displayText + speedInfo;
        }
    }

    startSyncProgressTicker() {
        this.stopSyncProgressTicker();
        this.syncProgressTimer = setInterval(() => {
            if (!this.syncInProgress) {
                this.stopSyncProgressTicker();
                return;
            }
            this.updateSyncProgress(this.lastSyncProgressPercent, this.lastSyncProgressText || '同步进行中...');
        }, SYNC_PROGRESS_TICKER_INTERVAL);
    }

    stopSyncProgressTicker() {
        if (this.syncProgressTimer) {
            clearInterval(this.syncProgressTimer);
            this.syncProgressTimer = null;
        }
    }

    resetSyncProgressUI() {
        const syncBtn = document.getElementById('sync-start-sync');
        const progressArea = document.getElementById('sync-progress-area');
        if (syncBtn) syncBtn.classList.remove('hidden');
        if (progressArea) progressArea.classList.add('hidden');
        this.syncBytesTransferred = 0;
        this.stopSyncProgressTicker();
        this.lastSyncProgressPercent = 0;
        this.lastSyncProgressText = '';
        this.updateSyncProgress(0, '');
    }
    
    // ======== Sync Protocol ========
    async handleSyncMessage(data) {
        try {
            if (SyncCrypto.isEnvelope(data)) {
                if (!this.sessionKey) {
                    throw new Error('收到加密消息，但当前连接没有会话密钥');
                }
                data = await SyncCrypto.decryptString(this.sessionKey, data);
            }
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'sync_request':
                    await this.handleSyncRequest(message);
                    break;
                case 'sync_data':
                    await this.handleSyncData(message);
                    break;
                case 'sync_ack':
                    console.log('Sync acknowledged by peer');
                    this.updateSyncProgress(55, '正在合并对方数据...');
                    // Bidirectional: sync_ack may include peer's data
                    if (message.notes || message.notebooks || message.folders || message.tombstones) {
                        const counts = await this.mergeRemoteData(message, (current, total) => {
                            const ratio = total > 0 ? (current / total) : 1;
                            const pct = 55 + Math.round(ratio * 40);
                            this.updateSyncProgress(pct, `正在合并对方数据... ${current}/${total}`);
                        });
                        this.updateSyncProgress(100, `同步完成：${counts.folders} 文件夹, ${counts.notebooks} 笔记本, ${counts.notes} 笔记`);
                        this.app.Toast?.show(`同步完成！${counts.folders} 文件夹, ${counts.notebooks} 笔记本, ${counts.notes} 笔记`, 'success');
                        await this.app.directoryTree?.render();
                    } else {
                        this.updateSyncProgress(100, '同步完成！');
                        this.app.Toast?.show('同步完成！', 'success');
                    }
                    this.syncInProgress = false;
                    this.app.logger?.info('sync completed successfully!');
                    
                    // Close wizard and cleanup after successful sync
                    setTimeout(() => {
                        this.closeWizard();
                        this.resetSyncProgressUI();
                    }, 1500);
                    break;
            }
        } catch (error) {
            console.error('Failed to handle sync message:', error);
            this.syncInProgress = false;
            this.stopSyncProgressTicker();
        }
    }
    
    async handleSyncRequest(message) {
        if (!this.isChannelOpen()) {
            console.warn('Sync request received but channel is closed.');
            this.app.Toast?.show('连接已断开，请重新连接', 'error');
            return;
        }

        this.syncInProgress = true;
        this.syncStartTime = Date.now();
        this.syncBytesTransferred = 0;
        this.startSyncProgressTicker();

        // Show progress on receiving end too
        const syncBtn = document.getElementById('sync-start-sync');
        const progressArea = document.getElementById('sync-progress-area');
        if (syncBtn) syncBtn.classList.add('hidden');
        if (progressArea) progressArea.classList.remove('hidden');
        this.updateSyncProgress(20, '正在计算增量数据...');

        try {
            const peerManifest = message.manifest || { notes: {}, notebooks: {}, folders: {} };

            // Load local data (raw IDB for structure, full notes only where needed)
            const [rawNotes, notebooks, folders, tombstones] = await Promise.all([
                this.db.getAll('notes'),
                this.db.getAllNotebooks(),
                this.db.getAllFolders(),
                this.db.getAllTombstones()
            ]);

            // Compute what the peer is missing or has stale versions of
            const foldersToSend    = this.getItemsNeededByPeer(folders,    peerManifest.folders);
            const notebooksToSend  = this.getItemsNeededByPeer(notebooks,  peerManifest.notebooks);
            const tombstonesToSend = this.getItemsNeededByPeer(tombstones, peerManifest.tombstones || {}, 'deletedAt');
            const staleNoteIds     = this.getItemsNeededByPeer(rawNotes,  peerManifest.notes).map(n => n.id);

            // Fetch full content only for the notes that actually need to be sent
            const notesToSend = await this.getNotesByIds(staleNoteIds);

            // Build local manifest so the peer can compute what to send back
            const localManifest = {
                notes:      Object.fromEntries(rawNotes.map(n => [n.id, n.updatedAt])),
                notebooks:  Object.fromEntries(notebooks.map(n => [n.id, n.updatedAt])),
                folders:    Object.fromEntries(folders.map(f => [f.id, f.updatedAt])),
                tombstones: Object.fromEntries(tombstones.map(t => [t.id, t.deletedAt]))
            };
            
            this.updateSyncProgress(40, `正在发送数据 (${notesToSend.length} 笔记, ${notebooksToSend.length} 笔记本, ${foldersToSend.length} 文件夹)...`);
            
            await this.sendMessage({
                type: 'sync_data',
                notes:      notesToSend,
                notebooks:  notebooksToSend,
                folders:    foldersToSend,
                tombstones: tombstonesToSend,
                manifest:   localManifest,
                timestamp:  new Date().toISOString()
            });

            this.updateSyncProgress(60, '数据已发送，等待确认...');
        } catch (error) {
            console.error('Failed to send sync data:', error);
            this.syncInProgress = false;
            this.app.Toast?.show('发送同步数据失败', 'error');
            this.resetSyncProgressUI();
        }
    }
    
    async handleSyncData(message) {
        this.syncInProgress = true;
        this.updateSyncProgress(50, '正在合并远端数据...');
        
        try {
            const mergedCount = await this.mergeRemoteData(message, (current, total) => {
                const ratio = total > 0 ? (current / total) : 1;
                const pct = 50 + Math.round(ratio * 30);
                this.updateSyncProgress(pct, `正在合并远端数据... ${current}/${total}`);
            });
            
            this.updateSyncProgress(70, '正在计算并发送本地增量数据...');

            // Use the peer's manifest (included in sync_data) to decide what to send back
            if (this.isChannelOpen()) {
                const peerManifest = message.manifest || { notes: {}, notebooks: {}, folders: {} };

                const [rawNotes, localNotebooks, localFolders, localTombstones] = await Promise.all([
                    this.db.getAll('notes'),
                    this.db.getAllNotebooks(),
                    this.db.getAllFolders(),
                    this.db.getAllTombstones()
                ]);

                const foldersToSend    = this.getItemsNeededByPeer(localFolders,    peerManifest.folders);
                const notebooksToSend  = this.getItemsNeededByPeer(localNotebooks,  peerManifest.notebooks);
                const tombstonesToSend = this.getItemsNeededByPeer(localTombstones, peerManifest.tombstones || {}, 'deletedAt');
                const staleNoteIds     = this.getItemsNeededByPeer(rawNotes,        peerManifest.notes).map(n => n.id);
                const notesToSend      = await this.getNotesByIds(staleNoteIds);
                
                await this.sendMessage({
                    type: 'sync_ack',
                    notes:      notesToSend,
                    notebooks:  notebooksToSend,
                    folders:    foldersToSend,
                    tombstones: tombstonesToSend,
                    timestamp:  new Date().toISOString()
                });
                
                this.updateSyncProgress(100, `同步完成：${mergedCount.folders} 文件夹, ${mergedCount.notebooks} 笔记本, ${mergedCount.notes} 笔记`);
                this.app.Toast?.show(`接收完成：${mergedCount.folders} 文件夹, ${mergedCount.notebooks} 笔记本, ${mergedCount.notes} 笔记`, 'success');
            } else {
                console.warn('Skipping sync ack because channel is closed.');
            }
            
            this.syncInProgress = false;

            // Refresh UI
            await this.app.directoryTree?.render();
            
            // Close wizard after successful sync
            setTimeout(() => {
                this.closeWizard();
                this.resetSyncProgressUI();
            }, 2000);
            
        } catch (error) {
            console.error('Sync data merge failed:', error);
            this.syncInProgress = false;
            this.app.Toast?.show('同步合并失败: ' + error.message, 'error');
            this.resetSyncProgressUI();
        }
    }
    
    /**
     * Merge remote data (folders, notebooks, notes, tombstones) into the local
     * DB. Entities are validated against a field whitelist before they are
     * written, tombstones are applied first so deletions beat stale data, and
     * conflicts resolve last-write-wins on `updatedAt` / `deletedAt`.
     * Returns counts of merged items.
     */
    async mergeRemoteData(message, onProgress) {
        const notes = Array.isArray(message.notes) ? message.notes : [];
        const notebooks = Array.isArray(message.notebooks) ? message.notebooks : [];
        const folders = Array.isArray(message.folders) ? message.folders : [];
        const tombstones = Array.isArray(message.tombstones) ? message.tombstones : [];

        const mergedCount = { notes: 0, notebooks: 0, folders: 0, deleted: 0, skipped: 0, unchanged: 0 };
        const totalItems = folders.length + notebooks.length + notes.length + tombstones.length;
        let processedItems = 0;
        const tick = () => onProgress?.(processedItems, totalItems);

        // 1) Apply remote tombstones first so deletions beat stale copies.
        for (const rawTombstone of tombstones) {
            processedItems++;
            const tombstone = this._sanitizeTombstone(rawTombstone);
            if (!tombstone) {
                mergedCount.skipped++;
                tick();
                continue;
            }
            try {
                const local = await this._getLocalEntity(tombstone.type, tombstone.entityId);
                const deletedDate = new Date(tombstone.deletedAt);

                if (!local) {
                    await this.db.upsertTombstone(tombstone);
                } else {
                    const localDate = new Date(local.updatedAt);
                    if (!Number.isNaN(localDate.getTime()) && localDate >= deletedDate) {
                        // Local copy is newer than the remote deletion — keep it.
                        mergedCount.unchanged++;
                    } else {
                        await this._deleteLocalEntity(tombstone.type, tombstone.entityId, { recordTombstone: false });
                        await this.db.upsertTombstone(tombstone);
                        mergedCount.deleted++;
                    }
                }
            } catch (e) {
                console.warn('Failed to apply tombstone:', tombstone, e);
                mergedCount.skipped++;
            }
            tick();
        }

        // 2) Merge live entities (parents before children), guarded by LWW and
        //    by any tombstone that is newer than the incoming copy.
        const mergeEntity = async (type, item, sanitize, upsert, getLocal) => {
            const clean = sanitize(item);
            if (!clean) return 'skipped';

            const [local, tombstone] = await Promise.all([
                getLocal(clean.id),
                this.db.getTombstone(type, clean.id)
            ]);

            const remoteDate = new Date(clean.updatedAt);
            const remoteValid = !Number.isNaN(remoteDate.getTime());

            if (tombstone) {
                const deletedDate = new Date(tombstone.deletedAt);
                if (!remoteValid || remoteDate < deletedDate) {
                    return 'skipped'; // do not resurrect a deleted item
                }
                await this.db.deleteTombstone(type, clean.id);
            }

            if (local) {
                const localDate = new Date(local.updatedAt);
                if (!remoteValid || (!Number.isNaN(localDate.getTime()) && localDate >= remoteDate)) {
                    return 'unchanged';
                }
            }

            await upsert(clean);
            return 'merged';
        };

        for (const folder of folders) {
            try {
                const outcome = await mergeEntity(
                    'folder', folder,
                    (f) => this._sanitizeFolder(f),
                    (f) => this.db.upsertFolder(f),
                    (id) => this.db.getFolder(id)
                );
                if (outcome === 'merged') mergedCount.folders++;
            } catch (e) {
                console.warn('Failed to merge folder:', folder?.id, e);
                mergedCount.skipped++;
            }
            processedItems++;
            tick();
        }

        for (const notebook of notebooks) {
            try {
                const outcome = await mergeEntity(
                    'notebook', notebook,
                    (n) => this._sanitizeNotebook(n),
                    (n) => this.db.upsertNotebook(n),
                    (id) => this.db.getNotebook(id)
                );
                if (outcome === 'merged') mergedCount.notebooks++;
            } catch (e) {
                console.warn('Failed to merge notebook:', notebook?.id, e);
                mergedCount.skipped++;
            }
            processedItems++;
            tick();
        }

        for (const note of notes) {
            try {
                const outcome = await mergeEntity(
                    'note', note,
                    (n) => this._sanitizeNote(n),
                    (n) => this.db.upsertNote(n),
                    (id) => this.db.get('notes', id) // raw record: no OPFS content read
                );
                if (outcome === 'merged') mergedCount.notes++;
            } catch (e) {
                console.warn('Failed to merge note:', note?.id, e);
                mergedCount.skipped++;
            }
            processedItems++;
            tick();
        }

        console.log(`Sync merge: ${mergedCount.folders} folders, ${mergedCount.notebooks} notebooks, ${mergedCount.notes} notes, ${mergedCount.deleted} deletions, ${mergedCount.skipped} skipped`);
        return mergedCount;
    }

    // ======== Remote payload sanitizers ========

    _sanitizeTombstone(raw) {
        if (!isPlainObject(raw)) return null;
        if (!['folder', 'notebook', 'note'].includes(raw.type)) return null;
        const entityId = clampString(raw.entityId, 128);
        if (!entityId) return null;
        return { type: raw.type, entityId, deletedAt: safeIsoDate(raw.deletedAt) };
    }

    _sanitizeFolder(raw) {
        if (!isPlainObject(raw)) return null;
        const id = clampString(raw.id, 128);
        if (!id) return null;
        return {
            id,
            name: clampString(raw.name, 200, '未命名文件夹'),
            parentId: typeof raw.parentId === 'string' ? clampString(raw.parentId, 128) : null,
            order: Number.isFinite(raw.order) ? raw.order : Date.now(),
            createdAt: safeIsoDate(raw.createdAt),
            updatedAt: safeIsoDate(raw.updatedAt)
        };
    }

    _sanitizeNotebook(raw) {
        if (!isPlainObject(raw)) return null;
        const id = clampString(raw.id, 128);
        if (!id) return null;

        const patterns = ['blank', 'lines', 'grid', 'dots', 'calligraphy', 'staff'];
        const style = isPlainObject(raw.pageStyle) ? raw.pageStyle : {};
        const color = typeof style.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(style.color)
            ? style.color
            : '#ffffff';

        return {
            id,
            name: clampString(raw.name, 200, '未命名笔记本'),
            folderId: typeof raw.folderId === 'string' ? clampString(raw.folderId, 128) : null,
            order: Number.isFinite(raw.order) ? raw.order : Date.now(),
            pageStyle: {
                pattern: patterns.includes(style.pattern) ? style.pattern : 'blank',
                color
            },
            createdAt: safeIsoDate(raw.createdAt),
            updatedAt: safeIsoDate(raw.updatedAt)
        };
    }

    _sanitizeNote(raw) {
        if (!isPlainObject(raw)) return null;
        const id = clampString(raw.id, 128);
        if (!id) return null;

        const type = raw.type === 'ink' ? 'ink' : 'text';
        let content = raw.content;
        if (type === 'text') {
            content = typeof content === 'string' ? content : '';
        } else {
            content = isPlainObject(content) && Array.isArray(content.strokes)
                ? content
                : { version: 2, strokes: [], images: [] };
        }

        return {
            id,
            title: clampString(raw.title, 300, '未命名笔记'),
            type,
            textMode: raw.textMode === 'latex' ? 'latex' : 'markdown',
            latexMacros: clampString(raw.latexMacros, 50000, ''),
            content,
            notebookId: typeof raw.notebookId === 'string' ? clampString(raw.notebookId, 128) : null,
            order: Number.isFinite(raw.order) ? raw.order : Date.now(),
            createdAt: safeIsoDate(raw.createdAt),
            updatedAt: safeIsoDate(raw.updatedAt)
        };
    }

    async _getLocalEntity(type, entityId) {
        if (type === 'folder') return this.db.getFolder(entityId);
        if (type === 'notebook') return this.db.getNotebook(entityId);
        if (type === 'note') return this.db.get('notes', entityId);
        return null;
    }

    async _deleteLocalEntity(type, entityId, options = {}) {
        if (type === 'folder') return this.db.deleteFolder(entityId, options);
        if (type === 'notebook') return this.db.deleteNotebook(entityId, options);
        if (type === 'note') return this.db.deleteNote(entityId, options);
    }

    // ======== Delta-sync helpers ========

    /**
     * Build a lightweight manifest of local data: { notes, notebooks, folders }
     * where each value is a map of id → updatedAt.
     * Uses raw IDB reads so OPFS block data is never read unnecessarily.
     */
    async buildManifest() {
        const [rawNotes, notebooks, folders, tombstones] = await Promise.all([
            this.db.getAll('notes'),       // raw IDB records – no OPFS reads
            this.db.getAllNotebooks(),
            this.db.getAllFolders(),
            this.db.getAllTombstones()
        ]);
        return {
            notes:      Object.fromEntries(rawNotes.map(n => [n.id, n.updatedAt])),
            notebooks:  Object.fromEntries(notebooks.map(n => [n.id, n.updatedAt])),
            folders:    Object.fromEntries(folders.map(f => [f.id, f.updatedAt])),
            tombstones: Object.fromEntries(tombstones.map(t => [t.id, t.deletedAt]))
        };
    }

    /**
     * From a list of local items, return only those that the peer is missing
     * or that are newer than what the peer has.
     * @param {Array}  localItems   – local records with at least {id, updatedAt}
     * @param {Object} peerManifest – peer's { id: updatedAt } map for this store
     */
    getItemsNeededByPeer(localItems, peerManifest, dateField = 'updatedAt') {
        return localItems.filter(item => {
            const peerUpdatedAt = peerManifest?.[item.id];
            if (!peerUpdatedAt) return true; // peer doesn't have it
            const localDate = new Date(item[dateField]);
            const peerDate = new Date(peerUpdatedAt);
            if (Number.isNaN(localDate.getTime())) return false;
            if (Number.isNaN(peerDate.getTime())) return true;
            return localDate > peerDate;
        });
    }

    /**
     * Fetch full note content (OPFS-aware) for a specific set of note IDs.
     */
    async getNotesByIds(ids) {
        const notes = await Promise.all(ids.map(id => this.db.getNote(id)));
        return notes.filter(Boolean);
    }

    // ======== Utilities ========
    async copyText(element) {
        const text = element.value || element.textContent;
        try {
            await navigator.clipboard.writeText(text);
            this.app.Toast?.show('已复制到剪贴板', 'success');
        } catch (error) {
            element.select?.();
            document.execCommand('copy');
            this.app.Toast?.show('已复制', 'success');
        }
    }

    isChannelOpen() {
        return this.currentDataChannel?.readyState === 'open';
    }

    /**
     * Send a message over the data channel.
     * Automatically chunks large messages to avoid WebRTC size limits.
     */
    async sendMessage(payload, { queueIfConnecting = true } = {}) {
        const channel = this.currentDataChannel;
        if (!channel) {
            throw new Error('数据通道未建立');
        }

        const plainData = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const data = this.sessionKey
            ? await SyncCrypto.encryptString(this.sessionKey, plainData)
            : plainData;

        if (channel.readyState === 'open') {
            // WebRTC data channels can struggle with messages > 64KB
            // Chunk large messages
            const MAX_CHUNK_SIZE = 16384; // 16KB per chunk
            if (data.length > MAX_CHUNK_SIZE) {
                const totalChunks = Math.ceil(data.length / MAX_CHUNK_SIZE);
                const chunkId = Date.now().toString(36);
                
                for (let i = 0; i < totalChunks; i++) {
                    const chunk = data.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
                    const wrapper = JSON.stringify({
                        type: '__chunk__',
                        chunkId,
                        index: i,
                        total: totalChunks,
                        data: chunk
                    });
                    
                    // Wait for buffer to drain if needed
                    while (channel.bufferedAmount > 65536) {
                        await new Promise(r => setTimeout(r, 50));
                        if (channel.readyState !== 'open') {
                            throw new Error('数据通道在发送过程中关闭');
                        }
                    }
                    
                    channel.send(wrapper);
                    this.syncBytesTransferred += wrapper.length;
                }
                return true;
            }
            
            channel.send(data);
            this.syncBytesTransferred += data.length;
            return true;
        }

        if (queueIfConnecting && channel.readyState === 'connecting') {
            this.sendQueue.push(data);
            return false;
        }

        throw new Error('数据通道未就绪: ' + channel.readyState);
    }

    flushSendQueue() {
        if (!this.isChannelOpen() || this.sendQueue.length === 0) {
            return;
        }

        const queue = [...this.sendQueue];
        this.sendQueue.length = 0;
        queue.forEach(data => {
            try {
                this.currentDataChannel.send(data);
            } catch (error) {
                console.warn('Failed to flush queued message:', error);
            }
        });
    }
    
    getDeviceId() {
        return this.deviceId;
    }

    async logChange() {
        // Placeholder for sync change log; keep no-op until delta sync is implemented.
    }
    
    // Legacy sync method (for programmatic use)
    async sync() {
        if (!this.isChannelOpen()) {
            this.showSyncDialog();
            return;
        }
        
        const manifest = await this.buildManifest();
        await this.sendMessage({
            type: 'sync_request',
            deviceId: this.deviceId,
            manifest,
            timestamp: new Date().toISOString()
        });
    }
}
