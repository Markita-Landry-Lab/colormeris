const fileLoader = document.getElementById('fileLoader');
const canvas = document.getElementById('imageCanvas');
const ctx = canvas.getContext('2d');
const pixelInfo = document.getElementById('pixelInfo');
const cursorLocation = document.getElementById('cursorLocation');
const cursorRGBA = document.getElementById('cursorRGBA');
const pageNumberInput = document.getElementById('pageNumber');
const crossColorSelect = document.getElementById('crossColor');
const zoomCanvas = document.getElementById('zoomCanvas');
const zoomCtx = zoomCanvas.getContext('2d');

let img = new Image();
let isPDF = false;
let pdfImage = null;
let currentPDF = null;

let zoomScale = 1;
let naturalWidth = 0;
let naturalHeight = 0;
const minZoom = 0.01;
const maxZoom = 10;
const zoomStep = 0.25;
const wheelZoomStep = 0.05;

const canvasContainer = document.getElementById('canvasContainer');
const mainCanvasWrapper = document.getElementById('mainCanvasWrapper');
const zoomCanvasWrapper = document.getElementById('zoomCanvasWrapper');
const overviewCanvasWrapper = document.getElementById('overviewCanvasWrapper');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomLevelDisplay = document.getElementById('zoomLevelDisplay');
const overviewCanvas = document.getElementById('overviewCanvas');
const overviewCtx = overviewCanvas.getContext('2d');
const pdfThumbnails = document.getElementById('pdfThumbnails');

let isPanning = false;
let panStart = { x: 0, y: 0 };
let panOffset = { x: 0, y: 0 };

let isDraggingBox = false;
let dragStart = { x: 0, y: 0 };
let viewportBox = { x: 0, y: 0, w: 0, h: 0 };

// Initialize last crosshair position variables
let lastCrossX = -1;
let lastCrossY = -1;
let lastMouseX = null;
let lastMouseY = null;

// Calibration variables
let calibrationMode = false;
let calibrationStep = 0; // 0=x1, 1=x2, 2=y1, 3=y2
let calibrationPoints = {
    x1: null, x2: null, y1: null, y2: null
};
let calibrationValues = {
    x1: null, x2: null, y1: null, y2: null
};
let isCalibrated = false;
let dataPoints = [];

// Get calibration UI elements
const calibrationStatus = document.getElementById('calibrationStatus');
const x1ValueInput = document.getElementById('x1Value');
const x2ValueInput = document.getElementById('x2Value');
const y1ValueInput = document.getElementById('y1Value');
const y2ValueInput = document.getElementById('y2Value');
const calibrateBtn = document.getElementById('calibrateBtn');
const resetCalibrationBtn = document.getElementById('resetCalibrationBtn');
const calibrationInfo = document.getElementById('calibrationInfo');
const dataPointsSection = document.getElementById('dataPointsSection');
const clearDataPointsBtn = document.getElementById('clearDataPointsBtn');
const dataPointsList = document.getElementById('dataPointsList');

