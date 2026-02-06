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
 * KittenNote - Main Application Entry Point
 * A PWA note-taking application with text and ink support
 */

import { Database } from './database.js';
import { DirectoryTree } from './directory-tree.js';
import { TextEditor } from './text-editor.js';
import { InkEditor } from './ink-editor.js';
import { SettingsManager } from './settings.js';
import { SyncManager } from './sync.js';
import { NESManager } from './nes.js';
import { ExportManager } from './export.js';
import { Toast } from './toast.js';

class DebugLogger {
    constructor(scope = 'KittenNote') {
        this.scope = scope;
        this.phrases = [
            'I learnt that',
            'I noticed that',
            'I realized that',
            'I observed that',
            'I found that',
            'I sensed that',
            'I caught that',
            'I picked up that',
            'I can see that',
            'I can tell that',
            'I was glad that',
            'I was relieved that',
            'I was curious that',
            'I came to see that'
        ];
        this.overlay = null;
        this.overlayBody = null;
        this.overlayEnabled = false;
        this.maxEntries = 200;
        this.entries = [];
    }

    pickPhrase() {
        return this.phrases[Math.floor(Math.random() * this.phrases.length)];
    }

    setOverlayTarget(container, body) {
        this.overlay = container;
        this.overlayBody = body;
    }

    setOverlayEnabled(enabled) {
        this.overlayEnabled = enabled;
        if (this.overlay) {
            this.overlay.classList.toggle('hidden', !enabled);
        }
    }

    clearOverlay() {
        if (this.overlayBody) {
            this.overlayBody.innerHTML = '';
        }
        this.entries = [];
    }

    isAlreadySentence(message) {
        const trimmed = message.trim();
        if (!trimmed) return false;
        if (/^(I\s+(?:learn(?:t)?|notice(?:d)?|real(?:i|y)zed|observe(?:d)?|found|saw|heard|felt|picked up|caught|figured|suspected|confirmed|was)\b)/i.test(trimmed)) {
            return true;
        }
        if (/^[\u4e00-\u9fff]/.test(trimmed)) {
            return true;
        }
        return /^[A-Z]/.test(trimmed);
    }

    buildMessage(message) {
        const trimmed = String(message ?? '').trim();
        if (!trimmed) return '';
        if (this.isAlreadySentence(trimmed)) {
            return trimmed;
        }
        return `${this.pickPhrase()} ${trimmed}`;
    }

    appendOverlay(level, message, data) {
        if (!this.overlayEnabled || !this.overlayBody) return;

        const entryRecord = {
            time: new Date().toISOString(),
            level,
            message,
            data
        };
        this.entries.push(entryRecord);
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }

        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = new Date().toLocaleTimeString();

        const text = document.createElement('span');
        text.className = 'log-message';
        text.textContent = message;

        entry.appendChild(time);
        entry.appendChild(text);

        if (data !== undefined) {
            const dataEl = document.createElement('pre');
            dataEl.className = 'log-data';
            try {
                dataEl.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            } catch (error) {
                dataEl.textContent = String(data);
            }
            entry.appendChild(dataEl);
        }

        this.overlayBody.appendChild(entry);
        if (this.overlayBody.children.length > this.maxEntries) {
            this.overlayBody.removeChild(this.overlayBody.firstElementChild);
        }
        this.overlayBody.scrollTop = this.overlayBody.scrollHeight;
    }

    exportLogs() {
        const lines = this.entries.map((entry) => {
            const header = `[${entry.time}] [${entry.level.toUpperCase()}] ${entry.message}`;
            if (entry.data === undefined) return header;
            try {
                const payload = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
                return `${header}\n${payload}`;
            } catch (error) {
                return `${header}\n${String(entry.data)}`;
            }
        });
        return lines.join('\n\n');
    }

    info(message, data) {
        const text = this.buildMessage(message);
        if (data !== undefined) {
            console.log(`%c${this.scope}%c ${text}`, 'color:#4CAF50;font-weight:600', 'color:inherit', data);
        } else {
            console.log(`%c${this.scope}%c ${text}`, 'color:#4CAF50;font-weight:600', 'color:inherit');
        }
        this.appendOverlay('info', text, data);
    }

    warn(message, data) {
        const text = this.buildMessage(message);
        if (data !== undefined) {
            console.warn(`%c${this.scope}%c ${text}`, 'color:#FF9800;font-weight:600', 'color:inherit', data);
        } else {
            console.warn(`%c${this.scope}%c ${text}`, 'color:#FF9800;font-weight:600', 'color:inherit');
        }
        this.appendOverlay('warn', text, data);
    }

    error(message, data) {
        const text = this.buildMessage(message);
        if (data !== undefined) {
            console.error(`%c${this.scope}%c ${text}`, 'color:#F44336;font-weight:600', 'color:inherit', data);
        } else {
            console.error(`%c${this.scope}%c ${text}`, 'color:#F44336;font-weight:600', 'color:inherit');
        }
        this.appendOverlay('error', text, data);
    }
}

class KittenNoteApp {
    constructor() {
        this.db = null;
        this.directoryTree = null;
        this.textEditor = null;
        this.inkEditor = null;
        this.settingsManager = null;
        this.syncManager = null;
        this.nesManager = null;
        this.exportManager = null;
        this.logger = new DebugLogger();
        
        this.currentNote = null;
        this.currentNotebook = null;
        this.isModified = false;
        this.isSourceMode = false;
        this.pendingSessionRestore = null;
        this.sessionSaveTimer = null;
        this.autoSaveTimer = null;
        this.autoSaveDelay = 2000; // 2 seconds
        this.lastSaveTime = null;
        
        this.init();
    }
    
