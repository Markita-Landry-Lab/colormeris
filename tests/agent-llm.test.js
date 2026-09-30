import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { toReviewItem, reviewContent, reviewTool, parseReviewAnswers, fromReviewAnswer, panelRegion, colorbarRegion, pruneImages, parsePages, llmTools, validateRunnerTool, toolResultText } = CM;

const gridQ = (labelCounts) => ({
  type: 'confirm_grid_size',
  evidence: { detected: { rows: 4, cols: 5 }, rowConfidence: 2.1, colConfidence: 1.1, uncertain: true, labelCounts },
});

test('grid size: a labels option only when the label count differs', () => {
  const sq = gridQ({ rows: 0, cols: 0 });
  const same = toReviewItem(sq);
  assert.deepEqual(Object.keys(same.options), ['detected', 'neither']);
  assert.deepEqual(fromReviewAnswer(sq, same, { answer: 'detected', confidence: 0.8, reason: 'ok' }), { answer: { rows: 4, cols: 5 }, confidence: 0.8, reason: 'ok' });
  // "neither" keeps the detected size with little confidence, so a human decides.
  const n = fromReviewAnswer(sq, same, { answer: 'neither', confidence: 0.9, reason: 'one column short' });
  assert.deepEqual(n.answer, { rows: 4, cols: 5 });
  assert.ok(Math.abs(n.confidence - 0.1) < 1e-9);

  const q = gridQ({ rows: 4, cols: 6 });
  const item = toReviewItem(q);
  assert.deepEqual(Object.keys(item.options), ['detected', 'labels', 'neither']);
  assert.deepEqual(fromReviewAnswer(q, item, { answer: 'labels', confidence: 0.95 }).answer, { rows: 4, cols: 6 });
});

test('flagged cells and final acceptance map to the answer schema', () => {
  const flag = { type: 'classify_flagged', evidence: { row: 1, col: 2, rowLabel: 'R2', colLabel: 'C3', rgb: [255, 0, 0], deltaE: 47, maxDeltaE: 10, value: 23 } };
  const item = toReviewItem(flag, { flaggedCount: 1, cellCount: 20 });
  assert.equal(item.evidence.color, '#ff0000');
  assert.match(item.instructions, /row 2, column 3/);
  assert.deepEqual(Object.keys(item.options), ['keep', 'exclude', 'recheck_colorbar']);
  assert.deepEqual(fromReviewAnswer(flag, item, { answer: 'exclude', confidence: 1.4, reason: 'an asterisk' }), { answer: 'exclude', confidence: 1, reason: 'an asterisk' });

  const acc = { type: 'confirm_extraction', evidence: { rows: 4, cols: 5, flaggedCount: 0 } };
  const r2 = toReviewItem(acc, { valueRange: [0, 100], tickRange: [0, 100] });
  assert.deepEqual(fromReviewAnswer(acc, r2, { answer: 'reject', confidence: 0.7, reason: 'x' }), { answer: 'reject', confidence: 0.7, reason: 'x' });
  assert.equal(fromReviewAnswer(acc, r2, { answer: 'accept' }).confidence, null);
  assert.throws(() => fromReviewAnswer(acc, r2, undefined), /no valid answer/);
  assert.throws(() => fromReviewAnswer(acc, r2, { answer: 'maybe' }), /"maybe"/);
});

