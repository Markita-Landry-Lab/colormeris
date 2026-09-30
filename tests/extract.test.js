import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPanel, panelProblem } from '../assets/js/extract.js';
import { createPanel } from '../assets/js/state.js';
import { rectCorners } from '../assets/js/grid.js';
import { makeImage, paintHeatmap, paintColorbar, VIRIDISH } from './helpers.js';

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function setup(corners, rows, cols) {
  const rand = seeded(42);
  const matrix = Array.from({ length: rows }, () => Array.from({ length: cols }, () => rand()));
  const img = makeImage(200, 260);
  paintHeatmap(img, corners, matrix, VIRIDISH);
  paintColorbar(img, 150, 160, 20, 219, VIRIDISH);
  const panel = createPanel('test');
  panel.grid.corners = corners;
  panel.grid.rows = rows;
  panel.grid.cols = cols;
  panel.colorbar.start = { x: 155, y: 219 };
  panel.colorbar.end = { x: 155, y: 20 };
  return { img, panel, matrix };
}

test('panelProblem guides through calibration steps', () => {
  const p = createPanel();
  assert.match(panelProblem(p), /grid/);
  p.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 10, y: 10 });
  assert.match(panelProblem(p), /colorbar/);
  p.colorbar.start = { x: 0, y: 100 };
  p.colorbar.end = { x: 0, y: 0 };
  assert.match(panelProblem(p), /two ticks/);
});

test('round trip on an axis-aligned heatmap with linear ticks', () => {
  const { img, panel, matrix } = setup(rectCorners({ x: 20, y: 20 }, { x: 120, y: 220 }), 8, 4);
  // Ticks at values 2 and 8 on a 0–10 bar (bottom → top).
  const yAt = (v) => 219 - (v / 10) * 199;
  panel.colorbar.ticks = [{ x: 158, y: yAt(2), value: 2 }, { x: 152, y: yAt(8), value: 8 }];
  const res = extractPanel(img, panel);
  assert.equal(res.error, undefined);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = res.cells[r][c];
      assert.ok(Math.abs(cell.value - matrix[r][c] * 10) < 0.08, `cell ${r},${c}: ${cell.value} vs ${matrix[r][c] * 10}`);
      assert.equal(cell.flagged, false);
    }
  }
});

test('round trip on a skewed heatmap with log ticks', () => {
  const corners = [{ x: 22, y: 18 }, { x: 125, y: 26 }, { x: 118, y: 232 }, { x: 14, y: 224 }];
  const { img, panel, matrix } = setup(corners, 10, 5);
  // Bar spans 10^0 .. 10^3 from bottom to top.
  const yAt = (v) => 219 - (Math.log10(v) / 3) * 199;
  panel.colorbar.scale = 'log10';
  panel.colorbar.ticks = [1, 10, 100, 1000].map((v) => ({ x: 155, y: yAt(v), value: v }));
  const res = extractPanel(img, panel);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 5; c++) {
      const expected = Math.log10(Math.pow(10, matrix[r][c] * 3));
      assert.ok(Math.abs(Math.log10(res.cells[r][c].value) - expected) < 0.03, `cell ${r},${c}`);
    }
  }
});
