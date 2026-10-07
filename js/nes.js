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
 *
 * Two modes:
 *   local: built-in EFT v0 predictor (on-device, zero network, zero download)
 *          - typed edit atoms, calibrated gate, content-layer payloads
 *   api:   OpenAI-compatible chat completion (text continuation + titles)
 */

import { Toast } from './toast.js';
import { EftEngine, atomEditRange } from './eft-engine.js';

export class NESManager {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.delay = 800;
        this.debounceTimer = null;
        this.currentSuggestion = null;   // legacy inline completion (api mode)
        this.editSuggestion = null;      // EFT typed edit suggestion (local mode)
        this.eftEngine = null;
        this.isModelLoaded = false;
        this.isInferring = false;
        this.inferenceId = 0;
        this.isLoadingModel = false;
        this.warnedNoModel = false;
        this.pendingReload = false;

        // API mode settings
        this.mode = 'local';
        this.apiUrl = '';
        this.apiKey = '';
        this.apiModel = 'gpt-3.5-turbo';
        this.customModelId = null;

        this.suggestionCard = null;
        this.init();
    }

    init() {
        // Setup NES accept button for mobile
        const acceptBtn = document.getElementById('nes-accept-btn');
        acceptBtn?.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.isAcceptingSuggestion = true;
            setTimeout(() => {
                if (this.isAcceptingSuggestion) {
                    this.isAcceptingSuggestion = false;
                }
            }, 500);
        });
        acceptBtn?.addEventListener('click', () => this.acceptSuggestion());
        this.statusIcon = document.querySelector('.nes-status-icon');

        this.createSuggestionCard();
    }

    createSuggestionCard() {
        if (this.suggestionCard) return;
        const card = document.createElement('div');
        card.id = 'eft-suggestion-card';
        card.className = 'eft-suggestion-card hidden';
        card.innerHTML = `
            <span class="eft-suggestion-text"></span>
            <button class="eft-suggestion-accept" type="button" title="接受（Tab）"><i class="fas fa-check"></i></button>
            <button class="eft-suggestion-dismiss" type="button" title="忽略（Esc）"><i class="fas fa-times"></i></button>
        `;
        document.body.appendChild(card);

        const accept = card.querySelector('.eft-suggestion-accept');
        const dismiss = card.querySelector('.eft-suggestion-dismiss');
        accept.addEventListener('pointerdown', (e) => e.preventDefault());
        accept.addEventListener('click', () => this.acceptSuggestion());
        dismiss.addEventListener('pointerdown', (e) => e.preventDefault());
        dismiss.addEventListener('click', () => this.dismissSuggestion());

        this.suggestionCard = card;
    }

    setMode(mode) {
        if (mode !== 'local' && mode !== 'api') return;
        this.mode = mode;
        this.app.logger?.info(`I noticed that NES switched to ${mode === 'api' ? 'API' : 'built-in EFT'} mode.`);

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

    setCustomModel(modelId) {
        // Kept for settings compatibility; custom ONNX models are API-mode only now.
        this.customModelId = modelId || null;
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
            }
            const error = await response.text();
            Toast.error(`API错误: ${response.status}`);
            this.app.logger?.warn('I noticed that NES API test failed.', error);
            return false;
        } catch (error) {
            Toast.error('连接失败: ' + error.message);
            this.app.logger?.warn('I noticed that NES API connection failed.', error);
            return false;
        }
    }

    async enable() {
        this.enabled = true;
        this.setStatus('idle');
        this.app.logger?.info('I noticed that NES woke up and is ready.');

        if (this.mode === 'api') {
            this.isModelLoaded = true;
            return;
        }

        if (!this.isModelLoaded) {
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

    setBackend() {
        // No-op: the EFT predictor is pure JS and needs no WASM/WebGPU backend.
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
        this.dismissSuggestion();
        this.isModelLoaded = false;
        this.isInferring = false;
        this.inferenceId++;
        this.warnedNoModel = false;
        // The engine stays cached: it is small (~6 MB) and instant to reuse.
    }

    async loadModel() {
        try {
            this.app.logger?.info('I noticed that NES is waking up the built-in EFT predictor.');
            this.eftEngine = this.eftEngine || await EftEngine.load('./assets/eft/');
            this.onModelLoaded();
        } catch (error) {
            console.error('Failed to load EFT predictor:', error);
            this.isModelLoaded = false;
            this.app.logger?.warn('I noticed that the EFT predictor refused to load.', error);
            Toast.error('内置预测器加载失败');
        }
    }

    onModelLoaded() {
        this.isModelLoaded = true;
        this.app.logger?.info('I learnt that the EFT predictor is ready.');
    }

    scheduleInference() {
        if (!this.enabled) return;
        if (this.mode === 'local' && !this.eftEngine) {
            if (!this.warnedNoModel) {
                this.app.logger?.warn('I noticed that NES cannot think without its predictor.');
                this.warnedNoModel = true;
            }
            return;
        }
        if (this.mode === 'api' && (!this.apiUrl || !this.apiKey)) {
            return;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.runInference();
        }, this.delay);
    }

    async runInference() {
        if (!this.enabled) return;

        if (this.mode === 'local' && !this.eftEngine) return;
        if (this.mode === 'api' && (!this.apiUrl || !this.apiKey)) return;

        if (this.isInferring) {
            this.inferenceId++;
        }

        const requestId = ++this.inferenceId;
        this.isInferring = true;
        this.currentSuggestion = '';
        this.currentInferenceId = requestId;
        this.setStatus('running');

        const textEditor = this.app.textEditor;
        if (!textEditor) {
            this.isInferring = false;
            this.setStatus('idle');
            return;
        }

        const textBefore = textEditor.getTextBeforeCursor();
        const textAfter = textEditor.getTextAfterCursor();

        if (!textBefore && !textAfter) {
            this.isInferring = false;
            this.setStatus('idle');
            return;
        }

        try {
            if (this.mode === 'api') {
                const limitedBefore = textBefore.slice(-400);
                const limitedAfter = textAfter.slice(0, 200);
                const suggestion = await this.runApiInference(limitedBefore, limitedAfter, requestId);
                if (requestId !== this.currentInferenceId) return;

                if (suggestion) {
                    this.currentSuggestion = suggestion;
                    this.showSuggestion();
                    this.setStatus('success');
                } else {
                    this.setStatus('idle');
                }
            } else {
                this.runEftInference(textBefore, textAfter, requestId);
            }

            this.app.logger?.info('I noticed that NES finished thinking.');
        } catch (error) {
            console.error('Inference failed:', error);
            this.app.logger?.warn('I noticed that NES inference stumbled.', error);
            this.setStatus('error', error?.message || 'Inference failed');
        } finally {
            if (requestId === this.currentInferenceId) {
                this.isInferring = false;
            }
        }
    }

    runEftInference(textBefore, textAfter, requestId) {
        const document = textBefore + textAfter;
        const suggestions = this.eftEngine.suggest(document, textBefore.length, { maxResults: 1 });

        if (requestId !== this.currentInferenceId) return;
        if (!suggestions.length) {
            this.setStatus('idle');
            return;
        }

        this.editSuggestion = suggestions[0];
        this.showEditSuggestion();
        this.setStatus('success');
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

    async generateTitle(text) {
        const source = (text || '').toString().trim();
        if (!source) return '';

        if (this.mode === 'local') {
            Toast.warning('内置预测器不支持标题生成，请切换 API 模式');
            return '';
        }

        if (!this.apiUrl || !this.apiKey) {
            Toast.warning('请先在设置中配置 NES API 地址和密钥');
            return '';
        }
        return this.runApiTitle(source.slice(0, 800));
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
        return this.trimTitle(data.choices?.[0]?.message?.content?.trim() || '');
    }

    trimTitle(title) {
        const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';
        return cleaned.length > 10 ? cleaned.slice(0, 10) : cleaned;
    }

    showSuggestion() {
        if (!this.currentSuggestion) return;

        this.app.textEditor?.showSuggestion(this.currentSuggestion);

        const acceptBtn = document.getElementById('nes-accept-btn');
        if (acceptBtn && this.currentSuggestion) {
            acceptBtn.classList.remove('hidden');
        }
    }

    showEditSuggestion() {
        const card = this.suggestionCard;
        if (!card || !this.editSuggestion) return;

        const label = card.querySelector('.eft-suggestion-text');
        if (label) {
            label.textContent = `建议：${this.editSuggestion.description}`;
        }

        const cursor = this.app.textEditor?.getCursorPosition?.();
        card.classList.remove('hidden');
        if (cursor) {
            const width = 340;
            const x = Math.max(8, Math.min(window.innerWidth - width - 8, cursor.x));
            const y = Math.min(window.innerHeight - 56, cursor.y + (cursor.height || 20) + 8);
            card.style.left = `${x}px`;
            card.style.top = `${y}px`;
        }

        const acceptBtn = document.getElementById('nes-accept-btn');
        acceptBtn?.classList.remove('hidden');
    }

    dismissSuggestion() {
        this.currentSuggestion = null;
        this.editSuggestion = null;
        this.app.textEditor?.hideSuggestion();
        this.suggestionCard?.classList.add('hidden');
        this.setStatus('idle');

        const acceptBtn = document.getElementById('nes-accept-btn');
        acceptBtn?.classList.add('hidden');
    }

    hasSuggestion() {
        return !!(this.editSuggestion || this.currentSuggestion);
    }

    acceptSuggestion() {
        if (this.editSuggestion) {
            const range = atomEditRange(this.editSuggestion.atom);
            const applied = range
                ? this.app.textEditor?.applyPlainTextEdit(range.start, range.end, range.replacement)
                : false;
            this.app.logger?.info(
                `I applied a NES suggestion: ${this.editSuggestion.description} (${applied ? 'ok' : 'failed'}).`
            );
            this.dismissSuggestion();
            return;
        }

        if (!this.currentSuggestion) return;

        this.app.textEditor?.acceptSuggestion(this.currentSuggestion);
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
}
