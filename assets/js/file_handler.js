// fileHandler.js - Handles file loading, PDF processing, and thumbnails
export class FileHandler {
    constructor(canvas, ctx) {
        this.canvas = canvas;
        this.ctx = ctx;
        
        this.img = new Image();
        this.isPDF = false;
        this.pdfImage = null;
        this.currentPDF = null;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        
        this.onImageLoaded = null; // Callback for when image is loaded
        
        this.initializeFileLoader();
    }

    initializeFileLoader() {
        const fileLoader = document.getElementById('fileLoader');
        fileLoader.addEventListener('change', (e) => this.handleFile(e), false);
    }

    handleFile(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();

        if (file.type === 'application/pdf') {
            this.isPDF = true;
            reader.onload = (event) => {
                const typedarray = new Uint8Array(event.target.result);
                
                pdfjsLib.getDocument({ data: typedarray }).promise.then((pdf) => {
                    this.currentPDF = pdf;
                    this.setupPDFControls();
                    this.generateThumbnails();
                    this.renderPage(1);
                });
            };
            reader.readAsArrayBuffer(file);
        } else {
            this.isPDF = false;
            this.hideThumbnails();
            reader.onload = (event) => {
                this.img = new Image();
                this.img.onload = () => {
                    this.naturalWidth = this.img.width;
                    this.naturalHeight = this.img.height;
                    this.canvas.width = this.naturalWidth;
                    this.canvas.height = this.naturalHeight;

                    if (this.onImageLoaded) {
                        this.onImageLoaded(this.img, false, null);
                    }
                };
                this.img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }
    }

    setupPDFControls() {
        const pageNumberInput = document.getElementById('pageNumber');
        pageNumberInput.min = 1;
        pageNumberInput.max = this.currentPDF.numPages;
        pageNumberInput.value = 1;
    }

    generateThumbnails() {
        if (!this.currentPDF) return;

        const pdfThumbnails = document.getElementById('pdfThumbnails');
        pdfThumbnails.style.display = 'flex';
        
        const thumbnailsGrid = pdfThumbnails.querySelector('.thumbnails-grid');
        thumbnailsGrid.innerHTML = '';

        for (let pageNum = 1; pageNum <= this.currentPDF.numPages; pageNum++) {
            this.currentPDF.getPage(pageNum).then((page) => {
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
                    this.updateThumbnailActiveState();
                });

                thumbnailCanvas.addEventListener('click', () => {
                    document.getElementById('pageNumber').value = pageNum;
                    this.renderPage(pageNum);
                });

                thumbnailContainer.appendChild(thumbnailCanvas);
                thumbnailContainer.appendChild(label);
                thumbnailsGrid.appendChild(thumbnailContainer);
            });
        }
    }

    updateThumbnailActiveState() {
        const currentPage = parseInt(document.getElementById('pageNumber').value, 10);
        const pdfThumbnails = document.getElementById('pdfThumbnails');
        const thumbnailCanvases = pdfThumbnails.querySelectorAll('.thumbnail-canvas');

        thumbnailCanvases.forEach((canvas, index) => {
            if (index + 1 === currentPage) {
                canvas.classList.add('active');
            } else {
                canvas.classList.remove('active');
            }
        });
    }

    renderPage(requestedPage = 1) {
        if (!this.currentPDF) return;

        const pageNum = Math.min(Math.max(1, requestedPage), this.currentPDF.numPages);

        this.currentPDF.getPage(pageNum).then((page) => {
            const viewport = page.getViewport({ scale: 3 });

            this.naturalWidth = viewport.width;
            this.naturalHeight = viewport.height;
            this.canvas.width = this.naturalWidth;
            this.canvas.height = this.naturalHeight;

            const renderContext = { canvasContext: this.ctx, viewport: viewport };
            
            page.render(renderContext).promise.then(() => {
                this.pdfImage = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                this.updateThumbnailActiveState();
                
                if (this.onImageLoaded) {
                    this.onImageLoaded(null, true, this.pdfImage);
                }
            });
        });
    }

    hideThumbnails() {
        const pdfThumbnails = document.getElementById('pdfThumbnails');
        pdfThumbnails.style.display = 'none';
    }

    getCurrentImage() {
        return this.isPDF ? this.pdfImage : this.img;
    }

    getImageDimensions() {
        return {
            width: this.naturalWidth,
            height: this.naturalHeight
        };
    }
}