    async init() {
        try {
            // Register service worker
            await this.registerServiceWorker();
            
            // Initialize database
            this.db = new Database();
            await this.db.init();
            
            // Initialize components
            this.directoryTree = new DirectoryTree(this.db, this);
            this.textEditor = new TextEditor(this);
            this.inkEditor = new InkEditor(this);
            this.settingsManager = new SettingsManager(this);
            this.syncManager = new SyncManager(this.db, this);
            this.nesManager = new NESManager(this);
            this.exportManager = new ExportManager(this.db, this);

            this.setupLogOverlay();
            
            // Load settings and apply theme
            await this.settingsManager.loadSettings();
            
            // Auto-show log overlay if enabled in settings
            if (this.settingsManager?.settings?.logOverlayEnabled) {
                this.setLogOverlayEnabled(true, false);
            }
            
            // Render directory tree
            await this.directoryTree.render();

            // Restore last session
            await this.restoreLastSession();
            
            // Setup event listeners
            this.setupEventListeners();

            // Backup reminders
            this.checkBackupReminders();
            
            // Check for URL actions
            this.handleUrlActions();
            
            // Initialize complete
            this.logger.info('the app is ready and feeling cozy.');
            
        } catch (error) {
            this.logger.error('initialization stumbled.', error);
            Toast.show('应用初始化失败', 'error');
        }
    }
    
    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('./sw.js', {
                    scope: './'
                });
                console.log('Service Worker registered:', registration.scope);
                
