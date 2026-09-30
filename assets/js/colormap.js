// Colorbar calibration: sample the bar's colors along a line, map positions
// along the bar (t in [0, 1], start → end) to data values via user ticks, and
// map arbitrary colors back to t by nearest perceptual match.

import { rgbToLab, labToRgb, colorDistance } from './color.js';
import { readPixel } from './grid.js';

export const DEFAULT_SAMPLES = 256;

// Returns [{t, rgb, lab}] sampled evenly from start to end. Each sample is the
// mean over a window of ±halfWidth pixels perpendicular to the bar.
export function sampleColorbar(img, start, end, halfWidth = 2, n = DEFAULT_SAMPLES) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const px = -dy / len;
  const py = dx / len;
  const hw = Math.max(0, Math.round(halfWidth));
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const cx = start.x + t * dx;
    const cy = start.y + t * dy;
    const sum = [0, 0, 0];
    for (let k = -hw; k <= hw; k++) {
      const [r, g, b] = readPixel(img, cx + k * px, cy + k * py);
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
    }
    const count = 2 * hw + 1;
    const rgb = sum.map((s) => s / count);
    samples.push({ t, rgb, lab: rgbToLab(rgb) });
  }
  return samples;
}

// Position of point p projected onto the line start → end, as t (unclamped).
export function projectT(start, end, p) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return ((p.x - start.x) * dx + (p.y - start.y) * dy) / len2;
}

export function pointAtT(start, end, t) {
  return { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) };
}

// Validates ticks and returns a problem description, or null when usable.
export function tickProblem(ticks, scale) {
  const valid = ticks.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value));
  if (valid.length < 2) return 'Add at least two ticks with numeric values.';
  if (scale === 'log10' && valid.some((k) => k.value <= 0)) return 'Log scale needs positive tick values.';
  const ts = new Set(valid.map((k) => k.t.toFixed(6)));
  if (ts.size < 2) return 'Ticks must be at different positions along the bar.';
  return null;
}

// Piecewise-linear t → value through the ticks, extrapolated linearly beyond
// the outermost ticks. With scale "log10" interpolation happens in log space.
export function makeValueFn(ticks, scale = 'linear') {
  if (tickProblem(ticks, scale)) return null;
  const log = scale === 'log10';
  const pts = ticks
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value))
    .map((k) => ({ t: k.t, y: log ? Math.log10(k.value) : k.value }))
    .sort((a, b) => a.t - b.t);
  // Collapse ticks at identical positions by averaging.
  const merged = [];
  for (const p of pts) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.t - p.t) < 1e-9) {
      last.y = (last.y * last.n + p.y) / (last.n + 1);
      last.n++;
    } else merged.push({ ...p, n: 1 });
  }
  return (t) => {
    let k = 0;
    while (k < merged.length - 2 && t > merged[k + 1].t) k++;
    const a = merged[k];
    const b = merged[k + 1];
    const y = a.y + ((t - a.t) / (b.t - a.t)) * (b.y - a.y);
    return log ? Math.pow(10, y) : y;
  };
}

// Nearest position along the sampled bar for a Lab color. Refines between the
// best sample and its closer neighbour by projecting in Lab space.
// Returns {t, deltaE}.
export function labToT(lab, samples, distance = 'de2000') {
  const dist = colorDistance(distance);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = dist(lab, samples[i].lab);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  let result = { t: samples[best].t, deltaE: bestD };
  for (const j of [best - 1, best + 1]) {
    if (j < 0 || j >= samples.length) continue;
    const a = samples[best].lab;
    const b = samples[j].lab;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    if (len2 === 0) continue;
    const s = ((lab[0] - a[0]) * ab[0] + (lab[1] - a[1]) * ab[1] + (lab[2] - a[2]) * ab[2]) / len2;
    if (s <= 0 || s >= 1) continue;
    const q = [a[0] + s * ab[0], a[1] + s * ab[1], a[2] + s * ab[2]];
    const d = dist(lab, q);
    if (d < result.deltaE) {
      result = { t: samples[best].t + s * (samples[j].t - samples[best].t), deltaE: d };
    }
  }
  return result;
}

// Interpolated RGB color of the sampled bar at position t (clamped to [0, 1]).
export function colorAtT(samples, t) {
  const n = samples.length;
  if (n === 0) return [0, 0, 0];
  const x = Math.min(1, Math.max(0, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  if (n === 1) return samples[0].rgb;
  const f = x - i;
  const a = samples[i].lab;
  const b = samples[i + 1].lab;
  return labToRgb([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]);
}
