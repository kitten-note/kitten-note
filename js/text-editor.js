/**
 * KittenNote - Text Editor
 * Rich text editor with Markdown storage
 */
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
 * KittenNote - Text Editor
 * Rich text editor with Markdown support
 */
import { Toast } from './toast.js';

export class TextEditor {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('text-editor');
        this.contentElement = document.getElementById('text-content');
        this.suggestionElement = document.getElementById('nes-suggestion');
        this.inlineSuggestionEl = null;
        this.sourceContainer = document.getElementById('md-source-editor');
        this.sourceTextarea = document.getElementById('md-source-textarea');
        this.fontSizeIndicator = document.getElementById('text-font-size');
        
        this.content = '';
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSize = 50;
        this.lastSaveState = '';

        this.fontSize = 16;
        this.pointerMap = new Map();
        this.isPinching = false;
        this.pinchStartDistance = 0;
        this.pinchStartFontSize = 16;
        this.pageStyle = { pattern: 'blank', color: '#ffffff' };
        
        this.init();
    }
    
    init() {
        if (!this.contentElement) return;
        
        // Setup content editable handlers
        this.contentElement.addEventListener('input', () => this.handleInput());
        this.contentElement.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.contentElement.addEventListener('paste', (e) => this.handlePaste(e));
        this.contentElement.addEventListener('focus', () => this.handleFocus());
        this.contentElement.addEventListener('blur', () => this.handleBlur());
        this.contentElement.addEventListener('contextmenu', (e) => this.showEditorContextMenu(e));
        this.contentElement.addEventListener('scroll', () => this.app.scheduleSessionSave?.());
        document.addEventListener('selectionchange', () => {
            if (document.activeElement === this.contentElement) {
                this.app.scheduleSessionSave?.();
            }
        });
        this.contentElement.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
        this.contentElement.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        this.contentElement.addEventListener('pointerup', (e) => this.handlePointerUp(e));
        this.contentElement.addEventListener('pointercancel', (e) => this.handlePointerUp(e));

        this.sourceTextarea?.addEventListener('input', () => {
            this.app.markModified();
        });
        
        // Setup toolbar buttons
        this.setupToolbar();

        // Editor context menu actions
        this.setupEditorContextMenu();
    }
    
    setupToolbar() {
        document.getElementById('bold-btn')?.addEventListener('click', () => this.toggleBold());
        document.getElementById('italic-btn')?.addEventListener('click', () => this.toggleItalic());
        document.getElementById('underline-btn')?.addEventListener('click', () => this.toggleUnderline());
        document.getElementById('heading-btn')?.addEventListener('click', () => this.insertHeading());
        document.getElementById('list-btn')?.addEventListener('click', () => this.insertList());
        document.getElementById('quote-btn')?.addEventListener('click', () => this.insertQuote());

        // NES toggle
        const nesToggle = document.getElementById('nes-toggle');
        nesToggle?.addEventListener('change', () => {
            if (nesToggle.checked) {
                // Check if NES is properly configured
                const nesManager = this.app.nesManager;
                const settings = this.app.settingsManager?.settings;
                if (settings?.nesMode === 'api') {
                    // API mode requires URL and Key
                    if (!settings.nesApiUrl || !settings.nesApiKey) {
                        nesToggle.checked = false;
                        Toast.warning('请先在设置中配置 NES API 地址和密钥');
                        return;
                    }
                }
                nesManager?.enable();
            } else {
                this.app.nesManager?.disable();
            }
        });
    }
    
    loadContent(content) {
        this.content = content || '';
        this.undoStack = [];
        this.redoStack = [];
        this.lastSaveState = this.content;
        
        // Convert markdown to HTML for display
        this.renderContent();
        this.setFontSize(this.fontSize);
        this.applyPageStyle();
    }
    
    renderContent() {
        if (!this.contentElement) return;
        
        // Parse markdown and render as HTML
        const html = this.markdownToHtml(this.content);
        this.contentElement.innerHTML = html || '<p><br></p>';
        
        // Move cursor to end
        this.moveCursorToEnd();
    }
    
    getContent() {
        // Convert current HTML back to markdown
        return this.htmlToMarkdown(this.contentElement.innerHTML);
    }
    
    handleInput() {
        // Save state for undo
        this.saveUndoState();
        
        // Mark as modified
        this.app.markModified();

        // Clear stale suggestion when content changes
        this.app.nesManager?.dismissSuggestion();
        
        // Trigger NES suggestion if enabled
        this.app.nesManager?.scheduleInference();
    }
    
    handleKeydown(e) {
        // Handle keyboard shortcuts
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'b':
                    e.preventDefault();
                    this.toggleBold();
                    break;
                case 'i':
                    e.preventDefault();
                    this.toggleItalic();
                    break;
                case 'u':
                    e.preventDefault();
                    this.toggleUnderline();
                    break;
            }
        }
        
        // Tab to accept NES suggestion
        if (e.key === 'Tab' && this.app.nesManager?.hasSuggestion()) {
            e.preventDefault();
            this.app.nesManager.acceptSuggestion();
        }
        
        // Escape to dismiss suggestion
        if (e.key === 'Escape') {
            this.app.nesManager?.dismissSuggestion();
        }
    }
    
    handlePaste(e) {
        e.preventDefault();
        
        // Get plain text from clipboard
        const text = e.clipboardData.getData('text/plain');
        
        // Insert at cursor position
        document.execCommand('insertText', false, text);
    }
    
    handleFocus() {
        // Could show formatting toolbar or other UI
    }
    
    handleBlur() {
        if (this.app.nesManager?.isAcceptingSuggestion) return;
        this.app.nesManager?.dismissSuggestion();
    }

    handlePointerDown(e) {
        if (e.pointerType !== 'touch') return;
        this.pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointerMap.size === 2) {
            const points = Array.from(this.pointerMap.values());
            this.isPinching = true;
            this.pinchStartDistance = this.getDistance(points[0], points[1]);
            this.pinchStartFontSize = this.fontSize;
        }
    }

    handlePointerMove(e) {
        if (e.pointerType !== 'touch') return;
        if (!this.pointerMap.has(e.pointerId)) return;
        this.pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.isPinching && this.pointerMap.size === 2) {
            e.preventDefault();
            const points = Array.from(this.pointerMap.values());
            const distance = this.getDistance(points[0], points[1]);
            const ratio = distance / this.pinchStartDistance;
            const newSize = Math.max(8, this.pinchStartFontSize * ratio);
            this.setFontSize(newSize);
        }
    }

    handlePointerUp(e) {
        if (e.pointerType !== 'touch') return;
        this.pointerMap.delete(e.pointerId);
        if (this.pointerMap.size < 2) {
            this.isPinching = false;
        }
    }

    getDistance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    setFontSize(size) {
        this.fontSize = Math.round(size);
        if (this.contentElement) {
            this.contentElement.style.fontSize = `${this.fontSize}px`;
        }
        if (this.sourceTextarea) {
            this.sourceTextarea.style.fontSize = `${this.fontSize}px`;
        }
        if (this.fontSizeIndicator) {
            this.fontSizeIndicator.textContent = `${this.fontSize}px`;
        }
        this.app.scheduleSessionSave?.();
    }

    getFontSize() {
        return this.fontSize;
    }

    setPageStyle(style) {
        this.pageStyle = style || { pattern: 'blank', color: '#ffffff' };
        this.applyPageStyle();
    }

    applyPageStyle() {
        const targetElements = [this.contentElement, this.sourceTextarea].filter(Boolean);
        const pattern = this.pageStyle?.pattern || 'blank';
        const color = this.pageStyle?.color || '#ffffff';

        const patternBackground = this.getPatternBackground(pattern, color);
        const textColor = this.getContrastColor(color);
        targetElements.forEach(el => {
            el.style.backgroundColor = color;
            el.style.backgroundImage = patternBackground;
            el.style.backgroundSize = pattern === 'grid' ? '24px 24px' : pattern === 'lines' ? '100% 24px' : 'auto';
            el.style.color = textColor;
        });
    }

    /**
     * Returns black or white depending on which contrasts more with the given hex color.
     */
    getContrastColor(hex) {
        if (!hex || typeof hex !== 'string') return '#000000';
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        // Relative luminance (ITU-R BT.709)
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    getPatternBackground(pattern, color) {
        const lineColor = this.getContrastColor(color) === '#ffffff'
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(0,0,0,0.08)';
        if (pattern === 'grid') {
            return `linear-gradient(to right, ${lineColor} 1px, transparent 1px), linear-gradient(to bottom, ${lineColor} 1px, transparent 1px)`;
        }
        if (pattern === 'lines') {
            return `linear-gradient(to bottom, ${lineColor} 1px, transparent 1px)`;
        }
        return 'none';
    }

    setupEditorContextMenu() {
        this.editorContextMenu = document.getElementById('editor-context-menu');
        if (!this.editorContextMenu) return;

        this.editorContextMenu.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                this.handleEditorContextMenuAction(action);
                this.hideEditorContextMenu();
            });
        });

        document.addEventListener('click', () => this.hideEditorContextMenu());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hideEditorContextMenu();
        });
    }

    showEditorContextMenu(e) {
        if (!this.editorContextMenu) return;
        e.preventDefault();
        this.contentElement?.focus();

        this.editorContextMenu.style.left = `${e.clientX}px`;
        this.editorContextMenu.style.top = `${e.clientY}px`;
        this.editorContextMenu.classList.remove('hidden');

        const rect = this.editorContextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.editorContextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.editorContextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }

    hideEditorContextMenu() {
        this.editorContextMenu?.classList.add('hidden');
    }

    async handleEditorContextMenuAction(action) {
        if (!this.contentElement) return;

        this.contentElement.focus();

        switch (action) {
            case 'cut':
                document.execCommand('cut');
                break;
            case 'copy':
                document.execCommand('copy');
                break;
            case 'paste':
                if (navigator.clipboard?.readText) {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text) {
                            document.execCommand('insertText', false, text);
                        }
                    } catch {
                        document.execCommand('paste');
                    }
                } else {
                    document.execCommand('paste');
                }
                break;
            case 'edit-md':
                this.app.enterMarkdownSourceMode();
                break;
        }
    }
    
    saveUndoState() {
        const currentContent = this.getContent();
        
        if (currentContent !== this.lastSaveState) {
            this.undoStack.push(this.lastSaveState);
            if (this.undoStack.length > this.maxUndoSize) {
                this.undoStack.shift();
            }
            this.redoStack = [];
            this.lastSaveState = currentContent;
        }
    }
    
    undo() {
        if (this.undoStack.length === 0) return;
        
        const currentContent = this.getContent();
        this.redoStack.push(currentContent);
        
        const previousState = this.undoStack.pop();
        this.content = previousState;
        this.lastSaveState = previousState;
        this.renderContent();
        
        this.app.markModified();
    }
    
    redo() {
        if (this.redoStack.length === 0) return;
        
        const currentContent = this.getContent();
        this.undoStack.push(currentContent);
        
        const nextState = this.redoStack.pop();
        this.content = nextState;
        this.lastSaveState = nextState;
        this.renderContent();
        
        this.app.markModified();
    }
    
    toggleBold() {
        document.execCommand('bold', false, null);
        this.handleInput();
    }
    
    toggleItalic() {
        document.execCommand('italic', false, null);
        this.handleInput();
    }
    
    toggleUnderline() {
        document.execCommand('underline', false, null);
        this.handleInput();
    }
    
    insertHeading() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        
        const range = selection.getRangeAt(0);
        const container = range.startContainer.parentElement;
        
        // Cycle through heading levels
        let level = 1;
        const match = container?.tagName?.match(/^H(\d)$/);
        if (match) {
            level = parseInt(match[1]) + 1;
            if (level > 6) level = 0; // Back to paragraph
        }
        
        if (level === 0) {
            document.execCommand('formatBlock', false, 'p');
        } else {
            document.execCommand('formatBlock', false, `h${level}`);
        }
        
        this.handleInput();
    }
    
    insertList() {
        document.execCommand('insertUnorderedList', false, null);
        this.handleInput();
    }
    
    insertQuote() {
        document.execCommand('formatBlock', false, 'blockquote');
        this.handleInput();
    }
    
    insertTextAtCursor(text) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        
        // Move cursor to end of inserted text
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
        
        this.handleInput();
    }
    
    getTextBeforeCursor() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return '';
        
        const range = selection.getRangeAt(0).cloneRange();
        range.selectNodeContents(this.contentElement);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        
        return range.toString();
    }
    
    getTextAfterCursor() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return '';
        
        const range = selection.getRangeAt(0).cloneRange();
        range.selectNodeContents(this.contentElement);
        range.setStart(selection.focusNode, selection.focusOffset);
        
        return range.toString();
    }
    
    getCursorPosition() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return null;
        
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        return {
            x: rect.left,
            y: rect.top,
            height: rect.height
        };
    }
    
    moveCursorToEnd() {
        const range = document.createRange();
        const selection = window.getSelection();
        
        range.selectNodeContents(this.contentElement);
        range.collapse(false);
        
        selection.removeAllRanges();
        selection.addRange(range);
    }

    focusAtEnd() {
        this.contentElement?.focus();
        this.moveCursorToEnd();
    }

    getCursorOffset() {
        const selection = window.getSelection();
        if (!selection.rangeCount || !this.contentElement) return 0;

        const range = selection.getRangeAt(0).cloneRange();
        range.selectNodeContents(this.contentElement);
        range.setEnd(selection.anchorNode, selection.anchorOffset);

        return range.toString().length;
    }

    setCursorOffset(offset) {
        if (!this.contentElement) return;

        const walker = document.createTreeWalker(this.contentElement, NodeFilter.SHOW_TEXT, null);
        let currentOffset = 0;
        let node = walker.nextNode();

        while (node) {
            const length = node.textContent.length;
            if (currentOffset + length >= offset) {
                const range = document.createRange();
                const selection = window.getSelection();
                range.setStart(node, Math.max(0, offset - currentOffset));
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            currentOffset += length;
            node = walker.nextNode();
        }
        this.moveCursorToEnd();
    }

    getScrollTop() {
        return this.contentElement?.scrollTop || 0;
    }

    setScrollTop(value) {
        if (this.contentElement) {
            this.contentElement.scrollTop = value;
        }
    }

    setSourceValue(markdown) {
        if (this.sourceTextarea) {
            this.sourceTextarea.value = markdown || '';
        }
    }

    getSourceValue() {
        return this.sourceTextarea?.value || '';
    }

    focusSource() {
        this.sourceTextarea?.focus();
    }
    
    // Markdown to HTML conversion
    markdownToHtml(markdown) {
        if (!markdown) return '';
        
        let html = markdown;
        
        // Escape HTML entities first
        html = html.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');
        
        // Headers
        html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
        html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
        html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        
        // Bold: **text** or __text__
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
        
        // Italic: *text* or _text_
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        html = html.replace(/_(.+?)_/g, '<em>$1</em>');
        
        // Underline: ++text++ (custom extension)
        html = html.replace(/\+\+(.+?)\+\+/g, '<u>$1</u>');
        
        // Strikethrough: ~~text~~
        html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
        
        // Inline code: `code`
        html = html.replace(/`(.+?)`/g, '<code>$1</code>');
        
        // Blockquotes
        html = html.replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>');
        
        // Unordered lists
        html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
        html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
        
        // Ordered lists
        html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');
        
        // Horizontal rules
        html = html.replace(/^---$/gim, '<hr>');
        
        // Line breaks
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        // Wrap in paragraphs if not already structured
        if (!html.match(/^<[hpuob]/)) {
            html = '<p>' + html + '</p>';
        }
        
        // Clean up empty paragraphs
        html = html.replace(/<p><\/p>/g, '<p><br></p>');
        
        return html;
    }
    
    // HTML to Markdown conversion
    htmlToMarkdown(html) {
        if (!html) return '';
        
        // Create a temporary element to parse HTML
        const temp = document.createElement('div');
        temp.innerHTML = html;
        
        let markdown = '';
        
        const processNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent;
            }
            
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return '';
            }
            
            const tagName = node.tagName.toLowerCase();
            if (node.classList?.contains('nes-inline-suggestion')) {
                return '';
            }
            const children = Array.from(node.childNodes).map(processNode).join('');
            
            switch (tagName) {
                case 'h1': return `# ${children}\n`;
                case 'h2': return `## ${children}\n`;
                case 'h3': return `### ${children}\n`;
                case 'h4': return `#### ${children}\n`;
                case 'h5': return `##### ${children}\n`;
                case 'h6': return `###### ${children}\n`;
                case 'strong':
                case 'b': return `**${children}**`;
                case 'em':
                case 'i': return `*${children}*`;
                case 'u': return `++${children}++`;
                case 'del':
                case 's': return `~~${children}~~`;
                case 'code': return `\`${children}\``;
                case 'blockquote': return `> ${children}\n`;
                case 'li': return `- ${children}\n`;
                case 'ul':
                case 'ol': return children;
                case 'p': return `${children}\n\n`;
                case 'br': return '\n';
                case 'hr': return '---\n';
                case 'div': return `${children}\n`;
                default: return children;
            }
        };
        
        markdown = Array.from(temp.childNodes).map(processNode).join('');
        
        // Clean up extra whitespace
        markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
        
        return markdown;
    }
    
    showSuggestion(text) {
        if (!this.contentElement || !text) return;

        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0).cloneRange();
        if (!this.contentElement.contains(range.startContainer)) return;

        this.clearInlineSuggestion();

        const span = document.createElement('span');
        span.className = 'nes-inline-suggestion';
        span.textContent = text;

        range.insertNode(span);
        range.setStartBefore(span);
        range.setEndBefore(span);
        selection.removeAllRanges();
        selection.addRange(range);

        this.inlineSuggestionEl = span;
        this.suggestionElement?.classList.add('hidden');
    }

    acceptSuggestion(text) {
        if (!text) return;
        if (this.inlineSuggestionEl) {
            const span = this.inlineSuggestionEl;
            const textNode = document.createTextNode(text);
            span.replaceWith(textNode);
            this.inlineSuggestionEl = null;

            const selection = window.getSelection();
            const range = document.createRange();
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            selection.removeAllRanges();
            selection.addRange(range);

            this.handleInput();
            return;
        }

        this.insertTextAtCursor(text);
    }

    clearInlineSuggestion() {
        if (this.inlineSuggestionEl) {
            this.inlineSuggestionEl.remove();
            this.inlineSuggestionEl = null;
        }
    }

    hideSuggestion() {
        this.clearInlineSuggestion();
        this.suggestionElement?.classList.add('hidden');
    }
}