                // Listen for SW updates
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    if (newWorker) {
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New version available
                                this.showUpdateNotification();
                            }
                        });
                    }
                });
                
                // Listen for messages from SW
                navigator.serviceWorker.addEventListener('message', (event) => {
                    if (event.data?.type === 'SW_UPDATE_AVAILABLE') {
                        this.showUpdateNotification();
                    }
                });
                
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        }
    }
    
    showUpdateNotification() {
        // Create update notification dialog
        const dialog = document.createElement('div');
        dialog.className = 'update-notification';
        dialog.innerHTML = `
            <div class="update-content">
                <i class="fa-solid fa-arrow-rotate-right"></i>
                <div class="update-text">
                    <strong>发现新版本</strong>
                    <span>刷新页面以使用最新功能</span>
                </div>
                <div class="update-actions">
                    <button class="btn-update-later">稍后</button>
                    <button class="btn-update-now">立即刷新</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        // Animate in
        requestAnimationFrame(() => {
            dialog.classList.add('visible');
        });
        
        // Handle buttons
        dialog.querySelector('.btn-update-later')?.addEventListener('click', () => {
            dialog.classList.remove('visible');
            setTimeout(() => dialog.remove(), 300);
        });
        
        dialog.querySelector('.btn-update-now')?.addEventListener('click', () => {
            // Tell SW to skip waiting and activate
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
            window.location.reload();
        });
    }

    checkBackupReminders() {
        const settings = this.settingsManager?.settings;
        if (!settings) return;

        const intervalDays = Math.max(1, parseInt(settings.backupIntervalDays || 3, 10));
        const now = Date.now();
        const lastBackupAt = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
        const lastReminderAt = settings.lastBackupReminderAt ? Date.parse(settings.lastBackupReminderAt) : 0;

        const daysSince = (timestamp) => {
            if (!timestamp) return Infinity;
            return (now - timestamp) / (1000 * 60 * 60 * 24);
        };

        if (!settings.backupReminderSeen) {
            settings.backupReminderSeen = true;
            settings.lastBackupReminderAt = new Date().toISOString();
            this.settingsManager?.saveSettings();
            this.showBackupReminder(true, intervalDays);
            return;
        }

        const needsReminder = daysSince(lastBackupAt) >= intervalDays && daysSince(lastReminderAt) >= intervalDays;
        if (needsReminder) {
            settings.lastBackupReminderAt = new Date().toISOString();
            this.settingsManager?.saveSettings();
            this.showBackupReminder(false, intervalDays);
        }
    }

    showBackupReminder(isFirst, intervalDays) {
        const dialog = document.createElement('div');
        dialog.className = 'backup-reminder';
        dialog.innerHTML = `
            <div class="backup-reminder-content">
                <i class="fas fa-box-archive"></i>
                <div class="backup-reminder-text">
                    <strong>${isFirst ? '第一次见面，先备份一下吧' : '该备份啦'}</strong>
                    <span>这是自由软件，无中心服务器。你可以在“设置 > 备份与恢复”调整提醒间隔（当前 ${intervalDays} 天）。</span>
                </div>
                <div class="backup-reminder-actions">
                    <button class="btn-backup-now">一键备份</button>
                    <button class="btn-backup-settings">打开设置</button>
                    <button class="btn-backup-later">稍后</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        requestAnimationFrame(() => dialog.classList.add('visible'));

        const closeDialog = () => {
            dialog.classList.remove('visible');
            setTimeout(() => dialog.remove(), 300);
        };

        dialog.querySelector('.btn-backup-now')?.addEventListener('click', async () => {
            await this.settingsManager?.exportBackupZip();
            closeDialog();
        });

        dialog.querySelector('.btn-backup-settings')?.addEventListener('click', () => {
            this.settingsManager?.showModal();
            this.settingsManager?.switchTab('backup');
            closeDialog();
        });

        dialog.querySelector('.btn-backup-later')?.addEventListener('click', () => {
            closeDialog();
        });
    }
    
    setupEventListeners() {
        // Sidebar toggle
        const toggleSidebar = document.getElementById('toggle-sidebar');
        const sidebar = document.getElementById('sidebar');
        
        toggleSidebar?.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            const icon = toggleSidebar.querySelector('i');
            icon.classList.toggle('fa-chevron-left');
            icon.classList.toggle('fa-chevron-right');
        });

        let wasMobile = window.innerWidth <= 768;

        const updateMobileSidebarState = () => {
            const isMobile = window.innerWidth <= 768;

            if (isMobile && !wasMobile) {
                if (!sidebar.classList.contains('collapsed')) {
                    sidebar.classList.add('collapsed');
                    sidebar.dataset.autoCollapsed = 'true';
                }
            }

            if (!isMobile && wasMobile) {
                if (sidebar.dataset.autoCollapsed === 'true') {
                    sidebar.classList.remove('collapsed');
                    delete sidebar.dataset.autoCollapsed;
                }
            }

            wasMobile = isMobile;
        };

        updateMobileSidebarState();
        window.addEventListener('resize', updateMobileSidebarState);
        
        // New folder button
        document.getElementById('new-folder')?.addEventListener('click', () => {
            this.createNewFolder();
        });
        
        // New notebook button
        document.getElementById('new-notebook')?.addEventListener('click', () => {
            this.createNewNotebook();
        });
        
        // Import files button
        document.getElementById('import-files')?.addEventListener('click', () => {
            this.showImportDialog();
        });
        
        // Quick new note buttons
        document.getElementById('quick-new-text')?.addEventListener('click', () => {
            this.createQuickNote('text');
        });
        
        document.getElementById('quick-new-ink')?.addEventListener('click', () => {
            this.createQuickNote('ink');
        });
        
        // Search
        const searchInput = document.getElementById('search-input');
        searchInput?.addEventListener('input', (e) => {
            this.directoryTree.filter(e.target.value);
        });
        
        // Settings button
        document.getElementById('settings-btn')?.addEventListener('click', () => {
            this.settingsManager.showModal();
        });
        
        // Sync button
        document.getElementById('sync-btn')?.addEventListener('click', () => {
            this.syncManager.showSyncDialog();
        });
        
        // Editor header buttons
        document.getElementById('undo-btn')?.addEventListener('click', () => this.undo());
        document.getElementById('redo-btn')?.addEventListener('click', () => this.redo());
        document.getElementById('save-btn')?.addEventListener('click', () => this.save());
        
        // Export dropdown
        this.setupExportDropdown();
        
        // Note title change
        const noteTitle = document.getElementById('note-title');
        noteTitle?.addEventListener('input', () => {
            this.isModified = true;
        });
        noteTitle?.addEventListener('blur', () => {
            if (this.currentNote) {
                this.updateNoteTitle(noteTitle.value);
            }
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcut(e));
        
        // Before unload warning
        window.addEventListener('beforeunload', (e) => {
            this.saveLastSession();
            if (this.isModified) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        
        // Context menu
        this.setupContextMenu();

        // Markdown source mode
        document.getElementById('md-source-back')?.addEventListener('click', () => {
            this.exitMarkdownSourceMode();
        });
        
        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', () => {
                const modal = overlay.closest('.modal');
                if (modal?.id === 'sync-dialog') {
                    this.syncManager?.closeWizard();
                    return;
                }
                modal?.classList.add('hidden');
            });
        });
        
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = btn.closest('.modal');
                if (modal?.id === 'sync-dialog') {
                    this.syncManager?.closeWizard();
                    return;
                }
                modal?.classList.add('hidden');
            });
        });

        // Save session on visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveLastSession();
            }
        });
    }

    setupLogOverlay() {
        const overlay = document.getElementById('log-overlay');
        const overlayBody = document.getElementById('log-overlay-body');
        const overlayClose = document.getElementById('log-overlay-close');
        const overlayClear = document.getElementById('log-overlay-clear');
        const overlayExport = document.getElementById('log-overlay-export');
        const overlayHeader = overlay?.querySelector('.log-overlay-header');

        if (overlay && overlayBody) {
            this.logger.setOverlayTarget(overlay, overlayBody);
        }

        overlayClose?.addEventListener('click', () => {
            this.setLogOverlayEnabled(false, true);
        });

        overlayClear?.addEventListener('click', () => {
            this.logger.clearOverlay();
        });

        overlayExport?.addEventListener('click', () => {
            const content = this.logger.exportLogs();
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kittennote-logs-${Date.now()}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        });

        if (overlay && overlayHeader) {
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let startLeft = 0;
            let startTop = 0;

            const onMove = (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                overlay.style.left = `${startLeft + dx}px`;
                overlay.style.top = `${startTop + dy}px`;
            };

            const onUp = (e) => {
                if (!isDragging) return;
                isDragging = false;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                if (e?.pointerId !== undefined) {
                    overlayHeader.releasePointerCapture?.(e.pointerId);
                }
            };

            overlayHeader.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.log-overlay-actions')) return;
                e.preventDefault();
                overlayHeader.setPointerCapture?.(e.pointerId);
                const rect = overlay.getBoundingClientRect();
                overlay.style.left = `${rect.left}px`;
                overlay.style.top = `${rect.top}px`;
                overlay.style.right = 'auto';
                overlay.style.bottom = 'auto';
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
        }
    }

    setLogOverlayEnabled(enabled, persist = false) {
        this.logger.setOverlayEnabled(enabled);
        if (persist) {
            this.settingsManager?.setLogOverlayEnabled(enabled);
        }
    }
    
    setupExportDropdown() {
        const exportBtn = document.getElementById('export-btn');
        const dropdown = document.getElementById('export-dropdown');
        
        exportBtn?.addEventListener('click', () => {
            dropdown?.classList.toggle('open');
        });
        
        dropdown?.querySelector('.dropdown-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });
        
        dropdown?.querySelectorAll('.dropdown-menu button').forEach(btn => {
            btn.addEventListener('click', () => {
                const format = btn.dataset.format;
                this.exportManager.export(this.currentNote, format);
                dropdown.classList.remove('open');
            });
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!dropdown?.contains(e.target) && e.target !== exportBtn) {
                dropdown?.classList.remove('open');
            }
        });
    }
    
    setupContextMenu() {
        const contextMenu = document.getElementById('context-menu');
        
        contextMenu?.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                this.handleContextMenuAction(action);
                contextMenu.classList.add('hidden');
            });
        });
        
        // Hide context menu on click outside
        document.addEventListener('click', () => {
            contextMenu?.classList.add('hidden');
        });
        
        // Prevent default context menu
        document.addEventListener('contextmenu', (e) => {
            const treeItem = e.target.closest('.tree-item-content, .page-item');
            if (treeItem) {
                e.preventDefault();
                this.showContextMenu(e, treeItem);
            }
        });
    }
    
    async showContextMenu(event, targetElement) {
        const contextMenu = document.getElementById('context-menu');
        if (!contextMenu) return;
        
        // Store target for action handling
        this.contextMenuTarget = targetElement;
        
        const itemType = targetElement.dataset.type;
        let noteType = null;
        if (itemType === 'note') {
            const note = await this.db.getNote(targetElement.dataset.id);
            noteType = note?.type || null;
        }
        
        // Show/hide menu items based on target type
        const notebookOnlyActions = ['notebook-settings', 'new-note', 'new-ink'];
        contextMenu.querySelectorAll('button[data-action]').forEach(btn => {
            const action = btn.dataset.action;
            if (notebookOnlyActions.includes(action)) {
                // Only show for notebooks, not folders or notes
                btn.style.display = itemType === 'notebook' ? '' : 'none';
                return;
            }
            if (action === 'auto-title') {
                btn.style.display = itemType === 'note' && noteType === 'text' ? '' : 'none';
            }
        });
        
        // Position menu
        contextMenu.style.left = `${event.clientX}px`;
        contextMenu.style.top = `${event.clientY}px`;
        contextMenu.classList.remove('hidden');
        
        // Adjust if menu goes off screen
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }
    
    async handleContextMenuAction(action) {
        const target = this.contextMenuTarget;
        if (!target) return;
        
        const itemId = target.dataset.id;
        const itemType = target.dataset.type;
        
        switch (action) {
            case 'rename':
                await this.showRenameDialog(itemId, itemType);
                break;
            case 'delete':
                this.showDeleteDialog(itemId, itemType);
                break;
            case 'new-note':
                await this.createNoteInNotebook(itemId, 'text');
                break;
            case 'new-ink':
                await this.createNoteInNotebook(itemId, 'ink');
                break;
            case 'notebook-settings':
                if (itemType === 'notebook') {
                    this.showNotebookSettings(itemId);
                }
                break;
            case 'export':
                if (itemType === 'folder') {
                    this.exportManager.exportFolder(itemId);
                } else if (itemType === 'notebook') {
                    this.exportManager.exportNotebook(itemId);
                } else if (itemType === 'note') {
                    const note = await this.db.getNote(itemId);
                    this.exportManager.export(note, note.type === 'ink' ? 'ktnt' : 'md');
                }
                break;
            case 'auto-title':
                if (itemType === 'note') {
                    await this.generateAutoTitle(itemId);
                }
                break;
        }
    }

    async generateAutoTitle(noteId) {
        const titleInput = document.getElementById('note-title');
        try {
            const note = await this.db.getNote(noteId);
            if (!note || note.type !== 'text') return;

            // Add rainbow animation during generation
            if (this.currentNote?.id === noteId && titleInput) {
                titleInput.classList.add('is-generating');
            }

            const content = (note.content || '').toString();
            const snippet = content.slice(0, 800);
            const title = await this.nesManager?.generateTitle(snippet);
            
            // Remove animation
            titleInput?.classList.remove('is-generating');
            
            if (!title) {
                Toast.show('AI 未返回标题', 'warning');
                return;
            }

            await this.db.updateNote(noteId, { title });
            if (this.currentNote?.id === noteId) {
                this.currentNote.title = title;
                document.getElementById('note-title').value = title;
            }
            await this.directoryTree.render();
            Toast.show('标题已更新', 'success');
        } catch (error) {
            // Remove animation on error
            titleInput?.classList.remove('is-generating');
            console.error('Auto title failed:', error);
            Toast.show('生成标题失败', 'error');
        }
    }
    
    async showRenameDialog(itemId, itemType) {
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        const confirmBtn = document.getElementById('rename-confirm');
        const cancelBtn = document.getElementById('rename-cancel');
        
        let currentName = '';
        try {
            if (itemType === 'folder') {
                const folder = await this.db.getFolder(itemId);
                currentName = folder?.name || '';
            } else if (itemType === 'notebook') {
                const notebook = await this.db.getNotebook(itemId);
                currentName = notebook?.name || '';
            } else if (itemType === 'note') {
                const note = await this.db.getNote(itemId);
                currentName = note?.title || '';
            }
        } catch (error) {
            console.warn('Failed to load current name:', error);
        }

        if (input) {
            input.value = currentName;
            input.focus();
            input.select();
        }

        dialog?.classList.remove('hidden');
        
        const handleConfirm = async () => {
            const newName = input.value.trim();
            if (newName) {
                await this.renameItem(itemId, itemType, newName);
            }
            dialog.classList.add('hidden');
            cleanup();
        };
        
        const handleCancel = () => {
            dialog.classList.add('hidden');
            cleanup();
        };
        
        const handleKeydown = (e) => {
            if (e.key === 'Enter') handleConfirm();
            if (e.key === 'Escape') handleCancel();
        };

        const cleanup = () => {
            confirmBtn?.removeEventListener('click', handleConfirm);
            cancelBtn?.removeEventListener('click', handleCancel);
            input?.removeEventListener('keydown', handleKeydown);
        };
        
        confirmBtn?.addEventListener('click', handleConfirm);
        cancelBtn?.addEventListener('click', handleCancel);

        // Enter/Escape
        input?.addEventListener('keydown', handleKeydown);
    }
    
    showDeleteDialog(itemId, itemType) {
        const dialog = document.getElementById('delete-dialog');
        const message = document.getElementById('delete-message');
        const confirmBtn = document.getElementById('delete-confirm');
        const cancelBtn = document.getElementById('delete-cancel');
        
        const typeNames = {
            folder: '文件夹',
            notebook: '笔记本',
            note: '笔记'
        };
        
        message.textContent = `确定要删除这个${typeNames[itemType]}吗？此操作无法撤销。`;
        dialog?.classList.remove('hidden');
        
        const handleConfirm = async () => {
            await this.deleteItem(itemId, itemType);
            dialog.classList.add('hidden');
            cleanup();
        };
        
        const handleCancel = () => {
            dialog.classList.add('hidden');
            cleanup();
        };
        
        const cleanup = () => {
            confirmBtn?.removeEventListener('click', handleConfirm);
            cancelBtn?.removeEventListener('click', handleCancel);
        };
        
        confirmBtn?.addEventListener('click', handleConfirm);
        cancelBtn?.addEventListener('click', handleCancel);
    }
    
    async renameItem(itemId, itemType, newName) {
        try {
            switch (itemType) {
                case 'folder':
                    await this.db.updateFolder(itemId, { name: newName });
                    break;
                case 'notebook':
                    await this.db.updateNotebook(itemId, { name: newName });
                    break;
                case 'note':
                    await this.db.updateNote(itemId, { title: newName });
                    if (this.currentNote?.id === itemId) {
                        document.getElementById('note-title').value = newName;
                    }
                    break;
            }
            await this.directoryTree.render();
            Toast.show('重命名成功', 'success');
        } catch (error) {
            console.error('Rename failed:', error);
            Toast.show('重命名失败', 'error');
        }
    }
    
    async deleteItem(itemId, itemType) {
        try {
            // Check if current note is affected before deletion
            let shouldCloseEditor = false;
            if (this.currentNote) {
                if (itemType === 'note' && this.currentNote.id === itemId) {
                    shouldCloseEditor = true;
                } else if (itemType === 'notebook' && this.currentNote.notebookId === itemId) {
                    shouldCloseEditor = true;
                } else if (itemType === 'folder') {
                    // Check if current note's notebook is inside this folder
                    const notebook = await this.db.getNotebook(this.currentNote.notebookId);
                    if (notebook?.folderId === itemId) {
                        shouldCloseEditor = true;
                    }
                }
            }
            
            switch (itemType) {
                case 'folder':
                    await this.db.deleteFolder(itemId);
                    break;
                case 'notebook':
                    await this.db.deleteNotebook(itemId);
                    break;
                case 'note':
                    await this.db.deleteNote(itemId);
                    break;
            }
            
            if (shouldCloseEditor) {
                this.closeNote();
            }
            
            await this.directoryTree.render();
            Toast.show('删除成功', 'success');
        } catch (error) {
            console.error('Delete failed:', error);
            Toast.show('删除失败', 'error');
        }
    }
    
    handleKeyboardShortcut(e) {
        // Global shortcuts
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    this.save();
                    break;
                case 'z':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.redo();
                    } else {
                        this.undo();
                    }
                    break;
                case 'y':
                    e.preventDefault();
                    this.redo();
                    break;
            }
        }
        
        // Ink editor shortcuts (when not in text input)
        if (this.currentNote?.type === 'ink' && !e.target.matches('input, textarea, [contenteditable]')) {
            switch (e.key.toLowerCase()) {
                case 'b':
                    this.inkEditor.setTool('pen');
                    break;
                case 'h':
                    this.inkEditor.setTool('highlighter');
                    break;
                case 'e':
                    this.inkEditor.setTool('eraser');
                    break;
                case 'v':
                    this.inkEditor.setTool('select');
                    break;
                case 'l':
                    this.inkEditor.setTool('line');
                    break;
                case 'r':
                    this.inkEditor.setTool('rectangle');
                    break;
                case 'c':
                    this.inkEditor.setTool('circle');
                    break;
                case 'a':
                    this.inkEditor.setTool('arrow');
                    break;
            }
        }
    }
    
    handleUrlActions() {
        const params = new URLSearchParams(window.location.search);
        const action = params.get('action');
        
        if (action === 'new-text') {
            this.createQuickNote('text');
        } else if (action === 'new-ink') {
            this.createQuickNote('ink');
        }
    }
    
    async createNewFolder() {
        const name = '新建文件夹';
        try {
            await this.db.createFolder({
                name,
                parentId: null,
                order: Date.now()
            });
            await this.directoryTree.render();
            Toast.show('文件夹已创建', 'success');
        } catch (error) {
            console.error('Failed to create folder:', error);
            Toast.show('创建文件夹失败', 'error');
        }
    }
    
    async createNewNotebook() {
        const name = '新建笔记本';
        try {
            const notebook = await this.db.createNotebook({
                name,
                folderId: null,
                order: Date.now()
            });
            await this.directoryTree.render();
            Toast.show('笔记本已创建', 'success');
            
            // Create initial text and ink notes
            await this.createNoteInNotebook(notebook.id, 'text', false);
            await this.createNoteInNotebook(notebook.id, 'ink', true);
        } catch (error) {
            console.error('Failed to create notebook:', error);
            Toast.show('创建笔记本失败', 'error');
        }
    }
    
    async createNoteInNotebook(notebookId, type, openNote = true) {
        const title = type === 'text' ? '新建文字笔记' : '新建墨迹笔记';
        try {
            const note = await this.db.createNote({
                title,
                type,
                content: type === 'text' ? '' : { version: 1, strokes: [] },
                notebookId,
                order: Date.now()
            });
            await this.directoryTree.render();
            if (openNote) {
                await this.openNote(note.id);
            }
            Toast.show('笔记已创建', 'success');
        } catch (error) {
            console.error('Failed to create note:', error);
            Toast.show('创建笔记失败', 'error');
        }
    }
    
    async createQuickNote(type) {
        // Create default notebook if none exists
        let notebooks = await this.db.getAllNotebooks();
        let notebook;
        
        if (notebooks.length === 0) {
            notebook = await this.db.createNotebook({
                name: '我的笔记本',
                folderId: null,
                order: Date.now()
            });
        } else {
            notebook = notebooks[0];
        }
        
        await this.createNoteInNotebook(notebook.id, type);
        await this.directoryTree.render();
    }
    
    async showImportDialog() {
        const dialog = document.getElementById('import-dialog');
        const fileInput = document.getElementById('import-file-input');
        const selectFilesBtn = document.getElementById('import-select-files');
        const fileList = document.getElementById('import-file-list');
        const notebookSelect = document.getElementById('import-target-notebook');
        const confirmBtn = document.getElementById('import-confirm');
        const cancelBtn = document.getElementById('import-cancel');
        const closeBtn = dialog?.querySelector('.modal-close');
        
        // Reset state
        this.importFiles = [];
        fileList.innerHTML = '';
        fileInput.value = '';
        confirmBtn.disabled = true;
        
        // Populate notebook options
        const notebooks = await this.db.getAllNotebooks();
        notebookSelect.innerHTML = '<option value="">-- 请选择 --</option>';
        notebooks.forEach(nb => {
            const opt = document.createElement('option');
            opt.value = nb.id;
            opt.textContent = nb.name;
            notebookSelect.appendChild(opt);
        });
        
        const updateConfirmState = () => {
            const allZip = this.importFiles.length > 0 && this.importFiles.every(file => file.name.endsWith('.zip'));
            confirmBtn.disabled = this.importFiles.length === 0 || (!notebookSelect.value && !allZip);
        };
        
        const renderFileList = () => {
            fileList.innerHTML = '';
            this.importFiles.forEach((file, idx) => {
                const isZip = file.name.endsWith('.zip');
                const item = document.createElement('div');
                item.className = 'import-file-item';
                item.innerHTML = `
                    <i class="fas ${isZip ? 'fa-box-archive' : (file.name.endsWith('.ktnt') ? 'fa-pen-fancy' : 'fa-file-alt')}"></i>
                    <span class="file-name">${file.name}</span>
                    <button class="remove-file" data-idx="${idx}"><i class="fas fa-times"></i></button>
                `;
                fileList.appendChild(item);
            });
            updateConfirmState();
        };
        
        // File selection
        selectFilesBtn.onclick = () => fileInput.click();
        fileInput.onchange = () => {
            if (fileInput.files) {
                this.importFiles = [...this.importFiles, ...Array.from(fileInput.files)];
                renderFileList();
            }
        };
        
        // Remove file
        fileList.onclick = (e) => {
            const removeBtn = e.target.closest('.remove-file');
            if (removeBtn) {
                const idx = parseInt(removeBtn.dataset.idx);
                this.importFiles.splice(idx, 1);
                renderFileList();
            }
        };
        
        // Notebook selection change
        notebookSelect.onchange = updateConfirmState;
        
        const closeDialog = () => {
            dialog.classList.add('hidden');
            this.importFiles = [];
        };
        
        // Confirm import
        confirmBtn.onclick = async () => {
            const notebookId = notebookSelect.value;
            if (this.importFiles.length === 0) return;
            
            let successCount = 0;
            let appliedPageStyle = false;
            for (const file of this.importFiles) {
                try {
                    if (file.name.endsWith('.zip')) {
                        const importedCount = await this.importNotebookZip(file);
                        successCount += importedCount;
                        continue;
                    }
                    if (!notebookId) {
                        Toast.show('请选择目标笔记本', 'warning');
                        break;
                    }
                    const content = await this.readFileContent(file);
                    const isKtnt = file.name.endsWith('.ktnt');
                    const title = file.name.replace(/\.(md|ktnt)$/i, '');
                    
                    let noteContent = content;
                    if (isKtnt) {
                        const parsed = JSON.parse(content);
                        noteContent = parsed?.content || parsed;
                        if (!appliedPageStyle && parsed?.pageStyle && notebookId) {
                            await this.db.updateNotebook(notebookId, { pageStyle: parsed.pageStyle });
                            if (this.currentNotebook?.id === notebookId) {
                                this.currentNotebook.pageStyle = parsed.pageStyle;
                                this.applyNotebookStyle(this.currentNotebook);
                            }
                            appliedPageStyle = true;
                        }
                    }

                    await this.db.createNote({
                        title,
                        type: isKtnt ? 'ink' : 'text',
                        content: noteContent,
                        notebookId,
                        order: Date.now()
                    });
                    successCount++;
                } catch (error) {
                    console.error('Failed to import file:', file.name, error);
                    Toast.show(`导入 ${file.name} 失败`, 'error');
                }
            }
            
            if (successCount > 0) {
                Toast.show(`成功导入 ${successCount} 个文件`, 'success');
                await this.directoryTree.render();
            }
            closeDialog();
        };
        
        // Cancel and close
        cancelBtn.onclick = closeDialog;
        closeBtn.onclick = closeDialog;
        
        dialog.classList.remove('hidden');
    }
    
    readFileContent(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    readFileBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
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

    async importNotebookZip(file) {
        const buffer = await this.readFileBuffer(file);
        const entries = this.parseZip(buffer);
        const metaBytes = entries['notebook.json'];
        if (!metaBytes) {
            throw new Error('未找到 notebook.json');
        }

        const decoder = new TextDecoder();
        const metadata = JSON.parse(decoder.decode(metaBytes));
        const pageStyle = metadata.pageStyle || { pattern: 'blank', color: '#ffffff' };

        const notebook = await this.db.createNotebook({
            name: metadata.name || file.name.replace(/\.zip$/i, ''),
            folderId: null,
            order: Date.now(),
            pageStyle
        });

        let importedCount = 0;
        for (const note of metadata.notes || []) {
            const entry = entries[note.filename];
            if (!entry) continue;
            const text = decoder.decode(entry);
            let content = text;
            if (note.type === 'ink') {
                const parsed = JSON.parse(text);
                content = parsed?.content || parsed;
            }

            await this.db.createNote({
                title: note.title || '未命名',
                type: note.type || 'text',
                content,
                notebookId: notebook.id,
                order: Date.now()
            });
            importedCount++;
        }

        return importedCount;
    }
    
    async openNote(noteId) {
        // Save current note if modified
        if (this.isModified && this.currentNote) {
            await this.save();
        }
        
        try {
            const note = await this.db.getNote(noteId);
            if (!note) {
                Toast.show('笔记不存在', 'error');
                return;
            }
            
            this.currentNote = note;
            this.currentNotebook = await this.db.getNotebook(note.notebookId);
            this.isModified = false;
            this.isSourceMode = false;
            
            // Clear auto-save timers
            if (this.autoSaveTimer) {
                clearTimeout(this.autoSaveTimer);
                this.autoSaveTimer = null;
            }
            
            // Update UI
            document.getElementById('welcome-screen')?.classList.add('hidden');
            document.getElementById('editor-container')?.classList.remove('hidden');
            document.getElementById('note-title').value = note.title;
            document.getElementById('note-type-badge').textContent = 
                note.type === 'text' ? '文字' : '墨迹';
            
            // Initialize save status
            this.updateSaveStatus('saved');
            
            // Show appropriate editor
            if (note.type === 'text') {
                document.getElementById('text-toolbar')?.classList.remove('hidden');
                document.getElementById('ink-toolbar')?.classList.add('hidden');
                document.getElementById('text-editor')?.classList.remove('hidden');
                document.getElementById('ink-editor')?.classList.add('hidden');
                document.getElementById('md-source-editor')?.classList.add('hidden');
                document.getElementById('md-source-back')?.classList.add('hidden');
                this.textEditor.loadContent(note.content);
                this.applyNotebookStyle(this.currentNotebook);
            } else {
                document.getElementById('text-toolbar')?.classList.add('hidden');
                document.getElementById('ink-toolbar')?.classList.remove('hidden');
                document.getElementById('text-editor')?.classList.add('hidden');
                document.getElementById('ink-editor')?.classList.remove('hidden');
                document.getElementById('md-source-editor')?.classList.add('hidden');
                document.getElementById('md-source-back')?.classList.add('hidden');
                this.inkEditor.loadContent(note.content);
                this.applyNotebookStyle(this.currentNotebook);
            }
            
            // Update tree selection
            this.directoryTree.selectNote(noteId);

            // Restore session state (cursor/scroll/viewport)
            if (this.pendingSessionRestore?.noteId === noteId) {
                this.restoreSessionState(this.pendingSessionRestore);
                this.pendingSessionRestore = null;
            }

            this.logger.info('we are now looking at this note.', { id: noteId, type: note.type });

            // Fix focus/layout issues
            requestAnimationFrame(() => {
                if (note.type === 'text') {
                    this.textEditor.focusAtEnd();
                } else {
                    this.inkEditor.refreshLayout();
                }
            });
            
        } catch (error) {
            console.error('Failed to open note:', error);
            Toast.show('打开笔记失败', 'error');
        }
    }
    
    closeNote() {
        this.currentNote = null;
        this.currentNotebook = null;
        this.isModified = false;
        
        document.getElementById('welcome-screen')?.classList.remove('hidden');
        document.getElementById('editor-container')?.classList.add('hidden');
        
        this.directoryTree.clearSelection();
    }
    
    async save(isAutoSave = false) {
        if (!this.currentNote) return;
        
        try {
            const title = document.getElementById('note-title').value;
            const content = this.currentNote.type === 'text' 
                ? (this.isSourceMode ? this.textEditor.getSourceValue() : this.textEditor.getContent())
                : this.inkEditor.getContent();
            
            await this.db.updateNote(this.currentNote.id, {
                title,
                content,
                updatedAt: new Date().toISOString()
            });
            
            this.currentNote.title = title;
            this.currentNote.content = content;
            this.isModified = false;
            
            // Add to sync log
            await this.syncManager.logChange('update', this.currentNote.id);
            
            this.updateSaveStatus('saved');
            
            if (!isAutoSave) {
                Toast.show('保存成功', 'success');
            }
            this.logger.info('the note feels safely saved.');
        } catch (error) {
            console.error('Save failed:', error);
            this.updateSaveStatus('未保存');
            Toast.show('保存失败', 'error');
        }
    }
    
    async updateNoteTitle(title) {
        if (!this.currentNote) return;
        
        try {
            await this.db.updateNote(this.currentNote.id, { title });
            this.currentNote.title = title;
            await this.directoryTree.render();
        } catch (error) {
            console.error('Failed to update title:', error);
        }
    }
    
    undo() {
        if (this.currentNote?.type === 'text') {
            this.textEditor.undo();
        } else if (this.currentNote?.type === 'ink') {
            this.inkEditor.undo();
        }
    }
    
    redo() {
        if (this.currentNote?.type === 'text') {
            this.textEditor.redo();
        } else if (this.currentNote?.type === 'ink') {
            this.inkEditor.redo();
        }
    }
    
    markModified() {
        this.isModified = true;
        this.scheduleSessionSave();
        this.scheduleAutoSave();
        this.updateSaveStatus('未保存');
    }

    scheduleAutoSave() {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }
        this.autoSaveTimer = setTimeout(() => {
            this.autoSave();
        }, this.autoSaveDelay);
    }

    async autoSave() {
        if (!this.currentNote || !this.isModified) return;
        
        this.updateSaveStatus('保存中...');
        await this.save(true); // true = auto save, don't show toast
    }

    updateSaveStatus(status) {
        const saveStatus = document.getElementById('save-status');
        if (!saveStatus) return;
        
        if (status === '未保存') {
            saveStatus.textContent = '● 未保存';
            saveStatus.className = 'save-status unsaved';
        } else if (status === '保存中...') {
            saveStatus.textContent = '○ 保存中...';
            saveStatus.className = 'save-status saving';
        } else if (status === 'saved') {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            saveStatus.textContent = `✓ 已保存 ${timeStr}`;
            saveStatus.className = 'save-status saved';
            this.lastSaveTime = now;
        }
    }

    scheduleSessionSave() {
        if (this.sessionSaveTimer) {
            clearTimeout(this.sessionSaveTimer);
        }
        this.sessionSaveTimer = setTimeout(() => this.saveLastSession(), 600);
    }

    async saveLastSession() {
        if (!this.currentNote) return;

        const session = {
            noteId: this.currentNote.id,
            type: this.currentNote.type,
            updatedAt: Date.now()
        };

        if (this.currentNote.type === 'text') {
            session.text = {
                scrollTop: this.textEditor.getScrollTop(),
                cursorOffset: this.textEditor.getCursorOffset(),
                fontSize: this.textEditor.getFontSize()
            };
        } else {
            session.ink = this.inkEditor.getViewportState();
        }

        try {
            await this.db.setSetting('lastSession', session);
        } catch (error) {
            console.warn('Failed to save session:', error);
        }
    }

    async restoreLastSession() {
        try {
            const session = await this.db.getSetting('lastSession');
            if (session?.noteId) {
                this.pendingSessionRestore = session;
                await this.openNote(session.noteId);
                this.logger.info('the last note was found and reopened.');
            }
        } catch (error) {
            console.warn('Failed to restore session:', error);
        }
    }

    restoreSessionState(session) {
        if (!session || !this.currentNote || session.noteId !== this.currentNote.id) return;

        if (this.currentNote.type === 'text' && session.text) {
            if (typeof session.text.fontSize === 'number') {
                this.textEditor.setFontSize(session.text.fontSize);
            }
            if (typeof session.text.scrollTop === 'number') {
                this.textEditor.setScrollTop(session.text.scrollTop);
            }
            if (typeof session.text.cursorOffset === 'number') {
                this.textEditor.setCursorOffset(session.text.cursorOffset);
            }
        } else if (this.currentNote.type === 'ink' && session.ink) {
            this.inkEditor.setViewportState(session.ink);
        }
    }

    enterMarkdownSourceMode() {
        if (!this.currentNote || this.currentNote.type !== 'text') return;
        this.isSourceMode = true;

        const sourceEditor = document.getElementById('md-source-editor');
        const textEditor = document.getElementById('text-editor');
        const backBtn = document.getElementById('md-source-back');

        this.textEditor.setSourceValue(this.textEditor.getContent());

        textEditor?.classList.add('hidden');
        sourceEditor?.classList.remove('hidden');
        backBtn?.classList.remove('hidden');

        this.textEditor.focusSource();
    }

    exitMarkdownSourceMode() {
        if (!this.currentNote || this.currentNote.type !== 'text') return;
        this.isSourceMode = false;

        const sourceEditor = document.getElementById('md-source-editor');
        const textEditor = document.getElementById('text-editor');
        const backBtn = document.getElementById('md-source-back');

        const markdown = this.textEditor.getSourceValue();
        this.textEditor.loadContent(markdown);
        this.markModified();

        sourceEditor?.classList.add('hidden');
        textEditor?.classList.remove('hidden');
        backBtn?.classList.add('hidden');

        this.textEditor.focusAtEnd();
    }

    applyNotebookStyle(notebook) {
        const style = notebook?.pageStyle || {
            pattern: 'blank',
            color: '#ffffff'
        };
        this.textEditor?.setPageStyle(style);
        this.inkEditor?.setPageStyle(style);
    }

    showNotebookSettings(notebookId) {
        const modal = document.getElementById('notebook-settings-modal');
        const applyBtn = document.getElementById('notebook-settings-apply');
        const cancelBtn = document.getElementById('notebook-settings-cancel');
        const colorInput = document.getElementById('notebook-bg-color');
        const patternSelect = document.getElementById('notebook-pattern');

        if (!modal) return;

        this.currentNotebookSettingsTarget = notebookId;

        this.db.getNotebook(notebookId).then((notebook) => {
            const style = notebook?.pageStyle || { pattern: 'blank', color: '#ffffff' };
            modal.dataset.pattern = style.pattern;
            modal.dataset.color = style.color;
            if (colorInput) colorInput.value = style.color;

            if (patternSelect) patternSelect.value = style.pattern;
            modal.querySelectorAll('[data-bg-color]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.bgColor === style.color);
            });
        });

        if (patternSelect) {
            patternSelect.onchange = () => {
                modal.dataset.pattern = patternSelect.value;
            };
        }

        modal.querySelectorAll('[data-bg-color]').forEach(btn => {
            btn.onclick = () => {
                modal.dataset.color = btn.dataset.bgColor;
                if (colorInput) colorInput.value = btn.dataset.bgColor;
                modal.querySelectorAll('[data-bg-color]').forEach(b => b.classList.toggle('active', b === btn));
            };
        });

        if (colorInput) {
            colorInput.oninput = () => {
                modal.dataset.color = colorInput.value;
                modal.querySelectorAll('[data-bg-color]').forEach(b => b.classList.remove('active'));
            };
        }

        if (applyBtn) applyBtn.onclick = async () => {
            const pattern = modal.dataset.pattern || patternSelect?.value || 'blank';
            const color = modal.dataset.color || '#ffffff';
            await this.db.updateNotebook(this.currentNotebookSettingsTarget, {
                pageStyle: { pattern, color }
            });

            if (this.currentNotebook?.id === this.currentNotebookSettingsTarget) {
                this.currentNotebook.pageStyle = { pattern, color };
                this.applyNotebookStyle(this.currentNotebook);
            }

            modal.classList.add('hidden');
        };

        if (cancelBtn) cancelBtn.onclick = () => {
            modal.classList.add('hidden');
        };

        modal.classList.remove('hidden');
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.kittenNote = new KittenNoteApp();
});
