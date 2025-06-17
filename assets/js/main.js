print('a')

// main.js - Main application controller and initialization
import { FileHandler } from './file_handler.js';
import { CanvasRenderer } from './canvas_renderer.js';
import { ZoomPanController } from './zoom_pan_controller.js';
import { CalibrationManager } from './calibration_manager.js';
import { OverviewController } from './overview_controller.js';
import { UIManager } from './ui_manager.js';

if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.13.216/pdf.worker.min.js';
}

class ImageAnalyzerApp {
    constructor() {
        this.initializeComponents();
        this.setupEventListeners();
        this.initialize();
        window.calibrationManager = this.calibrationManager;
    }

    initializeComponents() {
        // Get DOM elements
        this.canvas = document.getElementById('imageCanvas');
        this.ctx = this.canvas.getContext('2d');

        // Initialize components
        this.fileHandler = new FileHandler(this.canvas, this.ctx);
        this.canvasRenderer = new CanvasRenderer(this.canvas, this.ctx);
        this.zoomPanController = new ZoomPanController(this.canvas, this.canvasRenderer);
        this.calibrationManager = new CalibrationManager(this.canvasRenderer);
        this.overviewController = new OverviewController(this.canvas, this.zoomPanController);
        this.uiManager = new UIManager();
    }

    setupEventListeners() {
        // File loading
        this.fileHandler.onImageLoaded = (img, isPDF, pdfImage) => {
            this.canvasRenderer.setImage(img, isPDF, pdfImage);
            this.zoomPanController.reset();
            this.canvasRenderer.draw();
        };

        // Canvas interactions
        this.setupCanvasEvents();

        // Calibration events
        this.setupCalibrationEvents();

        // PDF navigation
        this.setupPDFEvents();
    }

    setupCanvasEvents() {
        // Mouse move for crosshair and pixel info
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / this.zoomPanController.zoomScale);
            const y = Math.floor((e.clientY - rect.top) / this.zoomPanController.zoomScale);

            if (x >= 0 && x < this.canvas.width && y >= 0 && y < this.canvas.height) {
                this.uiManager.updateCursorInfo(x, y);
                this.uiManager.updateRGBAInfo(this.ctx, x, y);
                this.canvasRenderer.setLastCrossPosition(x, y);
                this.canvasRenderer.draw(x, y);
                this.uiManager.updateZoomWindow(this.ctx, x, y);
            } else {
                this.uiManager.clearRGBAInfo();
            }
        });

        // Canvas click handling
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / this.zoomPanController.zoomScale);
            const y = Math.floor((e.clientY - rect.top) / this.zoomPanController.zoomScale);

            if (x >= 0 && x < this.canvas.width && y >= 0 && y < this.canvas.height) {
                if (this.calibrationManager.isInCalibrationMode()) {
                    this.calibrationManager.handleCalibrationClick(x, y);
                    this.canvasRenderer.draw();
                } else if (this.calibrationManager.getCalibrationStatus()) {
                    this.calibrationManager.addDataPoint(x, y);
                    this.canvasRenderer.draw();
                } else {
                    this.uiManager.updatePixelInfo(this.ctx, x, y);
                }
            }
        });
    }

    setupCalibrationEvents() {
        const calibrateBtn = document.getElementById('calibrateBtn');
        const resetCalibrationBtn = document.getElementById('resetCalibrationBtn');
        const clearDataPointsBtn = document.getElementById('clearDataPointsBtn');

        calibrateBtn.addEventListener('click', () => {
            if (this.calibrationManager.finalize()) {
                this.uiManager.showDataPointsSection();
                this.uiManager.updateCalibrationInfo(this.calibrationManager.getCalibrationInfo());
            }
        });

        resetCalibrationBtn.addEventListener('click', () => {
            this.calibrationManager.reset();
            this.uiManager.hideDataPointsSection();
            this.uiManager.clearCalibrationInfo();
            this.canvasRenderer.draw();
        });

        clearDataPointsBtn.addEventListener('click', () => {
            this.calibrationManager.clearDataPoints();
            this.canvasRenderer.draw();
        });
    }

    setupPDFEvents() {
        // PDF page navigation
        const pageNumberInput = document.getElementById('pageNumber');
        pageNumberInput.addEventListener('change', () => {
            if (this.fileHandler.isPDF && this.fileHandler.currentPDF) {
                this.fileHandler.renderPage(parseInt(pageNumberInput.value, 10));
            }
        });

        // Keyboard shortcuts for PDF navigation
        document.addEventListener('keydown', (e) => {
            if (!this.fileHandler.isPDF || !this.fileHandler.currentPDF) return;

            const currentPage = parseInt(pageNumberInput.value, 10);

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const newPage = Math.max(1, currentPage - 1);
                if (newPage !== currentPage) {
                    pageNumberInput.value = newPage;
                    this.fileHandler.renderPage(newPage);
                }
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                const newPage = Math.min(this.fileHandler.currentPDF.numPages, currentPage + 1);
                if (newPage !== currentPage) {
                    pageNumberInput.value = newPage;
                    this.fileHandler.renderPage(newPage);
                }
            }
        });
    }

    initialize() {
        // Start calibration mode
        this.calibrationManager.startCalibration();

        // Set up cross-component communication
        this.zoomPanController.onTransformUpdate = () => {
            this.overviewController.update();
        };

        this.canvasRenderer.setCalibrationManager(this.calibrationManager);
        this.overviewController.setZoomPanController(this.zoomPanController);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ImageAnalyzerApp();
});