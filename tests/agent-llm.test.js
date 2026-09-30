import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { batchDecisionRequests, toDecisionRequest, fromDecisionAnswer, pruneImages, parsePages, llmTools, validateRunnerTool, toolResultText } = CM;

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

test('retry guard: counts attempts, blocks after the limit, stops long failure runs', () => {
  const g = CM.createRetryGuard({ maxAttempts: 2, maxResolves: 1, maxErrorsInARow: 3 });
  const bad = { ok: false, error: 'args: bad.' };
  assert.equal(g.before('add_tick', 'p1'), null);
  assert.match(g.after('add_tick', 'p1', bad).error, /Attempt 1 of 2/);
  assert.match(g.after('add_tick', 'p1', bad).error, /now blocked/);
  assert.match(g.before('add_tick', 'p1').error, /blocked for this panel/);
  assert.equal(g.before('add_tick', 'p2'), null, 'other panels are not blocked');
  assert.equal(g.after('set_grid', 'p1', { ok: true }).ok, true);
  assert.equal(g.before('resolve_questions', 'p1'), null);
  assert.match(g.before('resolve_questions', 'p1').result, /already resolved 1 times/);
  assert.equal(g.stop, null);
  g.after('a', 'p1', bad);
  g.after('b', 'p1', bad);
  g.after('c', 'p1', bad);
  assert.match(g.stop, /3 tool calls in a row failed/);
});

test('normalizeArgs forgives nulls and at+t on add_tick', () => {
  const r = CM.normalizeArgs('add_tick', { at: { x: 1, y: 2 }, t: 0.5, value: 3, panelId: null });
  assert.deepEqual(r.args, { at: { x: 1, y: 2 }, value: 3 });
  assert.match(r.notes[0], /used at/);
  assert.deepEqual(CM.validateAction('add_tick', r.args), []);
  assert.match(CM.validateAction('add_tick', { value: 3 })[0], /"at": \{"x": 606/);
  assert.deepEqual(CM.normalizeArgs('set_review', { status: null }).args, { status: null }, 'null kept where it is a value');
});

test('batchDecisionRequests puts several questions in one request', () => {
  const acc = { type: 'confirm_extraction', evidence: { rows: 4, cols: 5, flaggedCount: 0 } };
  const tick = { type: 'confirm_tick_order', evidence: { ticks: [{ t: 0, value: 1 }, { t: 1, value: 0 }] } };
  const items = [acc, tick].map((q) => ({ q, req: toDecisionRequest(q, { fit: { medianDeltaE: 1.2 } }) }));
  const b = batchDecisionRequests(items);
  assert.deepEqual(b.keys, ['q0', 'q1']);
  assert.deepEqual(Object.keys(b.questions), ['q0', 'q1']);
  assert.equal(b.questions.q0.type, 'noul');
  assert.equal(b.state.cases.q0.fit.medianDeltaE, 1.2);
  assert.ok(b.state.cases.q1.ticks);
});

test('finishCheck refuses to stop after the first heatmap', () => {
  const { finishCheck, progressNote } = CM;
  const panels = [
    { id: 'a', name: 'Fig 2b', page: 3, ready: true, started: true },
    { id: 'b', name: 'Panel 2', page: 5, ready: false, started: false },
  ];
  const base = { pages: [3, 5], panels, checked: false, refusals: 0 };
  assert.match(finishCheck({ ...base, viewedPages: new Set([3]) }).message, /page 5 was not looked at/);
  const list = finishCheck({ ...base, viewedPages: new Set([3, 5]) });
  assert.ok(list.checklist);
  assert.match(list.message, /page 3: Fig 2b; page 5: no panels/);
  assert.equal(finishCheck({ ...base, viewedPages: new Set([3, 5]), checked: true, refusals: 1 }), null);
  const partial = [{ ...panels[0], ready: false }];
  assert.match(finishCheck({ ...base, panels: partial, viewedPages: new Set([3, 5]) }).message, /only partly calibrated/);
  assert.equal(finishCheck({ ...base, viewedPages: new Set(), refusals: 3 }), null, 'a stuck model can still end');
  assert.match(progressNote({ pages: [3, 5], viewedPages: new Set([3]), panels, currentPage: 3 }), /Page 3 panels: Fig 2b\. .*not looked at yet: 5/);
});
