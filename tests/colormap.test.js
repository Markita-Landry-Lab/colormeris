import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImage, paintColorbar, cmap, VIRIDISH } from './helpers.js';
import CM from './load.js';

const { sampleColorbar, projectT, makeValueFn, labToT, tickProblem, colorAtT, rgbToLab } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('projectT projects onto the line', () => {
  close(projectT({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 7 }), 0.4, 1e-12);
  close(projectT({ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 3, y: 25 }), 0.75, 1e-12);
});

test('makeValueFn interpolates and extrapolates linearly', () => {
  const f = makeValueFn([{ t: 0.2, value: 3 }, { t: 0.6, value: 5 }, { t: 1, value: 6 }]);
  close(f(0.2), 3, 1e-12);
  close(f(0.4), 4, 1e-12);
  close(f(0.8), 5.5, 1e-12);
  close(f(0), 2, 1e-12);
});

test('makeValueFn log10 interpolates in log space', () => {
  const f = makeValueFn([{ t: 0, value: 1 }, { t: 1, value: 1000 }], 'log10');
  close(f(1 / 3), 10, 1e-9);
  close(f(2 / 3), 100, 1e-9);
});

test('tickProblem reports missing or invalid ticks', () => {
  assert.ok(tickProblem([{ t: 0.1, value: 1 }], 'linear'));
  assert.ok(tickProblem([{ t: 0.1, value: 1 }, { t: 0.1, value: 2 }], 'linear'));
  assert.ok(tickProblem([{ t: 0, value: 0 }, { t: 1, value: 2 }], 'log10'));
  assert.equal(tickProblem([{ t: 0, value: 0 }, { t: 1, value: 2 }], 'linear'), null);
});

test('sampleColorbar and labToT recover positions along a painted bar', () => {
  const img = makeImage(40, 240);
  paintColorbar(img, 10, 20, 20, 219, VIRIDISH);
  const samples = sampleColorbar(img, { x: 15, y: 219 }, { x: 15, y: 20 }, 2, 256);
  assert.equal(samples.length, 256);
  for (const s of [0, 0.13, 0.5, 0.77, 1]) {
    const { t, deltaE } = labToT(rgbToLab(cmap(VIRIDISH, s)), samples);
    close(t, s, 0.01);
    assert.ok(deltaE < 2);
  }
  const mid = colorAtT(samples, 0.5);
  cmap(VIRIDISH, 0.5).forEach((c, i) => close(mid[i], c, 4));
});

test('labToT reports large deltaE for off-colormap colors', () => {
  const img = makeImage(40, 240);
  paintColorbar(img, 10, 20, 20, 219, VIRIDISH);
  const samples = sampleColorbar(img, { x: 15, y: 219 }, { x: 15, y: 20 }, 2, 256);
  assert.ok(labToT(rgbToLab([255, 0, 0]), samples).deltaE > 10);
});
