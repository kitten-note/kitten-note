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
 * KittenNote - Export Manager
 * Handles export to various formats (MD, KTNT, PDF, PNG, ZIP)
 */

import { Toast } from './toast.js';

export class ExportManager {
    constructor(db, app) {
        this.db = db;
        this.app = app;
    }
    
    async export(note, format) {
        if (!note) {
            Toast.show('请先选择一个笔记', 'warning');
            return;
        }
        
        try {
            switch (format) {
                case 'md':
                    await this.exportAsMarkdown(note);
                    break;
                case 'ktnt':
                    await this.exportAsKTNT(note);
                    break;
                case 'pdf':
                    await this.exportAsPDF(note);
                    break;
                case 'png':
                    await this.exportAsPNG(note);
                    break;
                case 'zip':
                    await this.exportNotebook(note.notebookId);
                    break;
                default:
                    Toast.show('不支持的导出格式', 'error');
            }
        } catch (error) {
            console.error('Export failed:', error);
            Toast.show('导出失败', 'error');
        }
    }
    
    async exportAsMarkdown(note) {
        if (note.type !== 'text') {
            Toast.show('墨迹笔记请使用KTNT格式导出', 'warning');
            return;
        }
        
        const content = note.content || '';
        const filename = this.sanitizeFilename(note.title) + '.md';
        
        this.downloadFile(content, filename, 'text/markdown');
        Toast.show('已导出为Markdown', 'success');
    }
    
    async exportAsKTNT(note) {
        if (note.type !== 'ink') {
            Toast.show('文字笔记请使用Markdown格式导出', 'warning');
            return;
        }

        const notebook = await this.db.getNotebook(note.notebookId);
        const pageStyle = notebook?.pageStyle || { pattern: 'blank', color: '#ffffff' };
        
        const ktntData = {
            version: 1,
            format: 'ktnt',
            title: note.title,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            pageStyle,
            content: note.content
        };
        
        const content = JSON.stringify(ktntData, null, 2);
        const filename = this.sanitizeFilename(note.title) + '.ktnt';
        
        this.downloadFile(content, filename, 'application/json');
        Toast.show('已导出为KTNT', 'success');
    }
    
    async exportAsPDF(note) {
        if (note.type === 'text') {
            await this.exportTextAsPDF(note);
        } else {
            await this.exportInkAsPDF(note);
        }
    }
    
    async exportTextAsPDF(note) {
        // Create printable HTML
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            Toast.show('请允许弹出窗口以导出PDF', 'warning');
            return;
        }
        
