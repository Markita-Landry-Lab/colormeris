import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImage, setPixel, paintColorbar, cmap, VIRIDISH } from '../helpers.js';
import CM from '../load.js';

const { sampleColorbar, projectT, makeValueFn, labToT, tickProblem, colorAtT, rgbToLab, refineColorbar, snapTick } = CM;

const close = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b} ${msg}`);

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

// A vertical viridis bar at x 20–39, y 30–229 (value 1 at the top) with a
// 1 px black outline and tick marks on the right at y 30, 130 and 229.
function outlinedBar() {
  const img = makeImage(90, 260);
  for (let y = 29; y <= 230; y++) for (let x = 19; x <= 40; x++) setPixel(img, x, y, [0, 0, 0]);
  paintColorbar(img, 20, 39, 30, 229, VIRIDISH);
  for (const y of [30, 130, 229]) for (let x = 41; x <= 46; x++) setPixel(img, x, y, [0, 0, 0]);
  return img;
}

test('refineColorbar centres a rough line and puts its ends on the last colors', () => {
  const img = outlinedBar();
  // Near the left edge, one end on the outline and beyond, the other short.
  const r = refineColorbar(img, { x: 22, y: 234 }, { x: 22, y: 37 });
  assert.ok(r, 'strip found');
  close(r.start.x, 29.5, 1.01);
  close(r.end.x, 29.5, 1.01);
  assert.ok(r.start.y <= 229 && r.start.y >= 227, `start y ${r.start.y}`);
  assert.ok(r.end.y >= 30 && r.end.y <= 32, `end y ${r.end.y}`);
  assert.ok(r.halfWidth >= 2 && r.halfWidth <= 6);
  assert.deepEqual(r.found, { start: true, end: true });
});

test('refineColorbar gives up when the line is not on a colorbar', () => {
  const img = makeImage(90, 260);
  assert.equal(refineColorbar(img, { x: 30, y: 230 }, { x: 30, y: 30 }), null);
});

test('snapTick moves a tick onto the nearest tick mark', () => {
  const img = outlinedBar();
  const start = { x: 29.5, y: 229 };
  const end = { x: 29.5, y: 30 };
  const k = snapTick(img, start, end, { x: 60, y: 126 });
  assert.ok(k, 'mark found');
  close(k.point.y, 130, 0.6);
  close(k.moved, -4, 0.6, 'towards the end at the top');
  assert.equal(snapTick(makeImage(90, 260), start, end, { x: 60, y: 126 }), null);
});

test('snapTick also finds marks drawn into the strip from its edge', () => {
  const img = makeImage(90, 260);
  paintColorbar(img, 20, 39, 30, 229, VIRIDISH);
  for (const x of [37, 38, 39]) for (const y of [150, 151]) setPixel(img, x, y, [20, 20, 20]);
  const k = snapTick(img, { x: 29.5, y: 229 }, { x: 29.5, y: 30 }, { x: 60, y: 146 });
  assert.ok(k, 'mark found');
  close(k.point.y, 150.5, 0.6);
});
