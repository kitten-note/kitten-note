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
 * KittenNote - Ink Editor
 * Canvas-based drawing with pressure sensitivity
 */

export class InkEditor {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('ink-editor');
        this.bgCanvas = document.getElementById('ink-canvas-bg');
        this.mainCanvas = document.getElementById('ink-canvas-main');
        this.uiCanvas = document.getElementById('ink-canvas-ui');
        
        this.bgCtx = null;
        this.mainCtx = null;
        this.uiCtx = null;
        
        // Drawing state
        this.isDrawing = false;
        this.currentTool = 'pen';
        this.strokeColor = '#000000';
        this.strokeWidth = 3;
        this.currentStroke = null;
        this.lastPoint = null;
        
        // Content (log-based storage)
        this.content = { version: 1, strokes: [] };
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSize = 50;
        
        // Selection (lasso)
        this.selectedStrokes = [];
        this.lassoPoints = [];
        this.isLassoing = false;
        this.selectionMenu = null;
        this.isMovingSelection = false;
        this.moveStartPoint = null;
        
        // Shape drawing
        this.shapeStart = null;
        
        // Transform
        this.scale = 1;
        this.offset = { x: 0, y: 0 };
        this.pageStyle = { pattern: 'blank', color: '#ffffff' };

        // Virtual canvas size (infinite canvas)
        this.virtualWidth = 4000;
        this.virtualHeight = 4000;

        // Pinch zoom and pan
        this.activePointers = new Map();
        this.isPinching = false;
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.pinchStartDistance = 0;
        this.pinchStartScale = 1;
        this.pinchStartCenter = { x: 0, y: 0 };
        this.pinchStartOffset = { x: 0, y: 0 };

        // Palm rejection settings
        this.palmRejectionEnabled = true;
        this.palmMinSize = 40; // Minimum touch size considered palm
        this.palmMaxPressure = 0.1; // Low pressure likely palm
        this.recentStylusTime = 0;
        this.stylusActiveTimeout = 500; // ms to ignore touch after stylus

        // Eraser visualization
        this.eraserCursorPos = null;
        
        // Smoothing
        this.smoothingEnabled = true;
        this.straighteningThreshold = 15; // degrees
        this.minLengthForStraightening = 50; // pixels
        
        // Variable width (pressure sensitive)
        this.variableWidthEnabled = true;
        this.pressureSamplingInterval = 0; // 0 = no sampling limit
        this.lastSampleTime = 0;

        // --- Performance optimizations ---
        // Offscreen cache canvas for committed strokes
        this._cacheCanvas = null;
        this._cacheCtx = null;
        this._cacheDirty = true;    // Needs full repaint when true
        this._cacheScale = 1;       // Scale used when cache was rendered
        this._cacheOffset = { x: 0, y: 0 };

        // Bounding box cache per stroke (keyed by stroke.id)
        this._strokeBounds = new Map();

        // requestAnimationFrame throttle
        this._rafId = null;
        this._rafPending = false;
        
