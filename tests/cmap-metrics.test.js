import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

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
  assert.deepEqual(v.rating, { uniform: 'yes', cvdSafe: 'yes', graySafe: 'yes' });
  assert.equal(v.steps.length, 63);
  const j = metricsOf('jet');
  assert.deepEqual(j.rating, { uniform: 'no', cvdSafe: 'no', graySafe: 'no' });
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
  assert.ok(performance.now() - t0 < 3000);
});
