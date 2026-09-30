import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectCorners, bilinear, invertBilinear, cellAt, sampleCell, readPixel } from '../assets/js/grid.js';
import { makeImage } from './helpers.js';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const skewed = [{ x: 10, y: 12 }, { x: 110, y: 20 }, { x: 104, y: 220 }, { x: 4, y: 210 }];

test('rectCorners orders corners TL, TR, BR, BL', () => {
  assert.deepEqual(rectCorners({ x: 50, y: 5 }, { x: 10, y: 40 }), [
    { x: 10, y: 5 }, { x: 50, y: 5 }, { x: 50, y: 40 }, { x: 10, y: 40 },
  ]);
});

test('invertBilinear inverts bilinear on a skewed quad', () => {
  for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.71]]) {
    const r = invertBilinear(skewed, bilinear(skewed, u, v));
    close(r.u, u, 1e-6);
    close(r.v, v, 1e-6);
  }
});

test('cellAt finds the cell and rejects outside points', () => {
  const grid = { corners: rectCorners({ x: 0, y: 0 }, { x: 100, y: 80 }), rows: 4, cols: 5 };
  assert.deepEqual(cellAt(grid, { x: 45, y: 70 }), { row: 3, col: 2 });
  assert.equal(cellAt(grid, { x: 120, y: 10 }), null);
});

test('readPixel composites transparency on white', () => {
  const img = makeImage(1, 1, [0, 0, 0, 0]);
  assert.deepEqual(readPixel(img, 0, 0), [255, 255, 255]);
});

test('sampleCell median ignores sparse outliers', () => {
  const img = makeImage(20, 20, [10, 20, 30, 255]);
  // Sprinkle a few bright outlier pixels inside the sampled area.
  for (const [x, y] of [[8, 8], [9, 10], [11, 9]]) img.data.set([255, 255, 255, 255], (y * 20 + x) * 4);
  const grid = { corners: rectCorners({ x: 0, y: 0 }, { x: 20, y: 20 }), rows: 1, cols: 1, sampleFraction: 0.5 };
  assert.deepEqual(sampleCell(img, grid, 0, 0), [10, 20, 30]);
});
