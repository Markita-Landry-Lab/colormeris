(function (CM) {
  'use strict';
  const { rgbToLab, sampleColorbar, makeValueFn, labToT, tickProblem, ticksWithT, readPixel, roiInstances, forEachPixelInPolygon, cellAt, centroid } = CM;

  // Quantify signal inside ROIs of images such as IVIS luminescence overlays:
  // colored pixels are read through the calibrated colorbar, grayscale pixels
  // (the photograph underneath) are background with value 0.

  function colorbarProblem(panel) {
    const cb = panel.colorbar;
    if (!cb.start || !cb.end) return 'Set the colorbar start and end.';
    if (Math.hypot(cb.end.x - cb.start.x, cb.end.y - cb.start.y) < 2) return 'Colorbar is too short.';
    return tickProblem(ticksWithT(cb), cb.scale);
  }

  function roiPanelProblem(panel) {
    const bar = colorbarProblem(panel);
    if (bar) return bar;
    if (!panel.rois.length) return 'Draw at least one region (ellipse, rectangle or polygon).';
    if (panel.rois.some((r) => r.replicate) && !panel.grid.corners) return 'Place the grid, or turn off "copy to every box" for each region.';
    return null;
  }

  // Area of one pixel in (unit)² from a scale-bar calibration, or null.
  function pixelArea(scale) {
    if (!scale?.p1 || !scale?.p2 || !(scale.length > 0)) return null;
    const px = Math.hypot(scale.p2.x - scale.p1.x, scale.p2.y - scale.p1.y);
    if (px < 1) return null;
    const perPx = scale.length / px;
    return perPx * perPx;
  }

  // Classifier for pixels: returns {value, signal, deltaE}. Results are cached
  // per color since overlays repeat colors heavily.
  function makeClassifier(img, panel) {
    const cb = panel.colorbar;
    const samples = sampleColorbar(img, cb.start, cb.end, cb.halfWidth, cb.nSamples);
    const valueAt = makeValueFn(ticksWithT(cb), cb.scale);
    const { grayChroma, distance, maxDeltaE } = panel.settings;
    const cache = new Map();
    return (rgb) => {
      const r = Math.round(rgb[0]);
      const g = Math.round(rgb[1]);
      const b = Math.round(rgb[2]);
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (!hit) {
        const lab = rgbToLab([r, g, b]);
        if (Math.hypot(lab[1], lab[2]) <= grayChroma) hit = { value: 0, signal: false, deltaE: 0, flagged: false };
        else {
          const { t, deltaE } = labToT(lab, samples, distance);
          hit = { value: valueAt(t), signal: true, deltaE, flagged: deltaE > maxDeltaE };
        }
        cache.set(key, hit);
      }
      return hit;
    };
  }

  // Statistics over the pixels of one outline (image pixels).
  function quantifyOutline(img, outline, classify, pxArea) {
    let areaPx = 0;
    let signalPx = 0;
    let flaggedPx = 0;
    let sum = 0;
    let max = 0;
    forEachPixelInPolygon(outline, img.width, img.height, (x, y) => {
      const c = classify(readPixel(img, x, y));
      areaPx++;
      if (!c.signal) return;
      signalPx++;
      if (c.flagged) flaggedPx++;
      sum += c.value;
      if (c.value > max) max = c.value;
    });
    const stats = {
      areaPx,
      signalPx,
      flaggedPx,
      sum,
      mean: areaPx ? sum / areaPx : 0,
      meanSignal: signalPx ? sum / signalPx : 0,
      max,
    };
    if (pxArea) Object.assign(stats, { area: areaPx * pxArea, signalArea: signalPx * pxArea, sumArea: sum * pxArea });
    return stats;
  }

  // One row per ROI copy: {roi, row, col, outline, stats}, or {error}.
  function quantifyPanel(img, panel) {
    const error = roiPanelProblem(panel);
    if (error) return { error };
    const classify = makeClassifier(img, panel);
    const pxArea = pixelArea(panel.scale);
    const rows = [];
    for (const roi of panel.rois) {
      for (const inst of roiInstances(roi, panel.grid)) {
        let { row, col } = inst;
        // A single region reports under the grid box its centre lies in, if any.
        if (row === null && panel.grid.corners) {
          const cell = cellAt(panel.grid, centroid(inst.outline));
          if (cell) ({ row, col } = cell);
        }
        rows.push({ roi, row, col, outline: inst.outline, stats: quantifyOutline(img, inst.outline, classify, pxArea) });
      }
    }
    return { rows, pxArea, unit: pxArea ? panel.scale.unit : null };
  }

  Object.assign(CM, { colorbarProblem, roiPanelProblem, pixelArea, makeClassifier, quantifyOutline, quantifyPanel });
})((globalThis.Colormeris ??= {}));
