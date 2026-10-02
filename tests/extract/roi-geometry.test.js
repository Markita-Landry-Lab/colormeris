import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from '../load.js';

const { shapeOutline, roiInstances, pointInPolygon, forEachPixelInPolygon, polygonArea, boxGeom, geomToBox, toBox, fromBox, createRoi, rectCorners } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('shape outlines', () => {
  const rect = shapeOutline(createRoi('rect', { cx: 5, cy: 5, rx: 2, ry: 1 }));
  assert.deepEqual(rect, [{ x: 3, y: 4 }, { x: 7, y: 4 }, { x: 7, y: 6 }, { x: 3, y: 6 }]);
  const ell = shapeOutline(createRoi('ellipse', { cx: 0, cy: 0, rx: 10, ry: 10 }));
  assert.equal(ell.length, 72);
  close(polygonArea(ell), Math.PI * 100, 2); // 72-gon is within 0.2% of the circle
  const tri = shapeOutline(createRoi('polygon', { points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }] }));
  assert.equal(polygonArea(tri), 6);
});

test('pointInPolygon and pixel scan agree with the area', () => {
  const sq = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 10, y: 20 }];
  assert.ok(pointInPolygon({ x: 15, y: 15 }, sq));
  assert.ok(!pointInPolygon({ x: 35, y: 15 }, sq));
  let n = 0;
  forEachPixelInPolygon(sq, 100, 100, () => n++);
  assert.equal(n, 200); // 20 x 10 pixel centres
  const circle = shapeOutline(createRoi('ellipse', { cx: 50, cy: 50, rx: 20, ry: 20 }));
  n = 0;
  forEachPixelInPolygon(circle, 100, 100, (x, y) => {
    n++;
    assert.ok(pointInPolygon({ x: x + 0.5, y: y + 0.5 }, circle));
  });
  close(n, Math.PI * 400, 20);
  // Clipped to the image.
  n = 0;
  forEachPixelInPolygon([{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }], 100, 100, () => n++);
  assert.equal(n, 25);
});

test('boxGeom makes circles/squares with Shift', () => {
  assert.deepEqual(boxGeom({ x: 0, y: 0 }, { x: 10, y: 4 }, false), { cx: 5, cy: 2, rx: 5, ry: 2 });
  assert.deepEqual(boxGeom({ x: 10, y: 10 }, { x: 0, y: 6 }, true), { cx: 5, cy: 5, rx: 5, ry: 5 });
});

const grid = { corners: rectCorners({ x: 0, y: 0 }, { x: 600, y: 200 }), rows: 2, cols: 6 };

test('replicated regions are copied into every box, with per-box nudges', () => {
  // Circle drawn in box (0, 1) (x 100..200, y 0..100) at its centre.
  const drawn = { cx: 150, cy: 50, rx: 20, ry: 20 };
  const geom = geomToBox('ellipse', drawn, grid, 0, 1);
  for (const [k, v] of Object.entries({ cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 })) close(geom[k], v, 1e-9);
  const roi = createRoi('ellipse', geom);
  roi.offsets['1,5'] = { dx: 0.1, dy: 0 };
  const inst = roiInstances(roi, grid);
  assert.equal(inst.length, 12);
  const centre = (o) => ({ x: o.reduce((s, p) => s + p.x, 0) / o.length, y: o.reduce((s, p) => s + p.y, 0) / o.length });
  const c00 = centre(inst.find((i) => i.row === 0 && i.col === 0).outline);
  close(c00.x, 50, 1e-9);
  close(c00.y, 50, 1e-9);
  const c15 = centre(inst.find((i) => i.row === 1 && i.col === 5).outline);
  close(c15.x, 560, 1e-9); // 550 + 0.1 box widths
  close(c15.y, 150, 1e-9);
  // Without a grid there are no copies; a single region is used as drawn.
  assert.equal(roiInstances(roi, { corners: null }).length, 0);
  const single = createRoi('rect', drawn, { replicate: false });
  assert.deepEqual(roiInstances(single, grid).map((i) => [i.row, i.col]), [[null, null]]);
});

test('box coordinates round-trip on a skewed grid', () => {
  const skew = { corners: [{ x: 10, y: 5 }, { x: 610, y: 25 }, { x: 600, y: 230 }, { x: 0, y: 210 }], rows: 2, cols: 6 };
  const p = { x: 0.3, y: 0.7 };
  const img = fromBox(skew, p, 1, 4);
  const back = toBox(skew, img, 1, 4);
  close(back.x, 0.3, 1e-6);
  close(back.y, 0.7, 1e-6);
});

test('local coordinates round-trip through a nudged copy', () => {
  const grid = { corners: rectCorners({ x: 0, y: 0 }, { x: 200, y: 100 }), rows: 1, cols: 2 };
  const roi = createRoi('ellipse', { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 });
  roi.offsets['0,1'] = { dx: 0.1, dy: 0 };
  const p = CM.roiFromLocal(roi, grid, 0, 1, { x: 0.5, y: 0.5 });
  close(p.x, 160, 1e-9); // box 1 spans x 100–200; centre 0.5 + nudge 0.1
  close(p.y, 50, 1e-9);
  const q = CM.roiToLocal(roi, grid, 0, 1, p);
  close(q.x, 0.5, 1e-9);
  close(q.y, 0.5, 1e-9);
  const single = createRoi('rect', { cx: 5, cy: 5, rx: 1, ry: 1 }, { replicate: false });
  assert.deepEqual(CM.roiToLocal(single, grid, 0, 0, { x: 3, y: 4 }), { x: 3, y: 4 });
});

test('control points, box size, equal shapes and translation', () => {
  const rect = createRoi('rect', { cx: 5, cy: 5, rx: 2, ry: 1 });
  assert.deepEqual(CM.roiControlPoints(rect), [{ x: 3, y: 4 }, { x: 7, y: 4 }, { x: 7, y: 6 }, { x: 3, y: 6 }]);
  const grid = { corners: rectCorners({ x: 0, y: 0 }, { x: 200, y: 100 }), rows: 2, cols: 4 };
  assert.deepEqual(CM.gridBoxSize(grid), { w: 50, h: 50 });
  // One box unit is 50 × 25 px, so a circle is twice as tall in box units.
  const g = CM.equalBoxGeom({ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { w: 50, h: 25 });
  close(g.rx * 50, g.ry * 25, 1e-9);
  assert.deepEqual(CM.translateGeom('rect', rect.geom, 1, -1), { cx: 6, cy: 4, rx: 2, ry: 1 });
  assert.deepEqual(CM.translateGeom('polygon', { points: [{ x: 0, y: 0 }] }, 2, 3), { points: [{ x: 2, y: 3 }] });
});
