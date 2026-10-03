import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImage, setPixel, paintColorbar, cmap, VIRIDISH } from '../helpers.js';
import CM from '../load.js';

const { extractMap, mapProblem, mapSize, axisFn, sampleProfile, colorbarLevels, mapAt, axisCoords, mapMatrixCsv, mapLongCsv, profileCsv, mapPanelFiles, createPanel, createAxisTick, createProfile, rectCorners, sampleColorbar, MAX_MAP_CELLS, FLAG_HIGH } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// A smooth field s(u, v) = (u + v) / 2 in a 200 × 100 plot area at (20, 10),
// painted pixel by pixel, and a vertical colorbar from 0 (bottom) to 1 (top).
const X0 = 20;
const Y0 = 10;
const W = 200;
const H = 100;
const truth = (u, v) => (u + v) / 2;

function scene() {
  const img = makeImage(280, 130);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) setPixel(img, X0 + x, Y0 + y, cmap(VIRIDISH, truth((x + 0.5) / W, (y + 0.5) / H)));
  }
  paintColorbar(img, 240, 250, 10, 110, VIRIDISH);
  const panel = createPanel('field', 1, 'map');
  panel.grid.corners = rectCorners({ x: X0, y: Y0 }, { x: X0 + W, y: Y0 + H });
  panel.colorbar.start = { x: 245, y: 110 };
  panel.colorbar.end = { x: 245, y: 10 };
  panel.colorbar.ticks = [{ x: 245, y: 110, value: 0 }, { x: 245, y: 10, value: 1 }];
  return { img, panel };
}

function maxError(res) {
  let worst = 0;
  for (let r = 0; r < res.rows; r++) {
    for (let c = 0; c < res.cols; c++) worst = Math.max(worst, Math.abs(res.values[r * res.cols + c] - truth((c + 0.5) / res.cols, (r + 0.5) / res.rows)));
  }
  return worst;
}

test('mapProblem guides the map workflow', () => {
  const p = createPanel('m', 1, 'map');
  assert.match(mapProblem(p), /plot area/);
  p.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 10, y: 10 });
  assert.match(mapProblem(p), /colorbar/);
  assert.equal(mapProblem(scene().panel), null);
});

test('extractMap reads a smooth field at native resolution and in bins', () => {
  const { img, panel } = scene();
  const native = extractMap(img, panel);
  assert.deepEqual([native.cols, native.rows, native.values.length], [200, 100, 20000]);
  assert.ok(maxError(native) < 0.02, `native error ${maxError(native)}`);
  assert.equal(native.stats.flagged, 0);
  assert.ok(native.stats.levels > 100, `levels ${native.stats.levels}`);
  panel.map.bin = 4;
  const binned = extractMap(img, panel);
  assert.deepEqual([binned.cols, binned.rows], [50, 25]);
  assert.ok(maxError(binned) < 0.02, `binned error ${maxError(binned)}`);
  // Bins of 2 px: a bin reaching half a pixel past the plot area (white) would
  // pull the edge bins' medians off.
  panel.map.bin = 2;
  assert.ok(maxError(extractMap(img, panel)) < 0.01, `bin 2 error ${maxError(extractMap(img, panel))}`);
  // Without axes, coordinates are pixel offsets of bin centres.
  assert.equal(binned.xAxis, false);
  assert.deepEqual([binned.xs[0], binned.ys[24]], [2, 98]);
});

test('extractMap refuses more values than MAX_MAP_CELLS', () => {
  const { panel } = scene();
  panel.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 2000, y: 1000 });
  assert.ok(2000 * 1000 > MAX_MAP_CELLS);
  assert.match(mapProblem(panel), /larger bin/);
  panel.map.bin = 2;
  assert.equal(mapProblem(panel), null);
  assert.deepEqual([mapSize(panel).cols, mapSize(panel).rows], [1000, 500]);
});

