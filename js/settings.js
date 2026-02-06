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
 * KittenNote - Settings Manager
 * Handles application settings and theme management
 */

import { Toast } from './toast.js';

export class SettingsManager {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('settings-modal');
        
        this.settings = {
            theme: 'auto',
            accent: 'green',
            preset: null,
            nesDelay: 800,
            nesEnabled: false,
            logOverlayEnabled: false,
            nesBackend: 'cpu',
            nesMode: 'api',
            backupIntervalDays: 3,
            lastBackupAt: null,
            lastBackupReminderAt: null,
            backupReminderSeen: false
        };
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.detectSystemTheme();
    }
    
    setupEventListeners() {
        // Tab switching
        this.modal?.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });
        
        // Theme mode
        this.modal?.querySelectorAll('.theme-option').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setThemeMode(btn.dataset.theme);
            });
        });
        
        // Accent colors
        this.modal?.querySelectorAll('.color-palette').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setAccentColor(btn.dataset.accent);
            });
        });
        
        // Preset themes
        this.modal?.querySelectorAll('.preset-theme').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyPreset(btn.dataset.preset);
            });
        });
        
        // NES delay slider
        const nesDelaySlider = document.getElementById('nes-delay');
        const nesDelayValue = document.getElementById('nes-delay-value');
        nesDelaySlider?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            this.settings.nesDelay = value;
            if (nesDelayValue) {
                nesDelayValue.textContent = `${value}ms`;
            }
            this.saveSettings();
            this.app.nesManager?.setDelay(value);
        });

        const logOverlayToggle = document.getElementById('log-overlay-toggle');
        logOverlayToggle?.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            this.settings.logOverlayEnabled = enabled;
            this.saveSettings();
            this.app.setLogOverlayEnabled(enabled);
        });

        const nesBackendSelect = document.getElementById('nes-backend');
        nesBackendSelect?.addEventListener('change', (e) => {
            const value = e.target.value;
            this.settings.nesBackend = value;
            this.saveSettings();
            this.app.nesManager?.setBackend(value);
        });
        
        // NES mode toggle (local/api)
        const nesModeSelect = document.getElementById('nes-mode');
        nesModeSelect?.addEventListener('change', (e) => {
            const mode = e.target.value;
            this.settings.nesMode = mode;
            this.saveSettings();
            this.app.nesManager?.setMode(mode);
            this.toggleNesSettingsPanels(mode);
        });
        
        // NES API settings
        const nesApiUrl = document.getElementById('nes-api-url');
        const nesApiKey = document.getElementById('nes-api-key');
        const nesApiModel = document.getElementById('nes-api-model');
        
        [nesApiUrl, nesApiKey, nesApiModel].forEach(el => {
            el?.addEventListener('change', () => {
                this.settings.nesApiUrl = nesApiUrl?.value || '';
                this.settings.nesApiKey = nesApiKey?.value || '';
                this.settings.nesApiModel = nesApiModel?.value || 'gpt-3.5-turbo';
                this.saveSettings();
                this.app.nesManager?.setApiConfig(
                    this.settings.nesApiUrl,
                    this.settings.nesApiKey,
                    this.settings.nesApiModel
                );
            });
        });
        
        // Test API button
        const testApiBtn = document.getElementById('test-api-btn');
        testApiBtn?.addEventListener('click', () => {
            this.app.nesManager?.testApiConnection();
        });
        
        // Custom model import
        const importModelBtn = document.getElementById('import-custom-model-btn');
        importModelBtn?.addEventListener('click', () => this.importCustomModel());
        
        const removeCustomModelBtn = document.getElementById('remove-custom-model-btn');
        removeCustomModelBtn?.addEventListener('click', () => this.removeCustomModel());
        
        // Drawing settings
        this.setupDrawingSettings();

        // Backup settings
        this.setupBackupSettings();
        
        // Developer settings
        this.setupDeveloperSettings();
        
        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (this.settings.theme === 'auto') {
                this.applyTheme(e.matches ? 'dark' : 'light');
                // Re-apply notebook style so background color follows dark/light mode
                if (this.app.currentNotebook) {
                    this.app.applyNotebookStyle(this.app.currentNotebook);
                }
            }
        });
    }
    
    async loadSettings() {
        try {
            const savedSettings = await this.app.db.getSetting('appSettings');
            if (savedSettings) {
                this.settings = { ...this.settings, ...savedSettings };
            }
            
            this.applySettings();
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }
    
    async saveSettings() {
        try {
            await this.app.db.setSetting('appSettings', this.settings);
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }
    
    applySettings() {
        // Apply theme mode
        this.setThemeMode(this.settings.theme, false);
        
        // Apply preset if set (preset includes accent color)
        // Otherwise apply accent color separately
        if (this.settings.preset) {
            this.applyPreset(this.settings.preset, false);
        } else {
            // Only apply accent color if no preset is active
            this.setAccentColor(this.settings.accent, false);
        }
        
        // Update NES delay UI
        const nesDelaySlider = document.getElementById('nes-delay');
        const nesDelayValue = document.getElementById('nes-delay-value');
        if (nesDelaySlider) {
            nesDelaySlider.value = this.settings.nesDelay;
        }
        if (nesDelayValue) {
            nesDelayValue.textContent = `${this.settings.nesDelay}ms`;
        }

        const logOverlayToggle = document.getElementById('log-overlay-toggle');
        if (logOverlayToggle) {
            logOverlayToggle.checked = !!this.settings.logOverlayEnabled;
        }

        this.app.setLogOverlayEnabled(!!this.settings.logOverlayEnabled);

        const nesBackendSelect = document.getElementById('nes-backend');
        if (nesBackendSelect) {
            nesBackendSelect.value = this.settings.nesBackend || 'cpu';
        }

        this.app.nesManager?.setBackend(this.settings.nesBackend || 'cpu');
        
        // NES mode settings
        const nesModeSelect = document.getElementById('nes-mode');
        if (nesModeSelect) {
            const localOption = nesModeSelect.querySelector('option[value="local"]');
            if (localOption) {
                localOption.disabled = true;
            }
            if (this.settings.nesMode === 'local') {
                this.settings.nesMode = 'api';
                this.saveSettings();
            }
            nesModeSelect.value = this.settings.nesMode || 'api';
        }
        this.toggleNesSettingsPanels(this.settings.nesMode || 'api');
        this.app.nesManager?.setMode(this.settings.nesMode || 'api');
        
        // NES API settings
        const nesApiUrl = document.getElementById('nes-api-url');
        const nesApiKey = document.getElementById('nes-api-key');
        const nesApiModel = document.getElementById('nes-api-model');
        if (nesApiUrl) nesApiUrl.value = this.settings.nesApiUrl || '';
        if (nesApiKey) nesApiKey.value = this.settings.nesApiKey || '';
        if (nesApiModel) nesApiModel.value = this.settings.nesApiModel || 'gpt-3.5-turbo';
        
        this.app.nesManager?.setApiConfig(
            this.settings.nesApiUrl || '',
            this.settings.nesApiKey || '',
            this.settings.nesApiModel || 'gpt-3.5-turbo'
        );
        
        // Custom model info
        if (this.settings.customModelName) {
            const modelInfo = document.getElementById('custom-model-info');
            const modelName = document.getElementById('custom-model-name');
            if (modelInfo && modelName) {
                modelInfo.classList.remove('hidden');
                modelName.textContent = this.settings.customModelName;
            }
            this.app.nesManager?.setCustomModel(this.settings.customModelId);
        }
        
        // Drawing settings
        this.applyDrawingSettings();

        // Backup settings UI
        const backupIntervalInput = document.getElementById('backup-interval-days');
        if (backupIntervalInput) {
            backupIntervalInput.value = this.settings.backupIntervalDays || 3;
        }
        this.updateBackupLastLabel();
        
        // Update UI to reflect current settings
        this.updateSettingsUI();
    }
    
    updateSettingsUI() {
        // Theme mode buttons
        this.modal?.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
        });
        
        // Accent color buttons
        this.modal?.querySelectorAll('.color-palette').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.accent === this.settings.accent);
        });
    }
    
    detectSystemTheme() {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (this.settings.theme === 'auto') {
            this.applyTheme(prefersDark ? 'dark' : 'light');
        }
    }
    
    setThemeMode(mode, save = true) {
        this.settings.theme = mode;
        
        if (mode === 'auto') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            this.applyTheme(prefersDark ? 'dark' : 'light');
        } else {
            this.applyTheme(mode);
        }
        
        // Re-apply notebook style so background follows theme
        if (this.app.currentNotebook) {
            this.app.applyNotebookStyle(this.app.currentNotebook);
        }
        
        // Update UI
        this.modal?.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === mode);
        });
        
        if (save) {
            this.saveSettings();
        }
    }
    
    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        
        // Update meta theme color
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.content = theme === 'dark' ? '#1a1a1a' : '#4CAF50';
        }
    }
    
    setAccentColor(accent, save = true) {
        this.settings.accent = accent;
        this.settings.preset = null;
        
        document.documentElement.setAttribute('data-accent', accent);
        document.documentElement.removeAttribute('data-preset');
        
        // Update UI
        this.modal?.querySelectorAll('.color-palette').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.accent === accent);
        });
        
        if (save) {
            this.saveSettings();
        }
    }
    
    applyPreset(preset, save = true) {
        this.settings.preset = preset;
        
        document.documentElement.setAttribute('data-preset', preset);
        
        // Preset color mappings (32 presets)
        const presetAccents = {
            campus: 'green',
            ocean: 'blue',
            sunset: 'orange',
            forest: 'forest',
            lavender: 'lavender',
            cherry: 'cherry',
            autumn: 'rust',
            mint: 'mint',
            coral: 'coral',
            night: 'navy',
            peach: 'peach',
            tropical: 'emerald',
            rose: 'rose',
            sage: 'olive',
            arctic: 'ocean',
            burgundy: 'crimson',
            teal: 'teal',
            plum: 'plum',
            sand: 'amber',
            slate: 'slate',
            crimson: 'crimson',
            lime: 'lime',
            indigo: 'indigo',
            tangerine: 'tangerine',
            orchid: 'orchid',
            navy: 'navy',
            amber: 'amber',
            grape: 'grape',
            emerald: 'emerald',
            rust: 'rust',
            cobalt: 'cobalt',
            magenta: 'magenta'
        };
        
        this.settings.accent = presetAccents[preset] || 'green';
        document.documentElement.setAttribute('data-accent', this.settings.accent);
        
        if (save) {
            this.saveSettings();
        }
        
        this.updateSettingsUI();
    }

    setLogOverlayEnabled(enabled) {
        this.settings.logOverlayEnabled = enabled;
        this.saveSettings();
        this.app.setLogOverlayEnabled(enabled);
    }
    
    switchTab(tabId) {
        // Update tab buttons
        this.modal?.querySelectorAll('.settings-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabId);
        });
        
        // Update panels
        this.modal?.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === `${tabId}-panel`);
            panel.classList.toggle('hidden', panel.id !== `${tabId}-panel`);
        });
    }
    
    showModal() {
        this.modal?.classList.remove('hidden');
        this.updateDeviceInfo();
        this.updateModelStatus();
        this.updateDeveloperInfo();
    }
    
    hideModal() {
        this.modal?.classList.add('hidden');
    }
    
    async updateDeviceInfo() {
        const deviceId = document.getElementById('device-id');
        const pairedCount = document.getElementById('paired-count');
        
        if (deviceId) {
            const myDeviceId = await this.app.syncManager?.getDeviceId();
            deviceId.textContent = myDeviceId ? myDeviceId.substring(0, 12) + '...' : '-';
        }
        
        if (pairedCount) {
            const devices = await this.app.db.getAllDevices();
            pairedCount.textContent = devices.length.toString();
        }
        
        // Update paired devices list
        const pairedDevicesList = document.getElementById('paired-devices');
        if (pairedDevicesList) {
            const devices = await this.app.db.getAllDevices();
            pairedDevicesList.innerHTML = devices.length === 0 
                ? '<p class="text-muted">暂无已配对设备</p>'
                : devices.map(device => `
                    <div class="paired-device">
                        <div class="device-name">
                            <i class="fas fa-mobile-alt"></i>
                            <span>${device.name || '未知设备'}</span>
                        </div>
                        <span class="device-status">上次同步: ${device.lastSync ? new Date(device.lastSync).toLocaleString() : '从未'}</span>
                    </div>
                `).join('');
        }
    }
    
    async updateModelStatus() {
        const statusEl = document.getElementById('model-status');
        const downloadBtn = document.getElementById('download-model-btn');
        
        if (!statusEl) return;
        
        try {
            const isDownloaded = await this.app.db.isModelDownloaded('nes-model');
            
            if (isDownloaded) {
                statusEl.textContent = '已下载';
                statusEl.style.color = 'var(--primary)';
                if (downloadBtn) {
                    downloadBtn.innerHTML = '<i class="fas fa-check"></i> 已下载';
                    downloadBtn.disabled = true;
                }
            } else {
                statusEl.textContent = '未下载';
                statusEl.style.color = 'var(--text-muted)';
                if (downloadBtn) {
                    downloadBtn.innerHTML = '<i class="fas fa-download"></i> 下载模型';
                    downloadBtn.disabled = false;
                    downloadBtn.onclick = () => this.app.nesManager?.downloadModel();
                }
            }
        } catch (error) {
            console.error('Failed to check model status:', error);
            statusEl.textContent = '检查失败';
        }
    }
    
    toggleNesSettingsPanels(mode) {
        const localSettings = document.getElementById('nes-local-settings');
        const apiSettings = document.getElementById('nes-api-settings');
        
        if (mode === 'api') {
            localSettings?.classList.add('hidden');
            apiSettings?.classList.remove('hidden');
        } else {
            localSettings?.classList.remove('hidden');
            apiSettings?.classList.add('hidden');
        }
    }
    
    async importCustomModel() {
        try {
            // Request directory access
            const dirHandle = await window.showDirectoryPicker({
                mode: 'read'
            });
            
            // Validate model files
            const requiredFiles = ['tokenizer.json', 'config.json'];
            const files = [];
            
            for await (const [name, handle] of dirHandle.entries()) {
                if (handle.kind === 'file') {
                    files.push(name);
                }
            }
            
            // Check for model file (various formats)
            const hasModel = files.some(f => 
                f.endsWith('.onnx') || f.endsWith('.bin') || f.endsWith('.gguf')
            );
            
            if (!hasModel) {
                this.app.Toast?.show('未找到模型文件（.onnx/.bin/.gguf）', 'error');
                return;
            }
            
            // Store model directory handle
            const modelId = 'custom-' + Date.now();
            await this.app.db.saveSetting('customModelHandle', { id: modelId, name: dirHandle.name });
            
            // Update UI
            const modelInfo = document.getElementById('custom-model-info');
            const modelName = document.getElementById('custom-model-name');
            if (modelInfo && modelName) {
                modelInfo.classList.remove('hidden');
                modelName.textContent = dirHandle.name;
            }
            
            this.settings.customModelId = modelId;
            this.settings.customModelName = dirHandle.name;
            this.saveSettings();
            
            this.app.nesManager?.setCustomModel(modelId);
            this.app.Toast?.show('自定义模型已导入', 'success');
            
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Failed to import custom model:', error);
                this.app.Toast?.show('导入失败: ' + error.message, 'error');
            }
        }
    }
    
    removeCustomModel() {
        this.settings.customModelId = null;
        this.settings.customModelName = null;
        this.saveSettings();
        
        const modelInfo = document.getElementById('custom-model-info');
        modelInfo?.classList.add('hidden');
        
        this.app.nesManager?.setCustomModel(null);
        this.app.db.deleteSetting('customModelHandle');
        this.app.Toast?.show('自定义模型已移除', 'success');
    }

    setupBackupSettings() {
        const exportBtn = document.getElementById('backup-export-btn');
        const importBtn = document.getElementById('backup-import-btn');
        const importInput = document.getElementById('backup-import-input');
        const intervalInput = document.getElementById('backup-interval-days');

        exportBtn?.addEventListener('click', () => this.exportBackupZip());

        importBtn?.addEventListener('click', () => {
            importInput?.click();
        });

        importInput?.addEventListener('change', () => {
            const file = importInput.files?.[0];
            if (file) {
                this.importBackupZip(file);
            }
            importInput.value = '';
        });

        intervalInput?.addEventListener('change', (e) => {
            const raw = parseInt(e.target.value, 10);
            const value = Number.isFinite(raw) ? Math.max(1, Math.min(30, raw)) : 3;
            this.settings.backupIntervalDays = value;
            e.target.value = value;
            this.saveSettings();
        });
    }

    updateBackupLastLabel() {
        const label = document.getElementById('backup-last');
        if (!label) return;
        if (!this.settings.lastBackupAt) {
            label.textContent = '未备份';
            return;
        }
        const date = new Date(this.settings.lastBackupAt);
        label.textContent = date.toLocaleString();
    }

    async exportBackupZip() {
        try {
            const data = await this.app.db.exportAllData();
            const payload = JSON.stringify(data, null, 2);
            const encoder = new TextEncoder();
            const files = [
                { name: 'kittennote-backup.json', data: encoder.encode(payload) }
            ];

            const zipData = this.buildZip(files);
            const blob = new Blob([zipData], { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kittennote-backup-${Date.now()}.zip`;
            a.click();
            URL.revokeObjectURL(url);

            const now = new Date().toISOString();
            this.settings.lastBackupAt = now;
            this.settings.lastBackupReminderAt = now;
            this.saveSettings();
            this.updateBackupLastLabel();

            Toast.show('备份已下载', 'success');
        } catch (error) {
            console.error('Backup export failed:', error);
            Toast.show('备份失败: ' + error.message, 'error');
        }
    }

    async importBackupZip(file) {
        if (!file) return;

        if (!confirm('导入备份会覆盖当前所有数据，确定继续吗？')) return;
        if (!confirm('再次确认：请确保你已备份当前数据。')) return;

        try {
            const buffer = await file.arrayBuffer();
            const entries = this.parseZip(buffer);
            const backupData = entries['kittennote-backup.json'] || entries['backup.json'];
            if (!backupData) {
                throw new Error('未找到备份文件内容');
            }

            const json = new TextDecoder().decode(backupData);
            const data = JSON.parse(json);
            await this.app.db.importAllData(data);

            const importedSettings = await this.app.db.getSetting('appSettings');
            if (importedSettings) {
                this.settings = { ...this.settings, ...importedSettings };
            }

            const now = new Date().toISOString();
            this.settings.lastBackupAt = now;
            this.settings.lastBackupReminderAt = now;
            this.saveSettings();
            this.applySettings();
            this.updateBackupLastLabel();

            Toast.show('已恢复备份，页面即将刷新', 'success');
            setTimeout(() => location.reload(), 1200);
        } catch (error) {
            console.error('Backup import failed:', error);
            Toast.show('恢复失败: ' + error.message, 'error');
        }
    }

    buildZip(files) {
        const encoder = new TextEncoder();
        const parts = [];
        const centralParts = [];
        let offset = 0;

        files.forEach((file) => {
            const nameBytes = encoder.encode(file.name);
            const dataBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
            const crc = this.crc32(dataBytes);

            const localHeader = new Uint8Array(30 + nameBytes.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, 0, true);
            localView.setUint16(12, 0, true);
            localView.setUint32(14, crc, true);
            localView.setUint32(18, dataBytes.length, true);
            localView.setUint32(22, dataBytes.length, true);
            localView.setUint16(26, nameBytes.length, true);
            localView.setUint16(28, 0, true);
            localHeader.set(nameBytes, 30);

            parts.push(localHeader, dataBytes);

            const centralHeader = new Uint8Array(46 + nameBytes.length);
            const centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, 0, true);
            centralView.setUint16(14, 0, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, dataBytes.length, true);
            centralView.setUint32(24, dataBytes.length, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, offset, true);
            centralHeader.set(nameBytes, 46);

            centralParts.push(centralHeader);

            offset += localHeader.length + dataBytes.length;
        });

        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const centralOffset = offset;
        const endRecord = new Uint8Array(22);
        const endView = new DataView(endRecord.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, files.length, true);
        endView.setUint16(10, files.length, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, centralOffset, true);
        endView.setUint16(20, 0, true);

        const allParts = [...parts, ...centralParts, endRecord];
        return this.concatUint8Arrays(allParts);
    }

    parseZip(buffer) {
        const view = new DataView(buffer);
        const decoder = new TextDecoder();
        const files = {};
        let offset = 0;

        while (offset + 4 <= buffer.byteLength) {
            const signature = view.getUint32(offset, true);
            if (signature !== 0x04034b50) break;

            const flags = view.getUint16(offset + 6, true);
            const method = view.getUint16(offset + 8, true);
            if (flags & 0x08) {
                throw new Error('不支持带数据描述符的 ZIP 文件');
            }
            if (method !== 0) {
                throw new Error('仅支持未压缩的 ZIP 文件');
            }

            const compressedSize = view.getUint32(offset + 18, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);

            const nameBytes = new Uint8Array(buffer, offset + 30, nameLen);
            const name = decoder.decode(nameBytes);
            const dataStart = offset + 30 + nameLen + extraLen;
            const data = new Uint8Array(buffer, dataStart, compressedSize);

            files[name] = data;
            offset = dataStart + compressedSize;
        }

        return files;
    }

    concatUint8Arrays(parts) {
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        parts.forEach((part) => {
            result.set(part, offset);
            offset += part.length;
        });
        return result;
    }

    crc32(data) {
        if (!this._crcTable) {
            this._crcTable = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let k = 0; k < 8; k++) {
                    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                this._crcTable[i] = c >>> 0;
            }
        }

        let crc = 0 ^ 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            crc = this._crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    
    setupDeveloperSettings() {
        // Unregister Service Worker
        const unregisterSwBtn = document.getElementById('unregister-sw-btn');
        unregisterSwBtn?.addEventListener('click', async () => {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                let count = 0;
                for (const reg of registrations) {
                    await reg.unregister();
                    count++;
                }
                // Also clear caches
                const cacheNames = await caches.keys();
                for (const name of cacheNames) {
                    await caches.delete(name);
                }
                this.app.Toast?.show(`已注销 ${count} 个 Service Worker，已清除 ${cacheNames.length} 个缓存`, 'success');
            } catch (error) {
                console.error('Failed to unregister SW:', error);
                this.app.Toast?.show('注销失败: ' + error.message, 'error');
            }
        });
        
        // Clear all data
        const clearAllDataBtn = document.getElementById('clear-all-data-btn');
        clearAllDataBtn?.addEventListener('click', async () => {
            if (!confirm('确定要删除所有数据吗？此操作不可恢复！')) return;
            if (!confirm('再次确认：所有笔记、文件夹和设置将被永久删除！')) return;
            
            try {
                const dbNames = await indexedDB.databases();
                for (const dbInfo of dbNames) {
                    indexedDB.deleteDatabase(dbInfo.name);
                }
                this.app.Toast?.show('所有数据已清除，页面即将刷新', 'success');
                setTimeout(() => location.reload(), 1500);
            } catch (error) {
                console.error('Failed to clear data:', error);
                this.app.Toast?.show('清除失败: ' + error.message, 'error');
            }
        });
        
        // Copy device ID
        const copyDeviceIdBtn = document.getElementById('copy-device-id-btn');
        copyDeviceIdBtn?.addEventListener('click', async () => {
            const deviceId = this.app.syncManager?.getDeviceId();
            if (deviceId) {
                try {
                    await navigator.clipboard.writeText(deviceId);
                    this.app.Toast?.show('设备 ID 已复制', 'success');
                } catch {
                    this.app.Toast?.show('复制失败', 'error');
                }
            }
        });
    }
    
    async updateDeveloperInfo() {
        const devDeviceId = document.getElementById('dev-device-id');
        if (devDeviceId) {
            const deviceId = this.app.syncManager?.getDeviceId();
            devDeviceId.textContent = deviceId || '未知';
        }
        
        const devCacheVersion = document.getElementById('dev-cache-version');
        if (devCacheVersion) {
            try {
                const keys = await caches.keys();
                devCacheVersion.textContent = keys.join(', ') || '无缓存';
            } catch {
                devCacheVersion.textContent = '无法获取';
            }
        }
    }
    
    setupDrawingSettings() {
        // Variable width toggle
        const variableWidthToggle = document.getElementById('variable-width-toggle');
        variableWidthToggle?.addEventListener('change', (e) => {
            this.settings.variableWidthEnabled = e.target.checked;
            this.saveSettings();
            if (this.app.inkEditor) {
                this.app.inkEditor.variableWidthEnabled = e.target.checked;
            }
        });
        
        // Pressure sampling interval
        const pressureSampling = document.getElementById('pressure-sampling');
        const samplingValue = document.getElementById('sampling-value');
        pressureSampling?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            if (samplingValue) samplingValue.textContent = `${value}ms`;
            this.settings.pressureSamplingInterval = value;
            this.saveSettings();
            if (this.app.inkEditor) {
                this.app.inkEditor.pressureSamplingInterval = value;
            }
        });
        
        // Smoothing toggle
        const smoothingToggle = document.getElementById('smoothing-toggle');
        smoothingToggle?.addEventListener('change', (e) => {
            this.settings.smoothingEnabled = e.target.checked;
            this.saveSettings();
            if (this.app.inkEditor) {
                this.app.inkEditor.smoothingEnabled = e.target.checked;
            }
        });
        
        // Straightening threshold
        const straighteningThreshold = document.getElementById('straightening-threshold');
        const thresholdValue = document.getElementById('threshold-value');
        straighteningThreshold?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            if (thresholdValue) thresholdValue.textContent = value;
            this.settings.straighteningThreshold = value;
            this.saveSettings();
            if (this.app.inkEditor) {
                this.app.inkEditor.straighteningThreshold = value;
            }
        });
        
        // Pressure test canvas
        this.setupPressureTestCanvas();
    }
    
    setupPressureTestCanvas() {
        const canvas = document.getElementById('pressure-test-canvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const pressureDisplay = document.getElementById('pressure-value');
        const widthDisplay = document.getElementById('estimated-width');
        
        // Set canvas resolution
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        
        let isDrawing = false;
        let lastPoint = null;
        
        const getPoint = (e) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                pressure: e.pressure || 0.5
            };
        };
        
        const drawLine = (from, to) => {
            const minWidth = 1;
            const maxWidth = 8;
            const width = minWidth + (to.pressure * (maxWidth - minWidth));
            
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#4CAF50';
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
            
            // Update display
            if (pressureDisplay) pressureDisplay.textContent = to.pressure.toFixed(3);
            if (widthDisplay) widthDisplay.textContent = width.toFixed(1) + 'px';
        };
        
        canvas.addEventListener('pointerdown', (e) => {
            isDrawing = true;
            lastPoint = getPoint(e);
            canvas.setPointerCapture(e.pointerId);
        });
        
        canvas.addEventListener('pointermove', (e) => {
            if (!isDrawing) return;
            const point = getPoint(e);
            drawLine(lastPoint, point);
            lastPoint = point;
        });
        
        canvas.addEventListener('pointerup', () => {
            isDrawing = false;
            lastPoint = null;
        });
        
        canvas.addEventListener('pointercancel', () => {
            isDrawing = false;
            lastPoint = null;
        });
        
        // Clear button (double-tap to clear)
        canvas.addEventListener('dblclick', () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
    }
    
    applyDrawingSettings() {
        const variableWidthToggle = document.getElementById('variable-width-toggle');
        if (variableWidthToggle) {
            variableWidthToggle.checked = this.settings.variableWidthEnabled !== false;
        }
        
        const pressureSampling = document.getElementById('pressure-sampling');
        const samplingValue = document.getElementById('sampling-value');
        if (pressureSampling) {
            pressureSampling.value = this.settings.pressureSamplingInterval || 0;
        }
        if (samplingValue) {
            samplingValue.textContent = `${this.settings.pressureSamplingInterval || 0}ms`;
        }
        
        const smoothingToggle = document.getElementById('smoothing-toggle');
        if (smoothingToggle) {
            smoothingToggle.checked = this.settings.smoothingEnabled !== false;
        }
        
        const straighteningThreshold = document.getElementById('straightening-threshold');
        const thresholdValue = document.getElementById('threshold-value');
        if (straighteningThreshold) {
            straighteningThreshold.value = this.settings.straighteningThreshold || 5;
        }
        if (thresholdValue) {
            thresholdValue.textContent = this.settings.straighteningThreshold || 5;
        }
        
        // Apply to ink editor
        if (this.app.inkEditor) {
            this.app.inkEditor.variableWidthEnabled = this.settings.variableWidthEnabled !== false;
            this.app.inkEditor.pressureSamplingInterval = this.settings.pressureSamplingInterval || 0;
            this.app.inkEditor.smoothingEnabled = this.settings.smoothingEnabled !== false;
            this.app.inkEditor.straighteningThreshold = this.settings.straighteningThreshold || 5;
        }
    }
}