function getAdaptiveZoomStep(currentZoom) {
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

function updateOverviewCanvas() {
    if ((!img && !pdfImage) || !canvas.width || !canvas.height) return;

    const source = isPDF ? pdfImage : img;
    const ow = overviewCanvas.width;
    const oh = overviewCanvas.height;

    overviewCtx.clearRect(0, 0, ow, oh);

    // Calculate scale to fit image in overview canvas
    const scaleX = ow / canvas.width;
    const scaleY = oh / canvas.height;
    const overviewScale = Math.min(scaleX, scaleY);

    // Draw the image in overview
    if (isPDF && pdfImage) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        tempCanvas.getContext('2d').putImageData(pdfImage, 0, 0);
        overviewCtx.drawImage(tempCanvas, 0, 0, canvas.width * overviewScale, canvas.height * overviewScale);
    } else if (source) {
        overviewCtx.drawImage(source, 0, 0, canvas.width * overviewScale, canvas.height * overviewScale);
    }

    // Calculate the viewport box in overview coordinates
    const wrapperRect = mainCanvasWrapper.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    // Visible area in canvas coordinates (accounting for transform)
    const visibleLeft = Math.max(0, (wrapperRect.left - canvasRect.left) / zoomScale);
    const visibleTop = Math.max(0, (wrapperRect.top - canvasRect.top) / zoomScale);
    const visibleRight = Math.min(canvas.width, (wrapperRect.right - canvasRect.left) / zoomScale);
    const visibleBottom = Math.min(canvas.height, (wrapperRect.bottom - canvasRect.top) / zoomScale);

    // Convert to overview coordinates
    const boxX = visibleLeft * overviewScale;
    const boxY = visibleTop * overviewScale;
    const boxW = (visibleRight - visibleLeft) * overviewScale;
    const boxH = (visibleBottom - visibleTop) * overviewScale;

    viewportBox = { x: boxX, y: boxY, w: boxW, h: boxH };

    // Draw the viewport box
    overviewCtx.strokeStyle = 'red';
    overviewCtx.lineWidth = 2;
    overviewCtx.strokeRect(boxX, boxY, boxW, boxH);

    overviewCtx.fillStyle = 'rgba(255, 0, 0, 0.15)';
    overviewCtx.fillRect(boxX, boxY, boxW, boxH);
}

overviewCanvas.addEventListener('mousedown', (e) => {
    const rect = overviewCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Increase draggable area by adding padding around the viewport box
    const padding = 10;
    if (
        mouseX >= viewportBox.x - padding &&
        mouseX <= viewportBox.x + viewportBox.w + padding &&
        mouseY >= viewportBox.y - padding &&
        mouseY <= viewportBox.y + viewportBox.h + padding
    ) {
        isDraggingBox = true;
        dragStart = { x: mouseX, y: mouseY };
        overviewCanvas.style.cursor = 'grabbing';
    } else {
        centerViewportAt(mouseX, mouseY);
    }
});

function centerViewportAt(overviewX, overviewY) {
    const overviewScale = Math.min(overviewCanvas.width / canvas.width, overviewCanvas.height / canvas.height);

    // Convert overview coordinates to canvas coordinates
    const canvasX = overviewX / overviewScale;
    const canvasY = overviewY / overviewScale;

    // Center the viewport on this point
    const wrapperRect = mainCanvasWrapper.getBoundingClientRect();
    const targetX = canvasX * zoomScale - wrapperRect.width / 2;
    const targetY = canvasY * zoomScale - wrapperRect.height / 2;

    panOffset.x = -targetX;
    panOffset.y = -targetY;

    updateTransform();
}

overviewCanvas.addEventListener('mousemove', (e) => {
    const rect = overviewCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (isDraggingBox) {
        const dx = mouseX - dragStart.x;
        const dy = mouseY - dragStart.y;

        const overviewScale = Math.min(overviewCanvas.width / canvas.width, overviewCanvas.height / canvas.height);

        // Convert movement to canvas coordinates and apply
        const canvasDx = dx / overviewScale;
        const canvasDy = dy / overviewScale;

        panOffset.x -= canvasDx * zoomScale;
        panOffset.y -= canvasDy * zoomScale;

        dragStart = { x: mouseX, y: mouseY };
        updateTransform();
    } else {
        // Update cursor based on hover - also use expanded area for hover detection
        const padding = 10;
        if (
            mouseX >= viewportBox.x - padding &&
            mouseX <= viewportBox.x + viewportBox.w + padding &&
            mouseY >= viewportBox.y - padding &&
            mouseY <= viewportBox.y + viewportBox.h + padding
        ) {
            overviewCanvas.style.cursor = 'grab';
        } else {
            overviewCanvas.style.cursor = 'default';
        }
    }
});

function applyZoom() {
    zoomScale = Math.min(maxZoom, Math.max(minZoom, zoomScale));
    zoomLevelDisplay.textContent = `Zoom: ${Math.round(zoomScale * 100)}%`;
    updateTransform();
}

