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
  assert.equal(long[4], 'e,1,R2,B,4.5,1,2,3,0.50,0');
});

test('panels keep their page; older files fall back to source.page', () => {
  const project = createProject();
  project.source = { fileName: 'fig.pdf', page: 3, renderScale: 3, width: 10, height: 10 };
  project.panels[0].page = 3;
  project.panels.push(createPanel('g', 5));
  const json = JSON.parse(JSON.stringify(serializeProject(project)));
  assert.deepEqual(json.panels.map((p) => p.page), [3, 5]);
  assert.deepEqual(parseProject(json).panels.map((p) => p.page), [3, 5]);
  json.panels.forEach((p) => delete p.page);
  assert.deepEqual(parseProject(json).panels.map((p) => p.page), [3, 3]);
});

test('IVIS panels keep their tool, regions, nudges and scale', () => {
  const project = createProject('ivis');
  project.source = { fileName: 'fig.pdf', page: 3 };
  const p = project.panels[0];
  p.grid.boxLabels = ['B-a11', 'B-a16'];
  p.rois.push(CM.createRoi('ellipse', { cx: 0.5, cy: 0.4, rx: 0.2, ry: 0.1 }, { name: 'liver' }));
  p.rois[0].offsets['1,2'] = { dx: 0.05, dy: -0.02 };
  p.rois.push(CM.createRoi('polygon', { points: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 3, y: 6 }] }, { name: 'tumour', replicate: false }));
  p.scale = { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, length: 1, unit: 'cm' };
  const json = JSON.parse(JSON.stringify(serializeProject(project)));
  assert.equal(json.version, 2);
  assert.equal(json.panels[0].tool, 'ivis');
  const back = parseProject(json);
  const q = back.panels[0];
  assert.equal(q.tool, 'ivis');
  assert.deepEqual(q.grid.boxLabels, ['B-a11', 'B-a16']);
  assert.deepEqual(q.rois.map((r) => [r.name, r.shape, r.replicate]), [['liver', 'ellipse', true], ['tumour', 'polygon', false]]);
  assert.deepEqual(q.rois[0].offsets, { '1,2': { dx: 0.05, dy: -0.02 } });
  assert.deepEqual(q.scale, { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, length: 1, unit: 'cm' });
  // Rescaling moves pixel regions and the scale bar, not box-relative regions.
  rescalePanel(q, 2);
  assert.deepEqual(q.rois[0].geom, { cx: 0.5, cy: 0.4, rx: 0.2, ry: 0.1 });
  assert.deepEqual(q.rois[1].geom.points[0], { x: 2, y: 4 });
  assert.deepEqual(q.scale.p2, { x: 200, y: 0 });
});

test('new IVIS projects use background and flag defaults suited to photos', () => {
  assert.deepEqual([createProject('ivis').panels[0].settings.grayChroma, createProject('ivis').panels[0].settings.maxDeltaE], [20, 20]);
  assert.equal(createProject().panels[0].settings.maxDeltaE, 10);
});

test('one project holds heatmap and IVIS panels', () => {
  const project = createProject('heatmap');
  project.panels.push(createPanel('mice', 1, 'ivis'));
  project.panels[1].rois.push(CM.createRoi('rect', { cx: 1, cy: 1, rx: 1, ry: 1 }, { replicate: false }));
  const json = JSON.parse(JSON.stringify(serializeProject(project)));
  assert.deepEqual(json.panels.map((p) => p.tool), ['heatmap', 'ivis']);
  assert.equal(json.panels[0].rois, undefined); // regions are only stored for IVIS panels
  const back = parseProject(json);
  assert.deepEqual(back.panels.map((p) => [p.tool, p.rois.length]), [['heatmap', 0], ['ivis', 1]]);
});

test('version 1 files: kind applies to every panel, missing kind means heatmap', () => {
  const v1 = (extra) => ({ schema: 'colormeris-project', version: 1, ...extra, panels: [{ name: 'a' }, { name: 'b', rois: [] }] });
  assert.deepEqual(parseProject(v1({ kind: 'ivis' })).panels.map((p) => p.tool), ['ivis', 'ivis']);
  assert.deepEqual(parseProject(v1({})).panels.map((p) => p.tool), ['heatmap', 'heatmap']);
  assert.throws(() => parseProject({ schema: 'colormeris-project', version: 3, panels: [{}] }), /version/);
});
