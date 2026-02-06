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
 * KittenNote - Directory Tree Component
 * Handles the sidebar directory/notebook/note tree structure
 */

export class DirectoryTree {
    constructor(db, app) {
        this.db = db;
        this.app = app;
        this.container = document.getElementById('directory-tree');
        this.filterQuery = '';
        this.selectedNoteId = null;
        this.draggedItem = null;
        this.draggedItemType = null;
        this.expandedState = {
            folders: new Set(),
            notebooks: new Set()
        };
        this.loadExpandedState();
    }

    loadExpandedState() {
        try {
            const raw = localStorage.getItem('kittennote-tree-expanded');
            if (!raw) return;
            const data = JSON.parse(raw);
            if (Array.isArray(data.folders)) {
                this.expandedState.folders = new Set(data.folders);
            }
            if (Array.isArray(data.notebooks)) {
                this.expandedState.notebooks = new Set(data.notebooks);
            }
        } catch (error) {
            console.warn('Failed to load tree state:', error);
        }
    }

    saveExpandedState() {
        try {
            localStorage.setItem('kittennote-tree-expanded', JSON.stringify({
                folders: Array.from(this.expandedState.folders),
                notebooks: Array.from(this.expandedState.notebooks)
            }));
        } catch (error) {
            console.warn('Failed to save tree state:', error);
        }
    }

    setExpanded(type, id, expanded) {
        const target = type === 'folder' ? this.expandedState.folders : this.expandedState.notebooks;
        if (expanded) {
            target.add(id);
        } else {
            target.delete(id);
        }
        this.saveExpandedState();
    }

    isExpanded(type, id) {
        return type === 'folder'
            ? this.expandedState.folders.has(id)
            : this.expandedState.notebooks.has(id);
    }
    
    async render() {
        if (!this.container) return;
        
        const folders = await this.db.getAllFolders();
        const notebooks = await this.db.getAllNotebooks();
        const notes = await this.db.getAllNotes();
        
        // Build tree structure
        const tree = this.buildTree(folders, notebooks, notes);
        
        // Render tree
        this.container.innerHTML = '';
        tree.forEach(item => {
            const element = this.renderTreeItem(item);
            if (element) {
                this.container.appendChild(element);
            }
        });
        
        // Add orphan notebooks (not in any folder)
        const orphanNotebooks = notebooks.filter(nb => !nb.folderId);
        orphanNotebooks.sort((a, b) => a.order - b.order);
        orphanNotebooks.forEach(notebook => {
            const notebookNotes = notes.filter(n => n.notebookId === notebook.id);
            const element = this.renderNotebook(notebook, notebookNotes);
            if (element) {
                this.container.appendChild(element);
            }
        });
        
        this.setupDragAndDrop();
    }
    
    buildTree(folders, notebooks, notes) {
        // Get root folders
        const rootFolders = folders.filter(f => !f.parentId);
        rootFolders.sort((a, b) => a.order - b.order);
        
        // Build tree recursively
        return rootFolders.map(folder => this.buildFolderNode(folder, folders, notebooks, notes));
    }
    
    buildFolderNode(folder, allFolders, allNotebooks, allNotes) {
        const children = allFolders.filter(f => f.parentId === folder.id);
        children.sort((a, b) => a.order - b.order);
        
        const folderNotebooks = allNotebooks.filter(nb => nb.folderId === folder.id);
        folderNotebooks.sort((a, b) => a.order - b.order);
        
        return {
            type: 'folder',
            data: folder,
            children: children.map(child => this.buildFolderNode(child, allFolders, allNotebooks, allNotes)),
            notebooks: folderNotebooks.map(notebook => ({
                type: 'notebook',
                data: notebook,
                notes: allNotes.filter(n => n.notebookId === notebook.id).sort((a, b) => a.order - b.order)
            }))
        };
    }
    
    renderTreeItem(item) {
        if (item.type === 'folder') {
            return this.renderFolder(item);
        }
        return null;
    }
    