test('axis ticks give axis coordinates, linear or log', () => {
  const { img, panel } = scene();
  // x: 400 at the left edge, 700 at the right edge, ticks clicked below the plot.
  panel.map.x.ticks = [createAxisTick({ x: X0, y: Y0 + H + 5 }, 400), createAxisTick({ x: X0 + W, y: Y0 + H + 5 }, 700)];
  // y: 1000 at the top, 1 at the bottom, log scale, ticks clicked left of the plot.
  panel.map.y.scale = 'log10';
  panel.map.y.ticks = [createAxisTick({ x: X0 - 5, y: Y0 }, 1000), createAxisTick({ x: X0 - 5, y: Y0 + H }, 1)];
  const res = extractMap(img, panel);
  assert.equal(res.xAxis, true);
  close(res.xs[0], 400 + 300 * (0.5 / 200), 1e-9);
  close(res.xs[199], 700 - 300 * (0.5 / 200), 1e-9);
  close(res.ys[0], 10 ** (3 - 3 * (0.5 / 100)), 1e-6);
  const at = axisCoords(panel, { x: X0 + W / 2, y: Y0 + H / 2 });
  close(at.x, 550, 1e-9);
  close(at.y, 10 ** 1.5, 1e-6);
  // A single tick is a hint, not an error.
  panel.map.x.ticks.pop();
  const one = extractMap(img, panel);
  assert.equal(one.error, undefined);
  assert.equal(one.xAxis, false);
  assert.match(one.axisProblems[0], /X axis: Add at least two ticks/);
  assert.equal(axisFn(panel, 'x').fn, null);
});

test('pixels at the end of the colorbar are counted as possibly clipped', () => {
  const { img, panel } = scene();
  const top = cmap(VIRIDISH, 1);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(img, X0 + x, Y0 + y, top);
  const res = extractMap(img, panel);
  assert.ok(res.stats.clippedHigh >= 100, `clippedHigh ${res.stats.clippedHigh}`);
  assert.ok(res.flags[0] & FLAG_HIGH);
  assert.equal(mapAt(res, panel, { x: X0 + 1, y: Y0 + 1 }).flags & FLAG_HIGH, FLAG_HIGH);
  assert.equal(mapAt(res, panel, { x: 0, y: 0 }), null);
});

test('sampleProfile reads one value per pixel along a line', () => {
  const { img, panel } = scene();
  // Along the middle row, s goes from about 0.25 to 0.75.
  const prof = createProfile({ x: X0 + 0.5, y: Y0 + 50 }, { x: X0 + W - 0.5, y: Y0 + 50 }, { halfWidth: 1 });
  const samples = sampleProfile(img, panel, prof);
  assert.equal(samples.length, 200);
  close(samples[0].value, truth(0.5 / W, 0.5), 0.02);
  close(samples[199].value, truth(1 - 0.5 / W, 0.5), 0.02);
  close(samples[199].d, 199, 1e-9);
  assert.ok(samples.every((q) => !q.flagged));
  assert.equal(samples[0].x, null);
  panel.map.profiles.push(prof);
  assert.equal(extractMap(img, panel).profiles[prof.id].length, 200);
});

test('colorbarLevels counts the values a bar can tell apart', () => {
  const img = makeImage(20, 110);
  // Five flat color steps.
  for (let y = 0; y <= 100; y++) for (let x = 0; x < 20; x++) setPixel(img, x, y, cmap(VIRIDISH, Math.min(4, Math.floor(y / 20.2)) / 4));
  assert.equal(colorbarLevels(sampleColorbar(img, { x: 10, y: 0 }, { x: 10, y: 100 }, 1, 256)), 5);
  const smooth = makeImage(20, 260);
  paintColorbar(smooth, 0, 19, 0, 255, VIRIDISH);
  assert.ok(colorbarLevels(sampleColorbar(smooth, { x: 10, y: 0 }, { x: 10, y: 255 }, 1, 256)) > 200);
});

