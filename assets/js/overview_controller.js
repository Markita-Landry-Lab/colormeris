// overviewController.js - Handles the overview canvas functionality
export class OverviewController {
    constructor(canvas, zoomPanController) {
        this.canvas = canvas;
        this.zoomPanController = zoomPanController;

        this.overviewCanvas = document.getElementById('overviewCanvas');
        this.overviewCtx = this.overviewCanvas.getContext('2d');

        this.isDraggingBox = false;
        this.dragStart = { x: 0, y: 0 };
        this.viewportBox = { x: 0, y: 0, w: 0, h: 0 };

        this.setupEventListeners();
    }

    setupEventListeners() {
        this.overviewCanvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.overviewCanvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('mouseup', () => this.handleMouseUp());
    }

    setZoomPanController(zoomPanController) {
        this.zoomPanController = zoomPanController;
    }

    handleMouseDown(e) {
        const rect = this.overviewCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Increase draggable area by adding padding around the viewport box
        const padding = 10;
        if (
            mouseX >= this.viewportBox.x - padding &&
            mouseX <= this.viewportBox.x + this.viewportBox.w + padding &&
            mouseY >= this.viewportBox.y - padding &&
            mouseY <= this.viewportBox.y + this.viewportBox.h + padding
        ) {
            this.isDraggingBox = true;
            this.dragStart = { x: mouseX, y: mouseY };
            this.overviewCanvas.style.cursor = 'grabbing';
        } else {
            this.centerViewportAt(mouseX, mouseY);
        }
    }

    handleMouseMove(e) {
    const rect = this.overviewCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (this.isDraggingBox) {
        const dx = mouseX - this.dragStart.x;
        const dy = mouseY - this.dragStart.y;

        const overviewScale = Math.min(
            this.overviewCanvas.width / this.canvas.width,
            this.overviewCanvas.height / this.canvas.height
        );

        // Convert movement to canvas coordinates and apply
        const canvasDx = dx / overviewScale;
        const canvasDy = dy / overviewScale;

        const panOffset = this.zoomPanController.getPanOffset();
        const zoomScale = this.zoomPanController.getZoomScale();

        panOffset.x -= canvasDx * zoomScale;
        panOffset.y -= canvasDy * zoomScale;

        // Add this method call to actually apply the changes:
        this.zoomPanController.setPanOffset(panOffset.x, panOffset.y);

        this.dragStart = { x: mouseX, y: mouseY };
        this.zoomPanController.updateTransform();
    } else {
        // Update cursor based on hover - also use expanded area for hover detection
        const padding = 10;
        if (
            mouseX >= this.viewportBox.x - padding &&
            mouseX <= this.viewportBox.x + this.viewportBox.w + padding &&
            mouseY >= this.viewportBox.y - padding &&
            mouseY <= this.viewportBox.y + this.viewportBox.h + padding
        ) {
            this.overviewCanvas.style.cursor = 'grab';
        } else {
            this.overviewCanvas.style.cursor = 'default';
        }
    }
}

    handleMouseUp() {
        if (this.isDraggingBox) {
            this.isDraggingBox = false;
            this.overviewCanvas.style.cursor = 'default';
        }
    }

    centerViewportAt(overviewX, overviewY) {
        const overviewScale = Math.min(
            this.overviewCanvas.width / this.canvas.width,
            this.overviewCanvas.height / this.canvas.height
        );

        // Convert overview coordinates to canvas coordinates
        const canvasX = overviewX / overviewScale;
        const canvasY = overviewY / overviewScale;

        // Use the zoom pan controller to center the viewport
        this.zoomPanController.centerViewportAt(canvasX, canvasY);
    }

    update() {
        this.updateOverviewCanvas();
    }

    updateOverviewCanvas() {
        // Get the current image from canvas renderer
        const canvasRenderer = this.zoomPanController.canvasRenderer;
        const source = canvasRenderer.getCurrentImageSource();

        if (!source || !this.canvas.width || !this.canvas.height) return;

        const ow = this.overviewCanvas.width;
        const oh = this.overviewCanvas.height;

        this.overviewCtx.clearRect(0, 0, ow, oh);

        // Calculate scale to fit image in overview canvas
        const scaleX = ow / this.canvas.width;
        const scaleY = oh / this.canvas.height;
        const overviewScale = Math.min(scaleX, scaleY);

        // Draw the image in overview
        if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement) {
            this.overviewCtx.drawImage(source, 0, 0, this.canvas.width * overviewScale, this.canvas.height * overviewScale);
        }

        // Calculate the viewport box in overview coordinates
        const mainCanvasWrapper = this.zoomPanController.getMainCanvasWrapper();
        const wrapperRect = mainCanvasWrapper.getBoundingClientRect();
        const canvasRect = this.canvas.getBoundingClientRect();
        const zoomScale = this.zoomPanController.getZoomScale();

        // Visible area in canvas coordinates (accounting for transform)
        const visibleLeft = Math.max(0, (wrapperRect.left - canvasRect.left) / zoomScale);
        const visibleTop = Math.max(0, (wrapperRect.top - canvasRect.top) / zoomScale);
        const visibleRight = Math.min(this.canvas.width, (wrapperRect.right - canvasRect.left) / zoomScale);
        const visibleBottom = Math.min(this.canvas.height, (wrapperRect.bottom - canvasRect.top) / zoomScale);

        // Convert to overview coordinates
        const boxX = visibleLeft * overviewScale;
        const boxY = visibleTop * overviewScale;
        const boxW = (visibleRight - visibleLeft) * overviewScale;
        const boxH = (visibleBottom - visibleTop) * overviewScale;

        this.viewportBox = { x: boxX, y: boxY, w: boxW, h: boxH };

        // Draw the viewport box
        this.overviewCtx.strokeStyle = 'red';
        this.overviewCtx.lineWidth = 2;
        this.overviewCtx.strokeRect(boxX, boxY, boxW, boxH);

        this.overviewCtx.fillStyle = 'rgba(255, 0, 0, 0.15)';
        this.overviewCtx.fillRect(boxX, boxY, boxW, boxH);
    }
}