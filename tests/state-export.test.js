import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { createProject, createPanel, serializeProject, parseProject, effectiveLabels, parseLabelText, rescalePanel, toWideCsv, toLongCsv, csvEscape, formatNumber, safeFileName, rectCorners } = CM;

test('effectiveLabels pads with defaults', () => {
  assert.deepEqual(effectiveLabels(['a', '', 'c'], 4, 'R'), ['a', 'R2', 'c', 'R4']);
});

test('parseLabelText splits on newlines or commas', () => {
  assert.deepEqual(parseLabelText('a1\na2\n a3 '), ['a1', 'a2', 'a3']);
  assert.deepEqual(parseLabelText('A, B,C'), ['A', 'B', 'C']);
  assert.deepEqual(parseLabelText('  '), []);
});

test('project serializes and parses back', () => {
  const project = createProject();
  project.source = { fileName: 'fig.pdf', mime: 'application/pdf', page: 3, renderScale: 3, width: 800, height: 1000 };
  const p = project.panels[0];
  p.name = 'e';
  p.grid.corners = rectCorners({ x: 10, y: 10 }, { x: 110, y: 210 });
  p.grid.rows = 16;
  p.grid.rowLabels = ['a1', 'a2'];
  p.colorbar.start = { x: 150, y: 210 };
  p.colorbar.end = { x: 150, y: 10 };
  p.colorbar.ticks = [{ x: 150, y: 110, value: 5 }];
  p.colorbar.scale = 'log10';
  const json = JSON.parse(JSON.stringify(serializeProject(project)));
  assert.equal(json.panels[0].colorbar.ticks[0].t, 0.5);
  assert.equal(json.panels[0].grid.rowLabels.length, 16);
  const back = parseProject(json);
  assert.equal(back.source.page, 3);
  const q = back.panels[0];
  assert.equal(q.name, 'e');
  assert.deepEqual(q.grid.corners, p.grid.corners);
  assert.equal(q.grid.rows, 16);
  assert.equal(q.grid.rowLabels[1], 'a2');
  assert.equal(q.colorbar.scale, 'log10');
  assert.deepEqual(q.colorbar.ticks, [{ x: 150, y: 110, value: 5 }]);
});

test('parseProject rejects foreign or future files', () => {
  assert.throws(() => parseProject({ schema: 'other' }), /schema/);
  assert.throws(() => parseProject({ schema: 'colormeris-project', version: 99, panels: [{}] }), /version/);
  assert.throws(() => parseProject({ schema: 'colormeris-project', version: 1, panels: [] }), /no panels/);
});

test('rescalePanel scales every coordinate', () => {
  const p = createPanel();
  p.grid.corners = rectCorners({ x: 1, y: 2 }, { x: 3, y: 4 });
  p.colorbar.start = { x: 5, y: 6 };
  p.colorbar.end = { x: 7, y: 8 };
  p.colorbar.ticks = [{ x: 5, y: 7, value: 1 }];
  rescalePanel(p, 2);
  assert.deepEqual(p.grid.corners[2], { x: 6, y: 8 });
  assert.deepEqual(p.colorbar.end, { x: 14, y: 16 });
  assert.deepEqual(p.colorbar.ticks[0], { x: 10, y: 14, value: 1 });
  assert.equal(p.colorbar.halfWidth, 4);
});

test('CSV helpers', () => {
  assert.equal(csvEscape('a,"b"'), '"a,""b"""');
  assert.equal(formatNumber(1 / 3), '0.333333');
  assert.equal(formatNumber(NaN), '');
  assert.equal(safeFileName(' Panel e / thiol '), 'Panel_e_thiol');

  const panel = createPanel('e');
  panel.grid.rows = 2;
  panel.grid.cols = 2;
  panel.grid.colLabels = ['A', 'B'];
  const cell = (value) => ({ value, rgb: [1, 2, 3], deltaE: 0.5, flagged: false });
  const result = { rows: 2, cols: 2, cells: [[cell(1), cell(2)], [cell(3), cell(4.5)]] };
  assert.equal(toWideCsv(panel, result), 'row\\col,A,B\nR1,1,2\nR2,3,4.5\n');
  const long = toLongCsv([{ panel, result }]).trim().split('\n');
  assert.equal(long.length, 5);
  assert.equal(long[4], 'e,R2,B,4.5,1,2,3,0.50,0');
});
