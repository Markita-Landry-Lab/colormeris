(function (CM) {
  'use strict';
  const { rgbToLab, deltaE2000, simulateCvd, CVD_TYPES } = CM;

  // Perceptual measures of a colormap for the colormap viewer: step sizes
  // along the map, CIELCh profiles, the smallest separation between colors that
  // stand for clearly different values (also in the CVD views and in
  // grayscale), and a short yes / partly / no rating built from them.
  // Inputs are arrays of 0–255 sRGB colors, in colormap order.

  // ΔE2000 between neighboring colors: a flat profile means equal perceptual
  // steps for equal data steps; spikes are bands (as in jet).
  function perceptualSteps(rgbs) {
    const labs = rgbs.map(rgbToLab);
    const steps = [];
    for (let i = 1; i < labs.length; i++) steps.push(deltaE2000(labs[i - 1], labs[i]));
    return steps;
  }

  // Mean, max and coefficient of variation (std / mean) of the steps.
  function stepStats(steps) {
    const n = steps.length;
    if (!n) return { mean: 0, max: 0, cv: 0, total: 0 };
    const total = steps.reduce((a, b) => a + b, 0);
    const mean = total / n;
    const sd = Math.sqrt(steps.reduce((a, s) => a + (s - mean) ** 2, 0) / n);
    return { mean, max: Math.max(...steps), cv: mean > 1e-9 ? sd / mean : 0, total };
  }

  // CIELCh: lightness, chroma C* = √(a² + b²) and hue angle h in degrees [0, 360).
  function lchOf(rgb) {
    const [L, a, b] = rgbToLab(rgb);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return [L, Math.hypot(a, b), h];
  }

  function lchProfile(rgbs) {
    const L = [];
    const C = [];
    const h = [];
    for (const rgb of rgbs) {
      const v = lchOf(rgb);
      L.push(v[0]);
      C.push(v[1]);
      h.push(v[2]);
    }
    return { L, C, h };
  }

  // Evenly pick n of the colors (keeps the first and the last).
  function resample(rgbs, n) {
    if (rgbs.length <= n) return rgbs.slice();
    return Array.from({ length: n }, (_, i) => rgbs[Math.round((i * (rgbs.length - 1)) / (n - 1))]);
  }

  // The smallest color difference between two points that are at least `gap`
  // apart along the map (as a fraction of its length). Neighbors always look
  // alike, so only clearly different values count: a small result means two
  // different values can be confused. Cyclic maps measure the gap around the
  // circle, since their ends are meant to match. Qualitative maps compare
  // every pair of their colors.
  //   values   per-point features (Lab triples, or L* numbers)
  //   dist     (a, b) → difference
  // Returns { min, i, j } (indices into values) or null with fewer than 2 points.
  function minSeparation(values, dist, { gap = 0.1, cyclic = false, discrete = false } = {}) {
    const n = values.length;
    if (n < 2) return null;
    const span = cyclic ? n : n - 1;
    const minIdx = discrete ? 1 : Math.max(1, Math.ceil(gap * span - 1e-9));
    let best = { min: Infinity, i: 0, j: 0 };
    for (let i = 0; i < n; i++) {
      for (let j = i + minIdx; j < n; j++) {
        if (cyclic && n - (j - i) < minIdx) continue;
        const d = dist(values[i], values[j]);
        if (d < best.min) best = { min: d, i, j };
      }
    }
    return Number.isFinite(best.min) ? best : null;
  }

  const SAMPLES = 64; // enough to find confusions; keeps 87 maps × 5 views fast (≈ 0.2 s)
  const labDist = (a, b) => deltaE2000(a, b);
  const lDist = (a, b) => Math.abs(a - b);

  // Separations in the colormap itself, each CVD view and grayscale (ΔL*).
  // Indices are given as positions t in [0, 1] (or color numbers for
  // qualitative maps) so the viewer can point at the confused pair.
  function separations(rgbs, { kind = 'continuous', cyclic = false, gap = 0.1 } = {}) {
    const discrete = kind === 'qualitative';
    const pts = discrete ? rgbs : resample(rgbs, SAMPLES);
    const n = pts.length;
    const opts = { gap, cyclic, discrete };
    const at = (s) => s && { min: s.min, t: discrete ? [s.i, s.j] : [s.i / (n - 1), s.j / (n - 1)] };
    const out = { orig: at(minSeparation(pts.map(rgbToLab), labDist, opts)) };
    for (const type of CVD_TYPES) {
      out[type] = at(minSeparation(pts.map((c) => rgbToLab(simulateCvd(c, type))), labDist, opts));
    }
    out.gray = at(minSeparation(pts.map((c) => rgbToLab(c)[0]), lDist, opts));
    return out;
  }

  // yes / partly / no thresholds, set on the matplotlib maps so that the
  // usual verdicts come out (viridis family, cividis yes; jet, turbo, hsv no).
  // Steps are ΔE2000, not CAM02-UCS (which viridis was built in), so magma and
  // plasma vary by ≈ 0.27 although they are uniform by design.
  // ΔE2000 ≈ 2 is about the smallest difference noticed side by side.
  const RATING = {
    // Coefficient of variation of the steps (lower is better).
    uniform: { yes: 0.3, partly: 0.45 },
    // Worst CVD view: share of the colormap's own separation it keeps, and ΔE2000.
    cvd: { yes: { ratio: 0.4, min: 2.5 }, partly: { ratio: 0.25, min: 1.5 } },
    // Min ΔL* between points 10% apart; a full black-to-white ramp has ≈ 10.
    gray: { yes: 5, partly: 2 },
  };

  const gradeLow = (v, { yes, partly }) => (v <= yes ? 'yes' : v <= partly ? 'partly' : 'no');
  const gradeHigh = (v, { yes, partly }) => (v >= yes ? 'yes' : v >= partly ? 'partly' : 'no');
  const gradeCvd = (ratio, min, { yes, partly }) =>
    ratio >= yes.ratio && min >= yes.min ? 'yes' : ratio >= partly.ratio && min >= partly.min ? 'partly' : 'no';

  // Everything the viewer shows for one map, computed once. steps are between
  // 64 evenly spaced samples, so step i spans t = i/63 to (i+1)/63.
  //   uniform    perceptually uniform: even ΔE steps (null for qualitative maps)
  //   cvdSafe    distinct values stay distinct in all three CVD views
  //   graySafe   distinct values stay distinct in grayscale (prints in black and white)
  function colormapMetrics(rgbs, { kind = 'continuous', cyclic = false } = {}) {
    const discrete = kind === 'qualitative';
    // 64 samples: 8-bit rounding makes neighboring steps of 256 samples noisy.
    const steps = discrete ? [] : perceptualSteps(resample(rgbs, SAMPLES));
    const st = stepStats(steps);
    const sep = separations(rgbs, { kind, cyclic });
    const cvdWorst = Math.min(...CVD_TYPES.map((t) => sep[t]?.min ?? 0));
    const origMin = sep.orig?.min ?? 0;
    const cvdRatio = origMin > 1e-9 ? cvdWorst / origMin : 0;
    const grayMin = sep.gray?.min ?? 0;
    return {
      steps,
      stepStats: st,
      lch: lchProfile(rgbs),
      separations: sep,
      cvdWorst,
      cvdRatio,
      rating: {
        uniform: discrete ? null : gradeLow(st.cv, RATING.uniform),
        cvdSafe: gradeCvd(cvdRatio, cvdWorst, RATING.cvd),
        graySafe: gradeHigh(grayMin, RATING.gray),
      },
    };
  }

  // The maps chosen for side-by-side comparison, from the page URL
  // (?compare=viridis,jet). Unknown names and repeats are dropped, matching
  // ignores case, and at most `max` are kept, so a hand-edited or old link
  // still opens a valid comparison.
  const COMPARE_MAX = 10;

  function parseCompare(param, names, max = COMPARE_MAX) {
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const out = [];
    for (const part of String(param ?? '').split(',')) {
      const name = byLower.get(part.trim().toLowerCase());
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= max) break;
    }
    return out;
  }

  Object.assign(CM, {
    perceptualSteps, stepStats, resample, lchOf, lchProfile, minSeparation, separations, colormapMetrics, CMAP_RATING: RATING, COMPARE_MAX, parseCompare,
  });
})((globalThis.Colormeris ??= {}));
