(function (CM) {
  'use strict';
  const { rgbToLab, labToRgb, colorDistance, deltaE76, deltaE2000, readPixel } = CM;

  // Colorbar calibration: sample the bar's colors along a line, map positions
  // along the bar (t in [0, 1], start → end) to data values via user ticks, and
  // map arbitrary colors back to t by nearest perceptual match.


  const DEFAULT_SAMPLES = 256;

  // Returns [{t, rgb, lab}] sampled evenly from start to end. Each sample is the
  // mean over a window of ±halfWidth pixels perpendicular to the bar.
  function sampleColorbar(img, start, end, halfWidth = 2, n = DEFAULT_SAMPLES) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return [];
    const px = -dy / len;
    const py = dx / len;
    const hw = Math.max(0, Math.round(halfWidth));
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const cx = start.x + t * dx;
      const cy = start.y + t * dy;
      const sum = [0, 0, 0];
      for (let k = -hw; k <= hw; k++) {
        const [r, g, b] = readPixel(img, cx + k * px, cy + k * py);
        sum[0] += r;
        sum[1] += g;
        sum[2] += b;
      }
      const count = 2 * hw + 1;
      const rgb = sum.map((s) => s / count);
      samples.push({ t, rgb, lab: rgbToLab(rgb) });
    }
    return samples;
  }

  // Position of point p projected onto the line start → end, as t (unclamped).
  function projectT(start, end, p) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return 0;
    return ((p.x - start.x) * dx + (p.y - start.y) * dy) / len2;
  }

  function pointAtT(start, end, t) {
    return { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) };
  }

  // Validates ticks and returns a problem description, or null when usable.
  function tickProblem(ticks, scale) {
    const valid = ticks.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value));
    if (valid.length < 2) return 'Add at least two ticks with numeric values.';
    if (scale === 'log10' && valid.some((k) => k.value <= 0)) return 'Log scale needs positive tick values.';
    const ts = new Set(valid.map((k) => k.t.toFixed(6)));
    if (ts.size < 2) return 'Ticks must be at different positions along the bar.';
    return null;
  }

  // Piecewise-linear t → value through the ticks, extrapolated linearly beyond
  // the outermost ticks. With scale "log10" interpolation happens in log space.
  function makeValueFn(ticks, scale = 'linear') {
    if (tickProblem(ticks, scale)) return null;
    const log = scale === 'log10';
    const pts = ticks
      .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value))
      .map((k) => ({ t: k.t, y: log ? Math.log10(k.value) : k.value }))
      .sort((a, b) => a.t - b.t);
    // Collapse ticks at identical positions by averaging.
    const merged = [];
    for (const p of pts) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.t - p.t) < 1e-9) {
        last.y = (last.y * last.n + p.y) / (last.n + 1);
        last.n++;
      } else merged.push({ ...p, n: 1 });
    }
    return (t) => {
      let k = 0;
      while (k < merged.length - 2 && t > merged[k + 1].t) k++;
      const a = merged[k];
      const b = merged[k + 1];
      const y = a.y + ((t - a.t) / (b.t - a.t)) * (b.y - a.y);
      return log ? Math.pow(10, y) : y;
    };
  }

  // The colorbar's samples: from its known colormap when it has one (see
  // colormapSamples in core/colormap-match.js, loaded after this file), else
  // read from the image along the bar line.
  function colorbarSamples(img, cb) {
    if (cb.colormap) return CM.colormapSamples(cb.colormap, cb.nSamples) || [];
    return sampleColorbar(img, cb.start, cb.end, cb.halfWidth, cb.nSamples);
  }

  // Nearest position along the sampled bar for a Lab color. Refines between the
  // best sample and its closer neighbour by projecting in Lab space.
  // Returns {t, deltaE}.
  function labToT(lab, samples, distance = 'de2000') {
    const dist = colorDistance(distance);
    let best = 0;
    let bestD = Infinity;
    // Exact pruning for CIEDE2000: its lightness term alone is at most
    // dL / 1 and at least dL / 1.75 (Sl ≤ 1.75), and the other terms never
    // make the sum smaller than that (the cross term is dominated), so a
    // sample whose dL / 1.75 already exceeds the best distance cannot win. A
    // ΔE76 seed (the likely winner) makes the bound tight from the start; ties
    // still go to the lowest index, as in a plain scan.
    const prune = dist === deltaE2000 ? 1.75 : 0;
    if (prune) {
      let seed = 0;
      let seedD = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const d = deltaE76(lab, samples[i].lab);
        if (d < seedD) {
          seedD = d;
          seed = i;
        }
      }
      best = seed;
      bestD = dist(lab, samples[seed].lab);
    }
    const L = lab[0];
    for (let i = 0; i < samples.length; i++) {
      if (prune && Math.abs(L - samples[i].lab[0]) > prune * bestD) continue;
      const d = dist(lab, samples[i].lab);
      if (d < bestD || (d === bestD && i < best)) {
        bestD = d;
        best = i;
      }
    }
    let result = { t: samples[best].t, deltaE: bestD };
    for (const j of [best - 1, best + 1]) {
      if (j < 0 || j >= samples.length) continue;
      const a = samples[best].lab;
      const b = samples[j].lab;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
      if (len2 === 0) continue;
      const s = ((lab[0] - a[0]) * ab[0] + (lab[1] - a[1]) * ab[1] + (lab[2] - a[2]) * ab[2]) / len2;
      if (s <= 0 || s >= 1) continue;
      const q = [a[0] + s * ab[0], a[1] + s * ab[1], a[2] + s * ab[2]];
      const d = dist(lab, q);
      if (d < result.deltaE) {
        result = { t: samples[best].t + s * (samples[j].t - samples[best].t), deltaE: d };
      }
    }
    return result;
  }

  // Interpolated RGB color of the sampled bar at position t (clamped to [0, 1]).
  function colorAtT(samples, t) {
    const n = samples.length;
    if (n === 0) return [0, 0, 0];
    const x = Math.min(1, Math.max(0, t)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    if (n === 1) return samples[0].rgb;
    const f = x - i;
    const a = samples[i].lab;
    const b = samples[i + 1].lab;
    return labToRgb([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]);
  }

  // ---------------------------------------------------------------- snapping

  // An LLM reading coordinates off images places the colorbar and its ticks
  // a few pixels off: the line drifts towards the strip's edge, the ends land
  // on the outline or short of the last color, and ticks miss their marks.
  // These functions find the real strip and tick marks near a rough
  // placement. Color steps are ΔE76 in CIELAB.

  const SIDE_EDGE = 15; // sideways step that counts as leaving the strip
  const MAX_SIDE = 60; // widest half-strip searched, in pixels
  const labAt = (img, p) => rgbToLab(readPixel(img, p.x, p.y));
  const chroma = (lab) => Math.hypot(lab[1], lab[2]);
  const median = (v) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function axes(start, end) {
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    const u = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };
    const n = { x: -u.y, y: u.x };
    // Page point at s pixels along the bar from start and k pixels across it.
    const at = (s, k = 0) => ({ x: start.x + s * u.x + k * n.x, y: start.y + s * u.y + k * n.y });
    return { len, u, n, at };
  }

  // How far the strip reaches on each side of the line (last pixel that still
  // has the line's color), as medians over the middle of the bar. A colorbar
  // has one color across its width, so the first big sideways step is its edge.
  function stripSides(img, start, end) {
    const { len, at } = axes(start, end);
    const lo = [];
    const hi = [];
    const centre = [];
    for (let i = 0; i < 15; i++) {
      const s = len * (0.2 + (0.6 * i) / 14);
      const c = labAt(img, at(s));
      centre.push(c);
      const reach = (dir) => {
        let k = 0;
        while (k < MAX_SIDE && deltaE76(labAt(img, at(s, dir * (k + 1))), c) < SIDE_EDGE) k++;
        return k;
      };
      lo.push(reach(-1));
      hi.push(reach(1));
    }
    // A colorbar changes color along its length; a flat line is not on one.
    let spread = 0;
    for (const c of centre) spread = Math.max(spread, deltaE76(c, centre[0]));
    return { lo: median(lo), hi: median(hi), spread };
  }

  // Rough colorbar line → the strip's centre line with both ends on its last
  // colored pixels. Returns {start, end, halfWidth (for sampling), stripHalf,
  // found: {start, end}, moved: {sideways, start, end}} or null when no strip
  // is found under the line (the rough placement is then kept).
  function refineColorbar(img, start, end) {
    // Figure colorbars are horizontal or vertical: a line tilted by a few
    // degrees would drift towards one side, so straighten it about its middle.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.abs(dx) < 0.07 * Math.abs(dy)) {
      const mx = (start.x + end.x) / 2;
      [start, end] = [{ x: mx, y: start.y }, { x: mx, y: end.y }];
    } else if (Math.abs(dy) < 0.07 * Math.abs(dx)) {
      const my = (start.y + end.y) / 2;
      [start, end] = [{ x: start.x, y: my }, { x: end.x, y: my }];
    }
    const rough = axes(start, end);
    if (rough.len < 10) return null;
    const { lo, hi, spread } = stripSides(img, start, end);
    if (spread < 10 || lo + hi < 2 || lo >= MAX_SIDE || hi >= MAX_SIDE) return null;
    const shift = (hi - lo) / 2;
    const half = (hi + lo) / 2;
    const s0 = rough.at(0, shift);
    const { len, u, at } = axes(s0, rough.at(rough.len, shift));
    const on = (s) => labAt(img, at(s));

    // Steps along the bar inside it; an end is a step much bigger than these.
    const steps = [];
    for (let s = Math.round(len * 0.3); s < len * 0.7; s++) steps.push(deltaE76(on(s), on(s + 1)));
    const jump = Math.max(12, 5 * median(steps));
    const W = Math.max(8, Math.min(Math.round(len * 0.12), Math.floor(len * 0.35)));
    const out = half + 3;

    // Walk outward across the rough end (s0 along the bar, dir ±1). The end is
    // the first big step, from the inside out, into something that looks like
    // the surroundings (the outline or background beside the strip, or a gray).
    function findEnd(sEnd, dir) {
      for (let j = -W + 1; j <= W; j++) {
        const prev = on(sEnd + dir * (j - 1));
        const cur = on(sEnd + dir * j);
        const d = deltaE76(prev, cur);
        if (d <= jump) continue;
        const s = sEnd + dir * (j + 1);
        const past = on(s);
        const side = Math.min(deltaE76(past, labAt(img, at(s, -out))), deltaE76(past, labAt(img, at(s, out))));
        if (side >= SIDE_EDGE * 1.5 && chroma(past) >= 8) continue; // an inner step (e.g. a discrete bar)
        // Last clean pixel: step back over an anti-aliased edge pixel, then one more.
        let e = j - 1;
        for (let k = 0; k < 2 && deltaE76(on(sEnd + dir * (e - 1)), on(sEnd + dir * e)) > 0.3 * d; k++) e--;
        return sEnd + dir * (e - 1);
      }
      return null;
    }
    const sStart = findEnd(0, -1);
    const sEnd = findEnd(len, 1);
    const a = sStart ?? 0;
    const b = sEnd ?? len;
    if (b - a < Math.max(5, len * 0.5)) return null;
    const r = (v) => Math.round(v * 10) / 10;
    const p = (s) => ({ x: r(at(s).x), y: r(at(s).y) });
    return {
      start: p(a),
      end: p(b),
      // Sample the middle half of the strip, away from its anti-aliased sides.
      halfWidth: Math.max(0, Math.min(6, Math.floor(half / 2))),
      stripHalf: half,
      found: { start: sStart !== null, end: sEnd !== null },
      moved: { sideways: r(shift), start: r(-a), end: r(b - len) },
    };
  }

  // Tick mark nearest `at` on a colorbar (start → end on the strip's centre
  // line). Marks are short lines across the bar's edge: outside it (dark on
  // the background) or drawn into the strip from its edge (off the strip's
  // color there). Returns {t, moved (pixels along the bar), point} or null
  // when no clear mark is near.
  function snapTick(img, start, end, at) {
    const { len, u, at: pt } = axes(start, end);
    if (len < 10) return null;
    const s0 = (at.x - start.x) * u.x + (at.y - start.y) * u.y;
    const W = Math.max(4, Math.round(len * 0.04));
    const from = Math.round(s0 - W - 4);
    const to = Math.round(s0 + W + 4);
    const { lo, hi } = stripSides(img, start, end);
    const bands = [];
    for (const [dir, edge] of [[-1, lo], [1, hi]]) {
      if (edge >= MAX_SIDE) continue;
      const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => dir * (a + i));
      // Outside: the background dominates the band, marks stand out from it.
      bands.push({ ks: range(edge + 2, edge + 9), min: 3, outside: true });
      // Inside: the strip has one color across, so a mark differs from the centre.
      if (edge >= 3) bands.push({ ks: range(Math.max(1, edge - 6), edge), min: 2, outside: false });
    }
    let best = null;
    for (const band of bands) {
      const rows = [];
      for (let s = from; s <= to; s++) rows.push(band.ks.map((k) => labAt(img, pt(s, k))));
      let refAt;
      if (band.outside) {
        const ref = [0, 1, 2].map((i) => median(rows.flat().map((l) => l[i])));
        refAt = () => ref;
      } else refAt = (i) => labAt(img, pt(from + i, 0));
      const limit = band.outside ? 25 : 20;
      const profile = rows.map((row, i) => row.filter((l) => deltaE76(l, refAt(i)) > limit).length);
      const base = median(profile);
      // Runs of positions where the band holds a mark; marks are thin.
      let run = null;
      const flush = () => {
        if (!run) return;
        const centre = run.sum / run.weight;
        if (run.to - run.from < 8 && Math.abs(centre - s0) <= W && (!best || Math.abs(centre - s0) < Math.abs(best - s0))) best = centre;
        run = null;
      };
      profile.forEach((v, i) => {
        const x = v - base;
        if (x < band.min) return flush();
        const s = from + i;
        run ??= { from: s, to: s, sum: 0, weight: 0 };
        run.to = s;
        run.sum += s * x;
        run.weight += x;
      });
      flush();
    }
    if (best === null) return null;
    return { t: best / len, moved: Math.round((best - s0) * 10) / 10, point: pt(best) };
  }

  Object.assign(CM, { DEFAULT_SAMPLES, sampleColorbar, colorbarSamples, projectT, pointAtT, tickProblem, makeValueFn, labToT, colorAtT, refineColorbar, snapTick });
})((globalThis.Colormeris ??= {}));
