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
