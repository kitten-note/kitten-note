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
 * KittenNote - NES (Next Edit Suggestion) Manager
 * Local AI-powered text suggestions using transformers.js (ONNX)
 * Also supports OpenAI-compatible API mode
 */

import { Toast } from './toast.js';

export class NESManager {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.delay = 800;
        this.debounceTimer = null;
        this.currentSuggestion = null;
        this.generator = null;
        this.modelId = 'nes-model';
        this.modelFileName = 'model_q4.onnx';
        this.backend = 'cpu';
        this.isModelLoaded = false;
        this.isInferring = false;
        this.inferenceId = 0;
        this.isLoadingModel = false;
        this.warnedNoModel = false;
        this.pendingReload = false;
        
        // API mode settings
        this.mode = 'api'; // 'local' or 'api'
        this.apiUrl = '';
        this.apiKey = '';
        this.apiModel = 'gpt-3.5-turbo';
        
        // Custom model
        this.customModelId = null;
        
        this.init();
    }
    
    init() {
        // Setup NES accept button for mobile
        const acceptBtn = document.getElementById('nes-accept-btn');
        // Use pointerdown to set flag BEFORE blur fires on the editor
        acceptBtn?.addEventListener('pointerdown', (e) => {
            e.preventDefault(); // Prevent focus change
            this.isAcceptingSuggestion = true;
            // Safety reset after a short delay in case click doesn't fire
            setTimeout(() => {
                if (this.isAcceptingSuggestion) {
                    this.isAcceptingSuggestion = false;
                }
            }, 500);
        });
        acceptBtn?.addEventListener('click', () => this.acceptSuggestion());
        this.statusIcon = document.querySelector('.nes-status-icon');
    }
    
    setMode(mode) {
        if (mode !== 'local' && mode !== 'api') return;
        this.mode = mode;
        this.app.logger?.info(`I noticed that NES switched to ${mode === 'api' ? 'API' : 'local'} mode.`);
        
        if (mode === 'local' && this.enabled) {
            this.reloadModel();
        } else if (mode === 'api') {
            this.unloadModel();
            this.isModelLoaded = true; // API mode is always "ready"
        }
    }
    
    setApiConfig(url, key, model) {
        this.apiUrl = url || '';
        this.apiKey = key || '';
        this.apiModel = model || 'gpt-3.5-turbo';
    }
    
    async testApiConnection() {
        if (!this.apiUrl || !this.apiKey) {
            Toast.warning('请填写API地址和Key');
            return false;
        }
        
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.apiModel,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5
                })
            });
            
            if (response.ok) {
                Toast.success('API连接成功！');
                this.app.logger?.info('I noticed that NES API connection test passed.');
                return true;
            } else {
                const error = await response.text();
                Toast.error(`API错误: ${response.status}`);
                this.app.logger?.warn('I noticed that NES API test failed.', error);
                return false;
            }
        } catch (error) {
            Toast.error('连接失败: ' + error.message);
            this.app.logger?.warn('I noticed that NES API connection failed.', error);
            return false;
        }
    }
    
    setCustomModel(modelId) {
        this.customModelId = modelId;
        if (modelId) {
            this.modelId = modelId;
        } else {
            this.modelId = 'nes-model';
        }
    }

    async ensureCrossOriginIsolation() {
        if (window.crossOriginIsolated === true) {
            return true;
        }

        if (!window.isSecureContext) {
            this.app.logger?.warn('I noticed that NES needs https/localhost to enable cross-origin isolation.');
            Toast.warning('NES 需要在 https/localhost 下启用跨域隔离');
            return false;
        }

        const url = new URL(window.location.href);
        const isCoiRequested = url.searchParams.get('coi') === '1';

        if (isCoiRequested) {
            if (!navigator.serviceWorker?.controller) {
                if (!sessionStorage.getItem('nes_coi_reload')) {
                    sessionStorage.setItem('nes_coi_reload', '1');
                    Toast.info('正在应用跨域隔离设置，马上刷新…');
                    window.location.reload();
                }
            } else {
                Toast.warning('请刷新页面以启用跨域隔离（COOP/COEP）');
            }
            return false;
        }

        url.searchParams.set('coi', '1');
        sessionStorage.removeItem('nes_coi_reload');
        Toast.info('NES 需要跨域隔离，正在刷新以启用…');
        window.location.replace(url.toString());
        return false;
    }
    
    async enable() {
        this.enabled = true;
        this.setStatus('idle');
        this.app.logger?.info('I noticed that NES woke up and is ready.');

        if (this.mode === 'api') {
            this.isModelLoaded = true;
            return;
        }
        
        // Check if model is loaded
        if (!this.isModelLoaded) {
            const isDownloaded = await this.app.db.isModelDownloaded(this.modelId);
            if (this.mode === 'local' && !isDownloaded) {
                this.app.logger?.warn('I noticed that the NES model is still missing.');
                this.app.settingsManager?.showModal();
                this.app.settingsManager?.switchTab('nes');
                return;
            }

            await this.reloadModel();
        }
    }
    
    disable() {
        this.enabled = false;
        this.dismissSuggestion();
        this.setStatus('idle');
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.unloadModel();
    }
    
    setDelay(ms) {
        this.delay = ms;
    }

    setBackend(backend) {
        if (!backend || backend === this.backend) return;
        this.backend = backend;
        this.app.logger?.info(`I noticed that NES switched to ${backend === 'webgpu' ? 'WebGPU' : 'CPU'} mode.`);
        if (this.enabled) {
            this.reloadModel();
        } else {
            this.unloadModel();
        }
    }

    async reloadModel() {
        if (this.isLoadingModel) {
            this.pendingReload = true;
            return;
        }

        this.isLoadingModel = true;
        try {
            await this.unloadModel();
            await this.loadModel();
        } finally {
            this.isLoadingModel = false;
            if (this.pendingReload) {
                this.pendingReload = false;
                this.reloadModel();
            }
        }
    }

    async unloadModel() {
        if (!this.generator) {
            this.isModelLoaded = false;
            return;
        }

        const pipelineInstance = this.generator;
        this.generator = null;
        this.isModelLoaded = false;
        this.isInferring = false;
        this.inferenceId++;
        this.warnedNoModel = false;

        try {
            if (typeof pipelineInstance.dispose === 'function') {
                await pipelineInstance.dispose();
            }
            if (pipelineInstance.model?.dispose) {
                await pipelineInstance.model.dispose();
            }
            if (pipelineInstance.tokenizer?.dispose) {
                await pipelineInstance.tokenizer.dispose();
            }
        } catch (error) {
            console.warn('Failed to dispose NES pipeline:', error);
        }

        this.app.logger?.info('I noticed that NES released its model to save memory.');
    }
    
    async loadModel() {
        try {
            const { pipeline, env } = await import('../assets/transformers.js/transformers.js');

            env.allowLocalModels = true;
            env.allowRemoteModels = false;
            env.localModelPath = './assets';
            env.useBrowserCache = false;

            if (env.backends?.onnx?.wasm) {
                env.backends.onnx.wasm.wasmPaths = {
                    mjs: '/assets/transformers.js/ort-wasm-simd-threaded.jsep.mjs',
                    wasm: '/assets/transformers.js/ort-wasm-simd-threaded.jsep.wasm'
                };
            }

            const attemptLoad = async (mode, message) => {
                if (env.backends?.onnx?.wasm) {
                    env.backends.onnx.wasm.numThreads = 1;
                    env.backends.onnx.wasm.simd = false; // Disable SIMD to avoid Aborted() errors
                    env.backends.onnx.wasm.proxy = false;
                }

                if (env.backends?.onnx) {
                    env.backends.onnx.preferredBackend = mode === 'webgpu' ? 'webgpu' : 'wasm';
                }
                this.app.logger?.info(message);

                const device = mode === 'webgpu' ? 'webgpu' : 'wasm';
                return pipeline('text-generation', this.modelId, {
                    local_files_only: true,
                    dtype: 'q4',
                    device
                });
            };

            const useWebGPU = this.backend === 'webgpu';
            if (useWebGPU && !navigator.gpu) {
                this.app.logger?.warn('WebGPU is not available in this browser. Falling back to CPU.');
                this.backend = 'cpu';
            }

            try {
                if (this.backend === 'webgpu') {
                    this.generator = await attemptLoad('webgpu', 'I noticed that NES is preparing a WebGPU pipeline (experimental).');
                } else {
                    this.generator = await attemptLoad('cpu', 'I noticed that NES is preparing its transformers pipeline.');
                }
            } catch (error) {
                if (this.backend === 'webgpu') {
                    // Release failed WebGPU instance
                    if (this.generator) {
                        try {
                            if (this.generator.dispose) await this.generator.dispose();
                            if (this.generator.model?.dispose) await this.generator.model.dispose();
                            if (this.generator.tokenizer?.dispose) await this.generator.tokenizer.dispose();
                        } catch (e) { console.warn('Cleanup failed:', e); }
                        this.generator = null;
                    }
                    this.app.logger?.warn('I noticed that WebGPU failed, retrying with CPU.', error);
                    this.backend = 'cpu';
                    this.generator = await attemptLoad('cpu', 'I noticed that NES is retrying with CPU pipeline.');
                } else {
                    throw error;
                }
            }

            this.onModelLoaded();
        } catch (error) {
            console.error('Failed to load NES model:', error);
            this.isModelLoaded = false;
            this.app.logger?.warn('I noticed that the NES model refused to load.', error);
        }
    }
    
    onModelLoaded() {
        console.log('NES model loaded successfully');
        this.app.logger?.info('I learnt that the NES model is now loaded.');
        this.isModelLoaded = true;
    }
    
    onModelOutput(text) {
        if (this.currentInferenceId === this.inferenceId) {
            this.currentSuggestion = (this.currentSuggestion || '') + text;
            this.showSuggestion();
        }
    }
    
    scheduleInference() {
        if (!this.enabled) return;
        if (this.mode === 'local' && !this.isModelLoaded) {
            if (!this.warnedNoModel) {
                this.app.logger?.warn('I noticed that NES cannot think without its model.');
                this.warnedNoModel = true;
            }
            return;
        }
        this.app.logger?.info('I noticed that NES is about to think.');
        
        // Clear previous timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // Schedule new inference
        this.debounceTimer = setTimeout(() => {
            this.runInference();
        }, this.delay);
    }
    
    async runInference() {
        if (!this.enabled) return;
        
        // Check if ready based on mode
        if (this.mode === 'local' && (!this.generator || !this.isModelLoaded)) return;
        if (this.mode === 'api' && (!this.apiUrl || !this.apiKey)) return;
        
        if (this.isInferring) {
            this.inferenceId++;
        }

        const requestId = ++this.inferenceId;
        this.isInferring = true;
        this.currentSuggestion = '';
        this.currentInferenceId = requestId;
        this.setStatus('running');
        
        // Get context from text editor
        const textEditor = this.app.textEditor;
        if (!textEditor) {
            this.isInferring = false;
            this.setStatus('idle');
            return;
        }
        
        const textBefore = textEditor.getTextBeforeCursor();
        const textAfter = textEditor.getTextAfterCursor();
        
        // Check if there's any content to work with
        if (!textBefore && !textAfter) {
            this.isInferring = false;
            this.setStatus('idle');
            return;
        }
        
        const limitedBefore = textBefore.slice(-400);
        const limitedAfter = textAfter.slice(0, 200);
        
        try {
            let suggestion = '';
            
            if (this.mode === 'api') {
                suggestion = await this.runApiInference(limitedBefore, limitedAfter, requestId);
            } else {
                suggestion = await this.runLocalInference(limitedBefore, limitedAfter, requestId);
            }

            if (requestId !== this.currentInferenceId) {
                return;
            }

            if (suggestion) {
                this.currentSuggestion = suggestion;
                this.showSuggestion();
                this.setStatus('success');
            } else {
                this.setStatus('idle');
            }

            this.app.logger?.info('I noticed that NES finished thinking.');
        } catch (error) {
            console.error('Inference failed:', error);
            this.app.logger?.warn('I noticed that NES inference stumbled.', error);
            this.setStatus('error', error?.message || 'Inference failed');
        } finally {
            // Always reset isInferring for this request
            if (requestId === this.currentInferenceId) {
                this.isInferring = false;
            }
        }
    }
    
    async runLocalInference(textBefore, textAfter, requestId) {
        const prompt = this.buildPrompt(textBefore, textAfter);
        
        const results = await this.generator(prompt, {
            max_new_tokens: 50,
            temperature: 0.7,
            top_p: 0.9,
            do_sample: true,
            return_full_text: false
        });

        if (requestId !== this.currentInferenceId) {
            return '';
        }

        return this.extractSuggestion(results, prompt);
    }
    
    async runApiInference(textBefore, textAfter, requestId) {
        const contextBefore = textBefore.slice(-400);
        const contextAfter = textAfter.slice(0, 200);
        
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.apiModel,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个写作助手。根据用户提供的上下文，预测并补全接下来最可能的文字。只输出补全内容，不要解释。只输出一句话，不要换行。'
                    },
                    {
                        role: 'user',
                        content: `请继续这段文字（只补全光标处的后续内容）：\n\n光标前：${contextBefore}\n\n光标后：${contextAfter}`
                    }
                ],
                max_tokens: 50,
                temperature: 0.7,
                stream: false
            })
        });
        
        if (requestId !== this.currentInferenceId) {
            return '';
        }
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || '';
    }
    
    buildPrompt(textBefore, textAfter) {
        // Simple completion prompt
        const contextBefore = textBefore.slice(-200);
        const contextAfter = textAfter.slice(0, 120);
        const prompt = `Continue this text naturally with one concise sentence (no line breaks).\n\nBefore cursor:\n${contextBefore}\n\nAfter cursor:\n${contextAfter}\n\nContinuation:`;
        return prompt;
    }

    extractSuggestion(results, prompt) {
        if (!results) return '';

        const item = Array.isArray(results) ? results[0] : results;
        const text = item?.generated_text ?? item?.text ?? '';
        if (!text) return '';

        if (text.startsWith(prompt)) {
            return text.slice(prompt.length).trimStart();
        }

        return text.trimStart();
    }

    async generateTitle(text) {
        const source = (text || '').toString().trim();
        if (!source) return '';

        const snippet = source.slice(0, 800);

        if (this.mode === 'api') {
            if (!this.apiUrl || !this.apiKey) {
                Toast.warning('请先在设置中配置 NES API 地址和密钥');
                return '';
            }
            return this.runApiTitle(snippet);
        }

        if (!this.generator || !this.isModelLoaded) {
            Toast.warning('本地模型未就绪');
            return '';
        }

        return this.runLocalTitle(snippet);
    }

    async runApiTitle(snippet) {
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.apiModel,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个写作助手。根据文本生成一个10字以内的标题，只输出标题，不要解释。'
                    },
                    {
                        role: 'user',
                        content: `请为以下内容生成标题（10字以内）：\n\n${snippet}`
                    }
                ],
                max_tokens: 20,
                temperature: 0.3,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim() || '';
        return this.trimTitle(raw);
    }

    async runLocalTitle(snippet) {
        const prompt = `Create a short title within 10 characters. Output only the title.\n\n${snippet}\n\nTitle:`;
        const results = await this.generator(prompt, {
            max_new_tokens: 20,
            temperature: 0.5,
            top_p: 0.9,
            do_sample: true,
            return_full_text: false
        });

        const title = this.extractSuggestion(results, prompt);
        return this.trimTitle(title);
    }

    trimTitle(title) {
        const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';
        return cleaned.length > 10 ? cleaned.slice(0, 10) : cleaned;
    }
    
    showSuggestion() {
        if (!this.currentSuggestion) return;
        
        const textEditor = this.app.textEditor;
        textEditor?.showSuggestion(this.currentSuggestion);
        
        // Show accept button on mobile
        const acceptBtn = document.getElementById('nes-accept-btn');
        if (acceptBtn && this.currentSuggestion) {
            acceptBtn.classList.remove('hidden');
        }
    }
    
    dismissSuggestion() {
        this.currentSuggestion = null;
        this.app.textEditor?.hideSuggestion();
        this.setStatus('idle');
        
        const acceptBtn = document.getElementById('nes-accept-btn');
        acceptBtn?.classList.add('hidden');
    }
    
    hasSuggestion() {
        return !!this.currentSuggestion;
    }
    
    acceptSuggestion() {
        if (!this.currentSuggestion) return;
        
        const textEditor = this.app.textEditor;
        this.isAcceptingSuggestion = true;
        textEditor?.acceptSuggestion(this.currentSuggestion);
        this.isAcceptingSuggestion = false;
        
        this.dismissSuggestion();
    }

    setStatus(state, detail = '') {
        if (!this.statusIcon) return;
        this.statusIcon.classList.remove('is-running', 'is-success', 'is-error');
        if (state === 'running') {
            this.statusIcon.classList.add('is-running');
            this.statusIcon.removeAttribute('title');
        } else if (state === 'success') {
            this.statusIcon.classList.add('is-success');
            this.statusIcon.removeAttribute('title');
        } else if (state === 'error') {
            this.statusIcon.classList.add('is-error');
            if (detail) {
                this.statusIcon.setAttribute('title', detail);
            }
        } else {
            this.statusIcon.removeAttribute('title');
        }
    }
    
    async downloadModel() {
        const progressBar = document.getElementById('download-progress');
        const progressFill = progressBar?.querySelector('.progress-fill');
        const progressText = progressBar?.querySelector('.progress-text');
        const downloadBtn = document.getElementById('download-model-btn');
        
        if (progressBar) progressBar.classList.remove('hidden');
        if (downloadBtn) downloadBtn.disabled = true;
        
        try {
            // The model is already included in assets/nes-model/
            // This simulates a download process for the UI
            const modelUrl = './assets/nes-model/onnx/model_q4.onnx';
            
            const response = await fetch(modelUrl);
            if (!response.ok) {
                throw new Error('Model file not found');
            }
            
            const contentLength = response.headers.get('content-length');
            const total = contentLength ? parseInt(contentLength) : 0;
            let loaded = 0;
            
            const reader = response.body?.getReader();
            const chunks = [];
            
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                loaded += value.length;
                
                if (total > 0) {
                    const percent = Math.round((loaded / total) * 100);
                    if (progressFill) progressFill.style.width = `${percent}%`;
                    if (progressText) progressText.textContent = `${percent}%`;
                }
            }
            
            // Store model data in IndexedDB
            const blob = new Blob(chunks);
            const chunkSize = 1024 * 1024; // 1MB chunks
            const totalChunks = Math.ceil(blob.size / chunkSize);
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, blob.size);
                const chunkBlob = blob.slice(start, end);
                const arrayBuffer = await chunkBlob.arrayBuffer();
                
                await this.app.db.saveModelChunk(this.modelId, i, arrayBuffer);
            }
            
            // Update UI
            if (progressBar) progressBar.classList.add('hidden');
            if (downloadBtn) {
                downloadBtn.innerHTML = '<i class="fas fa-check"></i> 已下载';
            }
            
            const statusEl = document.getElementById('model-status');
            if (statusEl) {
                statusEl.textContent = '已下载';
                statusEl.style.color = 'var(--primary)';
            }
            
            // Load model
            await this.loadModel();
            
        } catch (error) {
            console.error('Model download failed:', error);
            
            if (progressBar) progressBar.classList.add('hidden');
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.innerHTML = '<i class="fas fa-download"></i> 重试下载';
            }
            
            this.app.Toast?.show('模型下载失败', 'error');
        }
    }
}
