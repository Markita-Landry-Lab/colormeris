// Turn uploaded PDFs and images into a canvas whose pixels are analysed.

const PDFJS_BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
// Stay under the most restrictive browser canvas area limit (iOS Safari).
export const MAX_CANVAS_PIXELS = 16_000_000;

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_BASE}pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsPromise;
}

export function fileKind(file) {
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'application/zip' || type === 'application/x-zip-compressed' || name.endsWith('.zip')) return 'zip';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|tiff?)$/.test(name)) return 'image';
  return 'unknown';
}

export async function openPdf(blob) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return lib.getDocument({
    data,
    cMapUrl: `${PDFJS_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_BASE}wasm/`,
    iccUrl: `${PDFJS_BASE}iccs/`,
    isEvalSupported: false,
  }).promise;
}

// Largest scale ≤ requested that keeps the canvas under MAX_CANVAS_PIXELS.
export function clampScale(width, height, scale) {
  const area = width * height * scale * scale;
  return area <= MAX_CANVAS_PIXELS ? scale : Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
}

// Render a 1-based page on a white background. Returns {canvas, scale}.
export async function renderPdfPage(doc, pageNumber, requestedScale) {
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

export async function imageToCanvas(blob) {
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

export function canvasImageData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG.'))), 'image/png'),
  );
}

export async function sha256Hex(blob) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
