// zoomPanController.js - Handles zoom and pan functionality
export class ZoomPanController {
    constructor(canvas, canvasRenderer) {
        this.canvas = canvas;
        this.canvasRenderer = canvasRenderer;

        this.zoomScale = 1;
        this.minZoom = 0.01;
        this.maxZoom = 10;

        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.panOffset = { x: 0, y: 0 };

        this.onTransformUpdate = null; // Callback for transform updates

        this.initializeControls();
        this.setupEventListeners();
    }

    initializeControls() {
        this.mainCanvasWrapper = document.getElementById('mainCanvasWrapper');
        this.zoomInBtn = document.getElementById('zoomInBtn');
        this.zoomOutBtn = document.getElementById('zoomOutBtn');
        this.zoomLevelDisplay = document.getElementById('zoomLevelDisplay');
    }

    setupEventListeners() {
        // Zoom buttons
        this.zoomInBtn.addEventListener('click', () => this.zoomIn());
        this.zoomOutBtn.addEventListener('click', () => this.zoomOut());

        // Mouse wheel zoom
        [this.mainCanvasWrapper, document.getElementById('overviewCanvas')].forEach(element => {
            element.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
        });

        // Pan controls
        this.canvas.addEventListener('mousedown', (e) => this.startPan(e));
        window.addEventListener('mouseup', () => this.endPan());
        window.addEventListener('mousemove', (e) => this.handlePan(e));
    }

    getAdaptiveZoomStep(currentZoom) {
        // Much smoother zoom steps, especially at low zoom levels
        if (currentZoom < 0.05) return 0.005;
        if (currentZoom < 0.1) return 0.01;
        if (currentZoom < 0.25) return 0.02;
        if (currentZoom < 0.5) return 0.03;
        if (currentZoom < 1) return 0.05;
        if (currentZoom < 2) return 0.1;
        if (currentZoom < 5) return 0.2;
        return 0.3;
    }

    zoomIn() {
        const oldZoom = this.zoomScale;
        const adaptiveStep = this.getAdaptiveZoomStep(this.zoomScale);
        this.zoomScale = Math.min(this.maxZoom, this.zoomScale + adaptiveStep);

        // Zoom towards center of visible area
        const wrapperRect = this.mainCanvasWrapper.getBoundingClientRect();
        const centerX = wrapperRect.width / 2;
        const centerY = wrapperRect.height / 2;

        this.panOffset.x = this.panOffset.x - (centerX * (this.zoomScale / oldZoom - 1));
        this.panOffset.y = this.panOffset.y - (centerY * (this.zoomScale / oldZoom - 1));

        this.applyZoom();
        this.canvasRenderer.draw();
    }

    zoomOut() {
        const oldZoom = this.zoomScale;
        const adaptiveStep = this.getAdaptiveZoomStep(this.zoomScale);
        this.zoomScale = Math.max(this.minZoom, this.zoomScale - adaptiveStep);

        // Zoom from center of visible area
        const wrapperRect = this.mainCanvasWrapper.getBoundingClientRect();
        const centerX = wrapperRect.width / 2;
        const centerY = wrapperRect.height / 2;

        this.panOffset.x = this.panOffset.x - (centerX * (this.zoomScale / oldZoom - 1));
        this.panOffset.y = this.panOffset.y - (centerY * (this.zoomScale / oldZoom - 1));

        this.applyZoom();
        this.canvasRenderer.draw();
    }

    handleWheel(event) {
        event.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // Store the point in canvas coordinates before zoom
        const canvasPointX = mouseX / this.zoomScale;
        const canvasPointY = mouseY / this.zoomScale;

        const oldZoom = this.zoomScale;
        // Use smaller wheel zoom step for even smoother wheel zooming
        const wheelStep = this.getAdaptiveZoomStep(this.zoomScale) * 0.5;

        if (event.deltaY < 0) {
            this.zoomScale = Math.min(this.maxZoom, this.zoomScale + wheelStep);
        } else {
            this.zoomScale = Math.max(this.minZoom, this.zoomScale - wheelStep);
        }

        // Adjust pan offset to keep the point under cursor
        this.panOffset.x += mouseX - canvasPointX * this.zoomScale;
        this.panOffset.y += mouseY - canvasPointY * this.zoomScale;

        this.applyZoom();
        this.canvasRenderer.draw();
    }

    startPan(e) {
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.canvas.style.cursor = 'grabbing';
    }

    endPan() {
        if (this.isPanning) {
            this.isPanning = false;
            this.canvas.style.cursor = 'default';
        }
    }

    handlePan(e) {
        if (!this.isPanning) return;

        const dx = e.clientX - this.panStart.x;
        const dy = e.clientY - this.panStart.y;
        this.panOffset.x += dx;
        this.panOffset.y += dy;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.updateTransform();
    }

    applyZoom() {
        this.zoomScale = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoomScale));
        this.zoomLevelDisplay.textContent = `Zoom: ${Math.round(this.zoomScale * 100)}%`;
        this.updateTransform();
    }

    updateTransform() {
        this.canvas.style.transform = `translate(${this.panOffset.x}px, ${this.panOffset.y}px) scale(${this.zoomScale})`;
        this.zoomLevelDisplay.textContent = `Zoom: ${Math.round(this.zoomScale * 100)}%`;

        if (this.onTransformUpdate) {
            this.onTransformUpdate();
        }
    }

    reset() {
        this.zoomScale = 1;
        this.panOffset = { x: 0, y: 0 };
        this.applyZoom();
    }

    // Getters for other components
    getZoomScale() {
        return this.zoomScale;
    }

    getPanOffset() {
        return this.panOffset;
    }

    setPanOffset(x, y) {
        this.panOffset.x = x;
        this.panOffset.y = y;
    }

    getMainCanvasWrapper() {
        return this.mainCanvasWrapper;
    }

    // Method to center viewport at specific coordinates (used by overview)
    centerViewportAt(canvasX, canvasY) {
        const wrapperRect = this.mainCanvasWrapper.getBoundingClientRect();
        const targetX = canvasX * this.zoomScale - wrapperRect.width / 2;
        const targetY = canvasY * this.zoomScale - wrapperRect.height / 2;

        this.panOffset.x = -targetX;
        this.panOffset.y = -targetY;
        this.updateTransform();
    }
}