(function (CM) {
  'use strict';

  // Turn uploaded PDFs and images into a canvas whose pixels are analysed.

  // Resolve vendor paths relative to this script so the page works from any folder.
  const PDFJS_BASE = new URL('../../vendor/pdfjs/', document.currentScript.src).href;
  // Pages opened from disk (file://) cannot load ES module files, fetch files or
  // start workers, so there pdf.js is loaded from a classic-script embed of its
  // source, imported from blob URLs, and run without a worker.
  const FROM_DISK = location.protocol === 'file:';
  // Stay under the most restrictive browser canvas area limit (iOS Safari).
  const MAX_CANVAS_PIXELS = 16_000_000;

  let pdfjsPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(el);
    });
  }

  async function importPdfjs() {
    if (!FROM_DISK) {
      const lib = await import(`${PDFJS_BASE}pdf.min.mjs`);
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
      return lib;
    }
    await loadScript(`${PDFJS_BASE}pdf.embed.js`);
    const src = globalThis.ColormerisPdfjsSource;
    const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const lib = await import(blobUrl(src.lib));
    // Module workers cannot start from a null (file://) origin, so run the worker
    // code on the main thread; pdf.js picks it up from globalThis.pdfjsWorker.
    globalThis.pdfjsWorker = await import(blobUrl(src.worker));
    return lib;
  }

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = importPdfjs().catch((err) => {
        pdfjsPromise = null;
        throw err;
      });
    }
    return pdfjsPromise;
  }

  function fileKind(file) {
    const name = (file.name || '').toLowerCase();
    const type = file.type || '';
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (type === 'application/zip' || type === 'application/x-zip-compressed' || name.endsWith('.zip')) return 'zip';
    if (type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|tiff?)$/.test(name)) return 'image';
    return 'unknown';
  }

  async function openPdf(blob) {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    const options = { data, isEvalSupported: false };
    // Auxiliary data (CJK character maps, non-embedded fonts, JPEG 2000/JBIG2
    // decoders) is fetched on demand, which only works when served over HTTP.
    if (!FROM_DISK) {
      Object.assign(options, {
        cMapUrl: `${PDFJS_BASE}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
        wasmUrl: `${PDFJS_BASE}wasm/`,
        iccUrl: `${PDFJS_BASE}iccs/`,
      });
    }
    return lib.getDocument(options).promise;
  }

  // Largest scale ≤ requested that keeps the canvas under MAX_CANVAS_PIXELS.
  function clampScale(width, height, scale) {
    const area = width * height * scale * scale;
    return area <= MAX_CANVAS_PIXELS ? scale : Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  }

  // Render a 1-based page on a white background. Returns {canvas, scale}.
  async function renderPdfPage(doc, pageNumber, requestedScale) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = clampScale(base.width, base.height, requestedScale);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    page.cleanup();
    return { canvas, scale };
  }

  async function imageToCanvas(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = clampScale(bitmap.width, bitmap.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  }

  function canvasImageData(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG.'))), 'image/png'),
    );
  }

  async function sha256Hex(blob) {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  Object.assign(CM, { FROM_DISK, MAX_CANVAS_PIXELS, fileKind, openPdf, clampScale, renderPdfPage, imageToCanvas, canvasImageData, canvasToPngBlob, sha256Hex });
})((globalThis.Colormeris ??= {}));