test('one reviewer request per panel: checks as text, images, a forced answer tool', () => {
  const acc = { type: 'confirm_extraction', evidence: { rows: 4, cols: 5, flaggedCount: 0 } };
  const tick = { type: 'confirm_tick_order', evidence: { ticks: [{ t: 0, value: 1 }, { t: 1, value: 0 }] } };
  const items = [acc, tick].map((q) => ({ q, item: toReviewItem(q, { fit: { medianDeltaE: 1.2 } }) }));
  const images = [{ label: 'Figure', note: 'n', dataUrl: 'data:a' }, { label: 'Reconstruction', note: 'n', dataUrl: 'data:b' }];
  const { content, keys } = reviewContent({ panelName: 'Fig 2f', items, images });
  assert.deepEqual(keys, ['q0', 'q1']);
  assert.match(content[0].text, /Panel "Fig 2f"[\s\S]*medianDeltaE[\s\S]*"q1"/);
  assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
  const tool = reviewTool(items, keys);
  assert.deepEqual(tool.function.parameters.properties.answers.properties.q0.properties.answer.enum, ['accept', 'reject']);
  assert.deepEqual(tool.function.parameters.properties.answers.required, ['q0', 'q1']);

  const call = { toolCalls: [{ function: { name: 'answer', arguments: '{"answers":{"q0":{"answer":"accept","confidence":0.9,"reason":"ok"}}}' } }] };
  assert.equal(parseReviewAnswers(call).q0.answer, 'accept');
  assert.equal(parseReviewAnswers({ content: 'Here: {"q0": {"answer": "reject"}}' }).q0.answer, 'reject');
  assert.throws(() => parseReviewAnswers({ content: 'no idea' }), /no answers/);
});

test('review regions cover the grid and colorbar, clamped to the page', () => {
  const panel = { grid: { corners: [{ x: 20, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 150 }, { x: 20, y: 150 }] }, colorbar: { start: { x: 260, y: 40 }, end: { x: 260, y: 140 }, halfWidth: 6 } };
  assert.deepEqual(panelRegion(panel, { width: 300, height: 400 }), { x0: 0, y0: 0, x1: 300, y1: 210 });
  assert.deepEqual(colorbarRegion(panel, { width: 1000, height: 1000 }), { x0: 190, y0: 0, x1: 330, y1: 210 });
  assert.equal(panelRegion({ grid: {}, colorbar: {} }, { width: 1, height: 1 }), null);
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

test('LLM tools have unique names; runner tool arguments are checked', () => {
  const names = llmTools().map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('view_page') && names.includes('set_grid') && !names.includes('answer_question') && !names.includes('decide'));
  assert.deepEqual(validateRunnerTool('view_pages_overview', { from: 1, to: 3 }), []);
  assert.ok(validateRunnerTool('view_pages_overview', { from: 1 }).length);
  assert.match(toolResultText('x'.repeat(20), 5), /cut 15 characters/);
});

test('many flagged cells map to one panel-level check', () => {
  const q = { type: 'classify_flagged_cells', evidence: { count: 90, total: 99, medianDeltaE: 30, maxDeltaE: 50, threshold: 10, sampleColors: [[0, 0, 0]], cells: [] } };
  const item = toReviewItem(q);
  assert.deepEqual(Object.keys(item.options), ['keep_all', 'exclude_all', 'recheck_colorbar']);
  assert.deepEqual(item.evidence.sampleColors, ['#000000']);
  assert.equal(fromReviewAnswer(q, item, { answer: 'recheck_colorbar', confidence: 0.94 }).answer, 'recheck_colorbar');
});

test('reviewAdvice tells the LLM what to fix, with the reviewer\'s reason', () => {
  const advice = CM.reviewAdvice(
    [
      { type: 'confirm_extraction', panelId: 'p1', answer: 'reject', applied: true, reason: 'grid is one row short' },
      { type: 'classify_flagged_cells', panelId: 'p1', answer: 'recheck_colorbar', applied: true },
      { type: 'classify_flagged', panelId: 'p1', answer: 'recheck_colorbar', applied: true },
      { type: 'confirm_extraction', panelId: 'p2', answer: 'accept', applied: true },
    ],
    (id) => ({ p1: 'Fig 2f', p2: 'Fig 3a' })[id],
  );
  assert.equal(advice.length, 2);
  assert.match(advice[0], /^Fig 2f: the extraction was rejected\. The reviewer said: "grid is one row short"/);
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
