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
    // Reading values back (as seen): share of the map in flat zones and share
    // with a look-alike elsewhere. yes allows one ambiguous sample of 64.
    readable: { flat: { yes: 0.05, partly: 0.2 }, ambiguous: { yes: 0.02, partly: 0.1 } },
  };

  const gradeLow = (v, { yes, partly }) => (v <= yes ? 'yes' : v <= partly ? 'partly' : 'no');
  const gradeHigh = (v, { yes, partly }) => (v >= yes ? 'yes' : v >= partly ? 'partly' : 'no');
  const gradeCvd = (ratio, min, { yes, partly }) =>
    ratio >= yes.ratio && min >= yes.min ? 'yes' : ratio >= partly.ratio && min >= partly.min ? 'partly' : 'no';

  // How well values can be read back from colors, as Colormeris does. A color
  // seen in a figure is off by a few ΔE (compression, print, blending), so a
  // difference of READ_DE (3 ΔE2000) is taken as the smallest one that can be
  // relied on. Per view (as seen, CVD, grayscale by ΔL*):
  //   levels      distinguishable steps from one end to the other (each READ_DE
  //               from the last), i.e. how many values the map can tell apart
  //   flat        share of the map where values 5% of the range apart differ by
  //               less than READ_DE: there a color pins the value down poorly
  //   ambiguous   share of the map whose color has a look-alike (< READ_DE)
  //               at least 10% away: one color could mean two values
  //   flatSpans, ambiguousSpans   the same as [t0, t1] intervals, for drawing
  // Qualitative maps have no order and return null.
  const READ_DE = 3;
  const FLAT_WINDOW = 0.05;

  function mergeSpans(spans) {
    const out = [];
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function readView(feats, dist, cyclic, gap = 0.1) {
    const n = feats.length;
    let levels = 1;
    let anchor = feats[0];
    for (let i = 1; i < n; i++) {
      if (dist(anchor, feats[i]) >= READ_DE) { levels++; anchor = feats[i]; }
    }
    const w = Math.max(1, Math.round(FLAT_WINDOW * (n - 1)));
    const flatSpans = [];
    let flatCount = 0;
    let windows = 0;
    for (let i = 0; i + w < n; i++) {
      windows++;
      if (dist(feats[i], feats[i + w]) < READ_DE) {
        flatCount++;
        flatSpans.push([i / (n - 1), (i + w) / (n - 1)]);
      }
    }
    // Ambiguity on 64 samples, like the separations.
    const m = Math.min(n, SAMPLES);
    const idx = Array.from({ length: m }, (_, k) => Math.round((k * (n - 1)) / (m - 1)));
    const minIdx = Math.max(1, Math.ceil(gap * (cyclic ? m : m - 1) - 1e-9));
    const amb = new Array(m).fill(false);
    for (let i = 0; i < m; i++) {
      for (let j = i + minIdx; j < m; j++) {
        if (cyclic && m - (j - i) < minIdx) continue;
        if (dist(feats[idx[i]], feats[idx[j]]) < READ_DE) amb[i] = amb[j] = true;
      }
    }
    const half = 0.5 / (m - 1);
    const ambiguousSpans = mergeSpans(amb.flatMap((on, k) => (on ? [[Math.max(0, k / (m - 1) - half), Math.min(1, k / (m - 1) + half)]] : [])));
    return {
      levels,
      flat: windows ? flatCount / windows : 0,
      ambiguous: amb.filter(Boolean).length / m,
      flatSpans: mergeSpans(flatSpans),
      ambiguousSpans,
    };
  }

  function readability(rgbs, { kind = 'continuous', cyclic = false } = {}) {
    if (kind === 'qualitative' || rgbs.length < 2) return null;
    const out = { orig: readView(rgbs.map(rgbToLab), labDist, cyclic) };
    for (const type of CVD_TYPES) out[type] = readView(rgbs.map((c) => rgbToLab(simulateCvd(c, type))), labDist, cyclic);
    out.gray = readView(rgbs.map((c) => rgbToLab(c)[0]), lDist, cyclic);
    return out;
  }

  function gradeReadable({ flat, ambiguous }, { flat: f, ambiguous: a }) {
    if (flat <= f.yes && ambiguous <= a.yes) return 'yes';
    if (flat <= f.partly && ambiguous <= a.partly) return 'partly';
    return 'no';
  }

  // Everything the viewer shows for one map, computed once. steps are between
  // 64 evenly spaced samples, so step i spans t = i/63 to (i+1)/63.
  //   uniform    perceptually uniform: even ΔE steps (null for qualitative maps)
  //   cvdSafe    distinct values stay distinct in all three CVD views
  //   graySafe   distinct values stay distinct in grayscale (prints in black and white)
  //   readable   values can be read back from the colors as seen (null for qualitative maps)
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
    const read = readability(rgbs, { kind, cyclic });
    return {
      steps,
      stepStats: st,
      lch: lchProfile(rgbs),
      separations: sep,
      cvdWorst,
      cvdRatio,
      readability: read,
      rating: {
        uniform: discrete ? null : gradeLow(st.cv, RATING.uniform),
        cvdSafe: gradeCvd(cvdRatio, cvdWorst, RATING.cvd),
        graySafe: gradeHigh(grayMin, RATING.gray),
        readable: read ? gradeReadable(read.orig, RATING.readable) : null,
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

  const pct = (v) => `${Math.round(v * 100)}%`;

  // The CVD view that keeps the least separation.
  function worstCvd(m) {
    return CVD_TYPES.reduce((a, b) => (m.separations[b].min < m.separations[a].min ? b : a), CVD_TYPES[0]);
  }

  // One sentence per rating, shared by the pill tooltips, the rating columns
  // and the detail summary, so the numbers read the same everywhere.
  // Ratings that do not apply (null) are left out.
  function ratingNotes(m, { qual = false } = {}) {
    const out = [];
    if (!qual && m.rating.uniform) {
      out.push({ key: 'uniform', label: 'Uniform', rating: m.rating.uniform,
        text: `ΔE2000 steps vary by ${Math.round(m.stepStats.cv * 100)}% (CV ${m.stepStats.cv.toFixed(2)}).` });
    }
    out.push({ key: 'cvdSafe', label: 'CVD-safe', rating: m.rating.cvdSafe,
      text: `The worst view (${worstCvd(m)}) keeps ${pct(m.cvdRatio)} of the separation (min ΔE ${m.cvdWorst.toFixed(1)}).` });
    const g = m.separations.gray;
    out.push({ key: 'graySafe', label: 'Grayscale-safe', rating: m.rating.graySafe,
      text: `${qual ? 'Two colors differ' : 'Two values 10% apart differ'} by only ${g.min.toFixed(1)} L*.` });
    if (m.readability && m.rating.readable) {
      const { orig } = m.readability;
      out.push({ key: 'readable', label: 'Readable', rating: m.rating.readable,
        text: `${pct(orig.flat)} of the map is flat, ${pct(orig.ambiguous)} has a look-alike color elsewhere, ${orig.levels} distinguishable levels.` });
    }
    return out;
  }

  // How each rating is made, with the thresholds. Shown in the "?" popovers
  // and in the footer of the viewer.
  function ratingMethod() {
    const R = RATING;
    const RD = R.readable;
    return {
      uniform: `We measure the color difference (ΔE2000) between neighbors among ${SAMPLES} evenly spaced colors. The rating uses how much these steps vary, as the coefficient of variation (CV = standard deviation / mean): yes at CV ≤ ${R.uniform.yes}, partly up to ${R.uniform.partly}. A uniform map shows equal steps in the data as equal steps in color. Qualitative maps are not rated.`,
      cvdSafe: `For the map and for each CVD view we find the smallest ΔE2000 between two values at least 10% of the map apart (cyclic maps count around the circle, qualitative maps compare all pairs). The worst CVD view must keep at least ${pct(R.cvd.yes.ratio)} of the map’s own smallest difference and at least ${R.cvd.yes.min} ΔE for yes, or ${pct(R.cvd.partly.ratio)} and ${R.cvd.partly.min} ΔE for partly.`,
      graySafe: `The same search on L* alone: values 10% apart differ by at least ${R.gray.yes} L* for yes, or ${R.gray.partly} L* for partly.`,
      readable: `Can you read a value back from a color, as Colormeris does? A color in a figure is off by a few ΔE (compression, print, blending), so differences under ${READ_DE} ΔE2000 are not relied on. Flat is the share of the map where values ${pct(FLAT_WINDOW)} of the range apart differ by less than that. Ambiguous is the share whose color has a look-alike (under ${READ_DE} ΔE) at a value at least 10% away. Yes needs at most ${pct(RD.flat.yes)} flat and ${pct(RD.ambiguous.yes)} ambiguous; partly at most ${pct(RD.flat.partly)} and ${pct(RD.ambiguous.partly)}. This is not the same as Uniform: jet is readable, since its colors are all different, but not uniform. Qualitative maps are not rated.`,
    };
  }

  // What the viewer opens on, from its URL: the tab (#browse, #compare,
  // #identify), the map whose details are open (?map=) and the compared maps
  // (?compare=). Other hashes (#ref-…) leave the tab alone (tab: null). Old
  // shared links have only ?compare=, so they open on the comparison.
  const VIEWER_TABS = ['browse', 'compare', 'identify'];

  function parseViewerRoute(search, hash, names) {
    const params = new URLSearchParams(search || '');
    const compare = parseCompare(params.get('compare'), names);
    const want = String(params.get('map') ?? '').trim().toLowerCase();
    const map = want ? names.find((n) => n.toLowerCase() === want) ?? null : null;
    const h = String(hash || '').replace(/^#/, '').toLowerCase();
    let tab = VIEWER_TABS.includes(h) ? h : null;
    if (!h) tab = compare.length && !map ? 'compare' : 'browse';
    return { tab, map, compare };
  }

  Object.assign(CM, {
    perceptualSteps, stepStats, resample, lchOf, lchProfile, minSeparation, separations, readability, READ_DE, READ_WINDOW: FLAT_WINDOW, colormapMetrics, CMAP_RATING: RATING, COMPARE_MAX, parseCompare,
    worstCvd, ratingNotes, ratingMethod, VIEWER_TABS, parseViewerRoute,
  });
})((globalThis.Colormeris ??= {}));
