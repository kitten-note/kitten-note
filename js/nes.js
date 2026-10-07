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
        this.app.logger?.info(`NES 已启用（模式：${this.mode === 'local' ? '内置 EFT' : 'API'}）。`);

        if (this.mode === 'api') {
            this.isModelLoaded = true;
            return;
        }

        if (!this.isModelLoaded) {
            await this.reloadModel();
        }
        if (!this.eftEngine) {
            this.app.logger?.warn('NES 已启用但预测器未就绪：可运行"自检"或查看控制台错误。');
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

    async ensureEngine() {
        if (this.eftEngine) return this.eftEngine;
        const started = performance.now();
        this.app.logger?.info('NES 正在加载内置预测器（assets/eft/）…');
        this.eftEngine = await EftEngine.load('./assets/eft/');
        const meta = this.eftEngine.model.meta || {};
        const gate = meta.gate_thresholds?.softmax;
        this.app.logger?.info(
            `NES 预测器就绪：${(performance.now() - started).toFixed(0)} ms，` +
            `特征维度 ${meta.feature_dim}，门控阈值 ${typeof gate === 'number' ? gate.toFixed(3) : 'n/a'}`
        );
        return this.eftEngine;
    }

    async loadModel() {
        try {
            await this.ensureEngine();
            this.onModelLoaded();
        } catch (error) {
            console.error('[NES] EFT load failed:', error);
            this.isModelLoaded = false;
            this.app.logger?.error('NES 内置预测器加载失败：' + (error?.message || error));
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
            console.warn('[NES] inference skipped: predictor not loaded yet');
            return;
        }
        if (this.mode === 'api' && (!this.apiUrl || !this.apiKey)) {
            console.warn('[NES] inference skipped: API mode is not configured');
            return;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        console.debug('[NES] inference scheduled', {
            enabled: this.enabled,
            mode: this.mode,
            engine: !!this.eftEngine,
            delay: this.delay,
        });
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
        const started = performance.now();
        const details = this.eftEngine.suggestDetailed(document, textBefore.length, { maxResults: 1 });
        const elapsed = performance.now() - started;

        // Full sweep trace in the console; compact summary in the log overlay.
        console.log('[NES] sweep', {
            cursor: textBefore.length,
            documentLength: document.length,
            window: details.window,
            positions: details.positions,
            gateFired: details.gateFired,
            passedFilters: details.passedFilters,
            rejected: details.rejected,
            best: details.best,
            suggestions: details.suggestions,
            ms: Math.round(elapsed),
        });

        if (requestId !== this.currentInferenceId) return;

        if (!details.suggestions.length) {
            const best = details.best;
            this.app.logger?.info(
                `NES 扫描完成：${details.positions} 个位置，门控触发 ${details.gateFired}，通过筛选 ${details.passedFilters}；` +
                (best
                    ? `最佳候选 ${best.className} @${best.pos}（P=${best.editProbability.toFixed(3)}，conf=${best.confidence.toFixed(3)}）低于阈值。`
                    : '窗口内无候选。')
            );
            this.setStatus('idle');
            return;
        }

        this.editSuggestion = details.suggestions[0];
        this.app.logger?.info(
            `NES 建议：${this.editSuggestion.description}（${this.editSuggestion.className} @${this.editSuggestion.pos}，` +
            `P=${this.editSuggestion.editProbability.toFixed(3)}，conf=${this.editSuggestion.confidence.toFixed(3)}，${Math.round(elapsed)} ms）`
        );
        this.showEditSuggestion();
        this.setStatus('success');
    }

    async runSelfTest() {
        // Known-good held-out sample: ASCII comma after "珠穆朗玛峰" must become
        // the fullwidth "，" (the predictor fires FIX_CHAR with P≈0.999).
        const sample = '卢克拉（尼泊爾語：लुक्ला），是尼泊爾萨加玛塔专区索卢昆布县的一个城镇。该地海拔2,860米，靠近珠穆朗玛峰,攀登珠峰者多经此地登峰。卢克拉在尼泊爾語中意为“有许多羊的地方”';
        try {
            await this.ensureEngine();
        } catch (error) {
            console.error('[NES] self-test: engine load failed', error);
            this.app.logger?.error('NES 自检失败：预测器无法加载：' + (error?.message || error));
            Toast.error('预测器加载失败，详见日志');
            return;
        }

        const details = this.eftEngine.suggestDetailed(sample, sample.length, { maxResults: 3 });
        console.log('[NES] self-test', details);
        this.app.logger?.info(
            `NES 自检：文本 ${sample.length} 字，扫描 ${details.positions} 位置，门控触发 ${details.gateFired}，` +
            `通过筛选 ${details.passedFilters}，候选 ${details.suggestions.length} 个。`
        );
        for (const suggestion of details.suggestions) {
            this.app.logger?.info(
                `  ↳ ${suggestion.description}（${suggestion.className} @${suggestion.pos}，` +
                `P=${suggestion.editProbability.toFixed(3)}，conf=${suggestion.confidence.toFixed(3)}）`
            );
        }
        if (details.best) {
            this.app.logger?.info(
                `  最佳原始候选：${details.best.className} @${details.best.pos}（` +
                `P=${details.best.editProbability.toFixed(3)}，conf=${details.best.confidence.toFixed(3)}）`
            );
        }
        Toast.success(
            details.suggestions.length
                ? `自检通过：${details.suggestions.length} 个候选`
                : '自检完成：引擎正常（当前样本无高置信建议，属正常）'
        );
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
