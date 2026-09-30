import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { validateAction, toolDefinitions, openQuestions, stateSnapshot, createProject, rectCorners, AGENT_ACTIONS } = CM;

test('every action has a description and an object schema', () => {
  for (const def of toolDefinitions()) {
    assert.ok(def.description, def.name);
    assert.equal(def.input_schema.type, 'object', def.name);
  }
  assert.equal(toolDefinitions().length, Object.keys(AGENT_ACTIONS).length);
});

test('validateAction rejects bad arguments with paths', () => {
  assert.deepEqual(validateAction('set_grid_size', { rows: 3, cols: 4 }), []);
  assert.match(validateAction('set_grid_size', { rows: 2.5, cols: 4 })[0], /args\.rows: must be an integer/);
  assert.match(validateAction('set_grid_size', { rows: 3 })[0], /args\.cols: required/);
  assert.match(validateAction('set_tool', { tool: 'foo' })[0], /one of heatmap, ivis/);
  assert.match(validateAction('set_tool', { tool: 'ivis', extra: 1 })[0], /unknown property/);
  assert.match(validateAction('nope')[0], /unknown action/);
});

test('extra checks cover either-or arguments', () => {
  assert.match(validateAction('set_grid', {})[0], /corners, or topLeft and bottomRight/);
  assert.deepEqual(validateAction('set_grid', { topLeft: { x: 0, y: 0 }, bottomRight: { x: 9, y: 9 } }), []);
  assert.match(validateAction('add_tick', { value: 1 })[0], /exactly one of t or at/);
  assert.match(validateAction('add_tick', { value: 1, t: 0.5, at: { x: 0, y: 0 } })[0], /exactly one/);
  assert.deepEqual(validateAction('add_tick', { value: 1, t: 0.5 }), []);
  assert.match(validateAction('add_region', { shape: 'ellipse', geom: { cx: 1, cy: 1 } })[0], /needs cx, cy, rx, ry/);
});

test('questions: grid size after detection, tick order, answered ones drop out', () => {
  const project = createProject();
  const p = project.panels[0];
  p.grid.corners = rectCorners({ x: 0, y: 0 }, { x: 100, y: 80 });
  p.grid.autoSize = true;
  p.colorbar.start = { x: 0, y: 0 };
  p.colorbar.end = { x: 0, y: 100 };
  p.colorbar.ticks = [
    { id: 't1', x: 0, y: 0, value: 0 },
    { id: 't2', x: 0, y: 50, value: 5 },
    { id: 't3', x: 0, y: 100, value: 2 },
  ];
  const detections = { [p.id]: { rows: 4, cols: 5, rowConfidence: 1.1, colConfidence: 3 } };
  const qs = openQuestions({ panels: project.panels, results: {}, detections, decisions: [] });
  const grid = qs.find((q) => q.type === 'confirm_grid_size');
  assert.deepEqual(grid.suggested, { rows: 4, cols: 5 });
  assert.equal(grid.evidence.uncertain, true);
  assert.ok(qs.some((q) => q.type === 'confirm_tick_order'));

  const after = openQuestions({ panels: project.panels, results: {}, detections, decisions: [{ questionId: grid.id, applied: true }] });
  assert.ok(!after.some((q) => q.type === 'confirm_grid_size'));
  const escalated = openQuestions({ panels: project.panels, results: {}, detections, decisions: [{ questionId: grid.id, applied: false }] });
  assert.ok(escalated.some((q) => q.type === 'confirm_grid_size'));
});

test('state snapshot is plain JSON with readiness', () => {
  const project = createProject();
  const p = project.panels[0];
  const s = stateSnapshot({ project, tool: 'heatmap', mode: null, activePanelId: p.id, problems: { [p.id]: 'Set the heatmap grid corners.' }, canUndo: false, canRedo: false, openQuestions: 0 });
  assert.equal(s.panels[0].ready, false);
  assert.equal(s.panels[0].grid, null);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