test('map CSVs carry axis headers', () => {
  const { img, panel } = scene();
  panel.map.bin = 50;
  panel.map.profiles.push(createProfile({ x: X0, y: Y0 + 50 }, { x: X0 + 10, y: Y0 + 50 }, { name: 'mid row' }));
  let res = extractMap(img, panel);
  let lines = mapMatrixCsv(panel, res).trim().split('\n');
  assert.equal(lines.length, 3); // header + 2 rows
  assert.equal(lines[0], 'y_px\\x_px,25,75,125,175');
  assert.equal(lines[1].split(',').length, 5);
  panel.map.x.ticks = [createAxisTick({ x: X0, y: 0 }, 0), createAxisTick({ x: X0 + W, y: 0 }, 4)];
  res = extractMap(img, panel);
  assert.match(mapMatrixCsv(panel, res), /^y_px\\x,0\.5,1\.5,2\.5,3\.5\n/);
  const long = mapLongCsv([{ panel, result: res }]).trim().split('\n');
  assert.equal(long[0], 'panel,page,row,col,x,y_px,value,deltaE,flagged,clipped');
  assert.equal(long.length, 1 + 8);
  assert.equal(profileCsv(res.profiles[panel.map.profiles[0].id]).trim().split('\n').length, 1 + 11);
  assert.deepEqual(mapPanelFiles(panel, res, 'fig').map((f) => f.path), ['data/fig_map.csv', 'data/fig_map_long.csv', 'data/fig_profile_mid_row.csv']);
  // Profiles are written even before the plot area is placed.
  panel.grid.corners = null;
  assert.deepEqual(mapPanelFiles(panel, extractMap(img, panel), 'fig').map((f) => f.path), ['data/fig_profile_mid_row.csv']);
});

test('axis ticks sit on the plot edges', () => {
  const { panel } = scene();
  const { onAxisEdge, axisEdgePoint } = CM;
  // x ticks go to the bottom edge, keeping their position along x.
  assert.deepEqual(onAxisEdge(panel, 'x', { x: X0 + 50, y: Y0 + 30 }), { x: X0 + 50, y: Y0 + H });
  // y ticks go to the left edge, keeping their position along y.
  assert.deepEqual(onAxisEdge(panel, 'y', { x: X0 + 120, y: Y0 + 25 }), { x: X0, y: Y0 + 25 });
  // A typed position (25% across) and the clamp to half a plot beyond either side.
  assert.deepEqual(axisEdgePoint(panel, 'x', 0.25), { x: X0 + W / 4, y: Y0 + H });
  assert.deepEqual(axisEdgePoint(panel, 'y', 9), { x: X0, y: Y0 + 1.5 * H });
  // Without a plot area the point stays where it was clicked.
  panel.grid.corners = null;
  assert.deepEqual(onAxisEdge(panel, 'x', { x: 1, y: 2 }), { x: 1, y: 2 });
});

test('a profile length is set in axis units or pixels', () => {
  const { panel } = scene();
  const { profileAxisKey, profileLength, profileEndForLength } = CM;
  // Diagonal-ish, mostly horizontal: measured in pixels until x is calibrated.
  const prof = createProfile({ x: X0 + 10, y: Y0 + 20 }, { x: X0 + 50, y: Y0 + 50 });
  assert.equal(profileAxisKey(panel, prof), null);
  close(profileLength(panel, prof).length, 50, 1e-9);
  let b = profileEndForLength(panel, prof, 100);
  close(b.x, X0 + 90, 1e-9);
  close(b.y, Y0 + 80, 1e-9);
  // x from 0 to 4 across the plot: 50 px per unit.
  panel.map.x.ticks = [createAxisTick({ x: X0, y: 0 }, 0), createAxisTick({ x: X0 + W, y: 0 }, 4)];
  assert.equal(profileAxisKey(panel, prof), 'x');
  close(profileLength(panel, prof).length, 0.8, 1e-9);
  b = profileEndForLength(panel, { ...prof, b }, 2);
  close(b.x, X0 + 110, 1e-6);
  close(b.y, Y0 + 95, 1e-6); // same direction
  // On a log axis the span is in axis values, too.
  panel.map.x.scale = 'log10';
  panel.map.x.ticks = [createAxisTick({ x: X0, y: 0 }, 1), createAxisTick({ x: X0 + W, y: 0 }, 100)];
  b = profileEndForLength(panel, prof, 9);
  close(profileLength(panel, { ...prof, b }).length, 9, 1e-6);
  assert.equal(profileEndForLength(panel, prof, 0), null);
});