zoomInBtn.addEventListener('click', () => {
    const oldZoom = zoomScale;
    const adaptiveStep = getAdaptiveZoomStep(zoomScale);
    zoomScale = Math.min(maxZoom, zoomScale + adaptiveStep);

    // Zoom towards center of visible area
    const wrapperRect = mainCanvasWrapper.getBoundingClientRect();
    const centerX = wrapperRect.width / 2;
    const centerY = wrapperRect.height / 2;

    panOffset.x = panOffset.x - (centerX * (zoomScale / oldZoom - 1));
    panOffset.y = panOffset.y - (centerY * (zoomScale / oldZoom - 1));

    applyZoom();
    drawImage(lastCrossX, lastCrossY);
});

zoomOutBtn.addEventListener('click', () => {
    const oldZoom = zoomScale;
    const adaptiveStep = getAdaptiveZoomStep(zoomScale);
    zoomScale = Math.max(minZoom, zoomScale - adaptiveStep);

    // Zoom from center of visible area
    const wrapperRect = mainCanvasWrapper.getBoundingClientRect();
    const centerX = wrapperRect.width / 2;
    const centerY = wrapperRect.height / 2;

    panOffset.x = panOffset.x - (centerX * (zoomScale / oldZoom - 1));
    panOffset.y = panOffset.y - (centerY * (zoomScale / oldZoom - 1));

    applyZoom();
    drawImage(lastCrossX, lastCrossY);
});

fileLoader.addEventListener('change', handleFile, false);

