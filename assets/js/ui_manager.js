// uiManager.js - Handles UI updates and information display
export class UIManager {
    constructor() {
        this.initializeElements();
    }

    initializeElements() {
        this.pixelInfo = document.getElementById('pixelInfo');
        this.cursorLocation = document.getElementById('cursorLocation');
        this.cursorRGBA = document.getElementById('cursorRGBA');
        this.zoomCanvas = document.getElementById('zoomCanvas');
        this.zoomCtx = this.zoomCanvas.getContext('2d');
        this.dataPointsSection = document.getElementById('dataPointsSection');
        this.calibrationInfo = document.getElementById('calibrationInfo');
    }

    updateCursorInfo(x, y) {
        this.cursorLocation.textContent = `Cursor location: (${x}, ${y})`;
    }

    updateRGBAInfo(ctx, x, y) {
        try {
            const imgData = ctx.getImageData(x, y, 1, 1).data;
            const [r, g, b, a] = imgData;
            this.cursorRGBA.textContent = `RGBA: (${r}, ${g}, ${b}, ${a})`;
        } catch (error) {
            this.cursorRGBA.textContent = `RGBA: (error reading pixel)`;
        }
    }

    clearRGBAInfo() {
        this.cursorRGBA.textContent = `RGBA: (hover over image)`;
    }

    updatePixelInfo(ctx, x, y) {
        try {
            const imgData = ctx.getImageData(x, y, 1, 1).data;
            const [r, g, b, a] = imgData;
            this.pixelInfo.textContent = `Pixel at (${x}, ${y}): R=${r}, G=${g}, B=${b}, A=${a}`;
        } catch (error) {
            this.pixelInfo.textContent = `Pixel at (${x}, ${y}): Error reading pixel data`;
        }
    }

    updateZoomWindow(ctx, x, y) {
        try {
            const canvas = ctx.canvas;
            const zoomSize = 200;
            const zoomFactor = 3;
            const srcSize = zoomSize / zoomFactor;

            const srcX = Math.max(0, Math.min(canvas.width - srcSize, x - srcSize / 2));
            const srcY = Math.max(0, Math.min(canvas.height - srcSize, y - srcSize / 2));

            this.zoomCanvas.width = zoomSize;
            this.zoomCanvas.height = zoomSize;
            
            const zoomImageData = ctx.getImageData(srcX, srcY, srcSize, srcSize);
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = srcSize;
            tempCanvas.height = srcSize;
            tempCanvas.getContext('2d').putImageData(zoomImageData, 0, 0);
            
            this.zoomCtx.clearRect(0, 0, zoomSize, zoomSize);
            this.zoomCtx.drawImage(tempCanvas, 0, 0, srcSize, srcSize, 0, 0, zoomSize, zoomSize);

            // Draw crosshair in zoom window
            const centerX = zoomSize / 2;
            const centerY = zoomSize / 2;
            
            this.zoomCtx.save();
            this.zoomCtx.strokeStyle = 'red';
            this.zoomCtx.lineWidth = 1;
            this.zoomCtx.beginPath();
            this.zoomCtx.moveTo(0, centerY);
            this.zoomCtx.lineTo(zoomSize, centerY);
            this.zoomCtx.moveTo(centerX, 0);
            this.zoomCtx.lineTo(centerX, zoomSize);
            this.zoomCtx.stroke();
            this.zoomCtx.restore();
        } catch (error) {
            // Handle any errors in zoom window update silently
            console.warn('Error updating zoom window:', error);
        }
    }

    showDataPointsSection() {
        this.dataPointsSection.style.display = 'block';
    }

    hideDataPointsSection() {
        this.dataPointsSection.style.display = 'none';
    }

    updateCalibrationInfo(info) {
        this.calibrationInfo.textContent = info;
    }

    clearCalibrationInfo() {
        this.calibrationInfo.textContent = 'Not calibrated';
    }

    // Utility method to show messages to the user
    showMessage(message, type = 'info') {
        // You can extend this to show toast notifications or other UI feedback
        console.log(`${type.toUpperCase()}: ${message}`);
    }

    // Utility method to confirm user actions
    confirmAction(message) {
        return confirm(message);
    }

    // Method to handle validation errors
    showValidationError(message) {
        alert(message);
        return false;
    }
}