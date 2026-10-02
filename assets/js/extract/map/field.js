(function (CM) {
  'use strict';
  const {
    rgbToLab,
    deltaE76,
    sampleColorbar,
    makeValueFn,
    labToT,
    tickProblem,
    ticksWithT,
    colorbarProblem,
    gridPixelSize,
    bilinear,
    invertBilinear,
    readPixel,
    sampleCell,
  } = CM;

  // Map tool: read a near-continuous field (spectroscopy maps, fluorescence
  // images) as a dense value matrix. The plot area is the panel's grid corners;
  // it is sampled in square bins of map.bin rendered pixels (1 = native), each
  // bin the per-channel median of its pixels. Optional axis ticks turn bin
  // centres into axis coordinates; without them, coordinates are pixel offsets
  // from the plot's top-left corner.

  // Above this many values extraction gets slow and CSVs huge; a larger bin
  // is the honest answer for such images anyway.
  const MAX_MAP_CELLS = 1_000_000;
  // Flags per value.
  const FLAG_DELTA_E = 1;
  const FLAG_LOW = 2;
  const FLAG_HIGH = 4;

  function mapSize(panel) {
    const { width, height } = gridPixelSize(panel.grid.corners);
    const bin = Math.max(1, panel.map.bin);
    return { width, height, rows: Math.max(1, Math.round(height / bin)), cols: Math.max(1, Math.round(width / bin)) };
  }

  function mapProblem(panel) {
    if (!panel.grid.corners) return 'Place the plot area.';
    const bar = colorbarProblem(panel);
    if (bar) return bar;
    const { rows, cols } = mapSize(panel);
    if (rows * cols > MAX_MAP_CELLS) return `${cols} × ${rows} values is too many; use a larger bin (at most ${MAX_MAP_CELLS.toLocaleString('en-US')} values).`;
    return null;
  }

  // Position of a page point along an axis of the plot area: u (x, left → right)
  // or v (y, top → bottom).
  function axisT(panel, key, p) {
    const { u, v } = invertBilinear(panel.grid.corners, p);
    return key === 'x' ? u : v;
  }

  // {fn: axis position → axis value, or null, problem: why there is none}.
  // An axis is optional, so a problem is a hint rather than an error.
  function axisFn(panel, key) {
    const axis = panel.map[key];
    if (!panel.grid.corners) return { fn: null, problem: null };
    if (!axis.ticks.length) return { fn: null, problem: null };
    const ticks = axis.ticks.map((k) => ({ ...k, t: axisT(panel, key, k) }));
    const problem = tickProblem(ticks, axis.scale);
    if (problem) return { fn: null, problem: `${key.toUpperCase()} axis: ${problem.replace('along the bar', 'along the axis')}` };
    return { fn: makeValueFn(ticks, axis.scale), problem: null };
  }

  // rgb → {t, value, deltaE}, cached per color: maps repeat colors heavily, and
  // the colorbar search is the expensive part.
  function makeColorReader(samples, valueAt, settings) {
    const cache = new Map();
    return (rgb) => {
      const r = Math.round(rgb[0]);
      const g = Math.round(rgb[1]);
      const b = Math.round(rgb[2]);
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (!hit) {
        const { t, deltaE } = labToT(rgbToLab([r, g, b]), samples, settings.distance);
        hit = { t, value: valueAt(t), deltaE };
        cache.set(key, hit);
      }
      return hit;
    };
  }

  // How many distinct values the sampled colorbar can tell apart: steps between
  // neighbouring samples that change the color visibly, plus one.
  function colorbarLevels(samples) {
    let n = 1;
    for (let i = 1; i < samples.length; i++) if (deltaE76(samples[i - 1].lab, samples[i].lab) > 0.5) n++;
    return n;
  }

  function clipFlags(t, nSamples) {
    const edge = 0.5 / nSamples;
    return t < edge ? FLAG_LOW : t > 1 - edge ? FLAG_HIGH : 0;
  }

  function prepare(img, panel) {
    const cb = panel.colorbar;
    const samples = sampleColorbar(img, cb.start, cb.end, cb.halfWidth, cb.nSamples);
    const valueAt = makeValueFn(ticksWithT(cb), cb.scale);
    return { samples, read: makeColorReader(samples, valueAt, panel.settings) };
  }

  // Result: {rows, cols, bin, width, height, values, t, deltaE, flags (typed
  // arrays, row-major), xs, ys (axis values at bin centres, or pixel offsets
  // when xAxis/yAxis is false), xAxis, yAxis, axisProblems, samples, stats,
  // profiles} or {error, profiles}. profiles maps profile id → sampleProfile();
  // profiles only need the colorbar, so they are read even without a plot area.
  function extractMap(img, panel) {
    const profiles = Object.fromEntries(panel.map.profiles.map((l) => [l.id, sampleProfile(img, panel, l)]));
    const error = mapProblem(panel);
    if (error) return { error, profiles };
    const { samples, read } = prepare(img, panel);
    const { width, height, rows, cols } = mapSize(panel);
    const corners = panel.grid.corners;
    const grid = { corners, rows, cols, sampleFraction: 1 };
    const n = rows * cols;
    const values = new Float64Array(n);
    const ts = new Float32Array(n);
    const deltaE = new Float32Array(n);
    const flags = new Uint8Array(n);
    const native = panel.map.bin <= 1;
    const stats = { min: Infinity, max: -Infinity, flagged: 0, clippedLow: 0, clippedHigh: 0, levels: colorbarLevels(samples) };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // A native bin is one pixel: read it directly instead of taking a median.
        const rgb = native ? readPixelAt(img, corners, (c + 0.5) / cols, (r + 0.5) / rows) : sampleCell(img, grid, r, c);
        const hit = read(rgb);
        const i = r * cols + c;
        values[i] = hit.value;
        ts[i] = hit.t;
        deltaE[i] = hit.deltaE;
        let f = clipFlags(hit.t, samples.length);
        if (hit.deltaE > panel.settings.maxDeltaE) f |= FLAG_DELTA_E;
        flags[i] = f;
        if (f & FLAG_DELTA_E) stats.flagged++;
        if (f & FLAG_LOW) stats.clippedLow++;
        if (f & FLAG_HIGH) stats.clippedHigh++;
        if (hit.value < stats.min) stats.min = hit.value;
        if (hit.value > stats.max) stats.max = hit.value;
      }
    }
    const x = axisFn(panel, 'x');
    const y = axisFn(panel, 'y');
    const xs = Array.from({ length: cols }, (_, c) => (x.fn ? x.fn((c + 0.5) / cols) : ((c + 0.5) / cols) * width));
    const ys = Array.from({ length: rows }, (_, r) => (y.fn ? y.fn((r + 0.5) / rows) : ((r + 0.5) / rows) * height));
    return {
      rows,
      cols,
      bin: panel.map.bin,
      width,
      height,
      values,
      t: ts,
      deltaE,
      flags,
      xs,
      ys,
      xAxis: !!x.fn,
      yAxis: !!y.fn,
      axisProblems: [x.problem, y.problem].filter(Boolean),
      samples,
      stats,
      profiles,
    };
  }

  function readPixelAt(img, corners, u, v) {
    const p = bilinear(corners, u, v);
    return readPixel(img, p.x - 0.5, p.y - 0.5);
  }

  // Axis coordinates of a page point: {x, y}, with null for an uncalibrated
  // axis (pixel offsets from the plot's top-left corner are then in px, py).
  function axisCoords(panel, p) {
    const { u, v } = invertBilinear(panel.grid.corners, p);
    const { width, height } = gridPixelSize(panel.grid.corners);
    const x = axisFn(panel, 'x').fn;
    const y = axisFn(panel, 'y').fn;
    return { x: x ? x(u) : null, y: y ? y(v) : null, px: u * width, py: v * height, u, v };
  }

  // Value under a page point: {row, col, value, deltaE, flags} or null outside.
  function mapAt(result, panel, p) {
    if (!result || result.error || !panel.grid.corners) return null;
    const { u, v } = invertBilinear(panel.grid.corners, p);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const row = Math.floor(v * result.rows);
    const col = Math.floor(u * result.cols);
    const i = row * result.cols + col;
    return { row, col, value: result.values[i], deltaE: result.deltaE[i], flags: result.flags[i] };
  }

  // Values along a profile line, one sample per pixel of length, each averaged
  // over ±halfWidth pixels across the line. Returns
  // [{d, x, y, px, py, value, deltaE, flagged, clipped}] or {error}.
  function sampleProfile(img, panel, profile) {
    const bar = colorbarProblem(panel);
    if (bar) return { error: bar };
    const { a, b } = profile;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) return { error: 'Profile is too short.' };
    const { samples, read } = prepare(img, panel);
    const n = Math.round(length) + 1;
    const line = sampleColorbar(img, a, b, profile.halfWidth, n);
    const x = panel.grid.corners ? axisFn(panel, 'x').fn : null;
    const y = panel.grid.corners ? axisFn(panel, 'y').fn : null;
    return line.map((s) => {
      const hit = read(s.rgb);
      const p = { x: a.x + s.t * (b.x - a.x), y: a.y + s.t * (b.y - a.y) };
      let ax = null;
      let ay = null;
      if (x || y) {
        const { u, v } = invertBilinear(panel.grid.corners, p);
        if (x) ax = x(u);
        if (y) ay = y(v);
      }
      return {
        d: s.t * length,
        x: ax,
        y: ay,
        px: p.x,
        py: p.y,
        value: hit.value,
        deltaE: hit.deltaE,
        flagged: hit.deltaE > panel.settings.maxDeltaE,
        clipped: clipFlags(hit.t, samples.length) !== 0,
      };
    });
  }

  Object.assign(CM, {
    MAX_MAP_CELLS,
    FLAG_DELTA_E,
    FLAG_LOW,
    FLAG_HIGH,
    mapSize,
    mapProblem,
    axisT,
    axisFn,
    makeColorReader,
    colorbarLevels,
    extractMap,
    axisCoords,
    mapAt,
    sampleProfile,
  });
})((globalThis.Colormeris ??= {}));
