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

  Object.assign(CM, { CVD_TYPES, simulateCvd, lightness, grayscale, lightnessStats, parseHexColors });
})((globalThis.Colormeris ??= {}));
