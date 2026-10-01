(function (CM) {
  'use strict';
  const { srgbToLinear, linearToSrgb, rgbToLab, labToRgb } = CM;

  // Color vision deficiency (CVD) simulation, grayscale and lightness checks for
  // the colormap viewer (colormaps.html). RGB values are 0–255 sRGB.

  // Machado, Oliveira & Fernandes (2009), IEEE TVCG 15(6):1291–1298, severity
  // 1.0. Applied to linear RGB, as colorspacious (used by matplotlib's colormap
  // docs) does, so the views match matplotlib's.
  const MACHADO = {
    protanopia: [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    deuteranopia: [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.01182, 0.04294, 0.968881],
    ],
    tritanopia: [
      [1.255528, -0.076749, -0.178779],
      [-0.078411, 0.930809, 0.147602],
      [0.004733, 0.691367, 0.3039],
    ],
  };

  const CVD_TYPES = Object.keys(MACHADO);

  function simulateCvd(rgb, type) {
    const m = MACHADO[type];
    if (!m) throw new Error(`Unknown CVD type: ${type}`);
    const lin = rgb.map(srgbToLinear);
    // linearToSrgb clips to [0, 1] and rounds.
    return m.map((row) => linearToSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  }

  // ---- Image simulation (the CVD tab) ----
  // Three models, as compared in the DaltonLens review
  // (https://daltonlens.org/opensource-cvd-simulation/), all in linear sRGB:
  //   brettel  Brettel, Viénot & Mollon 1997: two half-planes; the only sound
  //            choice for tritan
  //   vienot   Viénot, Brettel & Mollon 1999: one plane; protan and deutan only
  //   machado  Machado et al. 2009: one matrix per severity step of 0.1; the
  //            most principled for partial severity (anomalous trichromacy)
  // Brettel and Viénot model only full dichromacy; lower severities blend with
  // the original in linear RGB, as libDaltonLens does.
  // Achromatopsia (no color at all) is not one of CVD_TYPES, which are the
  // strips' views: it is the gray of the same luminance Y, so the same L* as
  // `grayscale`, with the same severity blend.

  // Machado 2009, severity 0.0, 0.1, …, 1.0 (row-major 3 × 3). From the
  // authors' page via colour-science and DaltonLens-Python; the last entries
  // equal MACHADO.
  const MACHADO_SEVERITY = {
    protanopia: [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0.856167, 0.182038, -0.038205, 0.029342, 0.955115, 0.015544, -0.00288, -0.001563, 1.004443],
      [0.734766, 0.334872, -0.069637, 0.05184, 0.919198, 0.028963, -0.004928, -0.004209, 1.009137],
      [0.630323, 0.465641, -0.095964, 0.069181, 0.890046, 0.040773, -0.006308, -0.007724, 1.014032],
      [0.539009, 0.579343, -0.118352, 0.082546, 0.866121, 0.051332, -0.007136, -0.011959, 1.019095],
      [0.458064, 0.679578, -0.137642, 0.092785, 0.846313, 0.060902, -0.007494, -0.016807, 1.024301],
      [0.38545, 0.769005, -0.154455, 0.100526, 0.829802, 0.069673, -0.007442, -0.02219, 1.029632],
      [0.319627, 0.849633, -0.169261, 0.106241, 0.815969, 0.07779, -0.007025, -0.028051, 1.035076],
      [0.259411, 0.923008, -0.18242, 0.110296, 0.80434, 0.085364, -0.006276, -0.034346, 1.040622],
      [0.203876, 0.990338, -0.194214, 0.112975, 0.794542, 0.092483, -0.005222, -0.041043, 1.046265],
      [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
    ],
    deuteranopia: [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0.866435, 0.177704, -0.044139, 0.049567, 0.939063, 0.01137, -0.003453, 0.007233, 0.99622],
      [0.760729, 0.319078, -0.079807, 0.090568, 0.889315, 0.020117, -0.006027, 0.013325, 0.992702],
      [0.675425, 0.43385, -0.109275, 0.125303, 0.847755, 0.026942, -0.00795, 0.018572, 0.989378],
      [0.605511, 0.52856, -0.134071, 0.155318, 0.812366, 0.032316, -0.009376, 0.023176, 0.9862],
      [0.547494, 0.607765, -0.155259, 0.181692, 0.781742, 0.036566, -0.01041, 0.027275, 0.983136],
      [0.498864, 0.674741, -0.173604, 0.205199, 0.754872, 0.039929, -0.011131, 0.030969, 0.980162],
      [0.457771, 0.731899, -0.18967, 0.226409, 0.731012, 0.042579, -0.011595, 0.034333, 0.977261],
      [0.422823, 0.781057, -0.203881, 0.245752, 0.709602, 0.044646, -0.011843, 0.037423, 0.974421],
      [0.392952, 0.82361, -0.216562, 0.263559, 0.69021, 0.046232, -0.01191, 0.040281, 0.97163],
      [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
    ],
    tritanopia: [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0.92667, 0.092514, -0.019184, 0.021191, 0.964503, 0.014306, 0.008437, 0.054813, 0.93675],
      [0.89572, 0.13333, -0.02905, 0.029997, 0.9454, 0.024603, 0.013027, 0.104707, 0.882266],
      [0.905871, 0.127791, -0.033662, 0.026856, 0.941251, 0.031893, 0.01341, 0.148296, 0.838294],
      [0.948035, 0.08949, -0.037526, 0.014364, 0.946792, 0.038844, 0.010853, 0.193991, 0.795156],
      [1.017277, 0.027029, -0.044306, -0.006113, 0.958479, 0.047634, 0.006379, 0.248708, 0.744913],
      [1.104996, -0.046633, -0.058363, -0.032137, 0.971635, 0.060503, 0.001336, 0.317922, 0.680742],
      [1.193214, -0.109812, -0.083402, -0.058496, 0.97941, 0.079086, -0.002346, 0.403492, 0.598854],
      [1.257728, -0.139648, -0.118081, -0.078003, 0.975409, 0.102594, -0.003316, 0.501214, 0.502102],
      [1.278864, -0.125333, -0.153531, -0.084748, 0.957674, 0.127074, -0.000989, 0.601151, 0.399838],
      [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
    ],
  };

  // libDaltonLens' precomputed sRGB parameters (Smith & Pokorny cone
  // fundamentals): the matrix for each half-plane, chosen by the sign of
  // rgb · normal.
  const BRETTEL = {
    protanopia: {
      m1: [0.1498, 1.19548, -0.34528, 0.10764, 0.84864, 0.04372, 0.00384, -0.0054, 1.00156],
      m2: [0.1457, 1.16172, -0.30742, 0.10816, 0.85291, 0.03892, 0.00386, -0.00524, 1.00139],
      n: [0.00048, 0.00393, -0.00441],
    },
    deuteranopia: {
      m1: [0.36477, 0.86381, -0.22858, 0.26294, 0.64245, 0.09462, -0.02006, 0.02728, 0.99278],
      m2: [0.37298, 0.88166, -0.25464, 0.25954, 0.63506, 0.1054, -0.0198, 0.02784, 0.99196],
      n: [-0.00281, -0.00611, 0.00892],
    },
    tritanopia: {
      m1: [1.01277, 0.13548, -0.14826, -0.01243, 0.86812, 0.14431, 0.07589, 0.805, 0.11911],
      m2: [0.93678, 0.18979, -0.12657, 0.06154, 0.81526, 0.1232, -0.37562, 1.12767, 0.24796],
      n: [0.03901, -0.02788, -0.01113],
    },
  };

  // libDaltonLens' Viénot 1999 matrices. It has none for tritan worth using.
  const VIENOT = {
    protanopia: [0.11238, 0.88762, 0, 0.11238, 0.88762, 0, 0.00401, -0.00401, 1],
    deuteranopia: [0.29275, 0.70725, 0, 0.29275, 0.70725, 0, -0.02234, 0.02234, 1],
  };

  const CVD_MODELS = ['brettel', 'vienot', 'machado'];
  const ACHROMAT = 'achromatopsia';
  const LUMA = [0.2126729, 0.7151522, 0.072175]; // Y of linear sRGB, as rgbToLab

  // 'recommended' follows the DaltonLens review: Brettel for tritan, Machado
  // for protan and deutan. Viénot asked for tritan falls back to Brettel.
  function resolveCvdModel(type, model = 'recommended') {
    if (type === ACHROMAT) return 'luminance';
    if (!CVD_MODELS.includes(model)) return type === 'tritanopia' ? 'brettel' : 'machado';
    if (model === 'vienot' && !VIENOT[type]) return 'brettel';
    return model;
  }

  const mul = (m, r, g, b, out, k) => {
    out[k] = m[0] * r + m[1] * g + m[2] * b;
    out[k + 1] = m[3] * r + m[4] * g + m[5] * b;
    out[k + 2] = m[6] * r + m[7] * g + m[8] * b;
  };

  // A function (r, g, b linear, out, k) that writes the simulated linear RGB
  // to out[k..k+2].
  function cvdLinearFn(type, { model = 'recommended', severity = 1 } = {}) {
    if (!MACHADO[type] && type !== ACHROMAT) throw new Error(`Unknown CVD type: ${type}`);
    const s = Math.min(1, Math.max(0, Number(severity) || 0));
    const m = resolveCvdModel(type, model);
    if (m === 'machado') {
      // Interpolate between the two nearest tabulated severities.
      const table = MACHADO_SEVERITY[type];
      const lo = Math.min(9, Math.floor(s * 10 + 1e-9));
      const a = s * 10 - lo;
      const mat = table[lo].map((v, i) => v * (1 - a) + table[lo + 1][i] * a);
      return (r, g, b, out, k) => mul(mat, r, g, b, out, k);
    }
    const blend = (r, g, b, out, k) => {
      if (s >= 1) return;
      out[k] = s * out[k] + (1 - s) * r;
      out[k + 1] = s * out[k + 1] + (1 - s) * g;
      out[k + 2] = s * out[k + 2] + (1 - s) * b;
    };
    if (m === 'luminance') {
      return (r, g, b, out, k) => {
        out[k] = out[k + 1] = out[k + 2] = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
        blend(r, g, b, out, k);
      };
    }
    if (m === 'vienot') {
      const mat = VIENOT[type];
      return (r, g, b, out, k) => { mul(mat, r, g, b, out, k); blend(r, g, b, out, k); };
    }
    const { m1, m2, n } = BRETTEL[type];
    return (r, g, b, out, k) => {
      mul(r * n[0] + g * n[1] + b * n[2] >= 0 ? m1 : m2, r, g, b, out, k);
      blend(r, g, b, out, k);
    };
  }

  // One 0–255 sRGB color.
  function simulateCvdColor(rgb, type, opts) {
    const f = cvdLinearFn(type, opts);
    const out = [0, 0, 0];
    f(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]), out, 0);
    return out.map(linearToSrgb);
  }

  let LIN = null; // sRGB byte -> linear, built on first use

  // Simulate RGBA bytes (ImageData.data) into `out` (same length; a new array
  // by default), alpha kept. Figures have few distinct colors, so each is
  // computed once (`cache`, shared across chunks of the same image and
  // settings). `from`/`to` are pixel indices, for chunked runs.
  function simulateCvdPixels(rgba, type, opts = {}) {
    const { out = new Uint8ClampedArray(rgba.length), from = 0, to = rgba.length / 4, cache = new Map() } = opts;
    const f = opts.fn || cvdLinearFn(type, opts);
    LIN ??= Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
    const tmp = [0, 0, 0];
    for (let p = from; p < to; p++) {
      const o = p * 4;
      const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      let hit = cache.get(key);
      if (hit === undefined) {
        f(LIN[rgba[o]], LIN[rgba[o + 1]], LIN[rgba[o + 2]], tmp, 0);
        hit = (linearToSrgb(tmp[0]) << 16) | (linearToSrgb(tmp[1]) << 8) | linearToSrgb(tmp[2]);
        cache.set(key, hit);
      }
      out[o] = hit >> 16;
      out[o + 1] = (hit >> 8) & 255;
      out[o + 2] = hit & 255;
      out[o + 3] = rgba[o + 3];
    }
    return out;
  }

  // CIELAB L* (0–100).
  function lightness(rgb) {
    return rgbToLab(rgb)[0];
  }

  // The gray with the same L*: matplotlib's docs judge colormaps in grayscale by L*.
  function grayscale(rgb) {
    return labToRgb([lightness(rgb), 0, 0]);
  }

  // How straight an L* profile is. The endpoint line runs from the first to the
  // last value (what a linear colormap with the same ends would have).
  //   monotonic   L* never changes direction (steps under `tol` are ignored)
  //   reversals   number of direction changes
  //   r2          R² of the least-squares straight line (1 = perfectly linear,
  //               0 = no linear trend; null when the profile is flat). Unlike
  //               the endpoint line it stays in [0, 1], so it is easy to read.
  //   maxDev      largest |L* − endpoint line|
  function lightnessStats(Ls, tol = 0.5) {
    const n = Ls.length;
    if (n < 2) return { monotonic: true, reversals: 0, r2: null, maxDev: 0, range: [Ls[0] ?? 0, Ls[0] ?? 0] };
    const first = Ls[0];
    const last = Ls[n - 1];
    const mean = Ls.reduce((a, b) => a + b, 0) / n;
    const xMean = (n - 1) / 2;
    let sxy = 0;
    let sxx = 0;
    let sst = 0;
    let maxDev = 0;
    for (let i = 0; i < n; i++) {
      sxy += (i - xMean) * (Ls[i] - mean);
      sxx += (i - xMean) ** 2;
      sst += (Ls[i] - mean) ** 2;
      maxDev = Math.max(maxDev, Math.abs(Ls[i] - (first + ((last - first) * i) / (n - 1))));
    }
    let reversals = 0;
    let dir = 0;
    for (let i = 1; i < n; i++) {
      const step = Ls[i] - Ls[i - 1];
      if (Math.abs(step) < tol) continue;
      const s = Math.sign(step);
      if (dir && s !== dir) reversals++;
      dir = s;
    }
    return {
      monotonic: reversals === 0,
      reversals,
      r2: sst > 1e-9 ? (sxy * sxy) / (sxx * sst) : null,
      maxDev,
      range: [Math.min(...Ls), Math.max(...Ls)],
    };
  }

  // 'rrggbbrrggbb…' (as in cmap-data.js) → [[r, g, b], …].
  function parseHexColors(s) {
    const out = [];
    for (let i = 0; i + 6 <= s.length; i += 6) {
      out.push([0, 2, 4].map((k) => parseInt(s.slice(i + k, i + k + 2), 16)));
    }
    return out;
  }

  Object.assign(CM, {
    CVD_TYPES, simulateCvd, lightness, grayscale, lightnessStats, parseHexColors,
    CVD_MODELS, ACHROMAT, resolveCvdModel, cvdLinearFn, simulateCvdColor, simulateCvdPixels,
  });
})((globalThis.Colormeris ??= {}));
