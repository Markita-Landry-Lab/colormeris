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

  Object.assign(CM, { createIndexer, indexColors, recolorPixels, similarMask, tAtPixel, newColorAt });
})((globalThis.Colormeris ??= {}));
