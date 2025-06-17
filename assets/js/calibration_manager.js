// calibrationManager.js - Handles calibration points and data point conversion
export class CalibrationManager {
    constructor(canvasRenderer) {
        this.canvasRenderer = canvasRenderer;

        this.calibrationMode = false;
        this.calibrationStep = 0; // 0=x1, 1=x2, 2=y1, 3=y2
        this.calibrationPoints = {
            x1: null, x2: null, y1: null, y2: null
        };
        this.calibrationValues = {
            x1: null, x2: null, y1: null, y2: null
        };
        this.isCalibrated = false;
        this.dataPoints = [];

        this.initializeElements();
    }

    initializeElements() {
        this.calibrationStatus = document.getElementById('calibrationStatus');
        this.x1ValueInput = document.getElementById('x1Value');
        this.x2ValueInput = document.getElementById('x2Value');
        this.y1ValueInput = document.getElementById('y1Value');
        this.y2ValueInput = document.getElementById('y2Value');
        this.calibrationInfo = document.getElementById('calibrationInfo');
        this.dataPointsSection = document.getElementById('dataPointsSection');
        this.dataPointsList = document.getElementById('dataPointsList');
    }

    startCalibration() {
        this.calibrationMode = true;
        this.calibrationStep = 0;
        this.calibrationPoints = { x1: null, x2: null, y1: null, y2: null };
        this.isCalibrated = false;
        this.dataPoints = [];
        this.updateCalibrationStatus();
    }

    updateCalibrationStatus() {
        const steps = ['X1 (red)', 'X2 (red)', 'Y1 (green)', 'Y2 (green)'];
        if (this.calibrationMode && this.calibrationStep < 4) {
            this.calibrationStatus.textContent = `Click ${steps[this.calibrationStep]}`;
        } else if (this.isCalibrated) {
            this.calibrationStatus.textContent = 'Calibrated - Click to add data points';
        } else {
            this.calibrationStatus.textContent = 'Ready to click X1';
        }
    }

    handleCalibrationClick(x, y) {
        if (!this.calibrationMode || this.calibrationStep >= 4) return;

        const pointNames = ['x1', 'x2', 'y1', 'y2'];
        this.calibrationPoints[pointNames[this.calibrationStep]] = { x, y };
        this.calibrationStep++;

        if (this.calibrationStep >= 4) {
            this.calibrationMode = false;
        }

        this.updateCalibrationStatus();
    }

    finalize() {
        // Get values from inputs
        this.calibrationValues.x1 = parseFloat(this.x1ValueInput.value);
        this.calibrationValues.x2 = parseFloat(this.x2ValueInput.value);
        this.calibrationValues.y1 = parseFloat(this.y1ValueInput.value);
        this.calibrationValues.y2 = parseFloat(this.y2ValueInput.value);

        // Validate inputs
        if (isNaN(this.calibrationValues.x1) || isNaN(this.calibrationValues.x2) ||
            isNaN(this.calibrationValues.y1) || isNaN(this.calibrationValues.y2)) {
            alert('Please enter valid numbers for all calibration values');
            return false;
        }

        // Check if all calibration points are set
        if (!this.calibrationPoints.x1 || !this.calibrationPoints.x2 ||
            !this.calibrationPoints.y1 || !this.calibrationPoints.y2) {
            alert('Please click all 4 calibration points first (X1, X2, Y1, Y2)');
            this.startCalibration();
            return false;
        }

        this.isCalibrated = true;
        this.calibrationMode = false;
        this.updateCalibrationStatus();
        return true;
    }

    reset() {
        this.startCalibration();
        this.calibrationInfo.textContent = 'Not calibrated';
    }

    convertToActualCoordinates(canvasX, canvasY) {
        if (!this.isCalibrated) return { x: canvasX, y: canvasY };

        const { x1, x2, y1, y2 } = this.calibrationPoints;
        const { x1: x1Val, x2: x2Val, y1: y1Val, y2: y2Val } = this.calibrationValues;

        // Linear interpolation for X
        const actualX = x1Val + (canvasX - x1.x) * (x2Val - x1Val) / (x2.x - x1.x);

        // Linear interpolation for Y (note: canvas Y is inverted)
        const actualY = y1Val + (canvasY - y1.y) * (y2Val - y1Val) / (y2.y - y1.y);

        return { x: actualX, y: actualY };
    }

    addDataPoint(canvasX, canvasY) {
        const actualCoords = this.convertToActualCoordinates(canvasX, canvasY);
        const point = {
            canvas: { x: canvasX, y: canvasY },
            actual: { x: actualCoords.x, y: actualCoords.y }
        };
        this.dataPoints.push(point);
        this.updateDataPointsList();
    }

    updateDataPointsList() {
        this.dataPointsList.innerHTML = '';
        this.dataPoints.forEach((point, index) => {
            const div = document.createElement('div');
            div.style.fontSize = '12px';
            div.style.marginBottom = '5px';
            div.innerHTML = `
                Point ${index + 1}: (${point.actual.x.toFixed(3)}, ${point.actual.y.toFixed(3)})
                <button onclick="window.calibrationManager.removeDataPoint(${index})" style="margin-left: 5px; font-size: 10px;">×</button>
            `;
            this.dataPointsList.appendChild(div);
        });
    }

    removeDataPoint(index) {
        this.dataPoints.splice(index, 1);
        this.updateDataPointsList();
        if (this.canvasRenderer) {
            this.canvasRenderer.draw();
        }
    }

    clearDataPoints() {
        this.dataPoints = [];
        this.updateDataPointsList();
    }

    // Getters for other components
    isInCalibrationMode() {
        return this.calibrationMode;
    }

    getCalibrationStatus() {
        return this.isCalibrated;
    }

    getCalibrationPoints() {
        return this.calibrationPoints;
    }

    getDataPoints() {
        return this.dataPoints;
    }

    getCalibrationInfo() {
        if (!this.isCalibrated) return 'Not calibrated';
        return `Calibrated: X(${this.calibrationValues.x1}-${this.calibrationValues.x2}), Y(${this.calibrationValues.y1}-${this.calibrationValues.y2})`;
    }
}