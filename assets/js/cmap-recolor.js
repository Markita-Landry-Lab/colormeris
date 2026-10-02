(function (CM) {
  'use strict';
  const { rgbToLab, labToT } = CM;

  // Recolor a figure into another colormap (the Recolor tab of colormaps.html).
  //   indexColors     each pixel's position t along the calibrated colorbar
  //                   and its color distance (ΔE76) to the bar, once per bar
  //   recolorPixels   pixels close to the bar get the new map's color at t;
  //                   the rest (background, text, axes) keep theirs
  //   similarMask     the pixels whose t is near a given one, for the hover
  //                   highlight
  // Images are ImageData-shaped { width, height, data: RGBA bytes }. Samples
  // are sampleColorbar's [{ t, lab }] from the bar's start to its end.

  const INDEX_DE = 'de76'; // fast, and the tolerance is a rough cut anyway
  const LUT_N = 4096; // new-map colors precomputed along t

  // Pixels are processed in chunks so the page can stay responsive on big
  // images. Colors are looked up once each: figures have few distinct colors.
  function createIndexer(img, samples) {
    const n = img.width * img.height;
    const t = new Float32Array(n);
    const de = new Float32Array(n);
    const cache = new Map(); // rgb as one int -> [t, deltaE]
    const d = img.data;
    let i = 0;
    function step(maxPixels = Infinity) {
      const end = Math.min(n, i + maxPixels);
      for (; i < end; i++) {
        const o = i * 4;
        let r = d[o];
        let g = d[o + 1];
        let b = d[o + 2];
        const a = d[o + 3];
        // Transparent pixels count as white, as readPixel does.
        if (a < 255) {
          const k = a / 255;
          r = Math.round(r * k + 255 * (1 - k));
          g = Math.round(g * k + 255 * (1 - k));
          b = Math.round(b * k + 255 * (1 - k));
        }
        const key = (r << 16) | (g << 8) | b;
        let hit = cache.get(key);
        if (!hit) {
          const m = labToT(rgbToLab([r, g, b]), samples, INDEX_DE);
          hit = [m.t, m.deltaE];
          cache.set(key, hit);
        }
        t[i] = hit[0];
        de[i] = hit[1];
      }
      return i / n;
    }
    return { index: { width: img.width, height: img.height, t, de }, step, colors: () => cache.size };
  }

  function indexColors(img, samples) {
    const ix = createIndexer(img, samples);
    ix.step();
    return ix.index;
  }

  // Colors of `map` ({ kind, rgbs }) at LUT_N points along t, as one byte array.
  function mapLut(map, reversed = false) {
    const lut = new Uint8ClampedArray(LUT_N * 3);
    for (let i = 0; i < LUT_N; i++) {
      const u = i / (LUT_N - 1);
      const c = CM.cmapColorAt(map, reversed ? 1 - u : u);
      lut[i * 3] = Math.round(c[0]);
      lut[i * 3 + 1] = Math.round(c[1]);
      lut[i * 3 + 2] = Math.round(c[2]);
    }
    return lut;
  }

  // The new map's color for each bar position t (the order of the sampled
  // bar). `flip` turns the bar's t around first, when it was drawn from the
  // high end, so the low end of the old map becomes the low end of the new one.
  function newColorAt(map, t, { reversed = false, flip = false } = {}) {
    const u = flip ? 1 - t : t;
    return CM.cmapColorAt(map, reversed ? 1 - u : u);
  }

  // Returns { width, height, data, changed } with a new RGBA byte array.
  function recolorPixels(img, index, map, { tolerance = 12, reversed = false, flip = false } = {}) {
    const lut = mapLut(map, reversed);
    const src = img.data;
    const out = new Uint8ClampedArray(src);
    const { t, de } = index;
    let changed = 0;
    for (let i = 0; i < t.length; i++) {
      if (!(de[i] <= tolerance)) continue;
      let u = Math.min(1, Math.max(0, t[i]));
      if (flip) u = 1 - u;
      const k = Math.round(u * (LUT_N - 1)) * 3;
      const o = i * 4;
      out[o] = lut[k];
      out[o + 1] = lut[k + 1];
      out[o + 2] = lut[k + 2];
      out[o + 3] = 255;
      changed++;
    }
    return { width: img.width, height: img.height, data: out, changed };
  }

  // Pixels within `band` of position t0 (both in bar order) and within the
  // tolerance of the bar. With step > 1 only every step-th pixel in each
  // direction is looked at, for a highlight drawn at screen size on big images.
  // Returns { mask: Uint8Array of 0/1, width, height, count, total }.
  function similarMask(index, t0, band, tolerance = 12, { step = 1, mask = null } = {}) {
    const { t, de } = index;
    const s = Math.max(1, Math.floor(step));
    const w = Math.ceil(index.width / s);
    const h = Math.ceil(index.height / s);
    const m = mask && mask.length === w * h ? mask : new Uint8Array(w * h);
    let count = 0;
    for (let y = 0, j = 0; y < h; y++) {
      const row = y * s * index.width;
      for (let x = 0; x < w; x++, j++) {
        const i = row + x * s;
        const on = de[i] <= tolerance && Math.abs(t[i] - t0) <= band ? 1 : 0;
        m[j] = on;
        count += on;
      }
    }
    return { mask: m, width: w, height: h, count, total: w * h };
  }

  // Bar position and distance of the pixel at (x, y), or null when it is not
  // close to the bar.
  function tAtPixel(index, x, y, tolerance = 12) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= index.width || yi >= index.height) return null;
    const i = yi * index.width + xi;
    if (!(index.de[i] <= tolerance)) return null;
    return { t: index.t[i], deltaE: index.de[i] };
  }

  // ---- test patterns (Compare tab) ----

  // Values in [0, 1] of an n × n test image, row by row (y = 0 at the top).
  // 'waves': two tilted sine waves of unrelated frequencies plus rings around
  // an off-center point (like the viscm-web test image), stretched to 0–1.
  // The hills, dips and saddles never repeat, so every value and slope occurs
  // somewhere, and edges or bands that are not in the data come from the map.
  // 'bumps': a smooth ramp from 0 (top left) to 0.92 (bottom right) with a
  // 6 × 6 grid of identical Gaussian bumps 0.08 high, so the same small
  // difference sits at every level. A perceptually uniform map shows every bump
  // equally; others hide bumps in their flat zones and exaggerate the rest.
  function sinePattern(n, kind = 'waves') {
    const out = new Float32Array(n * n);
    const at = (i) => (n > 1 ? i / (n - 1) : 0);
    if (kind === 'bumps') {
      const H = 0.08;
      const K = 6; // bumps per side
      const s2 = 2 * (0.22 / K) ** 2; // width: well apart from each other
      for (let j = 0; j < n; j++) {
        const y = at(j);
        for (let i = 0; i < n; i++) {
          const x = at(i);
          let bump = 0;
          for (let q = 0; q < K * K; q++) {
            const cx = ((q % K) + 0.5) / K;
            const cy = (Math.floor(q / K) + 0.5) / K;
            bump += Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / s2);
          }
          out[j * n + i] = Math.min(1, (1 - H) * (x + y) / 2 + H * bump);
        }
      }
      return out;
    }
    const TAU = 2 * Math.PI;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < n; j++) {
      const y = at(j);
      for (let i = 0; i < n; i++) {
        const x = at(i);
        const r = Math.hypot(x - 0.62, y - 0.38);
        const v = 0.4 * Math.sin(TAU * (1.35 * x + 0.45 * y))
          + 0.35 * Math.sin(TAU * (0.4 * x - 1.05 * y) + 1)
          + 0.25 * Math.sin(TAU * 2.3 * r);
        out[j * n + i] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (let k = 0; k < out.length; k++) out[k] = (out[k] - lo) / (hi - lo || 1);
    return out;
  }

  // Colors ([r, g, b] from 0 to 255, low end first) as a LUT_N-entry byte
  // array: linear between neighbors, or bands of equal width for qualitative maps.
  function colorsLut(colors, qualitative = false) {
    const lut = new Uint8ClampedArray(LUT_N * 3);
    const n = colors.length;
    for (let k = 0; k < LUT_N; k++) {
      const u = k / (LUT_N - 1);
      let c;
      if (qualitative || n < 2) {
        c = colors[Math.min(n - 1, Math.floor(u * n))];
      } else {
        const x = u * (n - 1);
        const i = Math.min(n - 2, Math.floor(x));
        const f = x - i;
        c = [0, 1, 2].map((q) => colors[i][q] + f * (colors[i + 1][q] - colors[i][q]));
      }
      lut[k * 3] = Math.round(c[0]);
      lut[k * 3 + 1] = Math.round(c[1]);
      lut[k * 3 + 2] = Math.round(c[2]);
    }
    return lut;
  }

  // Values in [0, 1] → RGBA bytes through a LUT from colorsLut.
  function paintValues(values, lut, out = new Uint8ClampedArray(values.length * 4)) {
    for (let i = 0; i < values.length; i++) {
      const k = Math.round(Math.min(1, Math.max(0, values[i])) * (LUT_N - 1)) * 3;
      out[i * 4] = lut[k];
      out[i * 4 + 1] = lut[k + 1];
      out[i * 4 + 2] = lut[k + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  Object.assign(CM, { createIndexer, indexColors, recolorPixels, similarMask, tAtPixel, newColorAt, sinePattern, colorsLut, paintValues });
})((globalThis.Colormeris ??= {}));