test('several profiles go into one long CSV', () => {
  const { profilesCsv } = CM;
  const s = { d: 0, x: null, y: null, px: 1, py: 2, value: 0.5, deltaE: 1, flagged: false, clipped: false };
  const lines = profilesCsv([{ name: 'a, b', samples: [s, s] }, { name: 'c', samples: [s] }]).trim().split('\n');
  assert.equal(lines[0], 'profile,d_px,x,y,page_x,page_y,value,deltaE,flagged,clipped');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^"a, b",0\.00,/);
  assert.match(lines[3], /^c,/);
});

test('profiles can be divided by their max or mean', () => {
  const { profileDivisor, profilesCsv } = CM;
  const at = (value) => ({ d: 0, x: null, y: null, px: 0, py: 0, value, deltaE: 0, flagged: false, clipped: false });
  const samples = [at(1), at(2), at(6)];
  assert.deepEqual(profileDivisor(samples, 'raw'), { divisor: 1 });
  assert.deepEqual(profileDivisor(samples, 'max'), { divisor: 6 });
  assert.deepEqual(profileDivisor(samples, 'mean'), { divisor: 3 });
  // Not positive: dividing would flip or blow up the line.
  assert.ok(profileDivisor([at(-1), at(1)], 'mean').error);
  assert.ok(profileDivisor([at(-2), at(-1)], 'max').error);
  const lines = profilesCsv([
    { name: 'a', samples, norm: { mode: 'mean', divisor: 3 } },
    { name: 'b', samples: [at(0)], norm: { mode: 'mean', divisor: NaN } },
  ]).trim().split('\n');
  assert.equal(lines[0], 'profile,d_px,x,y,page_x,page_y,value,value_per_mean,deltaE,flagged,clipped');
  assert.equal(lines[3].split(',')[7], '2');
  assert.equal(lines[4].split(',')[7], ''); // b cannot be normalized
});

test('pasted profiles keep their place in the plot', () => {
  const { pastedProfiles } = CM;
  const from = createPanel('a', 1, 'map');
  from.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 100, y: 100 });
  const src = createProfile({ x: 10, y: 50 }, { x: 90, y: 50 }, { name: 'scan', halfWidth: 3 });
  from.map.profiles.push(src);
  // Into another panel twice the size: same place within its plot.
  const to = createPanel('b', 1, 'map');
  to.grid.corners = rectCorners({ x: 200, y: 0 }, { x: 400, y: 200 });
  const [c] = pastedProfiles(to, [src], from.grid.corners);
  close(c.a.x, 220, 1e-9);
  close(c.a.y, 100, 1e-9);
  close(c.b.x, 380, 1e-9);
  assert.equal(c.halfWidth, 3);
  assert.equal(c.name, 'scan');
  assert.notEqual(c.id, src.id);
  // Into the same panel: shifted, with a new name.
  const [d] = pastedProfiles(from, [src], null, { x: 5, y: 5 });
  assert.deepEqual([d.a, d.b, d.name], [{ x: 15, y: 55 }, { x: 95, y: 55 }, 'scan (2)']);
  // Without a plot area: the page position.
  const bare = createPanel('c', 1, 'map');
  assert.deepEqual(pastedProfiles(bare, [src], from.grid.corners)[0].a, { x: 10, y: 50 });
});
