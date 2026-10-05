(function (CM) {
  'use strict';
  const {
    rgbToLab,
    deltaE76,
    colorDistance,
    sampleColorbar,
    colorbarSamples,
    makeValueFn,
    labToT,
    tickProblem,
    ticksWithT,
    colorbarProblem,
    gridPixelSize,
    bilinear,
    invertBilinear,
    readPixel,
    createProfile,
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

  // Axis ticks sit on the plot area's edges: x ticks on the bottom edge, y
  // ticks on the left edge, where only their position along the axis matters.
  // They may lie a little beyond the corners, as axes often run past the image.
  const AXIS_T_MIN = -0.5;
  const AXIS_T_MAX = 1.5;

  // Page point of axis position t on the edge of `key`'s axis.
  function axisEdgePoint(panel, key, t) {
    const c = panel.grid.corners;
    const s = Math.min(AXIS_T_MAX, Math.max(AXIS_T_MIN, t));
    return key === 'x' ? bilinear(c, s, 1) : bilinear(c, 0, s);
  }

  // A page point moved onto the edge of `key`'s axis, keeping its position
  // along the axis. Without a plot area the point stays as it is.
  function onAxisEdge(panel, key, p) {
    return panel.grid.corners ? axisEdgePoint(panel, key, axisT(panel, key, p)) : p;
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

  // A color counts as at an end of the colorbar (possibly clipped) when it is
  // about as close to the end color as to its best match. A t threshold would
  // miss it: the end pixel of a bar covers several equal samples, and the match
  // lands on the first of them.
  const CLIP_DELTA_E = 0.5;

  // rgb → {t, value, deltaE, clip}, cached per color: maps repeat colors
  // heavily, and the colorbar search is the expensive part.
  function makeColorReader(samples, valueAt, settings) {
    const cache = new Map();
    const dist = colorDistance(settings.distance);
    const low = samples[0].lab;
    const high = samples[samples.length - 1].lab;
    return (rgb) => {
      const r = Math.round(rgb[0]);
      const g = Math.round(rgb[1]);
      const b = Math.round(rgb[2]);
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (!hit) {
        const lab = rgbToLab([r, g, b]);
        const { t, deltaE } = labToT(lab, samples, settings.distance);
        const clip = dist(lab, low) <= deltaE + CLIP_DELTA_E ? FLAG_LOW : dist(lab, high) <= deltaE + CLIP_DELTA_E ? FLAG_HIGH : 0;
        hit = { t, value: valueAt(t), deltaE, clip };
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

  function prepare(img, panel) {
    const cb = panel.colorbar;
    const samples = colorbarSamples(img, cb);
    const valueAt = makeValueFn(ticksWithT(cb), cb.scale);
    return { samples, read: makeColorReader(samples, valueAt, panel.settings) };
  }

  // The value field. Result: {rows, cols, bin, width, height, values, t,
  // deltaE, flags (typed arrays, row-major), xs, ys (axis values at bin
  // centres, or pixel offsets when xAxis/yAxis is false), xAxis, yAxis,
  // axisProblems, samples, stats} or {error}.
  function extractField(img, panel) {
    const error = mapProblem(panel);
    if (error) return { error };
    const { samples, read } = prepare(img, panel);
    const { width, height, rows, cols } = mapSize(panel);
    const corners = panel.grid.corners;
    // Pixels read per bin side: one per pixel of the bin, at least one.
    const nu = Math.max(1, Math.round(width / cols));
    const nv = Math.max(1, Math.round(height / rows));
    const n = rows * cols;
    const values = new Float64Array(n);
    const ts = new Float32Array(n);
    const deltaE = new Float32Array(n);
    const flags = new Uint8Array(n);
    const stats = { min: Infinity, max: -Infinity, flagged: 0, clippedLow: 0, clippedHigh: 0, levels: colorbarLevels(samples) };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rgb = sampleBin(img, corners, (c + 0.5) / cols, (r + 0.5) / rows, 1 / cols, 1 / rows, nu, nv);
        const hit = read(rgb);
        const i = r * cols + c;
        values[i] = hit.value;
        ts[i] = hit.t;
        deltaE[i] = hit.deltaE;
        let f = hit.clip;
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
    };
  }

  // profile id → sampleProfile(). Profiles only need the colorbar, so they are
  // read even without a plot area.
  function sampleProfiles(img, panel) {
    return Object.fromEntries(panel.map.profiles.map((l) => [l.id, sampleProfile(img, panel, l)]));
  }

  // Field and profiles together: extractField() plus {profiles}.
  function extractMap(img, panel) {
    return { ...extractField(img, panel), profiles: sampleProfiles(img, panel) };
  }

  // Per-channel median of nu × nv pixels spread over the bin centred at
  // (u, v) of size du × dv. Page points put pixel i at [i, i + 1), as in the
  // status bar, so a point is read at p − 0.5. (sampleCell in core/grid.js
  // reads pixel i at i; with full-size bins that reaches half a pixel past
  // the plot area.)
  // Reused typed buffers (one pass per channel, sorted in place), so reading a
  // bin allocates nothing per pixel.
  let binBuf = [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
  function sampleBin(img, corners, u, v, du, dv, nu, nv) {
    if (nu === 1 && nv === 1) {
      const p = bilinear(corners, u, v);
      return readPixel(img, p.x - 0.5, p.y - 0.5);
    }
    const n = nu * nv;
    if (binBuf[0].length < n) binBuf = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const [r, g, b] = binBuf;
    let k = 0;
    for (let j = 0; j < nv; j++) {
      const vv = v + ((j + 0.5) / nv - 0.5) * dv;
      for (let i = 0; i < nu; i++, k++) {
        const p = bilinear(corners, u + ((i + 0.5) / nu - 0.5) * du, vv);
        const px = readPixel(img, p.x - 0.5, p.y - 0.5);
        r[k] = px[0];
        g[k] = px[1];
        b[k] = px[2];
      }
    }
    return [median(r, n), median(g, n), median(b, n)];
  }

  function median(buf, n) {
    const values = buf.subarray(0, n);
    values.sort();
    const m = n >> 1;
    return n % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
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

  // The axis a profile is plotted and measured against: 'x' or 'y' when the
  // line runs mostly along that axis and it is calibrated, else null (distance
  // along the line in pixels).
  function profileAxisKey(panel, profile) {
    if (!panel.grid.corners) return null;
    const horizontal = Math.abs(profile.b.x - profile.a.x) >= Math.abs(profile.b.y - profile.a.y);
    const key = horizontal ? 'x' : 'y';
    return axisFn(panel, key).fn ? key : null;
  }

  // Length of a profile in the units of profileAxisKey(): the span of axis
  // values between its ends, or pixels. {length, key}.
  function profileLength(panel, profile) {
    const key = profileAxisKey(panel, profile);
    if (!key) return { length: Math.hypot(profile.b.x - profile.a.x, profile.b.y - profile.a.y), key };
    return { length: Math.abs(axisCoords(panel, profile.b)[key] - axisCoords(panel, profile.a)[key]), key };
  }

  // The end point that gives a profile `length` (in profileLength() units),
  // keeping its start and direction; null when no point along it does.
  function profileEndForLength(panel, profile, length) {
    const { a, b } = profile;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > 0) || len < 1e-9) return null;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const at = (s) => ({ x: a.x + s * dir.x, y: a.y + s * dir.y });
    const key = profileAxisKey(panel, profile);
    if (!key) return at(length);
    // Axis values are monotonic along the line (also on a log axis), so
    // bisect on the distance in pixels.
    const v0 = axisCoords(panel, a)[key];
    const span = (s) => Math.abs(axisCoords(panel, at(s))[key] - v0);
    let hi = len;
    for (let k = 0; k < 40 && span(hi) < length; k++) hi *= 2;
    if (!(span(hi) >= length)) return null;
    let lo = 0;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (span(mid) < length) lo = mid;
      else hi = mid;
    }
    return at(hi);
  }

  // What a profile's values are divided by to compare profiles by shape:
  // their maximum or mean (mode 'max' | 'mean') inside the plot area, 1 for 'raw'. {divisor} or
  // {error} when it is not positive (dividing would flip or blow up the line).
  function profileDivisor(samples, mode) {
    if (mode !== 'max' && mode !== 'mean') return { divisor: 1 };
    const values = samples.filter((s) => !s.outside).map((s) => s.value).filter(Number.isFinite);
    const d = mode === 'max' ? Math.max(...values) : values.reduce((a, v) => a + v, 0) / values.length;
    return d > 0 ? { divisor: d } : { error: `The ${mode} is not positive, so the profile cannot be divided by it.` };
  }

  // Copies of copied profiles for pasting into panel. Between panels with plot
  // areas a copy keeps its place within the plot (fromCorners → the panel's
  // corners); otherwise it keeps its page position, shifted by offset {x, y}.
  // Names already in the panel get a number: "Profile 1 (2)".
  function pastedProfiles(panel, profiles, fromCorners, offset = { x: 0, y: 0 }) {
    const to = panel.grid.corners;
    const move =
      fromCorners && to && !samePoints(fromCorners, to)
        ? (p) => {
            const { u, v } = invertBilinear(fromCorners, p);
            return bilinear(to, u, v);
          }
        : (p) => ({ x: p.x + offset.x, y: p.y + offset.y });
    const used = new Set(panel.map.profiles.map((l) => l.name));
    return profiles.map((l) => {
      let name = l.name;
      for (let n = 2; used.has(name); n++) name = `${l.name} (${n})`;
      used.add(name);
      return createProfile(move(l.a), move(l.b), { name, halfWidth: l.halfWidth });
    });
  }

  // How far the line a–b can move along its normal n (unit, to the right of
  // a → b in page coordinates) and stay inside the plot area (corners):
  // {n, min, max} in page px, min ≤ 0 ≤ max, or {error}. The midpoint must
  // stay inside, and so must each end that starts inside; an end drawn a
  // little past the edge (a line from edge to edge) does not block the sweep.
  // With runOff the line may leave the area until no part of it is left:
  // a wider sweep for slanted lines, whose ends leave first.
  function sweepRange(corners, a, b, { runOff = false } = {}) {
    if (!corners) return { error: 'Place the plot area first.' };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return { error: 'Profile is too short.' };
    const n = { x: -dy / len, y: dx / len };
    if (runOff) return runOffRange(corners, a, { x: dx / len, y: dy / len }, n, len);
    const inside = (p) => {
      const { u, v } = invertBilinear(corners, p);
      return u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9;
    };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!inside(mid)) return { error: 'Move the profile inside the plot area to sweep it.' };
    // The area is convex, so each point stays inside over one interval of
    // offsets; the farthest it can go is the area's diagonal.
    const far = Math.hypot(corners[2].x - corners[0].x, corners[2].y - corners[0].y) + Math.hypot(corners[3].x - corners[1].x, corners[3].y - corners[1].y);
    const reach = (p, sign) => {
      let lo = 0;
      let hi = far;
      for (let i = 0; i < 50; i++) {
        const s = (lo + hi) / 2;
        if (inside({ x: p.x + sign * s * n.x, y: p.y + sign * s * n.y })) lo = s;
        else hi = s;
      }
      return lo;
    };
    const points = [mid, a, b].filter(inside);
    return { n, min: -Math.min(...points.map((p) => reach(p, -1))), max: Math.min(...points.map((p) => reach(p, 1))) };
  }

  // The offsets along n at which the line (from a along d, len long) still
  // touches the area: the area clipped to the strip the line sweeps, measured
  // across. The plot area's edges are straight, so it is a polygon.
  function runOffRange(corners, a, d, n, len) {
    let poly = corners.map((p) => ({ along: (p.x - a.x) * d.x + (p.y - a.y) * d.y, across: (p.x - a.x) * n.x + (p.y - a.y) * n.y }));
    poly = clipPolygon(poly, (q) => q.along);
    poly = clipPolygon(poly, (q) => len - q.along);
    if (!poly.length) return { error: 'Move the profile onto the plot area to sweep it.' };
    const across = poly.map((q) => q.across);
    const min = Math.min(...across);
    const max = Math.max(...across);
    if (min > 1e-9 || max < -1e-9) return { error: 'Move the profile onto the plot area to sweep it.' };
    return { n, min: Math.min(0, min), max: Math.max(0, max) };
  }

  // The part of a convex polygon [{along, across}] where f ≥ 0 (Sutherland–Hodgman).
  function clipPolygon(poly, f) {
    const out = [];
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const fp = f(p);
      const fq = f(q);
      if (fp >= 0) out.push(p);
      if ((fp >= 0) !== (fq >= 0)) {
        const t = fp / (fp - fq);
        out.push({ along: p.along + t * (q.along - p.along), across: p.across + t * (q.across - p.across) });
      }
    });
    return out;
  }

  const samePoints = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-9 && Math.abs(p.y - b[i].y) < 1e-9);

  // Values along a profile line, one sample per pixel of length, each averaged
  // over ±halfWidth pixels across the line. Returns
  // [{d, x, y, px, py, value, deltaE, flagged, clipped, outside}] or {error}.
  // Samples outside the plot area (axes, labels, the page) are kept, so the
  // line keeps its length, but marked outside: plots and CSVs leave them out.
  function sampleProfile(img, panel, profile) {
    const bar = colorbarProblem(panel);
    if (bar) return { error: bar };
    const { a, b } = profile;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) return { error: 'Profile is too short.' };
    const { read } = prepare(img, panel);
    const n = Math.round(length) + 1;
    // Page points put pixel i at [i, i + 1), as in the status bar; the
    // colorbar sampler reads pixel i at i.
    const line = sampleColorbar(img, { x: a.x - 0.5, y: a.y - 0.5 }, { x: b.x - 0.5, y: b.y - 0.5 }, profile.halfWidth, n);
    const x = panel.grid.corners ? axisFn(panel, 'x').fn : null;
    const y = panel.grid.corners ? axisFn(panel, 'y').fn : null;
    return line.map((s) => {
      const hit = read(s.rgb);
      const p = { x: a.x + s.t * (b.x - a.x), y: a.y + s.t * (b.y - a.y) };
      let ax = null;
      let ay = null;
      let outside = false;
      if (panel.grid.corners) {
        const { u, v } = invertBilinear(panel.grid.corners, p);
        if (x) ax = x(u);
        if (y) ay = y(v);
        outside = !(u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9);
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
        clipped: hit.clip !== 0,
        outside,
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
    axisEdgePoint,
    onAxisEdge,
    axisFn,
    makeColorReader,
    colorbarLevels,
    extractField,
    sampleProfiles,
    extractMap,
    axisCoords,
    mapAt,
    profileAxisKey,
    profileLength,
    profileEndForLength,
    profileDivisor,
    pastedProfiles,
    sweepRange,
    sampleProfile,
  });
})((globalThis.Colormeris ??= {}));
