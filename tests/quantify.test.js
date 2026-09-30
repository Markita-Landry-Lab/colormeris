import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImage, setPixel, paintColorbar, cmap, VIRIDISH } from './helpers.js';
import CM from './load.js';

const { quantifyPanel, quantifyOutline, makeClassifier, pixelArea, roiPanelProblem, createPanel, createRoi, rectCorners, roiCsv } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// A 2 x 2 grid of 100 px "mice": gray photo background with a colored square
// of known value in each box, and a vertical colorbar (value 0..100).
function scene() {
  const img = makeImage(260, 240, [128, 128, 128, 255]);
  // Gray gradient photo so background is not a single color.
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) setPixel(img, x, y, [60 + (x % 50), 60 + (x % 50), 60 + (x % 50)]);
  const values = [[20, 40], [60, 80]];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const color = cmap(VIRIDISH, values[r][c] / 100);
      for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) setPixel(img, c * 100 + x, r * 100 + y, color);
    }
  }
  paintColorbar(img, 220, 230, 10, 210, VIRIDISH);
  const panel = createPanel('k');
  panel.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 200, y: 200 });
  panel.grid.rows = 2;
  panel.grid.cols = 2;
  panel.colorbar.start = { x: 225, y: 210 };
  panel.colorbar.end = { x: 225, y: 10 };
  panel.colorbar.ticks = [{ x: 225, y: 210, value: 0 }, { x: 225, y: 10, value: 100 }];
  return { img, panel, values };
}

test('roiPanelProblem guides the IVIS workflow', () => {
  const p = createPanel();
  assert.match(roiPanelProblem(p), /colorbar/);
  const { panel } = scene();
  assert.match(roiPanelProblem(panel), /region/);
  panel.rois.push(createRoi('rect', { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }));
  panel.grid.corners = null;
  assert.match(roiPanelProblem(panel), /grid/);
});

test('grayscale pixels are background and colored pixels read through the colorbar', () => {
  const { img, panel } = scene();
  const classify = makeClassifier(img, panel);
  assert.deepEqual(classify([90, 90, 90]), { value: 0, signal: false, deltaE: 0, flagged: false });
  const c = classify(cmap(VIRIDISH, 0.5));
  assert.equal(c.signal, true);
  close(c.value, 50, 1);
});

test('replicated square ROI measures each box', () => {
  const { img, panel, values } = scene();
  // Box-coordinate square covering x,y 0.3..0.7 of each box = 40 x 40 px, of
  // which the central 20 x 20 px is signal.
  panel.rois.push(createRoi('rect', { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }, { name: 'liver' }));
  const res = quantifyPanel(img, panel);
  assert.equal(res.rows.length, 4);
  for (const r of res.rows) {
    const v = values[r.row][r.col];
    assert.equal(r.stats.areaPx, 1600);
    assert.equal(r.stats.signalPx, 400);
    close(r.stats.sum, 400 * v, 400 * 1);
    close(r.stats.mean, (400 * v) / 1600, 1);
    close(r.stats.meanSignal, v, 1);
    close(r.stats.max, v, 1);
    assert.equal(r.stats.flaggedPx, 0);
  }
  const csv = roiCsv([{ panel, result: res }]).trim().split('\n');
  assert.equal(csv[0], 'panel,page,box,row,col,roi,shape,area_px,signal_px,flagged_px,sum,mean,mean_signal,max');
  assert.equal(csv.length, 5);
  assert.match(csv[1], /^k,1,R1 C1,1,1,liver,rect,1600,400,0,/);
});

test('scale bar calibration converts areas', () => {
  const { img, panel } = scene();
  assert.equal(pixelArea(null), null);
  panel.scale = { p1: { x: 0, y: 230 }, p2: { x: 100, y: 230 }, length: 2, unit: 'cm' }; // 50 px per cm
  close(pixelArea(panel.scale), 0.0004, 1e-12);
  panel.rois.push(createRoi('rect', { cx: 50, cy: 50, rx: 20, ry: 20 }, { replicate: false }));
  const res = quantifyPanel(img, panel);
  const s = res.rows[0].stats;
  assert.equal(res.unit, 'cm');
  close(s.area, 1600 * 0.0004, 1e-9);
  close(s.signalArea, 400 * 0.0004, 1e-9);
  close(s.sumArea, s.sum * 0.0004, 1e-9);
  assert.match(roiCsv([{ panel, result: res }]).split('\n')[0], /area_cm2,signal_area_cm2,sum_x_area$/);
});

test('quantifyOutline counts off-colormap colors as flagged signal', () => {
  const { img, panel } = scene();
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(img, x, y, [255, 0, 0]);
  const s = quantifyOutline(img, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], makeClassifier(img, panel), null);
  assert.equal(s.areaPx, 100);
  assert.equal(s.flaggedPx, 100);
});