    renderFolder(folderNode) {
        const folder = folderNode.data;
        
        // Filter check
        if (this.filterQuery && !this.matchesFilter(folder.name)) {
            const hasMatchingContent = this.checkFolderForMatches(folderNode);
            if (!hasMatchingContent) return null;
        }
        
        const element = document.createElement('div');
        element.className = 'tree-item folder';
        element.dataset.id = folder.id;
        element.dataset.type = 'folder';

        const isExpanded = this.isExpanded('folder', folder.id);
        if (isExpanded) {
            element.classList.add('expanded');
        }
        
        const content = document.createElement('div');
        content.className = 'tree-item-content';
        content.dataset.id = folder.id;
        content.dataset.type = 'folder';
        content.draggable = true;
        content.innerHTML = `
            <span class="expand-icon"><i class="fas fa-chevron-right"></i></span>
            <span class="item-icon"><i class="fas fa-folder"></i></span>
            <span class="item-name">${this.escapeHtml(folder.name)}</span>
            <button class="item-menu-btn" title="菜单"><i class="fas fa-ellipsis-v"></i></button>
        `;
        
        // Add three-dot menu button handler
        const menuBtn = content.querySelector('.item-menu-btn');
        menuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.showContextMenu(e, content);
        });
        
        const updateFolderIcon = () => {
            const icon = content.querySelector('.item-icon i');
            if (element.classList.contains('expanded')) {
                icon.classList.replace('fa-folder', 'fa-folder-open');
            } else {
                icon.classList.replace('fa-folder-open', 'fa-folder');
            }
        };

        updateFolderIcon();

        content.addEventListener('click', () => {
            element.classList.toggle('expanded');
            updateFolderIcon();
            this.setExpanded('folder', folder.id, element.classList.contains('expanded'));
        });
        
        element.appendChild(content);
        
        // Add children container
        if (folderNode.children.length > 0 || folderNode.notebooks.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            
            // Add child folders
            folderNode.children.forEach(child => {
                const childElement = this.renderFolder(child);
                if (childElement) {
                    childrenContainer.appendChild(childElement);
                }
            });
            
            // Add notebooks
            folderNode.notebooks.forEach(notebook => {
                const notebookElement = this.renderNotebook(notebook.data, notebook.notes);
                if (notebookElement) {
                    childrenContainer.appendChild(notebookElement);
                }
            });
            
            element.appendChild(childrenContainer);
        }
        
        return element;
    }
    
    renderNotebook(notebook, notes) {
        // Filter check
        if (this.filterQuery && !this.matchesFilter(notebook.name)) {
            const hasMatchingNotes = notes.some(n => this.matchesFilter(n.title));
            if (!hasMatchingNotes) return null;
        }
        
        const element = document.createElement('div');
        element.className = 'tree-item notebook';
        element.dataset.id = notebook.id;
        element.dataset.type = 'notebook';

        const isExpanded = this.isExpanded('notebook', notebook.id);
        if (isExpanded) {
            element.classList.add('expanded');
        }
        
        const content = document.createElement('div');
        content.className = 'tree-item-content';
        content.dataset.id = notebook.id;
        content.dataset.type = 'notebook';
        content.draggable = true;
        content.innerHTML = `
            <span class="expand-icon"><i class="fas fa-chevron-right"></i></span>
            <span class="item-icon"><i class="fas fa-book"></i></span>
            <span class="item-name">${this.escapeHtml(notebook.name)}</span>
            <button class="item-menu-btn" title="菜单"><i class="fas fa-ellipsis-v"></i></button>
        `;
        
        // Add three-dot menu button handler
        const menuBtn = content.querySelector('.item-menu-btn');
        menuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.showContextMenu(e, content);
        });
        
        content.addEventListener('click', (e) => {
            e.stopPropagation();
            element.classList.toggle('expanded');
            this.setExpanded('notebook', notebook.id, element.classList.contains('expanded'));
        });
        
        element.appendChild(content);
        
        // Add notes
        if (notes.length > 0) {
            const pagesContainer = document.createElement('div');
            pagesContainer.className = 'notebook-pages tree-children';
            
            notes.forEach(note => {
                const pageElement = this.renderNote(note);
                if (pageElement) {
                    pagesContainer.appendChild(pageElement);
                }
            });
            
            element.appendChild(pagesContainer);
        }
        
        return element;
    }
    
    renderNote(note) {
        // Filter check
        if (this.filterQuery && !this.matchesFilter(note.title)) {
            return null;
        }
        
        const element = document.createElement('div');
        element.className = 'page-item';
        element.dataset.id = note.id;
        element.dataset.type = 'note';
        element.draggable = true;
        
        if (note.id === this.selectedNoteId) {
            element.classList.add('active');
        }
        
        const icon = note.type === 'text' ? 'fa-file-alt' : 'fa-pen-fancy';
        element.innerHTML = `
            <i class="fas ${icon}"></i>
            <span class="item-name">${this.escapeHtml(note.title)}</span>
            <button class="item-menu-btn" title="菜单"><i class="fas fa-ellipsis-v"></i></button>
        `;
        
        // Add three-dot menu button handler
        const menuBtn = element.querySelector('.item-menu-btn');
        menuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.showContextMenu(e, element);
        });
        
        element.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.openNote(note.id);
        });
        
        return element;
    }
    
    checkFolderForMatches(folderNode) {
        // Check folder name
        if (this.matchesFilter(folderNode.data.name)) return true;
        
        // Check notebooks
        for (const nb of folderNode.notebooks) {
            if (this.matchesFilter(nb.data.name)) return true;
            for (const note of nb.notes) {
                if (this.matchesFilter(note.title)) return true;
            }
        }
        
        // Check child folders
        for (const child of folderNode.children) {
            if (this.checkFolderForMatches(child)) return true;
        }
        
        return false;
    }
    
    matchesFilter(text) {
        if (!this.filterQuery) return true;
        return text.toLowerCase().includes(this.filterQuery.toLowerCase());
    }
    
    filter(query) {
        this.filterQuery = query;
        this.render();
    }
    
    selectNote(noteId) {
        this.selectedNoteId = noteId;
        
        // Update UI
        this.container.querySelectorAll('.page-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.id === noteId) {
                item.classList.add('active');
                
                // Expand parent notebook and folder
                let parent = item.parentElement;
                let updated = false;
                while (parent && parent !== this.container) {
                    if (parent.classList.contains('tree-item')) {
                        parent.classList.add('expanded');
                        const type = parent.dataset.type;
                        const id = parent.dataset.id;
                        if (type && id) {
                            this.setExpanded(type, id, true);
                            updated = true;
                        }
                    }
                    parent = parent.parentElement;
                }
                if (updated) {
                    this.saveExpandedState();
                }
            }
        });
    }
    
    clearSelection() {
        this.selectedNoteId = null;
        this.container.querySelectorAll('.page-item.active').forEach(item => {
            item.classList.remove('active');
        });
    }
    
    setupDragAndDrop() {
        const draggables = this.container.querySelectorAll('[draggable="true"]');
        
        draggables.forEach(item => {
            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => this.handleDrop(e));
            item.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        });
    }
    
    handleDragStart(e) {
        const target = e.target.closest('[draggable="true"]');
        if (!target) return;
        
        this.draggedItem = target.dataset.id;
        this.draggedItemType = target.dataset.type;
        target.classList.add('dragging');
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({
            id: this.draggedItem,
            type: this.draggedItemType
        }));
    }
    
    handleDragEnd(e) {
        const target = e.target.closest('[draggable="true"]');
        if (target) {
            target.classList.remove('dragging');
        }
        
        this.container.querySelectorAll('.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
        
        this.draggedItem = null;
        this.draggedItemType = null;
    }
    
    handleDragOver(e) {
        e.preventDefault();
        
        const target = e.target.closest('[draggable="true"]');
        if (!target || target.dataset.id === this.draggedItem) return;
        
        const targetType = target.dataset.type;
        
        // Validate drop target
        let canDrop = false;
        
        if (this.draggedItemType === 'note' && targetType === 'notebook') {
            canDrop = true;
        } else if (this.draggedItemType === 'notebook' && targetType === 'folder') {
            canDrop = true;
        } else if (this.draggedItemType === 'folder' && targetType === 'folder') {
            canDrop = true;
        }
        
        if (canDrop) {
            e.dataTransfer.dropEffect = 'move';
            target.classList.add('drag-over');
        }
    }
    
    handleDragLeave(e) {
        const target = e.target.closest('[draggable="true"]');
        if (target) {
            target.classList.remove('drag-over');
        }
    }
    
    async handleDrop(e) {
        e.preventDefault();
        
        const target = e.target.closest('[draggable="true"]');
        if (!target || !this.draggedItem) return;
        
        target.classList.remove('drag-over');
        
        const targetId = target.dataset.id;
        const targetType = target.dataset.type;
        
        try {
            if (this.draggedItemType === 'note' && targetType === 'notebook') {
                await this.db.updateNote(this.draggedItem, { 
                    notebookId: targetId,
                    order: Date.now()
                });
            } else if (this.draggedItemType === 'notebook' && targetType === 'folder') {
                await this.db.updateNotebook(this.draggedItem, { 
                    folderId: targetId,
                    order: Date.now()
                });
            } else if (this.draggedItemType === 'folder' && targetType === 'folder') {
                // Prevent dropping folder into itself or its children
                if (await this.isDescendant(this.draggedItem, targetId)) {
                    return;
                }
                await this.db.updateFolder(this.draggedItem, { 
                    parentId: targetId,
                    order: Date.now()
                });
            }
            
            await this.render();
        } catch (error) {
            console.error('Drop operation failed:', error);
        }
    }
    
    async isDescendant(folderId, potentialChildId) {
        if (folderId === potentialChildId) return true;
        
        const folder = await this.db.getFolder(potentialChildId);
        if (!folder || !folder.parentId) return false;
        
        return this.isDescendant(folderId, folder.parentId);
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