function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();

    if (file.type === 'application/pdf') {
        isPDF = true;
        reader.onload = function (event) {
            const typedarray = new Uint8Array(event.target.result);

            pdfjsLib.getDocument({ data: typedarray }).promise.then(function (pdf) {
                currentPDF = pdf;
                pageNumberInput.min = 1;
                pageNumberInput.max = currentPDF.numPages;
                pageNumberInput.value = 1;
                generateThumbnails();
                renderPage();
            });
        };
        reader.readAsArrayBuffer(file);
    } else {
        isPDF = false;
        pdfThumbnails.style.display = 'none';
        reader.onload = function (event) {
            img = new Image();
            img.onload = function () {
                naturalWidth = img.width;
                naturalHeight = img.height;
                canvas.width = naturalWidth;
                canvas.height = naturalHeight;

                // Reset transform
                zoomScale = 1;
                panOffset = { x: 0, y: 0 };

                applyZoom();
                drawImage();
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }
}

function generateThumbnails() {
    if (!currentPDF) return;

    pdfThumbnails.style.display = 'flex';
    const thumbnailsGrid = pdfThumbnails.querySelector('.thumbnails-grid');
    thumbnailsGrid.innerHTML = '';

    for (let pageNum = 1; pageNum <= currentPDF.numPages; pageNum++) {
        currentPDF.getPage(pageNum).then(function (page) {
            const viewport = page.getViewport({ scale: 0.3 });

            const thumbnailContainer = document.createElement('div');
            thumbnailContainer.className = 'thumbnail-container';

            const thumbnailCanvas = document.createElement('canvas');
            thumbnailCanvas.className = 'thumbnail-canvas';
            thumbnailCanvas.width = viewport.width;
            thumbnailCanvas.height = viewport.height;

            const label = document.createElement('div');
            label.className = 'thumbnail-label';
            label.textContent = `${pageNum}`;

            const thumbnailCtx = thumbnailCanvas.getContext('2d');
            const renderContext = { canvasContext: thumbnailCtx, viewport: viewport };

            page.render(renderContext).promise.then(() => {
                // Update active state
                updateThumbnailActiveState();
            });

            thumbnailCanvas.addEventListener('click', () => {
                pageNumberInput.value = pageNum;
                renderPage();
            });

            thumbnailContainer.appendChild(thumbnailCanvas);
            thumbnailContainer.appendChild(label);
            thumbnailsGrid.appendChild(thumbnailContainer);
        });
    }
}

function updateThumbnailActiveState() {
    const currentPage = parseInt(pageNumberInput.value, 10);
    const thumbnailCanvases = pdfThumbnails.querySelectorAll('.thumbnail-canvas');

    thumbnailCanvases.forEach((canvas, index) => {
        if (index + 1 === currentPage) {
            canvas.classList.add('active');
        } else {
            canvas.classList.remove('active');
        }
    });
}

function renderPage() {
    const requestedPage = parseInt(pageNumberInput.value, 10);
    if (!currentPDF) return;

    const pageNum = Math.min(Math.max(1, requestedPage), currentPDF.numPages);

    // Store current zoom and pan state
    const savedZoom = zoomScale;
    const savedPanOffset = { x: panOffset.x, y: panOffset.y };

    currentPDF.getPage(pageNum).then(function (page) {
        const viewport = page.getViewport({ scale: 3 });

        naturalWidth = viewport.width;
        naturalHeight = viewport.height;
        canvas.width = naturalWidth;
        canvas.height = naturalHeight;

        // Restore zoom and pan state instead of resetting
        zoomScale = savedZoom;
        panOffset = savedPanOffset;

        applyZoom();

        const renderContext = { canvasContext: ctx, viewport: viewport };
        page.render(renderContext).promise.then(() => {
            pdfImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
            drawImage();
            updateThumbnailActiveState();
        });
    });
}

pageNumberInput.addEventListener('change', () => {
    if (isPDF && currentPDF) {
        renderPage();
    }
});

function startCalibration() {
    calibrationMode = true;
    calibrationStep = 0;
    calibrationPoints = { x1: null, x2: null, y1: null, y2: null };
    isCalibrated = false;
    dataPoints = [];
    updateCalibrationStatus();
    drawImage(lastCrossX, lastCrossY);
}

function updateCalibrationStatus() {
    const steps = ['X1 (red)', 'X2 (red)', 'Y1 (green)', 'Y2 (green)'];
    if (calibrationMode && calibrationStep < 4) {
        calibrationStatus.textContent = `Click ${steps[calibrationStep]}`;
    } else if (isCalibrated) {
        calibrationStatus.textContent = 'Calibrated - Click to add data points';
    } else {
        calibrationStatus.textContent = 'Ready to click X1';
    }
}

function convertToActualCoordinates(canvasX, canvasY) {
    if (!isCalibrated) return { x: canvasX, y: canvasY };

    const { x1, x2, y1, y2 } = calibrationPoints;
    const { x1: x1Val, x2: x2Val, y1: y1Val, y2: y2Val } = calibrationValues;

    // Linear interpolation for X
    const actualX = x1Val + (canvasX - x1.x) * (x2Val - x1Val) / (x2.x - x1.x);

    // Linear interpolation for Y (note: canvas Y is inverted)
    const actualY = y1Val + (canvasY - y1.y) * (y2Val - y1Val) / (y2.y - y1.y);

    return { x: actualX, y: actualY };
}

function addDataPoint(canvasX, canvasY) {
    const actualCoords = convertToActualCoordinates(canvasX, canvasY);
    const point = {
        canvas: { x: canvasX, y: canvasY },
        actual: { x: actualCoords.x, y: actualCoords.y }
    };
    dataPoints.push(point);
    updateDataPointsList();
    drawImage(lastCrossX, lastCrossY);
}

function updateDataPointsList() {
    dataPointsList.innerHTML = '';
    dataPoints.forEach((point, index) => {
        const div = document.createElement('div');
        div.style.fontSize = '12px';
        div.style.marginBottom = '5px';
        div.innerHTML = `
      Point ${index + 1}: (${point.actual.x.toFixed(3)}, ${point.actual.y.toFixed(3)})
      <button onclick="removeDataPoint(${index})" style="margin-left: 5px; font-size: 10px;">×</button>
    `;
        dataPointsList.appendChild(div);
    });
}

function removeDataPoint(index) {
    dataPoints.splice(index, 1);
    updateDataPointsList();
    drawImage(lastCrossX, lastCrossY);
}

function drawImage(crossX = -1, crossY = -1) {
    if (isPDF && pdfImage) {
        ctx.putImageData(pdfImage, 0, 0);
    } else if (img && img.complete) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
    }

    // Draw crosshair
    if (crossX >= 0 && crossY >= 0) {
        ctx.save();
        ctx.strokeStyle = crossColorSelect.value;
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(0, crossY);
        ctx.lineTo(canvas.width, crossY);
        ctx.moveTo(crossX, 0);
        ctx.lineTo(crossX, canvas.height);
        ctx.stroke();
        ctx.restore();
    }

    // Draw calibration points
    ctx.save();
    ctx.lineWidth = 2;

    // X1 and X2 (red dots)
    if (calibrationPoints.x1) {
        ctx.fillStyle = 'red';
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.arc(calibrationPoints.x1.x, calibrationPoints.x1.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        // Label
        ctx.fillStyle = 'black';
        ctx.font = '12px Arial';
        ctx.fillText('X1', calibrationPoints.x1.x + 8, calibrationPoints.x1.y - 8);
    }

    if (calibrationPoints.x2) {
        ctx.fillStyle = 'red';
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.arc(calibrationPoints.x2.x, calibrationPoints.x2.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.font = '12px Arial';
        ctx.fillText('X2', calibrationPoints.x2.x + 8, calibrationPoints.x2.y - 8);
    }

    // Y1 and Y2 (green dots)
    if (calibrationPoints.y1) {
        ctx.fillStyle = 'green';
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.arc(calibrationPoints.y1.x, calibrationPoints.y1.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.font = '12px Arial';
        ctx.fillText('Y1', calibrationPoints.y1.x + 8, calibrationPoints.y1.y - 8);
    }

    if (calibrationPoints.y2) {
        ctx.fillStyle = 'green';
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.arc(calibrationPoints.y2.x, calibrationPoints.y2.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.font = '12px Arial';
        ctx.fillText('Y2', calibrationPoints.y2.x + 8, calibrationPoints.y2.y - 8);
    }

    // Draw data points (black with white outline)
    dataPoints.forEach((point, index) => {
        ctx.fillStyle = 'black';
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.arc(point.canvas.x, point.canvas.y, 4, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
    });

    ctx.restore();
    updateOverviewCanvas();
}

canvas.addEventListener('mousedown', (e) => {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
});

window.addEventListener('mouseup', () => {
    if (isDraggingBox) {
        isDraggingBox = false;
        overviewCanvas.style.cursor = 'default';
    }
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = 'default';
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        panOffset.x += dx;
        panOffset.y += dy;
        panStart = { x: e.clientX, y: e.clientY };
        updateTransform();
    }
});

function updateTransform() {
    canvas.style.transform = `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`;
    zoomLevelDisplay.textContent = `Zoom: ${Math.round(zoomScale * 100)}%`;
    updateOverviewCanvas();
}

canvas.addEventListener('mousemove', function (e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoomScale);
    const y = Math.floor((e.clientY - rect.top) / zoomScale);

    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
        cursorLocation.textContent = `Cursor location: (${x}, ${y})`;

        // Get real-time RGBA values
        const imgData = ctx.getImageData(x, y, 1, 1).data;
        const [r, g, b, a] = imgData;
        cursorRGBA.textContent = `RGBA: (${r}, ${g}, ${b}, ${a})`;

        lastCrossX = x;
        lastCrossY = y;
        lastMouseX = e.clientX - rect.left;
        lastMouseY = e.clientY - rect.top;

        drawImage(x, y);

        // Update zoom window
        const zoomSize = 200;
        const zoomFactor = 3;
        const srcSize = zoomSize / zoomFactor;

        const srcX = Math.max(0, Math.min(canvas.width - srcSize, x - srcSize / 2));
        const srcY = Math.max(0, Math.min(canvas.height - srcSize, y - srcSize / 2));

        zoomCanvas.width = zoomSize;
        zoomCanvas.height = zoomSize;
        const zoomImageData = ctx.getImageData(srcX, srcY, srcSize, srcSize);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcSize;
        tempCanvas.height = srcSize;
        tempCanvas.getContext('2d').putImageData(zoomImageData, 0, 0);
        zoomCtx.drawImage(tempCanvas, 0, 0, srcSize, srcSize, 0, 0, zoomSize, zoomSize);
    } else {
        cursorRGBA.textContent = `RGBA: (hover over image)`;
    }
});

canvas.addEventListener('click', function (e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoomScale);
    const y = Math.floor((e.clientY - rect.top) / zoomScale);

    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
        if (calibrationMode && calibrationStep < 4) {
            // Handle calibration clicks
            const pointNames = ['x1', 'x2', 'y1', 'y2'];
            calibrationPoints[pointNames[calibrationStep]] = { x, y };
            calibrationStep++;

            if (calibrationStep >= 4) {
                calibrationMode = false;
            }

            updateCalibrationStatus();
            drawImage(lastCrossX, lastCrossY);
        } else if (isCalibrated) {
            // Add data point
            addDataPoint(x, y);
        } else {
            // Original pixel info functionality
            const imgData = ctx.getImageData(x, y, 1, 1).data;
            const [r, g, b, a] = imgData;
            pixelInfo.textContent = `Pixel at (${x}, ${y}): R=${r}, G=${g}, B=${b}, A=${a}`;
        }
    }
});

