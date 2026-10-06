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
 * KittenNote - LaTeX editor (source + live preview)
 *
 * Split-pane editor for `textMode: 'latex'` notes:
 *   • monospace source pane with editing shortcuts (Ctrl+B/I, Tab, Ctrl+S)
 *   • live MathJax SVG preview with error surfacing
 *   • snippet toolbar (\frac, \ce, \qty, matrices, cases …)
 *   • per-note macro preamble (\newcommand …), collapsible
 *   • view cycling: split / source only / preview only (persisted)
 */

import { Toast } from './toast.js';
import { renderLatexPreview, ensureMathJax } from './latex.js';

const VIEW_KEY = 'kittennote.latexViewMode';

export class LatexEditor {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('latex-editor');
        this.source = document.getElementById('latex-source');
        this.preview = document.getElementById('latex-preview');
        this.macrosInput = document.getElementById('latex-macros-input');
        this.macrosPanel = document.getElementById('latex-macros-panel');
        this.statusEl = document.getElementById('latex-status');
        this.debounceTimer = null;
        this.renderToken = 0;
        this.loadedNoteId = null;
        this.previewRequested = false;
        this.init();
    }

    init() {
        if (!this.container) return;

        this.source?.addEventListener('input', () => {
            this.app.markModified();
            this.schedulePreview();
        });
        this.source?.addEventListener('keydown', (event) => this.handleKeydown(event));
        this.macrosInput?.addEventListener('input', () => {
            this.app.markModified();
            this.schedulePreview();
        });

        document.querySelectorAll('#latex-toolbar [data-latex-snippet]').forEach((button) => {
            button.addEventListener('click', () => this.insertSnippet(button.dataset.latexSnippet));
        });

        document.getElementById('latex-macros-toggle')?.addEventListener('click', () => {
            this.macrosPanel?.classList.toggle('hidden');
            this.macrosInput?.focus();
        });

        document.getElementById('latex-view-toggle')?.addEventListener('click', () => this.cycleView());

        const storedView = localStorage.getItem(VIEW_KEY);
        if (storedView) this.setViewMode(storedView);
    }

    setViewMode(mode) {
        if (!this.container) return;
        const normalized = ['split', 'source', 'preview'].includes(mode) ? mode : 'split';
        this.container.classList.remove('view-split', 'view-source', 'view-preview');
        this.container.classList.add(`view-${normalized}`);
        try {
            localStorage.setItem(VIEW_KEY, normalized);
        } catch {
            // private mode – ignore
        }
        const labels = { split: '双栏', source: '仅源码', preview: '仅预览' };
        const button = document.getElementById('latex-view-toggle');
        if (button) button.title = `当前：${labels[normalized]}（点击切换）`;
        if (normalized !== 'source') this.schedulePreview(50);
    }

    cycleView() {
        const order = ['split', 'source', 'preview'];
        const current = order.find((mode) => this.container?.classList.contains(`view-${mode}`)) || 'split';
        this.setViewMode(order[(order.indexOf(current) + 1) % order.length]);
    }

    handleKeydown(event) {
        if (event.key === 'Tab') {
            event.preventDefault();
            this.insertAtCursor('  ');
            return;
        }
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return;

        const key = event.key.toLowerCase();
        if (!event.shiftKey && !event.altKey && key === 'b') {
            event.preventDefault();
            this.wrapSelection('\\textbf{', '}', '文本');
        } else if (!event.shiftKey && !event.altKey && key === 'i') {
            event.preventDefault();
            this.wrapSelection('\\emph{', '}', '文本');
        } else if (key === 's') {
            event.preventDefault();
            this.app.save();
        } else if (key === 'enter') {
            event.preventDefault();
            this.schedulePreview(0);
        }
    }

    insertSnippet(snippet) {
        if (!snippet) return;
        this.insertAtCursor(snippet);
    }

    insertAtCursor(text) {
        if (!this.source) return;
        const start = this.source.selectionStart ?? this.source.value.length;
        const end = this.source.selectionEnd ?? start;
        this.source.setRangeText(text, start, end, 'end');
        this.source.dispatchEvent(new Event('input', { bubbles: true }));
        this.source.focus();
    }

    wrapSelection(before, after, placeholder = '') {
        if (!this.source) return;
        const start = this.source.selectionStart ?? 0;
        const end = this.source.selectionEnd ?? 0;
        const selected = this.source.value.slice(start, end);
        const inner = selected || placeholder;
        const inserted = `${before}${inner}${after}`;
        this.source.setRangeText(inserted, start, end, 'end');
        if (!selected && placeholder) {
            this.source.selectionStart = start + before.length;
            this.source.selectionEnd = start + before.length + placeholder.length;
        }
        this.source.dispatchEvent(new Event('input', { bubbles: true }));
        this.source.focus();
    }

    /** Load a LaTeX note into the editor. */
    load(note) {
        if (!this.container) return;
        this.loadedNoteId = note.id;
        if (this.source) this.source.value = note.content || '';
        if (this.macrosInput) this.macrosInput.value = note.latexMacros || '';
        this.schedulePreview(0);
    }

    getContent() {
        return this.source?.value ?? '';
    }

    getMacros() {
        return this.macrosInput?.value ?? '';
    }

    isFocused() {
        return document.activeElement === this.source || document.activeElement === this.macrosInput;
    }

    focus() {
        this.source?.focus();
    }

    schedulePreview(delay = 350) {
        if (this.container?.classList.contains('view-source')) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.renderPreview(), delay);
    }

    async renderPreview() {
        const token = ++this.renderToken;
        if (this.statusEl) {
            this.statusEl.textContent = '渲染中…';
            this.statusEl.classList.remove('has-error');
        }

        try {
            await ensureMathJax();
            const { errors } = await renderLatexPreview(this.preview, this.getContent(), this.getMacros());
            if (token !== this.renderToken) return;

            if (this.statusEl) {
                if (errors.length) {
                    this.statusEl.textContent = `⚠ ${errors.length} 处公式错误`;
                    this.statusEl.classList.add('has-error');
                    this.statusEl.title = errors.slice(0, 3).join('\n');
                } else {
                    this.statusEl.textContent = '✓ 渲染正常';
                    this.statusEl.classList.remove('has-error');
                    this.statusEl.removeAttribute('title');
                }
            }
        } catch (error) {
            if (token !== this.renderToken) return;
            if (this.statusEl) {
                this.statusEl.textContent = '⚠ ' + (error?.message || '渲染失败');
                this.statusEl.classList.add('has-error');
            }
            console.warn('LaTeX preview failed:', error);
        }
    }
}
