import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from '../load.js';
import { makeImage, setPixel } from '../helpers.js';

const { createIndexer, indexColors, recolorPixels, similarMask, tAtPixel, newColorAt, sampleColorbar, cmapColorAt, rgbToLab, deltaE2000, parseHexColors, cmapData } = CM;

const map = (name) => {
  const m = cmapData.maps.find((x) => x.name === name);
  return { name, kind: m.kind, rgbs: parseHexColors(m.colors) };
};
const jet = map('jet');
const viridis = map('viridis');
const at = (m, t) => cmapColorAt(m, t).map(Math.round);
const pixel = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
const dE = (a, b) => deltaE2000(rgbToLab(a), rgbToLab(b));

// A jet colorbar in column 0 (top = low), cells in columns 2–9 with known t,
// plus white background, black text and a gray axis pixel.
const CELLS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];
function figure() {
  const img = makeImage(12, 100);
  for (let y = 0; y < 100; y++) setPixel(img, 0, y, at(jet, y / 99));
  CELLS.forEach((t, i) => setPixel(img, 2 + (i % 8), 10 + Math.floor(i / 8), at(jet, t)));
  setPixel(img, 5, 50, [0, 0, 0]);
  setPixel(img, 6, 50, [128, 128, 128]);
  return img;
}
const barOf = (img, flip = false) => {
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 99 };
  return flip ? sampleColorbar(img, b, a, 0, 256) : sampleColorbar(img, a, b, 0, 256);
};
const cellXY = (i) => [2 + (i % 8), 10 + Math.floor(i / 8)];

test('cells on the bar are recolored into the new map at their position', () => {
  const img = figure();
  const index = indexColors(img, barOf(img));
  const out = recolorPixels(img, index, viridis, { tolerance: 12 });
  CELLS.forEach((t, i) => {
    const [x, y] = cellXY(i);
    assert.ok(dE(pixel(out, x, y), at(viridis, t)) < 3, `t=${t}`);
  });
  // The colorbar itself becomes a viridis bar.
  assert.ok(dE(pixel(out, 0, 0), at(viridis, 0)) < 3);
  assert.ok(dE(pixel(out, 0, 99), at(viridis, 1)) < 3);
});

test('background, text and axes stay as they are', () => {
  const img = figure();
  const out = recolorPixels(img, indexColors(img, barOf(img)), viridis, { tolerance: 12 });
  assert.deepEqual(pixel(out, 11, 99), [255, 255, 255]);
  assert.deepEqual(pixel(out, 5, 50), [0, 0, 0]);
  assert.deepEqual(pixel(out, 6, 50), [128, 128, 128]);
  assert.equal(out.changed, 100 + CELLS.length);
  // A tolerance of 0 leaves almost nothing to recolor; a huge one recolors all.
  assert.equal(recolorPixels(img, indexColors(img, barOf(img)), viridis, { tolerance: 1e9 }).changed, img.width * img.height);
});

test('the source image is not changed', () => {
  const img = figure();
  const before = img.data.slice();
  recolorPixels(img, indexColors(img, barOf(img)), viridis);
  assert.deepEqual(img.data, before);
});

test('reversed new map and flipped bar', () => {
  const img = figure();
  const [x, y] = cellXY(2); // t = 0.25
  const fwd = indexColors(img, barOf(img));
  assert.ok(dE(pixel(recolorPixels(img, fwd, viridis, { reversed: true }), x, y), at(viridis, 0.75)) < 3);
  // Drawn from the high end: t runs the other way, flip restores it.
  const back = indexColors(img, barOf(img, true));
  assert.ok(Math.abs(tAtPixel(back, x, y).t - 0.75) < 0.01);
  assert.ok(dE(pixel(recolorPixels(img, back, viridis, { flip: true }), x, y), at(viridis, 0.25)) < 3);
  assert.deepEqual(newColorAt(viridis, 0.75, { flip: true }), cmapColorAt(viridis, 0.25));
});