[mainCanvasWrapper, overviewCanvas].forEach(element => {
    element.addEventListener('wheel', function (event) {
        event.preventDefault();

        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // Store the point in canvas coordinates before zoom
        const canvasPointX = mouseX / zoomScale;
        const canvasPointY = mouseY / zoomScale;

        const oldZoom = zoomScale;
        // Use smaller wheel zoom step for even smoother wheel zooming
        const wheelStep = getAdaptiveZoomStep(zoomScale) * 0.5;

        if (event.deltaY < 0) {
            zoomScale = Math.min(maxZoom, zoomScale + wheelStep);
        } else {
            zoomScale = Math.max(minZoom, zoomScale - wheelStep);
        }

        // Adjust pan offset to keep the point under cursor
        panOffset.x += mouseX - canvasPointX * zoomScale;
        panOffset.y += mouseY - canvasPointY * zoomScale;

        // Fixed: Update zoom display when using wheel
        applyZoom();
        drawImage(lastCrossX, lastCrossY);
    }, { passive: false });
});

// Global keyboard shortcuts for PDF navigation
document.addEventListener('keydown', function (e) {
    if (!isPDF || !currentPDF) return;

    const currentPage = parseInt(pageNumberInput.value, 10);

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const newPage = Math.max(1, currentPage - 1);
        if (newPage !== currentPage) {
            pageNumberInput.value = newPage;
            renderPage();
        }
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const newPage = Math.min(currentPDF.numPages, currentPage + 1);
        if (newPage !== currentPage) {
            pageNumberInput.value = newPage;
            renderPage();
        }
    }
});

