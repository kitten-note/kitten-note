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
 * P2P sync using WebRTC with QR code signaling (no server required)
 */

export class SyncManager {
    constructor(db, app) {
        this.db = db;
        this.app = app;
        
        this.deviceId = null;
        this.keyPair = null;
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
    
    async initializeDevice() {
        let deviceInfo = await this.db.getSetting('deviceInfo');
        
        if (!deviceInfo) {
            this.deviceId = this.generateDeviceId();
            this.keyPair = await this.generateKeyPair();
            
            deviceInfo = {
                id: this.deviceId,
                publicKey: await this.exportPublicKey(this.keyPair.publicKey),
                privateKey: await this.exportPrivateKey(this.keyPair.privateKey),
                createdAt: new Date().toISOString()
            };
            
            await this.db.setSetting('deviceInfo', deviceInfo);
        } else {
            this.deviceId = deviceInfo.id;
            this.keyPair = {
                publicKey: await this.importPublicKey(deviceInfo.publicKey),
                privateKey: await this.importPrivateKey(deviceInfo.privateKey)
            };
        }
    }
    
    generateDeviceId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }
    
    async generateKeyPair() {
        return await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
        );
    }
    
    async exportPublicKey(key) {
        const exported = await crypto.subtle.exportKey('spki', key);
        return this.arrayBufferToBase64(exported);
    }
    
    async exportPrivateKey(key) {
        const exported = await crypto.subtle.exportKey('pkcs8', key);
        return this.arrayBufferToBase64(exported);
    }
    
    async importPublicKey(base64) {
        const buffer = this.base64ToArrayBuffer(base64);
        return await crypto.subtle.importKey(
            'spki', buffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            true, ['verify']
        );
    }
    
    async importPrivateKey(base64) {
        const buffer = this.base64ToArrayBuffer(base64);
        return await crypto.subtle.importKey(
            'pkcs8', buffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            true, ['sign']
        );
    }
    
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
    
    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
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
            const svgMarkup = container.innerHTML;
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
            container.innerHTML = qr.createSvgTag({ scalable: true });
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
            
            // Package offer with candidates
            const offerData = {
                type: 'offer',
                sdp: this.currentPeerConnection.localDescription.sdp,
                candidates: candidates
            };
            
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
            
            // Package answer
            const answerData = {
                type: 'answer',
                sdp: this.currentPeerConnection.localDescription.sdp,
                candidates: candidates
            };
            
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
        // Chunk reassembly buffer
        const chunkBuffers = new Map();
        
        channel.addEventListener('message', (event) => {
            try {
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
            
            // Send sync request
            await this.sendMessage({
                type: 'sync_request',
                deviceId: this.deviceId,
                timestamp: new Date().toISOString()
            });
            
            this.app.Toast?.show('同步请求已发送', 'info');
            
        } catch (error) {
            console.error('Sync failed:', error);
            this.app.Toast?.show('同步失败: ' + error.message, 'error');
            this.syncInProgress = false;
        }
    }
    
    // ======== Sync Protocol ========
    async handleSyncMessage(data) {
        try {
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
                    // Bidirectional: sync_ack may include peer's data
                    if (message.notes || message.notebooks || message.folders) {
                        const counts = await this.mergeRemoteData(message);
                        this.app.Toast?.show(`同步完成！${counts.folders} 文件夹, ${counts.notebooks} 笔记本, ${counts.notes} 笔记`, 'success');
                        await this.app.directoryTree?.render();
                    } else {
                        this.app.Toast?.show('同步完成！', 'success');
                    }
                    this.syncInProgress = false;
                    
                    // Close wizard and cleanup after successful sync
                    setTimeout(() => {
                        this.closeWizard();
                    }, 1500);
                    break;
            }
        } catch (error) {
            console.error('Failed to handle sync message:', error);
            this.syncInProgress = false;
        }
    }
    
    async handleSyncRequest(message) {
        if (!this.isChannelOpen()) {
            console.warn('Sync request received but channel is closed.');
            this.app.Toast?.show('连接已断开，请重新连接', 'error');
            return;
        }

        this.syncInProgress = true;

        try {
            // Get all data to send
            const notes = await this.db.getAllNotes();
            const notebooks = await this.db.getAllNotebooks();
            const folders = await this.db.getAllFolders();
            
            await this.sendMessage({
                type: 'sync_data',
                notes: notes,
                notebooks: notebooks,
                folders: folders,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Failed to send sync data:', error);
            this.syncInProgress = false;
            this.app.Toast?.show('发送同步数据失败', 'error');
        }
    }
    
    async handleSyncData(message) {
        this.syncInProgress = true;
        
        try {
            const mergedCount = await this.mergeRemoteData(message);
            
            // Send acknowledgment + own data back for bidirectional sync
            if (this.isChannelOpen()) {
                const localNotes = await this.db.getAllNotes();
                const localNotebooks = await this.db.getAllNotebooks();
                const localFolders = await this.db.getAllFolders();
                
                await this.sendMessage({
                    type: 'sync_ack',
                    notes: localNotes,
                    notebooks: localNotebooks,
                    folders: localFolders,
                    timestamp: new Date().toISOString()
                });
                
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
            }, 2000);
            
        } catch (error) {
            console.error('Sync data merge failed:', error);
            this.syncInProgress = false;
            this.app.Toast?.show('同步合并失败: ' + error.message, 'error');
        }
    }
    
    /**
     * Merge remote data (folders, notebooks, notes) into local DB.
     * Returns counts of merged items.
     */
    async mergeRemoteData(message) {
        const { notes, notebooks, folders } = message;
        let mergedCount = { notes: 0, notebooks: 0, folders: 0 };
        
        // Merge folders first (parents before children)
        if (folders && folders.length > 0) {
            for (const folder of folders) {
                try {
                    const local = await this.db.getFolder(folder.id);
                    if (!local || new Date(folder.updatedAt) > new Date(local.updatedAt)) {
                        await this.db.upsertFolder(folder);
                        mergedCount.folders++;
                    }
                } catch (e) {
                    console.warn('Failed to merge folder:', folder.id, e);
                }
            }
        }
        
        // Merge notebooks
        if (notebooks && notebooks.length > 0) {
            for (const notebook of notebooks) {
                try {
                    const local = await this.db.getNotebook(notebook.id);
                    if (!local || new Date(notebook.updatedAt) > new Date(local.updatedAt)) {
                        await this.db.upsertNotebook(notebook);
                        mergedCount.notebooks++;
                    }
                } catch (e) {
                    console.warn('Failed to merge notebook:', notebook.id, e);
                }
            }
        }
        
        // Merge notes
        if (notes && notes.length > 0) {
            for (const note of notes) {
                try {
                    const local = await this.db.getNote(note.id);
                    if (!local || new Date(note.updatedAt) > new Date(local.updatedAt)) {
                        await this.db.upsertNote(note);
                        mergedCount.notes++;
                    }
                } catch (e) {
                    console.warn('Failed to merge note:', note.id, e);
                }
            }
        }
        
        console.log(`Sync merge: ${mergedCount.folders} folders, ${mergedCount.notebooks} notebooks, ${mergedCount.notes} notes`);
        return mergedCount;
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

        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

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
                }
                return true;
            }
            
            channel.send(data);
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
        
        await this.sendMessage({
            type: 'sync_request',
            deviceId: this.deviceId,
            timestamp: new Date().toISOString()
        });
    }
}
