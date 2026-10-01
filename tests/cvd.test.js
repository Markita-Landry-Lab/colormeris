import { test } from 'node:test';
import assert from 'node:assert/strict';
import CM from './load.js';

const { CVD_TYPES, simulateCvd, lightness, grayscale, lightnessStats, parseHexColors, cmapData, citeFor, CMAP_REFS } = CM;

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const closeRgb = (a, b, eps = 1) => a.forEach((v, i) => close(v, b[i], eps));
const mapNamed = (name) => cmapData.maps.find((m) => m.name === name);

test('grays stay gray under every CVD view', () => {
  for (const type of CVD_TYPES) {
    for (const v of [0, 128, 255]) closeRgb(simulateCvd([v, v, v], type), [v, v, v]);
  }
});

test('CVD views match colorspacious (Machado 2009, severity 100)', () => {
  // Reference values from colorspacious.cspace_convert(rgb, {'name': 'sRGB1+CVD', ...}, 'sRGB1').
  const ref = {
    protanopia: [[[255, 0, 0], [109, 95, 0]], [[68, 1, 84], [0, 34, 86]], [[0, 128, 255], [41, 142, 255]]],
    deuteranopia: [[[255, 0, 0], [163, 144, 0]], [[68, 1, 84], [4, 39, 82]], [[253, 231, 37], [255, 233, 57]]],
    tritanopia: [[[255, 0, 0], [255, 0, 15]], [[253, 231, 37], [255, 214, 198]], [[0, 128, 255], [0, 159, 179]]],
  };
  for (const [type, pairs] of Object.entries(ref)) {
    for (const [rgb, want] of pairs) closeRgb(simulateCvd(rgb, type), want);
  }
  assert.throws(() => simulateCvd([0, 0, 0], 'achromatopsia'));
});

test('grayscale keeps L*', () => {
  close(lightness([68, 1, 84]), 14.9, 0.1);
  close(lightness([253, 231, 37]), 90.85, 0.1);
  const g = grayscale([253, 231, 37]);
  assert.ok(g[0] === g[1] && g[1] === g[2]);
  close(lightness(g), 90.85, 0.5);
});

test('lightnessStats: viridis is linear, jet is not', () => {
  const L = (name) => parseHexColors(mapNamed(name).colors).map(lightness);
  const v = lightnessStats(L('viridis'));
  assert.equal(v.monotonic, true);
  assert.ok(v.r2 > 0.99, `viridis r2 ${v.r2}`);
  const j = lightnessStats(L('jet'));
  assert.equal(j.monotonic, false);
  assert.ok(j.reversals >= 1);
  assert.ok(j.maxDev > 20);
  assert.ok(j.r2 >= 0 && j.r2 < 0.5, `jet r2 ${j.r2}`);
  assert.equal(lightnessStats([50, 50, 50]).r2, null);
});

test('colormap data: valid colors, groups and citations', () => {
  assert.equal(cmapData.source, 'matplotlib');
  const groups = new Set(['sequential', 'diverging', 'cyclic', 'rainbow', 'others']);
  const names = new Set();
  for (const m of cmapData.maps) {
    assert.ok(groups.has(m.group), m.name);
    assert.ok(!names.has(m.name), `duplicate ${m.name}`);
    names.add(m.name);
    assert.match(m.colors, /^([0-9a-f]{6})+$/, m.name);
    const n = m.colors.length / 6;
    if (m.kind === 'continuous') assert.equal(n, 256, m.name);
    else assert.ok(n >= 2 && n <= 20, `${m.name} has ${n}`);
    for (const key of citeFor(m.name)) assert.ok(CMAP_REFS[key], `${m.name} → ${key}`);
  }
  for (const g of groups) assert.ok(cmapData.maps.some((m) => m.group === g), g);
  const viridis = parseHexColors(mapNamed('viridis').colors);
  assert.deepEqual(viridis[0], [0x44, 0x01, 0x54]);
  assert.deepEqual(viridis[255], [0xfd, 0xe7, 0x25]);
  assert.equal(citeFor('viridis')[0], 'viridis');
});

test('image simulation: grays stay gray, severity 0 is the identity', () => {
  const { simulateCvdColor } = CM;
  for (const type of CVD_TYPES) {
    for (const model of ['recommended', ...CM.CVD_MODELS]) {
      for (const severity of [0, 0.35, 1]) {
        for (const v of [0, 90, 255]) closeRgb(simulateCvdColor([v, v, v], type, { model, severity }), [v, v, v]);
        if (severity === 0) closeRgb(simulateCvdColor([200, 30, 120], type, { model, severity }), [200, 30, 120], 0);
      }
    }
  }
});