test('similarMask selects the cells near a position', () => {
  const img = figure();
  const index = indexColors(img, barOf(img));
  const { mask, count } = similarMask(index, 0.5, 0.02, 12);
  const on = (x, y) => mask[y * img.width + x];
  const [x5, y5] = cellXY(4); // t = 0.5
  assert.equal(on(x5, y5), 1);
  for (const i of [3, 5]) assert.equal(on(...cellXY(i)), 0); // 0.4 and 0.6
  // The cell plus the bar rows 48–51 (t 0.485–0.515).
  assert.equal(count, 1 + 4);
  assert.equal(on(6, 50), 0); // the gray axis pixel is off the bar
  // Every 2nd pixel: a 6 × 50 grid of the same picture.
  const half = similarMask(index, 0.5, 0.02, 12, { step: 2 });
  assert.equal(half.width, 6);
  assert.equal(half.height, 50);
  assert.equal(half.mask[(50 / 2) * 6], 1); // bar pixel (0, 50)
});

test('tAtPixel reads back positions, null off the bar', () => {
  const img = figure();
  const index = indexColors(img, barOf(img));
  CELLS.forEach((t, i) => assert.ok(Math.abs(tAtPixel(index, ...cellXY(i)).t - t) < 0.01, `t=${t}`));
  assert.equal(tAtPixel(index, 11, 99), null);
  assert.equal(tAtPixel(index, -1, 0), null);
});

test('indexing in chunks gives the same result', () => {
  const img = figure();
  const ix = createIndexer(img, barOf(img));
  let done = 0;
  while (done < 1) done = ix.step(97);
  assert.deepEqual(ix.index.t, indexColors(img, barOf(img)).t);
  assert.ok(ix.colors() < img.width * img.height);
});

test('qualitative maps recolor in blocks', () => {
  const tab10 = map('tab10');
  const img = figure();
  const out = recolorPixels(img, indexColors(img, barOf(img)), tab10);
  const [x, y] = cellXY(2); // t = 0.25 -> block 2
  assert.deepEqual(pixel(out, x, y), tab10.rgbs[2]);
});

test('sinePattern stays in [0, 1] and has the expected shape', () => {
  const n = 65;
  const w = CM.sinePattern(n, 'waves');
  assert.equal(w.length, n * n);
  assert.ok(w.every((v) => v >= 0 && v <= 1));
  assert.ok(Math.max(...w) > 1 - 1e-6 && Math.min(...w) < 1e-6); // stretched to the whole range
  // No repeats: the four quadrants differ.
  const q = (i0, j0) => Array.from({ length: 32 }, (_, j) => Array.from({ length: 32 }, (_, i) => w[(j0 + j) * n + i0 + i])).flat();
  const diff = (a, b) => a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0) / a.length;
  assert.ok(diff(q(0, 0), q(32, 0)) > 0.1 && diff(q(0, 0), q(0, 32)) > 0.1 && diff(q(0, 0), q(32, 32)) > 0.1);

  const b = CM.sinePattern(n, 'bumps');
  assert.ok(b.every((v) => v >= 0 && v <= 1));
  // Corners are (almost) the plain ramp; every bump top is 0.08 above it.
  assert.ok(b[0] < 1e-3 && Math.abs(b[n * n - 1] - 0.92) < 1e-3);
  const ramp = (i, j) => 0.92 * (i + j) / (2 * (n - 1));
  for (const [i, j] of [[16, 16], [48, 16], [48, 48]]) { // bump centers at n = 65
    const top = Math.max(...[-1, 0, 1].flatMap((dj) => [-1, 0, 1].map((di) => b[(j + dj) * n + i + di] - ramp(i + di, j + dj))));
    assert.ok(Math.abs(top - 0.08) < 0.005, `bump at ${i},${j}: ${top}`);
  }
});

test('colorsLut and paintValues map values to the colors', () => {
  const lut = CM.colorsLut([[0, 0, 0], [255, 255, 255]]);
  const px = CM.paintValues(Float32Array.from([0, 0.5, 1]), lut);
  assert.deepEqual(Array.from(px.slice(0, 4)), [0, 0, 0, 255]);
  assert.ok(Math.abs(px[4] - 128) <= 1);
  assert.deepEqual(Array.from(px.slice(8, 12)), [255, 255, 255, 255]);
  // Qualitative: two equal bands, no blending.
  const q = CM.paintValues(Float32Array.from([0.49, 0.51]), CM.colorsLut([[255, 0, 0], [0, 0, 255]], true));
  assert.deepEqual(Array.from(q), [255, 0, 0, 255, 0, 0, 255, 255]);
});
