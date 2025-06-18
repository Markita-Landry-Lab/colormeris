// canvasRenderer.js - Handles all canvas drawing operations
export class CanvasRenderer {
    constructor(canvas, ctx) {
        this.canvas = canvas;
        this.ctx = ctx;

        this.img = null;
        this.isPDF = false;
        this.pdfImage = null;

        this.lastCrossX = -1;
        this.lastCrossY = -1;

        this.calibrationManager = null;

        this.crossColorSelect = document.getElementById('crossColor');
    }

    setImage(img, isPDF, pdfImage) {
        this.img = img;
        this.isPDF = isPDF;
        this.pdfImage = pdfImage;
    }

    setCalibrationManager(calibrationManager) {
        this.calibrationManager = calibrationManager;
    }

    setLastCrossPosition(x, y) {
        this.lastCrossX = x;
        this.lastCrossY = y;
    }

    draw(crossX = -1, crossY = -1) {
        this.clearCanvas();
        this.drawImage();
        this.drawCrosshair(crossX, crossY);

        if (this.calibrationManager) {
            this.drawCalibrationPoints();
            this.drawDataPoints();
        }
    }

    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    drawImage() {
        if (this.isPDF && this.pdfImage) {
            this.ctx.putImageData(this.pdfImage, 0, 0);
        } else if (this.img && this.img.complete) {
            this.ctx.drawImage(this.img, 0, 0);
        }
    }

    drawCrosshair(crossX = -1, crossY = -1) {
        // Use provided coordinates or fall back to last known position
        const x = crossX >= 0 ? crossX : this.lastCrossX;
        const y = crossY >= 0 ? crossY : this.lastCrossY;

        if (x >= 0 && y >= 0) {
            this.ctx.save();
            this.ctx.strokeStyle = this.crossColorSelect.value;
            this.ctx.lineWidth = 2;

            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
            this.ctx.stroke();
            this.ctx.restore();
        }
    }

    drawCalibrationPoints() {
        if (!this.calibrationManager) return;

        const calibrationPoints = this.calibrationManager.getCalibrationPoints();

        this.ctx.save();
        this.ctx.lineWidth = 2;

        // X1 and X2 (red dots)
        this.drawCalibrationPoint(calibrationPoints.x1, 'red', 'X1');
        this.drawCalibrationPoint(calibrationPoints.x2, 'red', 'X2');

        // Y1 and Y2 (green dots)
        this.drawCalibrationPoint(calibrationPoints.y1, 'green', 'Y1');
        this.drawCalibrationPoint(calibrationPoints.y2, 'green', 'Y2');

        this.ctx.restore();
    }

    drawCalibrationPoint(point, color, label) {
        if (!point) return;

        this.ctx.fillStyle = color;
        this.ctx.strokeStyle = 'white';
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
        this.ctx.fill();
        this.ctx.stroke();

        // Label
        this.ctx.fillStyle = 'black';
        this.ctx.font = '12px Arial';
        this.ctx.fillText(label, point.x + 8, point.y - 8);
    }

    drawDataPoints() {
        if (!this.calibrationManager) return;

        const dataPoints = this.calibrationManager.getDataPoints();

        this.ctx.save();
        this.ctx.lineWidth = 2;

        dataPoints.forEach((point) => {
            this.ctx.fillStyle = 'black';
            this.ctx.strokeStyle = 'white';
            this.ctx.beginPath();
            this.ctx.arc(point.canvas.x, point.canvas.y, 4, 0, 2 * Math.PI);
            this.ctx.fill();
            this.ctx.stroke();
        });

        this.ctx.restore();
    }

    getImageData(x, y, width = 1, height = 1) {
        return this.ctx.getImageData(x, y, width, height);
    }

    // Helper method to get the current image source for other components
    getCurrentImageSource() {
        if (this.isPDF && this.pdfImage) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            tempCanvas.getContext('2d').putImageData(this.pdfImage, 0, 0);
            return tempCanvas;
        } else if (this.img) {
            return this.img;
        }
        return null;
    }
}