test('image simulation: Machado at full severity equals the colormap views', () => {
  for (const type of CVD_TYPES) {
    for (const rgb of [[255, 0, 0], [68, 1, 84], [0, 128, 255]]) {
      assert.deepEqual(CM.simulateCvdColor(rgb, type, { model: 'machado', severity: 1 }), simulateCvd(rgb, type));
    }
  }
  // Half severity lies between the original and full.
  const half = CM.simulateCvdColor([255, 0, 0], 'deuteranopia', { model: 'machado', severity: 0.5 });
  assert.ok(half[0] < 255 && half[0] > 163 && half[1] > 0 && half[1] < 144);
});

test('image simulation matches DaltonLens-Python (Brettel 1997, Viénot 1999)', () => {
  // daltonlens.simulate.Simulator_Brettel1997 / Simulator_Vienot1999, severity 1 and 0.5.
  const cols = [[255, 0, 0], [0, 128, 255], [253, 231, 37], [68, 1, 84], [30, 200, 90]];
  const ref = {
    brettel: {
      protanopia: { 1: [[106, 90, 13], [0, 129, 254], [254, 229, 36], [0, 24, 84], [212, 187, 88]], 0.5: [[199, 64, 7], [0, 128, 254], [254, 230, 36], [38, 15, 84], [156, 193, 89]] },
      deuteranopia: { 1: [[163, 138, 0], [0, 132, 254], [254, 226, 39], [2, 42, 83], [185, 166, 96]], 0.5: [[215, 100, 0], [0, 130, 254], [254, 228, 38], [47, 28, 83], [137, 184, 93]] },
      tritanopia: { 1: [[254, 0, 78], [0, 147, 185], [254, 216, 221], [59, 28, 32], [94, 185, 214]], 0.5: [[254, 0, 55], [0, 138, 223], [254, 223, 164], [64, 17, 64], [71, 193, 167]] },
    },
    vienot: {
      protanopia: { 1: [[92, 92, 14], [121, 121, 254], [233, 233, 37], [19, 19, 84], [190, 190, 88]], 0.5: [[196, 65, 7], [87, 124, 254], [243, 232, 37], [50, 11, 84], [140, 195, 89]] },
      deuteranopia: { 1: [[146, 146, 0], [109, 109, 254], [237, 237, 32], [35, 35, 83], [172, 172, 95]], 0.5: [[210, 106, 0], [78, 119, 254], [245, 234, 34], [54, 23, 83], [127, 186, 92]] },
    },
  };
  for (const [model, byType] of Object.entries(ref)) {
    for (const [type, bySev] of Object.entries(byType)) {
      for (const [sev, want] of Object.entries(bySev)) {
        cols.forEach((rgb, i) => closeRgb(CM.simulateCvdColor(rgb, type, { model, severity: Number(sev) }), want[i], 2));
      }
    }
  }
});

test('resolveCvdModel follows the DaltonLens advice', () => {
  const { resolveCvdModel } = CM;
  assert.equal(resolveCvdModel('tritanopia'), 'brettel');
  assert.equal(resolveCvdModel('protanopia'), 'machado');
  assert.equal(resolveCvdModel('deuteranopia', 'recommended'), 'machado');
  assert.equal(resolveCvdModel('tritanopia', 'vienot'), 'brettel');
  assert.equal(resolveCvdModel('deuteranopia', 'vienot'), 'vienot');
  assert.equal(resolveCvdModel('tritanopia', 'machado'), 'machado');
});

test('simulateCvdPixels keeps alpha, matches the per-color path, and works in chunks', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 30, 200, 90, 128, 255, 0, 0, 0]);
  const opts = { model: 'brettel', severity: 0.7 };
  const out = CM.simulateCvdPixels(px, 'protanopia', opts);
  for (let p = 0; p < 3; p++) {
    const o = p * 4;
    assert.deepEqual([...out.slice(o, o + 3)], CM.simulateCvdColor([...px.slice(o, o + 3)], 'protanopia', opts));
    assert.equal(out[o + 3], px[o + 3]);
  }
  const chunked = new Uint8ClampedArray(px.length);
  const cache = new Map();
  CM.simulateCvdPixels(px, 'protanopia', { ...opts, out: chunked, cache, from: 0, to: 2 });
  CM.simulateCvdPixels(px, 'protanopia', { ...opts, out: chunked, cache, from: 2, to: 3 });
  assert.deepEqual(chunked, out);
  assert.equal(cache.size, 2); // the two reds share one entry
});
