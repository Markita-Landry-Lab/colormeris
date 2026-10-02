import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from '../load.js';

const { perceptualSteps, stepStats, lchOf, minSeparation, colormapMetrics, parseHexColors, cmapData } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const metricsOf = (name) => {
  const m = cmapData.maps.find((x) => x.name === name);
  return colormapMetrics(parseHexColors(m.colors), { kind: m.kind, cyclic: m.group === 'cyclic' });
};

test('perceptual steps and their spread', () => {
  const steps = perceptualSteps([[0, 0, 0], [0, 0, 0], [255, 255, 255]]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0], 0);
  assert.ok(steps[1] > 90);
  const st = stepStats([2, 2, 2]);
  assert.equal(st.cv, 0);
  assert.equal(st.total, 6);
  close(stepStats([1, 3]).cv, 0.5, 1e-12);
});

test('LCh: grays have no chroma, hue is in [0, 360)', () => {
  close(lchOf([128, 128, 128])[1], 0, 0.01);
  const [, C, h] = lchOf([0, 0, 255]);
  assert.ok(C > 100);
  assert.ok(h >= 0 && h < 360);
  close(lchOf([255, 0, 0])[2], 40, 2);
});

test('minSeparation skips near neighbors and wraps for cyclic maps', () => {
  const vals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const d = (a, b) => Math.abs(a - b);
  // gap 0.3 of 10 steps → points at least 3 apart.
  assert.deepEqual(minSeparation(vals, d, { gap: 0.3 }), { min: 3, i: 0, j: 3 });
  // The ends are 1 step apart around the circle, so a cyclic map skips that pair.
  const ring = [0, 3, 6, 9, 7, 4, 0.5];
  assert.equal(minSeparation(ring, d, { gap: 0.3 }).min, 0.5);
  assert.equal(minSeparation(ring, d, { gap: 0.3, cyclic: true }).min, 1);
  // Qualitative: every pair counts.
  assert.equal(minSeparation([5, 1, 5.5], d, { discrete: true }).min, 0.5);
  assert.equal(minSeparation([1], d), null);
});

test('ratings match the usual verdicts', () => {
  const v = metricsOf('viridis');
  assert.deepEqual(v.rating, { uniform: 'yes', cvdSafe: 'yes', graySafe: 'yes', readable: 'yes' });
  assert.equal(v.steps.length, 63);
  // jet is uneven but its colors still pin values down: readable, not uniform.
  const j = metricsOf('jet');
  assert.deepEqual(j.rating, { uniform: 'no', cvdSafe: 'no', graySafe: 'no', readable: 'yes' });
  assert.equal(metricsOf('cividis').rating.cvdSafe, 'yes');
  assert.equal(metricsOf('turbo').rating.cvdSafe, 'no');
  assert.equal(metricsOf('RdBu').rating.graySafe, 'no'); // diverging: both ends equally dark
  assert.equal(metricsOf('gray').rating.graySafe, 'yes');
  const t = metricsOf('tab10');
  assert.equal(t.rating.uniform, null);
  assert.equal(t.steps.length, 0);
  assert.equal(metricsOf('okabe_ito').rating.cvdSafe, 'yes');
});

test('every map gets metrics quickly', () => {
  const t0 = performance.now();
  for (const m of cmapData.maps) {
    const r = colormapMetrics(parseHexColors(m.colors), { kind: m.kind, cyclic: m.group === 'cyclic' });
    for (const k of ['orig', 'protanopia', 'deuteranopia', 'tritanopia', 'gray']) assert.ok(r.separations[k], `${m.name} ${k}`);
  }
  // The viewer rates every map; keep it near 6 ms per map on a laptop.
  const per = (performance.now() - t0) / cmapData.maps.length;
  assert.ok(per < 15, `${per.toFixed(1)} ms per map`);
});

test('ratingNotes: one sentence per rating that applies', () => {
  const { ratingNotes, ratingMethod } = CM;
  const v = ratingNotes(metricsOf('viridis'));
  assert.deepEqual(v.map((n) => [n.key, n.rating]), [['uniform', 'yes'], ['cvdSafe', 'yes'], ['graySafe', 'yes'], ['readable', 'yes']]);
  for (const n of v) assert.ok(n.text.length > 10 && n.label);
  // Qualitative maps have no uniform or readable rating.
  assert.deepEqual(ratingNotes(metricsOf('tab10'), { qual: true }).map((n) => n.key), ['cvdSafe', 'graySafe']);
  assert.deepEqual(Object.keys(ratingMethod()), ['uniform', 'cvdSafe', 'graySafe', 'readable']);
});

test('readability: flat zones, ambiguity and levels', () => {
  const ramp = (n, f) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));
  const grayRamp = ramp(256, (t) => [255 * t, 255 * t, 255 * t].map(Math.round));
  const r = CM.readability(grayRamp);
  assert.equal(r.gray.flat, 0);
  assert.equal(r.gray.ambiguous, 0);
  assert.ok(r.gray.levels > 25 && r.gray.levels < 40, `levels ${r.gray.levels}`);
  // A map that goes up and back down: every color has a twin on the other side.
  const tent = ramp(256, (t) => { const v = Math.round(255 * (1 - Math.abs(2 * t - 1))); return [v, 0, 255 - v]; });
  assert.ok(CM.readability(tent).orig.ambiguous > 0.8);
  // Constant first half: flat there, and spans say where.
  const half = ramp(256, (t) => (t < 0.5 ? [0, 0, 128] : [255 * t, 0, 128].map(Math.round)));
  const h = CM.readability(half).orig;
  assert.ok(h.flat > 0.4);
  assert.equal(h.flatSpans[0][0], 0);
  assert.ok(h.flatSpans[0][1] > 0.45); // up to where the jump at t = 0.5 comes within 5%
  assert.equal(CM.readability(grayRamp, { kind: 'qualitative' }), null);
});

test('readable rating separates the usual suspects', () => {
  for (const n of ['viridis', 'cividis', 'RdBu', 'turbo']) assert.equal(metricsOf(n).rating.readable, 'yes', n);
  for (const n of ['summer', 'Wistia', 'flag', 'Greys']) assert.equal(metricsOf(n).rating.readable, 'no', n);
  assert.equal(metricsOf('tab10').rating.readable, null);
});
