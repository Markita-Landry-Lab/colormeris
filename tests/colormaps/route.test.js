import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from '../load.js';

const { cmapData } = CM;

test('parseCompare keeps known names once, in order, up to the cap', () => {
  const { parseCompare, COMPARE_MAX } = CM;
  const names = ['viridis', 'jet', 'RdBu', 'gray'];
  assert.deepEqual(parseCompare('jet,VIRIDIS, rdbu ,jet,nope,', names), ['jet', 'viridis', 'RdBu']);
  assert.deepEqual(parseCompare(null, names), []);
  assert.deepEqual(parseCompare('', names), []);
  assert.deepEqual(parseCompare('viridis,jet,gray', names, 2), ['viridis', 'jet']);
  const all = cmapData.maps.map((m) => m.name);
  assert.equal(parseCompare(all.join(','), all).length, COMPARE_MAX);
  assert.equal(COMPARE_MAX, 10);
});

test('parseViewerRoute: tab from the hash, map and comparison from the query', () => {
  const { parseViewerRoute } = CM;
  const names = ['viridis', 'jet', 'RdBu'];
  assert.deepEqual(parseViewerRoute('', '', names), { tab: 'browse', map: null, compare: [] });
  assert.deepEqual(parseViewerRoute('?map=JET', '#browse', names), { tab: 'browse', map: 'jet', compare: [] });
  assert.equal(parseViewerRoute('?map=nope', '', names).map, null);
  // Old shared links have only ?compare=, so they open the comparison.
  assert.deepEqual(parseViewerRoute('?compare=jet,viridis', '', names), { tab: 'compare', map: null, compare: ['jet', 'viridis'] });
  assert.equal(parseViewerRoute('?compare=jet&map=rdbu', '', names).tab, 'browse');
  assert.equal(parseViewerRoute('?compare=jet', '#Identify', names).tab, 'identify');
  assert.equal(parseViewerRoute('', '#cvd', names).tab, 'cvd');
  // Reference links leave the tab alone.
  assert.equal(parseViewerRoute('', '#ref-viridis', names).tab, null);
});