calibrateBtn.addEventListener('click', function () {
    // Get values from inputs
    calibrationValues.x1 = parseFloat(x1ValueInput.value);
    calibrationValues.x2 = parseFloat(x2ValueInput.value);
    calibrationValues.y1 = parseFloat(y1ValueInput.value);
    calibrationValues.y2 = parseFloat(y2ValueInput.value);

    // Validate inputs
    if (isNaN(calibrationValues.x1) || isNaN(calibrationValues.x2) ||
        isNaN(calibrationValues.y1) || isNaN(calibrationValues.y2)) {
        alert('Please enter valid numbers for all calibration values');
        return;
    }

    // Check if all calibration points are set
    if (!calibrationPoints.x1 || !calibrationPoints.x2 ||
        !calibrationPoints.y1 || !calibrationPoints.y2) {
        alert('Please click all 4 calibration points first (X1, X2, Y1, Y2)');
        startCalibration();
        return;
    }

    isCalibrated = true;
    calibrationMode = false;
    dataPointsSection.style.display = 'block';
    calibrationInfo.textContent = `Calibrated: X(${calibrationValues.x1}-${calibrationValues.x2}), Y(${calibrationValues.y1}-${calibrationValues.y2})`;
    updateCalibrationStatus();
});

resetCalibrationBtn.addEventListener('click', function () {
    startCalibration();
    dataPointsSection.style.display = 'none';
    calibrationInfo.textContent = 'Not calibrated';
});

clearDataPointsBtn.addEventListener('click', function () {
    dataPoints = [];
    updateDataPointsList();
    drawImage(lastCrossX, lastCrossY);
});

// Initialize calibration mode when page loads
startCalibration();