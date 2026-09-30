(function (CM) {
  'use strict';

  // Heatmap grid geometry and pixel sampling.
  // A grid is defined by four outer corners in image pixel space, ordered
  // [topLeft, topRight, bottomRight, bottomLeft]. Points inside the grid are
  // addressed with normalized (u, v) in [0, 1]², u along columns, v along rows.

  function rectCorners(p1, p2) {
    const x0 = Math.min(p1.x, p2.x);
    const x1 = Math.max(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y);
    const y1 = Math.max(p1.y, p2.y);
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }

  function bilinear(corners, u, v) {
    const [tl, tr, br, bl] = corners;
    const a = (1 - u) * (1 - v);
    const b = u * (1 - v);
    const c = u * v;
    const d = (1 - u) * v;
    return {
      x: a * tl.x + b * tr.x + c * br.x + d * bl.x,
      y: a * tl.y + b * tr.y + c * br.y + d * bl.y,
    };
  }

  // Inverse bilinear mapping by Newton iteration. Returns {u, v}; values
  // outside [0, 1] mean the point lies outside the grid.
  function invertBilinear(corners, p) {
    const [tl, tr, br, bl] = corners;
    let u = 0.5;
    let v = 0.5;
    for (let i = 0; i < 20; i++) {
      const q = bilinear(corners, u, v);
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      if (Math.abs(ex) < 1e-6 && Math.abs(ey) < 1e-6) break;
      const dxdu = (1 - v) * (tr.x - tl.x) + v * (br.x - bl.x);
      const dydu = (1 - v) * (tr.y - tl.y) + v * (br.y - bl.y);
      const dxdv = (1 - u) * (bl.x - tl.x) + u * (br.x - tr.x);
      const dydv = (1 - u) * (bl.y - tl.y) + u * (br.y - tr.y);
      const det = dxdu * dydv - dxdv * dydu;
      if (Math.abs(det) < 1e-12) break;
      u -= (ex * dydv - ey * dxdv) / det;
      v -= (ey * dxdu - ex * dydu) / det;
    }
    return { u, v };
  }

  function cellAt(grid, p) {
    const { u, v } = invertBilinear(grid.corners, p);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return { row: Math.floor(v * grid.rows), col: Math.floor(u * grid.cols) };
  }

  // Normalized bounds of the sampled (central) part of a cell.
  function cellSampleBounds(grid, row, col) {
    const f = grid.sampleFraction;
    const u0 = (col + 0.5 - f / 2) / grid.cols;
    const u1 = (col + 0.5 + f / 2) / grid.cols;
    const v0 = (row + 0.5 - f / 2) / grid.rows;
    const v1 = (row + 0.5 + f / 2) / grid.rows;
    return { u0, u1, v0, v1 };
  }

  function cellSamplePolygon(grid, row, col) {
    const { u0, u1, v0, v1 } = cellSampleBounds(grid, row, col);
    return [
      bilinear(grid.corners, u0, v0),
      bilinear(grid.corners, u1, v0),
      bilinear(grid.corners, u1, v1),
      bilinear(grid.corners, u0, v1),
    ];
  }

  // Read one pixel as [r, g, b], compositing transparency onto white.
  function readPixel(img, x, y) {
    const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
    const i = (yi * img.width + xi) * 4;
    const d = img.data;
    const a = d[i + 3] / 255;
    if (a >= 1) return [d[i], d[i + 1], d[i + 2]];
    return [d[i] * a + 255 * (1 - a), d[i + 1] * a + 255 * (1 - a), d[i + 2] * a + 255 * (1 - a)];
  }

  function median(values) {
    values.sort((a, b) => a - b);
    const m = values.length >> 1;
    return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
  }

  // Per-channel median color over the central part of a cell. Sampling density
  // is roughly one sample per image pixel.
  function sampleCell(img, grid, row, col) {
    const { u0, u1, v0, v1 } = cellSampleBounds(grid, row, col);
    const c = grid.corners;
    const width = Math.max(
      Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y),
      Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y),
    );
    const height = Math.max(
      Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y),
      Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y),
    );
    const nu = Math.max(1, Math.ceil(width * (u1 - u0)));
    const nv = Math.max(1, Math.ceil(height * (v1 - v0)));
    const rs = [];
    const gs = [];
    const bs = [];
    for (let j = 0; j < nv; j++) {
      const v = v0 + ((j + 0.5) / nv) * (v1 - v0);
      for (let i = 0; i < nu; i++) {
        const u = u0 + ((i + 0.5) / nu) * (u1 - u0);
        const p = bilinear(c, u, v);
        const [r, g, b] = readPixel(img, p.x, p.y);
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
    return [median(rs), median(gs), median(bs)];
  }

  // ---- Grid size detection -------------------------------------------------

  const MAX_PROFILE_SAMPLES = 1500;
  const MAX_PROFILE_LINES = 200;
  const MAX_CELLS = 200;
  // Minimum periodicity (normalized autocorrelation contrast) to accept any
  // split at all; below this the area is treated as a single cell.
  const MIN_SCORE = 0.1;
  // Minimum strength of the strongest edge (mean |ΔR|+|ΔG|+|ΔB| per line).
  const MIN_EDGE = 4;

  function gridPixelSize(corners) {
    const c = corners;
    return {
      width: Math.max(Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y), Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y)),
      height: Math.max(Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y), Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)),
    };
  }

  // Color change between neighbouring samples along one axis, summed over
  // lines across the other axis. `axis` is 'u' (profile across columns) or 'v'
  // (profile across rows). Entry i is the mean change (|ΔR|+|ΔG|+|ΔB| per line)
  // between samples i-1 and i.
  function edgeProfile(img, corners, axis, samples, lines) {
    const prof = new Float64Array(samples);
    for (let j = 0; j < lines; j++) {
      const w = (j + 0.5) / lines;
      let prev = null;
      for (let i = 0; i < samples; i++) {
        const s = (i + 0.5) / samples;
        const p = axis === 'u' ? bilinear(corners, s, w) : bilinear(corners, w, s);
        const rgb = readPixel(img, p.x, p.y);
        if (prev) prof[i] += Math.abs(rgb[0] - prev[0]) + Math.abs(rgb[1] - prev[1]) + Math.abs(rgb[2] - prev[2]);
        prev = rgb;
      }
    }
    for (let i = 0; i < samples; i++) prof[i] /= lines;
    return prof;
  }

  // Normalized autocorrelation of a profile for lags 0..maxLag. It depends only
  // on the spacing of the edges, not on where they start, so it is insensitive
  // to grid corners placed a few pixels off.
  function autocorrelation(prof, maxLag) {
    const N = prof.length;
    let mean = 0;
    for (let i = 1; i < N; i++) mean += prof[i];
    mean /= Math.max(1, N - 1);
    const x = new Float64Array(N);
    for (let i = 1; i < N; i++) x[i] = prof[i] - mean;
    const ac = new Float64Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) {
      let sum = 0;
      for (let i = 1; i + L < N; i++) sum += x[i] * x[i + L];
      ac[L] = sum / (N - 1 - L);
    }
    const zero = ac[0];
    if (zero > 0) for (let L = 0; L <= maxLag; L++) ac[L] /= zero;
    return ac;
  }

  // How well a cell size of P samples explains the edge spacing:
  // autocorrelation at multiples of P minus autocorrelation halfway between
  // them. Cell sizes that are multiples of the true one (fewer, bigger cells)
  // are penalized when their midpoints fall on real spacings; fractions of it
  // (more, smaller cells) because many of their lags are empty.
  function scorePeriod(ac, P) {
    const maxLag = ac.length - 1;
    const peak = (lag) => {
      // Tolerance grows with lag to absorb a slightly wrong cell size, but stays
      // well inside one cell so neighbouring spacings are not picked up.
      const r = Math.max(1, Math.min(P / 4, 1 + 0.02 * lag));
      const lo = Math.max(1, Math.round(lag - r));
      const hi = Math.min(maxLag, Math.round(lag + r));
      let m = -Infinity;
      for (let i = lo; i <= hi; i++) if (ac[i] > m) m = ac[i];
      return m;
    };
    let on = 0;
    let onCount = 0;
    for (let m = 1; m * P <= maxLag + 0.5; m++, onCount++) on += peak(m * P);
    let off = 0;
    let offCount = 0;
    for (let m = 1; (m - 0.5) * P <= maxLag; m++, offCount++) off += peak((m - 0.5) * P);
    if (!onCount || !offCount) return 0;
    return on / onCount - off / offCount;
  }

  // Count whole cells inside the placed range given an estimated cell size P0.
  // Finds where the boundaries sit, then counts cells whose centre is inside the
  // range, so a cell cut by a slightly too-small box still counts, and drops
  // end cells with no outer edge, so white margin from a too-large box does not.
  function countCells(prof, P0, margin) {
    const N = prof.length;
    const r = Math.max(1, Math.min(P0 / 4, 2));
    // Edge strength near a position, discounted by distance so an exactly
    // aligned boundary comb beats one that merely stays within the window.
    const peak = (pos) => {
      const lo = Math.max(1, Math.round(pos - r));
      const hi = Math.min(N - 1, Math.round(pos + r));
      let m = 0;
      for (let i = lo; i <= hi; i++) m = Math.max(m, prof[i] * (1 - Math.abs(i - pos) / (r + 1)));
      return m;
    };
    // Fit the cell size (within ±8% of the estimate; no harmonic is that close)
    // and the phase so the boundary comb best matches the edges away from the ends.
    let P = P0;
    let phase = 0;
    let bestSum = -1;
    for (let f = 0.92; f <= 1.08 + 1e-9; f += 0.002) {
      const Pf = P0 * f;
      for (let phi = 0; phi < Pf; phi += 0.5) {
        let sum = 0;
        let teeth = 0;
        for (let pos = phi; pos < N; pos += Pf) {
          if (pos >= margin && pos <= N - margin) {
            sum += peak(pos);
            teeth++;
          }
        }
        // Mean, not sum, so smaller sizes do not win just by having more teeth.
        if (teeth) sum /= teeth;
        if (sum > bestSum) {
          bestSum = sum;
          phase = phi;
          P = Pf;
        }
      }
    }
    const interior = [];
    for (let pos = phase; pos < N; pos += P) if (pos >= margin && pos <= N - margin) interior.push(peak(pos));
    interior.sort((a, b) => a - b);
    const typical = interior.length ? interior[interior.length >> 1] : 0;
    const threshold = 0.25 * typical;
    // Boundaries outside the placed range cannot be checked; assume the grid continues.
    const present = (pos) => pos < 0.5 || pos > N - 1.5 || peak(pos) >= threshold;
    // Cells whose centre is inside the placed range; then drop cells at either
    // end whose outer boundary shows no edge (margin outside the heatmap).
    // Interior boundaries may legitimately be faint (similar neighbouring
    // colors), so they are not checked.
    const cells = [];
    for (let k = -1; phase + k * P < N; k++) {
      const a = phase + k * P;
      const centre = a + P / 2;
      if (centre >= 0 && centre <= N) cells.push(a);
    }
    while (cells.length > 1 && !present(cells[0])) cells.shift();
    while (cells.length > 1 && !present(cells[cells.length - 1] + P)) cells.pop();
    return Math.max(1, cells.length);
  }

  const MIN_CELL = 4; // samples
  const PERIOD_STEP = 1.005; // relative step of the cell-size search

  // Estimate the cell count along one profile. The cell size is searched
  // continuously rather than as width / n, so a grid placed a few pixels too
  // wide or narrow still yields the right count.
  function bestCount(profile) {
    const N = profile.length;
    if (N < 2 * MIN_CELL) return { count: 1, confidence: 0 };
    // Ignore the ends: frame lines, axis ticks and margins just outside or
    // inside a roughly placed grid would otherwise dominate the profile.
    const prof = Float64Array.from(profile);
    const margin = Math.round(2 + 0.02 * N);
    let mid = 0;
    for (let i = margin; i < N - margin; i++) mid += prof[i];
    mid /= Math.max(1, N - 2 * margin);
    for (let i = 0; i < Math.min(margin, N); i++) prof[i] = prof[N - 1 - i] = mid;
    // Treat areas without clear color changes as one cell; the autocorrelation
    // below is scale-free and would otherwise find patterns in pixel noise.
    let strongest = 0;
    for (let i = margin; i < N - margin; i++) strongest = Math.max(strongest, prof[i]);
    if (strongest < MIN_EDGE) return { count: 1, confidence: 0 };

    // Lags a bit beyond N/2 so a two-cell grid (P = N/2) is not at the edge.
    const ac = autocorrelation(prof, Math.floor(0.6 * N));
    const minP = Math.max(MIN_CELL, N / MAX_CELLS);
    const cands = [];
    let best = null;
    for (let P = minP; P <= N / 2 + 1e-9; P *= PERIOD_STEP) {
      const c = { P, score: scorePeriod(ac, P) };
      cands.push(c);
      if (!best || c.score > best.score) best = c;
    }
    if (!best || best.score < MIN_SCORE) return { count: 1, confidence: 0 };
    // A multiple of the true cell size by an odd factor (e.g. 3 cells merged)
    // scores as well as the true size, because its midpoints fall between real
    // boundaries; fractions of the true size score only about 1/k as well. So
    // move to a fraction while it keeps most of the score, refining the size
    // around it. (Even factors are already penalized by the midpoint term.)
    const refine = (P) => {
      let b = { P, score: scorePeriod(ac, P) };
      for (let f = 0.97; f <= 1.03; f += 0.005) {
        const s = scorePeriod(ac, P * f);
        if (s > b.score) b = { P: P * f, score: s };
      }
      return b;
    };
    for (let grew = true; grew; ) {
      grew = false;
      for (const k of [3, 5, 7]) {
        if (best.P / k < minP) continue;
        const c = refine(best.P / k);
        if (c.score >= 0.6 * best.score) {
          best = c;
          grew = true;
          break;
        }
      }
    }
    // Runner-up among sizes that are not simple multiples or fractions of the winner.
    const harmonic = (P) => {
      const r = P > best.P ? P / best.P : best.P / P;
      // Near-harmonics (within 10%) score highly just from the peak tolerance.
      return Math.abs(r - Math.round(r)) < 0.1 * r;
    };
    let runner = 0;
    for (const c of cands) if (!harmonic(c.P)) runner = Math.max(runner, c.score);
    return { count: countCells(profile, best.P, margin), confidence: runner > 0 ? best.score / runner : Infinity };
  }

  // Guess the number of rows and columns inside a placed grid from where its
  // colors change. Returns {rows, cols, rowConfidence, colConfidence}; a
  // confidence below ~1.3 means the guess is uncertain.
  function detectGridSize(img, corners) {
    const { width, height } = gridPixelSize(corners);
    const W = Math.max(2, Math.min(MAX_PROFILE_SAMPLES, Math.round(width)));
    const H = Math.max(2, Math.min(MAX_PROFILE_SAMPLES, Math.round(height)));
    const colFit = bestCount(edgeProfile(img, corners, 'u', W, Math.min(MAX_PROFILE_LINES, H)));
    const rowFit = bestCount(edgeProfile(img, corners, 'v', H, Math.min(MAX_PROFILE_LINES, W)));
    return { rows: rowFit.count, cols: colFit.count, rowConfidence: rowFit.confidence, colConfidence: colFit.confidence };
  }

  Object.assign(CM, {
    detectGridSize,
    edgeProfile,
    autocorrelation,
    scorePeriod,
    countCells,
    bestCount,
    rectCorners, bilinear, invertBilinear, cellAt, cellSampleBounds, cellSamplePolygon, readPixel, sampleCell });
})((globalThis.Colormeris ??= {}));
