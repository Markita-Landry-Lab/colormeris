import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from '../load.js';

const { identifyColorbar, identifyColors, matchLevel, parseHexColors, cmapData } = CM;

const maps = cmapData.maps.map((m) => ({ name: m.name, kind: m.kind, rgbs: parseHexColors(m.colors) }));
const byName = (n) => maps.find((m) => m.name === n);

// Deterministic noise of ±6 per channel, like JPEG artifacts.
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noisy = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v + rand() * 12 - 6))));

function bar(name, { n = 180, reversed = false } = {}) {
  const m = byName(name);
  return Array.from({ length: n }, (_, i) => {
    let t = i / (n - 1);
    if (reversed) t = 1 - t;
    const c = m.kind === 'qualitative' ? m.rgbs[Math.min(m.rgbs.length - 1, Math.floor(t * m.rgbs.length))] : m.rgbs[Math.round(t * 255)];
    return noisy(c);
  });
}

test('a sampled colorbar is matched with its direction', () => {
  for (const name of ['viridis', 'magma', 'cividis', 'RdBu', 'twilight', 'turbo', 'tab10']) {
    const best = identifyColorbar(bar(name), maps)[0];
    assert.equal(best.name, name);
    assert.equal(best.reversed, false, name);
    assert.equal(matchLevel(best.score), 'exact', `${name} ${best.score}`);
  }
  const r = identifyColorbar(bar('jet', { reversed: true }), maps)[0];
  assert.deepEqual([r.name, r.reversed], ['jet', true]);
});

test('overshoot into the frame is trimmed off', () => {
  const s = [...Array(10).fill([255, 255, 255]), ...bar('plasma'), ...Array(6).fill([0, 0, 0])];
  const best = identifyColorbar(s, maps)[0];
  assert.equal(best.name, 'plasma');
  assert.equal(matchLevel(best.score), 'exact');
  assert.ok(best.trim[0] > 0 && best.trim[1] > 0);
});

test('an unknown map gets no exact match', () => {
  // Pure red to pure green is in none of the matplotlib maps.
  const s = Array.from({ length: 100 }, (_, i) => [255 - Math.round(2.55 * i), Math.round(2.55 * i), 0]);
  assert.notEqual(matchLevel(identifyColorbar(s, maps)[0].score), 'exact');
});

test('loose pixels of a heatmap find its map, ignoring the white background', () => {
  const v = byName('inferno').rgbs;
  const px = [];
  for (let i = 0; i < 6000; i++) px.push(i % 4 === 0 ? [255, 255, 255] : noisy(v[30 + Math.floor(rand() * 200)]));
  const r = identifyColors(px, maps);
  assert.equal(r[0].name, 'inferno');
  assert.ok(r[0].coverage > 0.5);
  assert.deepEqual(identifyColors([], maps), []);
});

test('suggested reference colormap names the direction by value', () => {
  const s = bar('viridis', { reversed: true });
  const free = CM.suggestColormap(s);
  assert.deepEqual([free.mplName, free.level, free.byValue], ['viridis_r', 'exact', false]);
  // Ticks say the start has the high values: then it is plain viridis.
  assert.equal(CM.suggestColormap(s, { lowAtStart: false }).mplName, 'viridis');
  const g = CM.suggestColormap(bar('gray'));
  assert.ok(g.same.length >= 2, g.same.join());
});

test('colormapSamples reads a known map as colorbar samples', () => {
  const v = byName('viridis').rgbs;
  const s = CM.colormapSamples({ name: 'viridis', reversed: false }, 256);
  assert.equal(s.length, 256);
  assert.deepEqual([s[0].t, s[255].t], [0, 1]);
  assert.deepEqual(s[0].rgb.map(Math.round), v[0]);
  assert.deepEqual(s[255].rgb.map(Math.round), v.at(-1));
  // Reversed runs from the map's end to its start.
  const r = CM.colormapSamples({ name: 'viridis', reversed: true }, 256);
  assert.deepEqual(r[0].rgb.map(Math.round), v.at(-1));
  assert.equal(CM.colormapSamples({ name: 'no-such-map' }), null);
});
