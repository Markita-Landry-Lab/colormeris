(function (CM) {
  'use strict';
  const { rgbToLab, colorbarSamples, makeValueFn, labToT, ticksWithT, colorbarProblem, readPixel, roiInstances, forEachPixelInPolygon, cellAt, centroid, boxLabel } = CM;

  // Quantify signal inside ROIs of images such as IVIS luminescence overlays:
  // colored pixels are read through the calibrated colorbar, grayscale pixels
  // (the photograph underneath) are background with value 0.

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
    const samples = colorbarSamples(img, cb);
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

  // ---------------------------------------------------------------- results table

  // One statistic of a region measurement, or null when it does not apply
  // (e.g. areas in real units without a scale bar).
  function metricValue(stats, metric) {
    const v = stats[metric];
    return v === undefined ? null : v;
  }

  // Four significant digits, exponent notation for very large or small values.
  function shortNumber(v) {
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-2) return v.toExponential(2).replace('e+', 'e');
    return String(Number(v.toPrecision(4)));
  }

  // Results table: one row per box (or "Image" without a grid), one column per
  // region. Boxes in reading order, the image row last.
  function roiTableModel(panel, result) {
    const rowsByKey = new Map();
    const order = [];
    const keyOf = (r) => (r.row === null ? 'image' : `${r.row},${r.col}`);
    for (const r of result.rows) {
      const key = keyOf(r);
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, { label: r.row === null ? 'Image' : boxLabel(panel.grid, r.row, r.col), row: r.row, col: r.col, cells: new Map() });
        order.push(key);
      }
      rowsByKey.get(key).cells.set(r.roi.id, r);
    }
    order.sort((a, b) => {
      const ra = rowsByKey.get(a);
      const rb = rowsByKey.get(b);
      if (ra.row === null) return 1;
      if (rb.row === null) return -1;
      return ra.row - rb.row || ra.col - rb.col;
    });
    return { rows: order.map((k) => rowsByKey.get(k)), rois: panel.rois };
  }

  Object.assign(CM, { roiPanelProblem, pixelArea, makeClassifier, quantifyOutline, quantifyPanel, metricValue, shortNumber, roiTableModel });
})((globalThis.Colormeris ??= {}));