        this.init();
    }
    
    init() {
        if (!this.mainCanvas) return;
        
        this.bgCtx = this.bgCanvas?.getContext('2d');
        this.mainCtx = this.mainCanvas?.getContext('2d');
        this.uiCtx = this.uiCanvas?.getContext('2d');
        
        this.setupCanvasSize();
        this.setupEventListeners();
        this.setupToolbar();
        
        // Handle resize
        window.addEventListener('resize', () => this.setupCanvasSize());
    }
    
    setupCanvasSize() {
        if (!this.container) return;
        
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        [this.bgCanvas, this.mainCanvas, this.uiCanvas].forEach(canvas => {
            if (!canvas) return;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = rect.width + 'px';
            canvas.style.height = rect.height + 'px';
            
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
        });
        
        this.render();
        this.updateScrollbars();
    }
    
    setupEventListeners() {
        if (!this.mainCanvas) return;
        
        // Pointer events for unified mouse/touch/stylus handling
        this.mainCanvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
        this.mainCanvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        this.mainCanvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
        this.mainCanvas.addEventListener('pointerleave', (e) => this.handlePointerUp(e));
        this.mainCanvas.addEventListener('pointercancel', (e) => this.handlePointerUp(e));
        
        // Prevent default touch behaviors
        this.mainCanvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
        
        // Prevent context menu for right-click panning
        this.mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
        
        // Wheel for zoom
        this.container?.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    }
    
    setupToolbar() {
        // Tool buttons
        document.querySelectorAll('.ink-toolbar [data-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });
        
        // Color picker
        const colorPicker = document.getElementById('stroke-color');
        colorPicker?.addEventListener('input', (e) => {
            this.strokeColor = e.target.value;
        });
        
        // Stroke width
        const widthSlider = document.getElementById('stroke-width');
        const widthValue = document.getElementById('stroke-width-value');
        widthSlider?.addEventListener('input', (e) => {
            this.strokeWidth = parseInt(e.target.value);
            if (widthValue) {
                widthValue.textContent = `${this.strokeWidth}px`;
            }
        });
        
        // Reset view (go to origin)
        document.getElementById('reset-view')?.addEventListener('click', () => {
            this.resetView();
        });
        
        // Clear canvas
        document.getElementById('clear-canvas')?.addEventListener('click', () => {
            if (confirm('确定要清空画布吗？')) {
                this.clear();
            }
        });

        // Quick colors
        document.querySelectorAll('.quick-color[data-ink-color]').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.inkColor;
                if (color) {
                    this.strokeColor = color;
                    const picker = document.getElementById('stroke-color');
                    if (picker) picker.value = color;
                }
            });
        });
    }
    
    setTool(tool) {
        this.currentTool = tool;
        
        // Update toolbar UI
        document.querySelectorAll('.ink-toolbar [data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        // Update cursor
        this.container?.setAttribute('data-tool', tool);
        
        // Clear selection if switching away from select tool
        if (tool !== 'select') {
            this.clearSelection();
        }
    }
    
    loadContent(content) {
        this.content = content || { version: 1, strokes: [] };
        // Ensure strokes is an array
        if (!Array.isArray(this.content.strokes)) {
            this.content.strokes = [];
        }
        this.undoStack = [];
        this.redoStack = [];
        this._strokeBounds.clear();
        this.invalidateCache();
        this.clearSelection();
        this.render();
    }

    setPageStyle(style) {
        this.pageStyle = style || { pattern: 'blank', color: '#ffffff' };
        this.render();
    }
    
    getContent() {
        return this.content;
    }
    
    handlePointerDown(e) {
        e.preventDefault();
        this.mainCanvas.setPointerCapture(e.pointerId);

        // Handle selection move mode
        if (this.isMovingSelection) {
            const point = this.getPoint(e);
            this.moveStartPoint = point;
            return;
        }

        // Track stylus activity for palm rejection
        if (e.pointerType === 'pen') {
            this.recentStylusTime = Date.now();
        }

        // Palm rejection: ignore touch if stylus was recently used
        if (e.pointerType === 'touch' && this.palmRejectionEnabled) {
            if (Date.now() - this.recentStylusTime < this.stylusActiveTimeout) {
                return; // Ignore touch during stylus activity
            }
            // Check for palm-like characteristics
            if (this.isPalmTouch(e)) {
                return;
            }
        }

        // Move tool: single pointer pan, two-finger pinch/zoom
        if (this.currentTool === 'move') {
            if (e.pointerType === 'touch') {
                this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (this.activePointers.size >= 2) {
                    this.isPanning = false;
                    this.container?.classList.remove('panning');
                    if (this.activePointers.size === 2) {
                        this.isPinching = true;
                        const points = Array.from(this.activePointers.values());
                        this.pinchStartDistance = this.getDistance(points[0], points[1]);
                        this.pinchStartScale = this.scale;
                        this.pinchStartCenter = this.getMidpoint(points[0], points[1]);
                        this.pinchStartOffset = { x: this.offset.x, y: this.offset.y };
                    }
                    this.render();
                    return;
                }
            }

            this.isPanning = true;
            this.panStart = { x: e.clientX, y: e.clientY };
            this.container?.classList.add('panning');
            this.isDrawing = false;
            return;
        }

        // Right-click (button 2) for panning on desktop
        if (e.button === 2) {
            this.isPanning = true;
            this.panStart = { x: e.clientX, y: e.clientY };
            this.container?.classList.add('panning');
            return;
        }

        if (e.pointerType === 'touch') {
            this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.activePointers.size >= 2) {
                // Multiple fingers: only allow pinch-zoom, cancel any drawing
                if (this.isDrawing) {
                    this.currentStroke = null;
                    this.isDrawing = false;
                }
                if (this.activePointers.size === 2) {
                    this.isPinching = true;
                    const points = Array.from(this.activePointers.values());
                    this.pinchStartDistance = this.getDistance(points[0], points[1]);
                    this.pinchStartScale = this.scale;
                    this.pinchStartCenter = this.getMidpoint(points[0], points[1]);
                    this.pinchStartOffset = { x: this.offset.x, y: this.offset.y };
                }
                this.render();
                return;
            }
        }
        
        const point = this.getPoint(e);
        this.isDrawing = true;
        this.lastPoint = point;
        
        if (this.currentTool === 'select') {
            // Check if clicking within selection bounds - enable drag to move
            if (this.selectedStrokes.length > 0 && !this.isLassoing) {
                const bounds = this.getSelectionBounds();
                if (bounds && this.pointInBounds(point, bounds)) {
                    this.isMovingSelection = true;
                    this.moveStartPoint = point;
                    this.hideSelectionMenu();
                    this.container.style.cursor = 'move';
                    this.isDrawing = false;
                    return;
                }
            }
            this.handleSelectionStart(point);
        } else if (['line', 'rectangle', 'circle', 'arrow'].includes(this.currentTool)) {
            this.shapeStart = point;
        } else {
            this.startStroke(point);
        }
    }

    isPalmTouch(e) {
        // Palm characteristics: large contact area, low pressure, or edge of screen
        const rect = this.mainCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Check if touch is near edge (likely palm resting)
        const edgeMargin = 50;
        if (x < edgeMargin || x > rect.width - edgeMargin ||
            y > rect.height - edgeMargin) {
            return e.pressure < 0.2;
        }
        
        // Check for palm-like touch size (if available)
        if (e.width && e.height) {
            const touchSize = Math.max(e.width, e.height);
            if (touchSize > this.palmMinSize) {
                return true;
            }
        }
        
        return false;
    }
    
    handlePointerMove(e) {
        e.preventDefault();

        // Handle selection moving
        if (this.isMovingSelection && this.moveStartPoint) {
            const point = this.getPoint(e);
            const dx = point.x - this.moveStartPoint.x;
            const dy = point.y - this.moveStartPoint.y;
            
            this.content.strokes
                .filter(s => this.selectedStrokes.includes(s.id))
                .forEach(stroke => {
                    // Update bounding box in-place instead of full recompute
                    const b = this._strokeBounds.get(stroke.id);
                    if (b) { b.x += dx; b.y += dy; }
                    if (stroke.points) {
                        stroke.points.forEach(p => { p.x += dx; p.y += dy; });
                    }
                    if (stroke.start) {
                        stroke.start.x += dx; stroke.start.y += dy;
                        stroke.end.x += dx; stroke.end.y += dy;
                    }
                });
            
            this.moveStartPoint = point;
            this.invalidateCache();
            if (!this._rafPending) {
                this._rafPending = true;
                this._rafId = requestAnimationFrame(() => {
                    this._rafPending = false;
                    this.render();
                });
            }
            return;
        }

        // Update eraser cursor position
        if (this.currentTool === 'eraser') {
            this.eraserCursorPos = { x: e.clientX, y: e.clientY };
            this.renderEraserCursor();
        }

        // Right-click panning
        if (this.isPanning && !this.isPinching) {
            const dx = e.clientX - this.panStart.x;
            const dy = e.clientY - this.panStart.y;
            this.offset.x += dx;
            this.offset.y += dy;
            this.panStart = { x: e.clientX, y: e.clientY };
            if (!this._rafPending) {
                this._rafPending = true;
                this._rafId = requestAnimationFrame(() => {
                    this._rafPending = false;
                    this.render();
                    this.updateScrollbars();
                });
            }
            return;
        }

        if (e.pointerType === 'touch' && this.activePointers.has(e.pointerId)) {
            const prevPoint = this.activePointers.get(e.pointerId);
            this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            
            if (this.isPinching && this.activePointers.size === 2) {
                const points = Array.from(this.activePointers.values());
                const distance = this.getDistance(points[0], points[1]);
                const center = this.getMidpoint(points[0], points[1]);
                
                // Calculate zoom
                const ratio = distance / this.pinchStartDistance;
                const newScale = Math.max(0.25, Math.min(4, this.pinchStartScale * ratio));

                // Calculate pan (move center)
                const startCenter = this.pinchStartCenter;
                const dx = center.x - startCenter.x;
                const dy = center.y - startCenter.y;

                const rect = this.mainCanvas.getBoundingClientRect();
                const x = startCenter.x - rect.left;
                const y = startCenter.y - rect.top;

                // Apply zoom + pan
                this.offset.x = this.pinchStartOffset.x + dx + (x - this.pinchStartOffset.x) * (1 - newScale / this.pinchStartScale);
                this.offset.y = this.pinchStartOffset.y + dy + (y - this.pinchStartOffset.y) * (1 - newScale / this.pinchStartScale);
                this.scale = newScale;
                
                if (!this._rafPending) {
                    this._rafPending = true;
                    this._rafId = requestAnimationFrame(() => {
                        this._rafPending = false;
                        this.render();
                        this.updateScrollbars();
                    });
                }
                this.app.scheduleSessionSave?.();
                return;
            }
        }

        if (!this.isDrawing) return;
        
        // Get all coalesced events for smoother strokes when moving fast
        const coalescedEvents = e.getCoalescedEvents?.() || [e];
        
        if (this.currentTool === 'select') {
            const point = this.getPoint(e);
            this.handleSelectionMove(point);
            this.lastPoint = point;
        } else if (['line', 'rectangle', 'circle', 'arrow'].includes(this.currentTool)) {
            const point = this.getPoint(e);
            this.drawShapePreview(point);
            this.lastPoint = point;
        } else if (this.currentTool === 'eraser') {
            // Process all coalesced points for eraser
            for (const coalesced of coalescedEvents) {
                const point = this.getPoint(coalesced);
                this.eraseAt(point);
            }
            this.lastPoint = this.getPoint(e);
        } else {
            // Process all coalesced points for stroke drawing
            for (const coalesced of coalescedEvents) {
                const point = this.getPoint(coalesced);
                this.continueStroke(point);
            }
            this.lastPoint = this.getPoint(e);
        }
    }
    
    handlePointerUp(e) {
        e.preventDefault();

        // End selection moving
        if (this.isMovingSelection && this.moveStartPoint) {
            this.isMovingSelection = false;
            this.moveStartPoint = null;
            this.container.style.cursor = '';
            // Invalidate bounds for moved strokes
            this.selectedStrokes.forEach(id => this._strokeBounds.delete(id));
            this.invalidateCache();
            this.showSelectionMenu();
            this.app.markModified();
            return;
        }

        // End panning
        if (this.isPanning && (e.button === 2 || this.currentTool === 'move')) {
            this.isPanning = false;
            this.container?.classList.remove('panning');
            this.updateScrollbars();
            return;
        }

        // Clear eraser cursor when not drawing
        if (this.currentTool === 'eraser') {
            this.eraserCursorPos = null;
            this.clearUI();
        }

        if (e.pointerType === 'touch' && this.activePointers.has(e.pointerId)) {
            this.activePointers.delete(e.pointerId);
            if (this.activePointers.size < 2) {
                this.isPinching = false;
            }
            // Don't start drawing after pinch ends
            if (this.activePointers.size === 1 && !this.isDrawing) {
                return;
            }
        }

        if (this.currentTool === 'move' && this.isPanning && this.activePointers.size < 2) {
            this.isPanning = false;
            this.container?.classList.remove('panning');
            this.updateScrollbars();
            return;
        }

        if (!this.isDrawing) return;
        
        // Get final coalesced events to capture stroke end accurately
        const coalescedEvents = e.getCoalescedEvents?.() || [e];
        const point = this.getPoint(e);
        this.isDrawing = false;
        
        // Validate stroke before finishing - reject spiral/accidental drawings
        if (this.currentStroke && this.isAccidentalStroke(this.currentStroke)) {
            this.currentStroke = null;
            this.render();
            return;
        }
        
        if (this.currentTool === 'select') {
            this.handleSelectionEnd(point);
        } else if (['line', 'rectangle', 'circle', 'arrow'].includes(this.currentTool)) {
            this.finishShape(point);
        } else if (this.currentTool !== 'eraser') {
            // Add all final coalesced points before finishing the stroke
            for (const coalesced of coalescedEvents) {
                const coalescedPoint = this.getPoint(coalesced);
                this.continueStroke(coalescedPoint);
            }
            this.finishStroke();
        }
        
        this.lastPoint = null;
        this.shapeStart = null;
    }

    isAccidentalStroke(stroke) {
        if (!stroke || !stroke.points || stroke.points.length < 3) return false;
        
        const points = stroke.points;
        const duration = points[points.length - 1].timestamp - points[0].timestamp;
        
        // Very fast strokes with many points might be accidental
        if (duration < 100 && points.length > 20) return true;
        
        // Check for spiral pattern (high angular change rate)
        let totalAngleChange = 0;
        for (let i = 2; i < points.length; i++) {
            const angle1 = Math.atan2(points[i-1].y - points[i-2].y, points[i-1].x - points[i-2].x);
            const angle2 = Math.atan2(points[i].y - points[i-1].y, points[i].x - points[i-1].x);
            let diff = Math.abs(angle2 - angle1);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;
            totalAngleChange += diff;
        }
        
        // If total rotation > 3 full circles in short time, likely accidental
        if (totalAngleChange > 6 * Math.PI && duration < 500) return true;
        
        return false;
    }
    
    handleWheel(e) {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.25, Math.min(4, this.scale * delta));
        
        // Zoom towards mouse position
        const rect = this.mainCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        this.offset.x = x - (x - this.offset.x) * (newScale / this.scale);
        this.offset.y = y - (y - this.offset.y) * (newScale / this.scale);
        this.scale = newScale;
        
        if (!this._rafPending) {
            this._rafPending = true;
            this._rafId = requestAnimationFrame(() => {
                this._rafPending = false;
                this.render();
                this.updateScrollbars();
            });
        }
        this.app.scheduleSessionSave?.();
    }

    updateScrollbars() {
        const hScrollbar = document.getElementById('ink-scrollbar-h');
        const vScrollbar = document.getElementById('ink-scrollbar-v');
        if (!hScrollbar || !vScrollbar || !this.container) return;

        const rect = this.container.getBoundingClientRect();
        const viewWidth = rect.width;
        const viewHeight = rect.height;
        const contentWidth = this.virtualWidth * this.scale;
        const contentHeight = this.virtualHeight * this.scale;

        // Horizontal scrollbar
        const hThumbWidth = Math.max(40, (viewWidth / contentWidth) * viewWidth);
        const hThumb = hScrollbar.querySelector('.scrollbar-thumb');
        if (hThumb) {
            hThumb.style.width = `${hThumbWidth}px`;
            const hPos = (-this.offset.x / contentWidth) * viewWidth;
            hThumb.style.left = `${Math.max(0, Math.min(viewWidth - hThumbWidth, hPos))}px`;
        }

        // Vertical scrollbar
        const vThumbHeight = Math.max(40, (viewHeight / contentHeight) * viewHeight);
        const vThumb = vScrollbar.querySelector('.scrollbar-thumb');
        if (vThumb) {
            vThumb.style.height = `${vThumbHeight}px`;
            const vPos = (-this.offset.y / contentHeight) * viewHeight;
            vThumb.style.top = `${Math.max(0, Math.min(viewHeight - vThumbHeight, vPos))}px`;
        }
    }

    resetView() {
        // Reset to origin (0, 0) with default scale
        this.offset = { x: 0, y: 0 };
        this.scale = 1;
        this.render();
        this.updateScrollbars();
        this.app.scheduleSessionSave?.();
    }

    renderEraserCursor() {
        if (!this.eraserCursorPos || this.currentTool !== 'eraser') {
            this.clearUI();
            return;
        }

        this.clearUI();
        const rect = this.mainCanvas.getBoundingClientRect();
        const x = this.eraserCursorPos.x - rect.left;
        const y = this.eraserCursorPos.y - rect.top;
        const radius = this.strokeWidth * 2 * this.scale;

        this.uiCtx.save();
        this.uiCtx.beginPath();
        this.uiCtx.arc(x, y, radius, 0, Math.PI * 2);
        this.uiCtx.strokeStyle = 'rgba(255, 100, 100, 0.8)';
        this.uiCtx.lineWidth = 2;
        this.uiCtx.setLineDash([4, 4]);
        this.uiCtx.stroke();
        this.uiCtx.restore();
    }

    getDistance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    getMidpoint(a, b) {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    
    getPoint(e) {
        const rect = this.mainCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - this.offset.x) / this.scale,
            y: (e.clientY - rect.top - this.offset.y) / this.scale,
            pressure: e.pressure || 0.5,
            timestamp: Date.now()
        };
    }
    
    startStroke(point) {
        const isHighlighter = this.currentTool === 'highlighter';
        
        this.currentStroke = {
            id: this.generateId(),
            type: 'stroke',
            tool: this.currentTool,
            color: this.strokeColor,
            width: isHighlighter ? this.strokeWidth * 3 : this.strokeWidth,
            opacity: isHighlighter ? 0.4 : 1,
            points: [point],
            timestamp: Date.now()
        };
    }
    
    continueStroke(point) {
        if (!this.currentStroke) return;
        
        const lastPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
        
        // Interpolate points if gap is large (fast pen movement)
        if (lastPoint) {
            const dx = point.x - lastPoint.x;
            const dy = point.y - lastPoint.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // If distance > 5 pixels, add interpolated points
            if (distance > 5) {
                const steps = Math.ceil(distance / 3);
                for (let i = 1; i < steps; i++) {
                    const t = i / steps;
                    const interpolated = {
                        x: lastPoint.x + dx * t,
                        y: lastPoint.y + dy * t,
                        pressure: lastPoint.pressure + (point.pressure - lastPoint.pressure) * t
                    };
                    this.currentStroke.points.push(interpolated);
                }
            }
        }
        
        this.currentStroke.points.push(point);
        // RAF throttle: avoid rendering every pointer event
        if (!this._rafPending) {
            this._rafPending = true;
            this._rafId = requestAnimationFrame(() => {
                this._rafPending = false;
                this.renderCurrentStroke();
            });
        }
    }
    
    finishStroke() {
        if (!this.currentStroke || this.currentStroke.points.length < 2) {
            this.currentStroke = null;
            // Cancel any pending RAF
            if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; this._rafPending = false; }
            return;
        }
        
        // Cancel any pending RAF from drawing
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; this._rafPending = false; }
        
        // Apply smoothing
        if (this.smoothingEnabled) {
            this.currentStroke.points = this.smoothPoints(this.currentStroke.points);
            
            // Check for straight line
            if (this.shouldStraighten(this.currentStroke.points)) {
                this.currentStroke.points = this.straightenLine(this.currentStroke.points);
            }
        }
        
        // Cache the bounding box for the new stroke
        this._strokeBounds.delete(this.currentStroke.id);
        
        // Save undo state and add stroke
        this.saveUndoState();
        this.content.strokes.push(this.currentStroke);
        this.currentStroke = null;
        
        this.invalidateCache();
        this.render();
        this.app.markModified();
    }
    
    eraseAt(point) {
        const eraseRadius = this.strokeWidth * 2;
        const strokesToRemove = [];
        
        this.content.strokes.forEach(stroke => {
            // Quick rejection using bounding box
            const bounds = this._getStrokeBounds(stroke);
            if (point.x < bounds.x - eraseRadius || point.x > bounds.x + bounds.w + eraseRadius ||
                point.y < bounds.y - eraseRadius || point.y > bounds.y + bounds.h + eraseRadius) {
                return; // Skip — not near this stroke
            }
            if (this.strokeIntersectsPoint(stroke, point, eraseRadius)) {
                strokesToRemove.push(stroke.id);
            }
        });
        
        if (strokesToRemove.length > 0) {
            this.saveUndoState();
            this.content.strokes = this.content.strokes.filter(s => !strokesToRemove.includes(s.id));
            // Remove cached bounds for deleted strokes
            strokesToRemove.forEach(id => this._strokeBounds.delete(id));
            this.invalidateCache();
            this.render();
            this.app.markModified();
        }
    }
    
    strokeIntersectsPoint(stroke, point, radius) {
        const radiusSq = radius * radius;
        if (stroke.type === 'stroke') {
            for (const p of stroke.points) {
                const dx = p.x - point.x;
                const dy = p.y - point.y;
                if (dx * dx + dy * dy < radiusSq) {
                    return true;
                }
            }
        } else {
            // For shapes, check if point is near the shape boundary
            return this.pointNearShape(stroke, point, radius);
        }
        return false;
    }
    
    pointNearShape(shape, point, radius) {
        switch (shape.type) {
            case 'line':
            case 'arrow':
                return this.pointNearLine(shape.start, shape.end, point, radius);
            case 'rectangle':
                return this.pointNearRectangle(shape, point, radius);
            case 'circle':
                return this.pointNearCircle(shape, point, radius);
            default:
                return false;
        }
    }
    
    pointNearLine(start, end, point, radius) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        
        if (length === 0) return false;
        
        const t = Math.max(0, Math.min(1, 
            ((point.x - start.x) * dx + (point.y - start.y) * dy) / (length * length)
        ));
        
        const closestX = start.x + t * dx;
        const closestY = start.y + t * dy;
        
        const distance = Math.sqrt(
            (point.x - closestX) ** 2 + (point.y - closestY) ** 2
        );
        
        return distance < radius;
    }
    
    pointNearRectangle(rect, point, radius) {
        const { start, end } = rect;
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        
        // Check each edge
        return (
            this.pointNearLine({x: minX, y: minY}, {x: maxX, y: minY}, point, radius) ||
            this.pointNearLine({x: maxX, y: minY}, {x: maxX, y: maxY}, point, radius) ||
            this.pointNearLine({x: maxX, y: maxY}, {x: minX, y: maxY}, point, radius) ||
            this.pointNearLine({x: minX, y: maxY}, {x: minX, y: minY}, point, radius)
        );
    }
    
    pointNearCircle(circle, point, radius) {
        const { start, end } = circle;
        const centerX = (start.x + end.x) / 2;
        const centerY = (start.y + end.y) / 2;
        const circleRadius = Math.sqrt(
            (end.x - start.x) ** 2 + (end.y - start.y) ** 2
        ) / 2;
        
        const distance = Math.sqrt(
            (point.x - centerX) ** 2 + (point.y - centerY) ** 2
        );
        
        return Math.abs(distance - circleRadius) < radius;
    }
    
    // Selection handling (lasso)
    handleSelectionStart(point) {
        this.lassoPoints = [point];
        this.isLassoing = true;
        this.hideSelectionMenu();
        this.clearSelection();
    }
    
    handleSelectionMove(point) {
        if (!this.isLassoing) return;
        
        this.lassoPoints.push(point);
        this.renderLasso();
    }
    
    handleSelectionEnd(point) {
        if (!this.isLassoing) return;
        
        this.lassoPoints.push(point);
        
        if (this.lassoPoints.length < 3) {
            // Click selection - select stroke at point
            const stroke = this.getStrokeAt(point);
            if (stroke) {
                this.selectedStrokes = [stroke.id];
                this.showSelectionMenu();
            }
        } else {
            // Lasso selection - find strokes inside polygon
            this.selectedStrokes = this.content.strokes
                .filter(stroke => this.strokeInLasso(stroke))
                .map(s => s.id);
            
            if (this.selectedStrokes.length > 0) {
                this.showSelectionMenu();
            }
        }
        
        this.isLassoing = false;
        this.lassoPoints = [];
        this.render();
    }
    
    renderLasso() {
        this.clearUI();
        if (this.lassoPoints.length < 2) return;
        
        this.uiCtx.save();
        this.uiCtx.translate(this.offset.x, this.offset.y);
        this.uiCtx.scale(this.scale, this.scale);
        
        this.uiCtx.beginPath();
        this.uiCtx.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y);
        for (let i = 1; i < this.lassoPoints.length; i++) {
            this.uiCtx.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y);
        }
        
        this.uiCtx.strokeStyle = 'rgba(74, 158, 255, 0.8)';
        this.uiCtx.lineWidth = 2 / this.scale;
        this.uiCtx.setLineDash([5 / this.scale, 5 / this.scale]);
        this.uiCtx.stroke();
        
        this.uiCtx.fillStyle = 'rgba(74, 158, 255, 0.1)';
        this.uiCtx.closePath();
        this.uiCtx.fill();
        
        this.uiCtx.restore();
    }
    
    strokeInLasso(stroke) {
        if (this.lassoPoints.length < 3) return false;
        
        if (stroke.type === 'stroke') {
            // Check if majority of stroke points are inside lasso
            const insideCount = stroke.points.filter(p => this.pointInPolygon(p, this.lassoPoints)).length;
            return insideCount > stroke.points.length * 0.5;
        }
        // For shapes, check if center is in lasso
        const center = {
            x: (stroke.start.x + stroke.end.x) / 2,
            y: (stroke.start.y + stroke.end.y) / 2
        };
        return this.pointInPolygon(center, this.lassoPoints);
    }
    
    pointInPolygon(point, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            
            if (((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    
    showSelectionMenu() {
        this.hideSelectionMenu();
        if (this.selectedStrokes.length === 0) return;
        
        // Calculate selection bounds
        const bounds = this.getSelectionBounds();
        if (!bounds) return;
        
        // Create menu element
        const menu = document.createElement('div');
        menu.className = 'ink-selection-menu';
        menu.innerHTML = `
            <button data-action="clone" title="克隆"><i class="fas fa-copy"></i></button>
            <button data-action="delete" title="删除"><i class="fas fa-trash"></i></button>
            <button data-action="export" title="导出PNG"><i class="fas fa-image"></i></button>
        `;
        
        // // Hint text for drag-to-move
        // const hint = document.createElement('div');
        // hint.className = 'ink-selection-hint';
        // hint.textContent = '拖动选区移动';
        // menu.appendChild(hint);
        
        // Position menu near selection
        const screenX = bounds.x * this.scale + this.offset.x;
        const screenY = bounds.y * this.scale + this.offset.y - 50;
        
        menu.style.left = `${Math.max(10, screenX)}px`;
        menu.style.top = `${Math.max(10, screenY)}px`;
        
        // Add event listeners
        menu.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleSelectionAction(btn.dataset.action);
            });
        });
        
        this.container.appendChild(menu);
        this.selectionMenu = menu;
    }
    
    hideSelectionMenu() {
        if (this.selectionMenu) {
            this.selectionMenu.remove();
            this.selectionMenu = null;
        }
    }
    
    getSelectionBounds() {
        if (this.selectedStrokes.length === 0) return null;
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        this.content.strokes
            .filter(s => this.selectedStrokes.includes(s.id))
            .forEach(stroke => {
                if (stroke.type === 'stroke') {
                    stroke.points.forEach(p => {
                        minX = Math.min(minX, p.x);
                        minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x);
                        maxY = Math.max(maxY, p.y);
                    });
                } else {
                    minX = Math.min(minX, stroke.start.x, stroke.end.x);
                    minY = Math.min(minY, stroke.start.y, stroke.end.y);
                    maxX = Math.max(maxX, stroke.start.x, stroke.end.x);
                    maxY = Math.max(maxY, stroke.start.y, stroke.end.y);
                }
            });
        
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    
    handleSelectionAction(action) {
        switch (action) {
            case 'clone':
                this.cloneSelected();
                break;
            case 'delete':
                this.deleteSelected();
                break;
            case 'export':
                this.exportSelectedAsPNG();
                break;
        }
    }
    
    cloneSelected() {
        if (this.selectedStrokes.length === 0) return;
        
        this.saveUndoState();
        const newStrokes = [];
        
        this.content.strokes
            .filter(s => this.selectedStrokes.includes(s.id))
            .forEach(stroke => {
                const cloned = JSON.parse(JSON.stringify(stroke));
                cloned.id = crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36);
                
                // Offset the clone slightly
                if (cloned.points) {
                    cloned.points = cloned.points.map(p => ({ ...p, x: p.x + 20, y: p.y + 20 }));
                }
                if (cloned.start) {
                    cloned.start = { x: cloned.start.x + 20, y: cloned.start.y + 20 };
                    cloned.end = { x: cloned.end.x + 20, y: cloned.end.y + 20 };
                }
                newStrokes.push(cloned);
            });
        
        this.content.strokes.push(...newStrokes);
        this.selectedStrokes = newStrokes.map(s => s.id);
        this.render();
        this.showSelectionMenu();
        this.app.markModified();
    }
    
    pointInBounds(point, bounds) {
        const margin = 10; // Extra margin for easier clicking
        return point.x >= bounds.x - margin &&
               point.x <= bounds.x + bounds.width + margin &&
               point.y >= bounds.y - margin &&
               point.y <= bounds.y + bounds.height + margin;
    }
    
    async exportSelectedAsPNG() {
        const bounds = this.getSelectionBounds();
        if (!bounds) return;
        
        const padding = 20;
        const canvas = document.createElement('canvas');
        canvas.width = (bounds.width + padding * 2) * 2;
        canvas.height = (bounds.height + padding * 2) * 2;
        const ctx = canvas.getContext('2d');
        
        ctx.scale(2, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, bounds.width + padding * 2, bounds.height + padding * 2);
        
        ctx.translate(padding - bounds.x, padding - bounds.y);
        
        this.content.strokes
            .filter(s => this.selectedStrokes.includes(s.id))
            .forEach(stroke => this.drawStrokeToContext(ctx, stroke));
        
        try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `selection_${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(url);
            this.app.showToast?.('已导出选区为PNG', 'success');
        } catch (e) {
            this.app.showToast?.('导出失败', 'error');
        }
    }
    
    drawStrokeToContext(ctx, stroke) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        if (stroke.type === 'stroke') {
            if (stroke.points.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            for (let i = 1; i < stroke.points.length; i++) {
                ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
            }
            ctx.stroke();
        } else {
            this.drawShape(ctx, stroke);
        }
    }
    
    getStrokeAt(point) {
        for (let i = this.content.strokes.length - 1; i >= 0; i--) {
            const stroke = this.content.strokes[i];
            if (this.strokeIntersectsPoint(stroke, point, 5)) {
                return stroke;
            }
        }
        return null;
    }
    
    clearSelection() {
        this.selectedStrokes = [];
        this.hideSelectionMenu();
        this.isMovingSelection = false;
        this.container.style.cursor = '';
        this.renderUI();
    }
    
    deleteSelected() {
        if (this.selectedStrokes.length === 0) return;
        
        this.saveUndoState();
        this.content.strokes = this.content.strokes.filter(
            s => !this.selectedStrokes.includes(s.id)
        );
        this._strokeBounds.clear();
        this.invalidateCache();
        this.clearSelection();
        this.render();
        this.app.markModified();
    }
    
    // Shape drawing
    drawShapePreview(point) {
        if (!this.shapeStart) return;
        
        this.clearUI();
        this.uiCtx.save();
        this.uiCtx.translate(this.offset.x, this.offset.y);
        this.uiCtx.scale(this.scale, this.scale);
        
        this.uiCtx.strokeStyle = this.strokeColor;
        this.uiCtx.lineWidth = this.strokeWidth;
        this.uiCtx.lineCap = 'round';
        this.uiCtx.lineJoin = 'round';
        
        switch (this.currentTool) {
            case 'line':
                this.drawLine(this.uiCtx, this.shapeStart, point);
                break;
            case 'rectangle':
                this.drawRectangle(this.uiCtx, this.shapeStart, point);
                break;
            case 'circle':
                this.drawCircle(this.uiCtx, this.shapeStart, point);
                break;
            case 'arrow':
                this.drawArrow(this.uiCtx, this.shapeStart, point);
                break;
        }
        
        this.uiCtx.restore();
    }
    
    finishShape(endPoint) {
        if (!this.shapeStart) return;
        
        const shape = {
            id: this.generateId(),
            type: this.currentTool,
            start: this.shapeStart,
            end: endPoint,
            color: this.strokeColor,
            width: this.strokeWidth,
            timestamp: Date.now()
        };
        
        this.saveUndoState();
        this.content.strokes.push(shape);
        this.invalidateCache();
        this.clearUI();
        this.render();
        this.app.markModified();
    }
    
    // ======== Performance: Bounding Box & Viewport Culling ========

    /**
     * Compute the axis-aligned bounding box for a stroke (content coords).
     */
    _computeStrokeBounds(stroke) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        if (stroke.type === 'stroke') {
            for (const p of stroke.points) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }
        } else if (stroke.start && stroke.end) {
            minX = Math.min(stroke.start.x, stroke.end.x);
            minY = Math.min(stroke.start.y, stroke.end.y);
            maxX = Math.max(stroke.start.x, stroke.end.x);
            maxY = Math.max(stroke.start.y, stroke.end.y);
        }

        // Add margin for stroke width
        const halfW = (stroke.width || 3) / 2 + 2;
        return { x: minX - halfW, y: minY - halfW, w: maxX - minX + halfW * 2, h: maxY - minY + halfW * 2 };
    }

    /**
     * Get cached bounding box for a stroke, computing if needed.
     */
    _getStrokeBounds(stroke) {
        if (this._strokeBounds.has(stroke.id)) return this._strokeBounds.get(stroke.id);
        const b = this._computeStrokeBounds(stroke);
        this._strokeBounds.set(stroke.id, b);
        return b;
    }

    /**
     * Return the viewport rectangle in content coordinates.
     */
    _getViewportInContentCoords() {
        const rect = this.container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        return {
            x: -this.offset.x / this.scale,
            y: -this.offset.y / this.scale,
            w: w / this.scale,
            h: h / this.scale
        };
    }

    /**
     * Check if a stroke bounding box intersects the viewport (with margin).
     */
    _isStrokeVisible(stroke, viewport, margin = 200) {
        const b = this._getStrokeBounds(stroke);
        return !(b.x + b.w < viewport.x - margin ||
                 b.y + b.h < viewport.y - margin ||
                 b.x > viewport.x + viewport.w + margin ||
                 b.y > viewport.y + viewport.h + margin);
    }

    /**
     * Invalidate the offscreen cache so the next render does a full repaint.
     */
    invalidateCache() {
        this._cacheDirty = true;
    }

    // ======== Rendering ========
    
    // Rendering
    render() {
        this.renderBackground();
        this.renderStrokes();
        this.renderUI();
    }

    drawBackgroundToContext(ctx, width, height, scale, offset) {
        ctx.clearRect(0, 0, width, height);

        const color = this.pageStyle?.color || '#ffffff';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);

        const pattern = this.pageStyle?.pattern || 'blank';
        if (pattern === 'blank') return;

        const spacing = 24;
        const scaledSpacing = spacing * scale;
        const startX = offset.x % scaledSpacing;
        const startY = offset.y % scaledSpacing;

        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;

        if (pattern === 'lines') {
            for (let y = startY; y < height; y += scaledSpacing) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();
            }
        }

        if (pattern === 'grid') {
            for (let x = startX; x < width; x += scaledSpacing) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            for (let y = startY; y < height; y += scaledSpacing) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();
            }
        }

        if (pattern === 'dots') {
            const dotRadius = 1.5 * scale;
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            for (let x = startX; x < width; x += scaledSpacing) {
                for (let y = startY; y < height; y += scaledSpacing) {
                    ctx.beginPath();
                    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        if (pattern === 'calligraphy') {
            const lineSpacing = 8 * scale;
            const groupSpacing = 48 * scale;
            const groupHeight = lineSpacing * 3;
            const totalGroupHeight = groupHeight + groupSpacing;
            const groupStartY = offset.y % totalGroupHeight;

            for (let groupY = groupStartY - totalGroupHeight; groupY < height; groupY += totalGroupHeight) {
                for (let i = 0; i < 4; i++) {
                    const y = groupY + i * lineSpacing;
                    if (y >= 0 && y <= height) {
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        ctx.lineTo(width, y);
                        ctx.stroke();
                    }
                }
            }
        }

        if (pattern === 'staff') {
            const lineSpacing = 6 * scale;
            const groupSpacing = 60 * scale;
            const staffHeight = lineSpacing * 4;
            const totalStaffHeight = staffHeight + groupSpacing;
            const staffStartY = offset.y % totalStaffHeight;

            ctx.strokeStyle = 'rgba(0,0,0,0.12)';

            for (let staffY = staffStartY - totalStaffHeight; staffY < height; staffY += totalStaffHeight) {
                for (let i = 0; i < 5; i++) {
                    const y = staffY + i * lineSpacing;
                    if (y >= 0 && y <= height) {
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        ctx.lineTo(width, y);
                        ctx.stroke();
                    }
                }
            }
        }
    }
    
    renderBackground() {
        if (!this.bgCtx) return;
        
        const width = this.bgCanvas.width / window.devicePixelRatio;
        const height = this.bgCanvas.height / window.devicePixelRatio;
        
        this.drawBackgroundToContext(this.bgCtx, width, height, this.scale, this.offset);
    }

    refreshLayout() {
        this.setupCanvasSize();
    }

    getViewportState() {
        return {
            scale: this.scale,
            offset: { ...this.offset }
        };
    }

    setViewportState(state) {
        if (!state) return;
        if (typeof state.scale === 'number') {
            this.scale = Math.max(0.25, Math.min(4, state.scale));
        }
        if (state.offset) {
            this.offset = { x: state.offset.x || 0, y: state.offset.y || 0 };
        }
        this.render();
    }
    
    renderStrokes() {
        if (!this.mainCtx) return;
        
        const dpr = window.devicePixelRatio || 1;
        const width = this.mainCanvas.width / dpr;
        const height = this.mainCanvas.height / dpr;
        
        // Ensure offscreen cache canvas exists and is sized correctly
        if (!this._cacheCanvas) {
            this._cacheCanvas = document.createElement('canvas');
            this._cacheCtx = this._cacheCanvas.getContext('2d');
            this._cacheDirty = true;
        }
        
        const needsResize = this._cacheCanvas.width !== this.mainCanvas.width ||
                            this._cacheCanvas.height !== this.mainCanvas.height;
        if (needsResize) {
            this._cacheCanvas.width = this.mainCanvas.width;
            this._cacheCanvas.height = this.mainCanvas.height;
            this._cacheCtx.scale(dpr, dpr);
            this._cacheDirty = true;
        }
        
        // Rebuild cache if dirty (strokes added/removed, zoom/pan changed significantly)
        const scaleChanged = this._cacheScale !== this.scale;
        const offsetChanged = this._cacheOffset.x !== this.offset.x || this._cacheOffset.y !== this.offset.y;
        
        if (this._cacheDirty || scaleChanged || offsetChanged) {
            this._cacheCtx.clearRect(0, 0, width, height);
            this._cacheCtx.save();
            this._cacheCtx.translate(this.offset.x, this.offset.y);
            this._cacheCtx.scale(this.scale, this.scale);
            
            // Viewport culling — only draw strokes that intersect the visible area
            const viewport = this._getViewportInContentCoords();
            
            for (const stroke of this.content.strokes) {
                if (this._isStrokeVisible(stroke, viewport)) {
                    this.renderStroke(this._cacheCtx, stroke);
                }
            }
            
            this._cacheCtx.restore();
            this._cacheScale = this.scale;
            this._cacheOffset = { x: this.offset.x, y: this.offset.y };
            this._cacheDirty = false;
        }
        
        // Blit offscreen cache to main canvas
        this.mainCtx.clearRect(0, 0, width, height);
        // Guard against 0-sized canvas during initialization
        if (this._cacheCanvas.width > 0 && this._cacheCanvas.height > 0) {
            this.mainCtx.drawImage(this._cacheCanvas, 0, 0, width, height);
        }
    }
    
    renderStroke(ctx, stroke) {
        ctx.save();
        
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = stroke.opacity || 1;
        
        if (stroke.type === 'stroke') {
            this.drawSmoothLine(ctx, stroke.points, stroke.width);
        } else {
            switch (stroke.type) {
                case 'line':
                    this.drawLine(ctx, stroke.start, stroke.end);
                    break;
                case 'rectangle':
                    this.drawRectangle(ctx, stroke.start, stroke.end);
                    break;
                case 'circle':
                    this.drawCircle(ctx, stroke.start, stroke.end);
                    break;
                case 'arrow':
                    this.drawArrow(ctx, stroke.start, stroke.end);
                    break;
            }
        }
        
        // Highlight if selected
        if (this.selectedStrokes.includes(stroke.id)) {
            ctx.strokeStyle = '#2196F3';
            ctx.lineWidth = stroke.width + 4;
            ctx.globalAlpha = 0.5;
            
            if (stroke.type === 'stroke') {
                this.drawSmoothLine(ctx, stroke.points, stroke.width);
            }
        }
        
        ctx.restore();
    }
    
    renderCurrentStroke() {
        if (!this.currentStroke) return;
        
        const dpr = window.devicePixelRatio || 1;
        const width = this.mainCanvas.width / dpr;
        const height = this.mainCanvas.height / dpr;
        
        // Instead of re-rendering all strokes, blit the cache and draw only current stroke on top.
        // Ensure cache is up-to-date first (it doesn't contain the current in-progress stroke).
        if (this._cacheDirty || this._cacheScale !== this.scale ||
            this._cacheOffset.x !== this.offset.x || this._cacheOffset.y !== this.offset.y) {
            // Cache needs refresh — do a lightweight rebuild
            this.renderStrokes();
        }
        
        // Blit cached committed strokes
        this.mainCtx.clearRect(0, 0, width, height);
        if (this._cacheCanvas && this._cacheCanvas.width > 0 && this._cacheCanvas.height > 0) {
            this.mainCtx.drawImage(this._cacheCanvas, 0, 0, width, height);
        }
        
        // Draw only the in-progress stroke
        this.mainCtx.save();
        this.mainCtx.translate(this.offset.x, this.offset.y);
        this.mainCtx.scale(this.scale, this.scale);
        this.renderStroke(this.mainCtx, this.currentStroke);
        this.mainCtx.restore();
    }
    
    renderUI() {
        this.clearUI();
        this.renderSelectionHighlights();
    }
    
    clearUI() {
        if (!this.uiCtx) return;
        
        const width = this.uiCanvas.width / window.devicePixelRatio;
        const height = this.uiCanvas.height / window.devicePixelRatio;
        this.uiCtx.clearRect(0, 0, width, height);
    }
    
    renderSelectionHighlights() {
        if (this.selectedStrokes.length === 0) return;
        
        this.uiCtx.save();
        this.uiCtx.translate(this.offset.x, this.offset.y);
        this.uiCtx.scale(this.scale, this.scale);
        
        // Get bounding box of selected strokes
        const bounds = this.getSelectionBounds();
        if (bounds) {
            this.uiCtx.strokeStyle = '#2196F3';
            this.uiCtx.lineWidth = 2 / this.scale;
            this.uiCtx.setLineDash([5 / this.scale, 5 / this.scale]);
            this.uiCtx.strokeRect(
                bounds.x - 5,
                bounds.y - 5,
                bounds.width + 10,
                bounds.height + 10
            );
        }
        
        this.uiCtx.restore();
    }
    
    getSelectionBounds() {
        if (this.selectedStrokes.length === 0) return null;
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        this.content.strokes
            .filter(s => this.selectedStrokes.includes(s.id))
            .forEach(stroke => {
                if (stroke.type === 'stroke') {
                    stroke.points.forEach(p => {
                        minX = Math.min(minX, p.x);
                        minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x);
                        maxY = Math.max(maxY, p.y);
                    });
                } else {
                    minX = Math.min(minX, stroke.start.x, stroke.end.x);
                    minY = Math.min(minY, stroke.start.y, stroke.end.y);
                    maxX = Math.max(maxX, stroke.start.x, stroke.end.x);
                    maxY = Math.max(maxY, stroke.start.y, stroke.end.y);
                }
            });
        
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }
    
    // Drawing primitives
    drawSmoothLine(ctx, points, baseWidth) {
        if (points.length < 2) return;
        
        // Variable width mode: draw each segment with its own width
        if (this.variableWidthEnabled) {
            this.drawVariableWidthLine(ctx, points, baseWidth);
            return;
        }
        
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        
        if (points.length === 2) {
            ctx.lineTo(points[1].x, points[1].y);
        } else {
            // Use quadratic bezier curves for smoothing
            for (let i = 1; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                
                ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
            }
            
            // Draw to the last point
            const last = points[points.length - 1];
            ctx.lineTo(last.x, last.y);
        }
        
        ctx.stroke();
    }
    
    drawVariableWidthLine(ctx, points, baseWidth) {
        if (points.length < 2) return;
        
        // Batch consecutive segments with similar width into single paths
        // to minimize expensive beginPath/stroke calls
        const widthThreshold = 0.4; // Max width diff before starting new batch
        let batchStart = 0;
        let currentWidth = baseWidth * (0.3 + ((points[0].pressure || 0.5) + (points[1].pressure || 0.5)) / 2 * 0.9);
        
        const flushBatch = (start, end, width) => {
            ctx.beginPath();
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            const p0 = points[start];
            ctx.moveTo(start === 0 ? p0.x : (points[start - 1].x + p0.x) / 2,
                       start === 0 ? p0.y : (points[start - 1].y + p0.y) / 2);
            
            for (let i = start; i < end; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                if (i < points.length - 2) {
                    const midX = (p1.x + p2.x) / 2;
                    const midY = (p1.y + p2.y) / 2;
                    ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
                } else {
                    ctx.lineTo(p2.x, p2.y);
                }
            }
            ctx.stroke();
        };
        
        for (let i = 1; i < points.length - 1; i++) {
            const pressure1 = points[i].pressure || 0.5;
            const pressure2 = points[i + 1].pressure || 0.5;
            const avgPressure = (pressure1 + pressure2) / 2;
            const width = baseWidth * (0.3 + avgPressure * 0.9);
            
            if (Math.abs(width - currentWidth) > widthThreshold) {
                // Flush current batch
                flushBatch(batchStart, i, currentWidth);
                batchStart = i;
                currentWidth = width;
            }
        }
        
        // Flush remaining
        flushBatch(batchStart, points.length - 1, currentWidth);
    }
    
    drawLine(ctx, start, end) {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
    }
    
    drawRectangle(ctx, start, end) {
        ctx.beginPath();
        ctx.strokeRect(
            Math.min(start.x, end.x),
            Math.min(start.y, end.y),
            Math.abs(end.x - start.x),
            Math.abs(end.y - start.y)
        );
    }
    
    drawCircle(ctx, start, end) {
        const centerX = (start.x + end.x) / 2;
        const centerY = (start.y + end.y) / 2;
        const radiusX = Math.abs(end.x - start.x) / 2;
        const radiusY = Math.abs(end.y - start.y) / 2;
        
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();
    }
    
    drawArrow(ctx, start, end) {
        const headLength = 15;
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        
        // Arrow head
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(
            end.x - headLength * Math.cos(angle - Math.PI / 6),
            end.y - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(
            end.x - headLength * Math.cos(angle + Math.PI / 6),
            end.y - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
    }
    
    // Smoothing algorithms
    smoothPoints(points) {
        if (points.length < 3) return points;
        
        const smoothed = [points[0]];
        
        for (let i = 1; i < points.length - 1; i++) {
            const p0 = points[i - 1];
            const p1 = points[i];
            const p2 = points[i + 1];
            
            smoothed.push({
                x: (p0.x + p1.x * 2 + p2.x) / 4,
                y: (p0.y + p1.y * 2 + p2.y) / 4,
                pressure: p1.pressure,
                timestamp: p1.timestamp
            });
        }
        
        smoothed.push(points[points.length - 1]);
        return smoothed;
    }
    
    shouldStraighten(points) {
        if (points.length < 3) return false;
        
        const start = points[0];
        const end = points[points.length - 1];
        
        const lineLength = Math.sqrt(
            (end.x - start.x) ** 2 + (end.y - start.y) ** 2
        );
        
        if (lineLength < this.minLengthForStraightening) return false;
        
        // Check if all points are close to the line
        const lineAngle = Math.atan2(end.y - start.y, end.x - start.x);
        
        for (const point of points) {
            const pointAngle = Math.atan2(point.y - start.y, point.x - start.x);
            const angleDiff = Math.abs(lineAngle - pointAngle) * (180 / Math.PI);
            
            if (angleDiff > this.straighteningThreshold && angleDiff < (180 - this.straighteningThreshold)) {
                return false;
            }
        }
        
        // Also check if it's close to horizontal or vertical
        const absDegrees = Math.abs(lineAngle * 180 / Math.PI);
        if (absDegrees < 10 || absDegrees > 170 || Math.abs(absDegrees - 90) < 10) {
            return true;
        }
        
        return false;
    }
    
    straightenLine(points) {
        if (points.length < 2) return points;
        
        const start = points[0];
        const end = points[points.length - 1];
        
        // Snap to horizontal or vertical if close
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const degrees = angle * 180 / Math.PI;
        
        let newEnd = { ...end };
        
        if (Math.abs(degrees) < 10 || Math.abs(degrees) > 170) {
            // Horizontal
            newEnd.y = start.y;
        } else if (Math.abs(Math.abs(degrees) - 90) < 10) {
            // Vertical
            newEnd.x = start.x;
        }
        
        return [
            { ...start },
            { ...newEnd, pressure: end.pressure, timestamp: end.timestamp }
        ];
    }
    
    // Undo/Redo
    saveUndoState() {
        const state = JSON.stringify(this.content);
        this.undoStack.push(state);
        if (this.undoStack.length > this.maxUndoSize) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }
    
    undo() {
        if (this.undoStack.length === 0) return;
        
        this.redoStack.push(JSON.stringify(this.content));
        const previousState = this.undoStack.pop();
        this.content = JSON.parse(previousState);
        
        this._strokeBounds.clear();
        this.invalidateCache();
        this.clearSelection();
        this.render();
        this.app.markModified();
    }
    
    redo() {
        if (this.redoStack.length === 0) return;
        
        this.undoStack.push(JSON.stringify(this.content));
        const nextState = this.redoStack.pop();
        this.content = JSON.parse(nextState);
        
        this._strokeBounds.clear();
        this.invalidateCache();
        this.clearSelection();
        this.render();
        this.app.markModified();
    }
    
    // Utility
    clear() {
        this.saveUndoState();
        this.content.strokes = [];
        this._strokeBounds.clear();
        this.invalidateCache();
        this.clearSelection();
        this.render();
        this.app.markModified();
    }
    
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
    }
    
    // Export helpers
    exportToDataURL(format = 'png') {
        // Create a temporary canvas with all content
        const tempCanvas = document.createElement('canvas');
        const bounds = this.getContentBounds();
        
        const padding = 20;
        tempCanvas.width = bounds.width + padding * 2;
        tempCanvas.height = bounds.height + padding * 2;
        
        const ctx = tempCanvas.getContext('2d');
        this.drawBackgroundToContext(
            ctx,
            tempCanvas.width,
            tempCanvas.height,
            1,
            { x: padding - bounds.x, y: padding - bounds.y }
        );
        
        ctx.translate(padding - bounds.x, padding - bounds.y);
        
        this.content.strokes.forEach(stroke => {
            this.renderStroke(ctx, stroke);
        });
        
        return tempCanvas.toDataURL(`image/${format}`);
    }
    
    getContentBounds() {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        this.content.strokes.forEach(stroke => {
            if (stroke.type === 'stroke') {
                stroke.points.forEach(p => {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                });
            } else {
                minX = Math.min(minX, stroke.start.x, stroke.end.x);
                minY = Math.min(minY, stroke.start.y, stroke.end.y);
                maxX = Math.max(maxX, stroke.start.x, stroke.end.x);
                maxY = Math.max(maxY, stroke.start.y, stroke.end.y);
            }
        });
        
        if (minX === Infinity) {
            return { x: 0, y: 0, width: 100, height: 100 };
        }
        
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }
}
