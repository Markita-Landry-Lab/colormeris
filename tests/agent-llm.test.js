import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { toDecisionRequest, fromDecisionAnswer, pruneImages, parsePages, llmTools, validateRunnerTool, toolResultText } = CM;

const gridQ = (labelCounts) => ({
  type: 'confirm_grid_size',
  evidence: { detected: { rows: 4, cols: 5 }, rowConfidence: 2.1, colConfidence: 1.1, uncertain: true, labelCounts },
});

test('grid size: noul when labels agree or are missing, choice when they differ', () => {
  const same = toDecisionRequest(gridQ({ rows: 0, cols: 0 }));
  assert.equal(same.questions.answer.type, 'noul');
  assert.deepEqual(fromDecisionAnswer(gridQ({ rows: 0, cols: 0 }), same, { type: 'noul', noul: 0.8 }), { answer: { rows: 4, cols: 5 }, confidence: 0.8 });

  const q = gridQ({ rows: 4, cols: 6 });
  const req = toDecisionRequest(q);
  assert.equal(req.questions.answer.type, 'choice');
  assert.deepEqual(req.alt, { rows: 4, cols: 6 });
  assert.deepEqual(fromDecisionAnswer(q, req, { type: 'choice', choice: 'labels', confidence: 0.95 }), { answer: { rows: 4, cols: 6 }, confidence: 0.95 });
  assert.deepEqual(fromDecisionAnswer(q, req, { type: 'choice', choice: 'detected', probabilities: { detected: 0.7, labels: 0.3 } }), { answer: { rows: 4, cols: 5 }, confidence: 0.7 });
});

test('flagged cells and final acceptance map to the answer schema', () => {
  const flag = { type: 'classify_flagged', evidence: { row: 1, col: 2, rowLabel: 'R2', colLabel: 'C3', rgb: [255, 0, 0], deltaE: 47, maxDeltaE: 10, value: 23 } };
  const req = toDecisionRequest(flag, { flaggedCount: 1, cellCount: 20 });
  assert.equal(req.state.cell.color, '#ff0000');
  assert.deepEqual(Object.keys(req.questions.answer.criteria), ['keep', 'exclude', 'recheck_colorbar']);
  assert.deepEqual(fromDecisionAnswer(flag, req, { type: 'choice', choice: 'exclude', confidence: 0.9 }), { answer: 'exclude', confidence: 0.9 });

  const acc = { type: 'confirm_extraction', evidence: { rows: 4, cols: 5, flaggedCount: 0 } };
  const r2 = toDecisionRequest(acc, { valueRange: [0, 100], tickRange: [0, 100] });
  assert.deepEqual(fromDecisionAnswer(acc, r2, { type: 'noul', noul: 0.97 }), { answer: 'accept', confidence: 0.97 });
  assert.deepEqual(fromDecisionAnswer(acc, r2, { type: 'noul', noul: 0.2 }), { answer: 'reject', confidence: 0.8 });
  assert.throws(() => fromDecisionAnswer(acc, r2, undefined), /no answer/);
});

test('pruneImages keeps only the newest images', () => {
  const img = (n) => ({ role: 'user', content: [{ type: 'text', text: `i${n}` }, { type: 'image_url', imageUrl: { url: `data:${n}` } }] });
  const msgs = [{ role: 'system', content: 'x' }, img(1), { role: 'tool', toolCallId: 'a', content: '{}' }, img(2), img(3)];
  const out = pruneImages(msgs, 2);
  assert.equal(out[1].content[1].type, 'text');
  assert.equal(out[3].content[1].type, 'image_url');
  assert.equal(out[4].content[1].type, 'image_url');
  assert.equal(msgs[1].content[1].type, 'image_url', 'input is not modified');
});

test('parsePages reads ranges and clamps to the page count', () => {
  assert.deepEqual(parsePages('2-4, 7', 10), [2, 3, 4, 7]);
  assert.deepEqual(parsePages('9-12', 10), [9, 10]);
  assert.throws(() => parsePages('a', 10), /Cannot read/);
});

test('LLM tools have unique names; decide questions are checked', () => {
  const names = llmTools().map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('view_page') && names.includes('set_grid') && !names.includes('answer_question'));
  assert.deepEqual(validateRunnerTool('decide', { state: 'x', questions: { a: { type: 'noul', instructions: 'Is it?' } } }), []);
  assert.match(validateRunnerTool('decide', { state: 'x', questions: { a: { type: 'choice', instructions: 'Which?', criteria: { only: '1' } } } })[0], /at least two options/);
  assert.match(validateRunnerTool('decide', { state: 'x', questions: {} })[0], /at least one/);
  assert.match(toolResultText('x'.repeat(20), 5), /cut 15 characters/);
});

test('many flagged cells map to one panel-level decision', () => {
  const q = { type: 'classify_flagged_cells', evidence: { count: 90, total: 99, medianDeltaE: 30, maxDeltaE: 50, threshold: 10, sampleColors: [[0, 0, 0]], cells: [] } };
  const req = CM.toDecisionRequest(q);
  assert.deepEqual(Object.keys(req.questions.answer.criteria), ['keep_all', 'exclude_all', 'recheck_colorbar']);
  assert.deepEqual(req.state.sampleColors, ['#000000']);
  assert.deepEqual(CM.fromDecisionAnswer(q, req, { type: 'choice', choice: 'recheck_colorbar', confidence: 0.94 }), { answer: 'recheck_colorbar', confidence: 0.94 });
});

test('decisionAdvice tells the LLM what to fix', () => {
  const advice = CM.decisionAdvice(
    [
      { type: 'confirm_extraction', panelId: 'p1', answer: 'reject', applied: true },
      { type: 'classify_flagged_cells', panelId: 'p1', answer: 'recheck_colorbar', applied: true },
      { type: 'classify_flagged', panelId: 'p1', answer: 'recheck_colorbar', applied: true },
      { type: 'confirm_extraction', panelId: 'p2', answer: 'accept', applied: true },
    ],
    (id) => ({ p1: 'Fig 2f', p2: 'Fig 3a' })[id],
  );
  assert.equal(advice.length, 2);
  assert.match(advice[0], /^Fig 2f: the extraction was rejected/);
  assert.match(advice[1], /recheck the colorbar/);
});
