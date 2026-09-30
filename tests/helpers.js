// Synthetic image helpers for tests.
import CM from './load.js';

const { invertBilinear } = CM;

export function makeImage(width, height, fill = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

export function setPixel(img, x, y, [r, g, b]) {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}

// Piecewise-linear RGB colormap through stops, s in [0, 1].
export function cmap(stops, s) {
  const x = Math.min(1, Math.max(0, s)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((c, k) => Math.round(c + f * (stops[i + 1][k] - c)));
}

export const VIRIDISH = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

// Paint a heatmap of `matrix` (values s in [0,1]) inside a quadrilateral,
// with 1px dark grid lines between cells unless `lines` is false.
export function paintHeatmap(img, corners, matrix, stops, { lines = true } = {}) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const cellW = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) / cols;
  const cellH = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) / rows;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const { u, v } = invertBilinear(corners, { x: x + 0.5, y: y + 0.5 });
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const fu = u * cols;
      const fv = v * rows;
      const edge = lines && (Math.min(fu % 1, 1 - (fu % 1)) * cellW < 0.5 || Math.min(fv % 1, 1 - (fv % 1)) * cellH < 0.5);
      const color = edge ? [30, 30, 30] : cmap(stops, matrix[Math.floor(fv)][Math.floor(fu)]);
      setPixel(img, x, y, color);
    }
  }
}

// Vertical colorbar from (x0..x1) spanning y0 (s=1, top) to y1 (s=0, bottom).
export function paintColorbar(img, x0, x1, y0, y1, stops) {
  for (let y = y0; y <= y1; y++) {
    const s = (y1 - y) / (y1 - y0);
    for (let x = x0; x <= x1; x++) setPixel(img, x, y, cmap(stops, s));
  }
}