        const htmlContent = this.app.textEditor?.markdownToHtml(note.content) || '';
        
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${note.title}</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        line-height: 1.6;
                        max-width: 800px;
                        margin: 0 auto;
                        padding: 40px;
                    }
                    h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
                    h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
                    code { background: #f5f5f5; padding: 0.2em 0.4em; border-radius: 3px; }
                    pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; }
                    blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1em; color: #666; }
                </style>
            </head>
            <body>
                <h1>${note.title}</h1>
                ${htmlContent}
            </body>
            </html>
        `);
        
        printWindow.document.close();
        printWindow.focus();
        
        setTimeout(() => {
            printWindow.print();
        }, 500);
        
        Toast.show('请在打印对话框中选择"保存为PDF"', 'info');
    }
    
    async exportInkAsPDF(note) {
        // For ink notes, we convert canvas to PDF
        const dataUrl = this.app.inkEditor?.exportToDataURL('png');
        if (!dataUrl) {
            Toast.show('无法导出墨迹内容', 'error');
            return;
        }
        
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            Toast.show('请允许弹出窗口以导出PDF', 'warning');
            return;
        }
        
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${note.title}</title>
                <style>
                    body { margin: 0; padding: 20px; }
                    img { max-width: 100%; height: auto; }
                    h1 { font-family: sans-serif; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <h1>${note.title}</h1>
                <img src="${dataUrl}" alt="Ink Note">
            </body>
            </html>
        `);
        
        printWindow.document.close();
        printWindow.focus();
        
        setTimeout(() => {
            printWindow.print();
        }, 500);
        
        Toast.show('请在打印对话框中选择"保存为PDF"', 'info');
    }
    
    async exportAsPNG(note) {
        if (note.type === 'text') {
            Toast.show('文字笔记不支持PNG导出', 'warning');
            return;
        }
        
        const dataUrl = this.app.inkEditor?.exportToDataURL('png');
        if (!dataUrl) {
            Toast.show('无法导出墨迹内容', 'error');
            return;
        }
        
        // Convert data URL to blob and download
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const filename = this.sanitizeFilename(note.title) + '.png';
        
        this.downloadBlob(blob, filename);
        Toast.show('已导出为PNG', 'success');
    }
    
    async exportNotebook(notebookId) {
        const result = await this.buildNotebookZip(notebookId);
        if (!result) return;

        this.downloadBlob(result.blob, result.filename);
        Toast.show('已导出笔记本为ZIP', 'success');
    }

    async exportFolder(folderId) {
        if (!folderId) {
            Toast.show('请先选择一个文件夹', 'warning');
            return;
        }

        const folder = await this.db.getFolder(folderId);
        if (!folder) {
            Toast.show('文件夹不存在', 'error');
            return;
        }

        const folders = await this.db.getAllFolders();
        const notebooks = await this.db.getAllNotebooks();
        const folderMap = new Map(folders.map(item => [item.id, item]));
        const folderIds = this.collectFolderIds(folderId, folderMap);
        const targetNotebooks = notebooks.filter(nb => folderIds.has(nb.folderId));

        if (targetNotebooks.length === 0) {
            Toast.show('该文件夹下没有笔记本', 'warning');
            return;
        }

        const files = [];
        const notebookEntries = [];

        for (const notebook of targetNotebooks) {
            const zipInfo = await this.buildNotebookZip(notebook.id);
            if (!zipInfo) continue;

            const folderPath = this.getFolderRelativePath(notebook.folderId, folderId, folderMap);
            const notebookFilename = this.sanitizeFilename(notebook.name) + '.zip';
            const zipPath = folderPath
                ? `${folderPath}/${notebookFilename}`
                : notebookFilename;

            const zipBytes = new Uint8Array(await zipInfo.blob.arrayBuffer());
            files.push({
                name: zipPath,
                content: zipBytes
            });

            notebookEntries.push({
                id: notebook.id,
                name: notebook.name,
                path: zipPath
            });
        }

        const metadata = {
            version: 1,
            id: folder.id,
            name: folder.name,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
            notebooks: notebookEntries
        };

        files.unshift({
            name: 'folder.json',
            content: JSON.stringify(metadata, null, 2)
        });

        const zipBlob = await this.createZipBlob(files);
        const filename = this.sanitizeFilename(folder.name) + '.zip';
        this.downloadBlob(zipBlob, filename);
        Toast.show('已导出文件夹为ZIP', 'success');
    }

    async buildNotebookZip(notebookId) {
        if (!notebookId) {
            Toast.show('请先选择一个笔记本', 'warning');
            return null;
        }

        const notebook = await this.db.getNotebook(notebookId);
        if (!notebook) {
            Toast.show('笔记本不存在', 'error');
            return null;
        }

        const notes = await this.db.getNotesInNotebook(notebookId);

        // Create ZIP file manually using JSZip-like structure
        const files = [];

        // Add metadata
        const metadata = {
            version: 1,
            name: notebook.name,
            createdAt: notebook.createdAt,
            updatedAt: notebook.updatedAt,
            pageStyle: notebook.pageStyle || { pattern: 'blank', color: '#ffffff' },
            notes: notes.map(n => ({
                id: n.id,
                title: n.title,
                type: n.type,
                filename: this.sanitizeFilename(n.title) + (n.type === 'text' ? '.md' : '.ktnt')
            }))
        };

        files.push({
            name: 'notebook.json',
            content: JSON.stringify(metadata, null, 2)
        });

        // Add each note
        for (const note of notes) {
            if (note.type === 'text') {
                files.push({
                    name: this.sanitizeFilename(note.title) + '.md',
                    content: note.content || ''
                });
            } else {
                const ktntData = {
                    version: 1,
                    format: 'ktnt',
                    title: note.title,
                    createdAt: note.createdAt,
                    updatedAt: note.updatedAt,
                    content: note.content
                };
                files.push({
                    name: this.sanitizeFilename(note.title) + '.ktnt',
                    content: JSON.stringify(ktntData, null, 2)
                });
            }
        }

        // Create ZIP blob
        const zipBlob = await this.createZipBlob(files);
        const filename = this.sanitizeFilename(notebook.name) + '.zip';

        return { blob: zipBlob, filename, notebook, notes };
    }

    collectFolderIds(rootId, folderMap) {
        const result = new Set([rootId]);
        const queue = [rootId];

        while (queue.length) {
            const current = queue.shift();
            for (const folder of folderMap.values()) {
                if (folder.parentId === current) {
                    result.add(folder.id);
                    queue.push(folder.id);
                }
            }
        }

        return result;
    }

    getFolderRelativePath(folderId, rootId, folderMap) {
        const parts = [];
        let current = folderId;

        while (current) {
            const folder = folderMap.get(current);
            if (!folder) break;
            parts.unshift(this.sanitizePathSegment(folder.name));
            if (current === rootId) break;
            current = folder.parentId;
        }

        return parts.join('/');
    }
    
    async createZipBlob(files) {
        // Simple ZIP file creation without external library
        // Using the basic ZIP format specification
        
        const textEncoder = new TextEncoder();
        const localFileHeaders = [];
        const centralDirectory = [];
        let offset = 0;
        
        for (const file of files) {
            const filename = textEncoder.encode(file.name);
            const content = await this.resolveZipContent(file.content, textEncoder);
            const crc = this.crc32(content);
            
            // Local file header
            const localHeader = new ArrayBuffer(30 + filename.length);
            const localView = new DataView(localHeader);
            
            localView.setUint32(0, 0x04034b50, true); // Signature
            localView.setUint16(4, 20, true); // Version needed
            localView.setUint16(6, 0x0800, true); // Flags (bit 11 = UTF-8)
            localView.setUint16(8, 0, true); // Compression
            localView.setUint16(10, 0, true); // Mod time
            localView.setUint16(12, 0, true); // Mod date
            localView.setUint32(14, crc, true); // CRC-32
            localView.setUint32(18, content.length, true); // Compressed size
            localView.setUint32(22, content.length, true); // Uncompressed size
            localView.setUint16(26, filename.length, true); // Filename length
            localView.setUint16(28, 0, true); // Extra field length
            
            new Uint8Array(localHeader, 30).set(filename);
            
            localFileHeaders.push({
                header: new Uint8Array(localHeader),
                content,
                offset,
                filename,
                crc,
                size: content.length
            });
            
            offset += localHeader.byteLength + content.length;
        }
        
        // Central directory
        let cdOffset = offset;
        for (const file of localFileHeaders) {
            const cdHeader = new ArrayBuffer(46 + file.filename.length);
            const cdView = new DataView(cdHeader);
            
            cdView.setUint32(0, 0x02014b50, true); // Signature
            cdView.setUint16(4, 20, true); // Version made by
            cdView.setUint16(6, 20, true); // Version needed
            cdView.setUint16(8, 0x0800, true); // Flags (bit 11 = UTF-8)
            cdView.setUint16(10, 0, true); // Compression
            cdView.setUint16(12, 0, true); // Mod time
            cdView.setUint16(14, 0, true); // Mod date
            cdView.setUint32(16, file.crc, true); // CRC-32
            cdView.setUint32(20, file.size, true); // Compressed size
            cdView.setUint32(24, file.size, true); // Uncompressed size
            cdView.setUint16(28, file.filename.length, true); // Filename length
            cdView.setUint16(30, 0, true); // Extra field length
            cdView.setUint16(32, 0, true); // Comment length
            cdView.setUint16(34, 0, true); // Disk number
            cdView.setUint16(36, 0, true); // Internal attributes
            cdView.setUint32(38, 0, true); // External attributes
            cdView.setUint32(42, file.offset, true); // Offset
            
            new Uint8Array(cdHeader, 46).set(file.filename);
            
            centralDirectory.push(new Uint8Array(cdHeader));
            offset += cdHeader.byteLength;
        }
        
        // End of central directory
        const eocd = new ArrayBuffer(22);
        const eocdView = new DataView(eocd);
        const cdSize = offset - cdOffset;
        
        eocdView.setUint32(0, 0x06054b50, true); // Signature
        eocdView.setUint16(4, 0, true); // Disk number
        eocdView.setUint16(6, 0, true); // CD disk number
        eocdView.setUint16(8, files.length, true); // CD entries on disk
        eocdView.setUint16(10, files.length, true); // Total CD entries
        eocdView.setUint32(12, cdSize, true); // CD size
        eocdView.setUint32(16, cdOffset, true); // CD offset
        eocdView.setUint16(20, 0, true); // Comment length
        
        // Combine all parts
        const parts = [];
        for (const file of localFileHeaders) {
            parts.push(file.header);
            parts.push(file.content);
        }
        for (const cd of centralDirectory) {
            parts.push(cd);
        }
        parts.push(new Uint8Array(eocd));
        
        return new Blob(parts, { type: 'application/zip' });
    }

    async resolveZipContent(content, textEncoder) {
        if (content instanceof Uint8Array) {
            return content;
        }
        if (content instanceof ArrayBuffer) {
            return new Uint8Array(content);
        }
        if (content instanceof Blob) {
            return new Uint8Array(await content.arrayBuffer());
        }
        if (typeof content === 'string') {
            return textEncoder.encode(content);
        }
        if (content === null || content === undefined) {
            return textEncoder.encode('');
        }
        return textEncoder.encode(String(content));
    }
    
    crc32(data) {
        // CRC-32 implementation
        const table = this.getCRC32Table();
        let crc = 0xFFFFFFFF;
        
        for (let i = 0; i < data.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
        }
        
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    
    getCRC32Table() {
        if (!this._crc32Table) {
            this._crc32Table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                this._crc32Table[n] = c;
            }
        }
        return this._crc32Table;
    }
    
    sanitizeFilename(name) {
        return (name || 'untitled')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 100);
    }

    sanitizePathSegment(name) {
        return this.sanitizeFilename(name);
    }
    
    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        this.downloadBlob(blob, filename);
    }
    
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
