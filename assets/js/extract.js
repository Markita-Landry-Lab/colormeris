(function (CM) {
  'use strict';
  const { rgbToLab, sampleColorbar, makeValueFn, labToT, tickProblem, sampleCell, ticksWithT } = CM;

  // Combine grid sampling and colorbar calibration into a value matrix.


  // Returns a description of what is still missing before extraction, or null.
  function panelProblem(panel) {
    if (!panel.grid.corners) return 'Set the heatmap grid corners.';
    const cb = panel.colorbar;
    if (!cb.start || !cb.end) return 'Set the colorbar start and end.';
    if (Math.hypot(cb.end.x - cb.start.x, cb.end.y - cb.start.y) < 2) return 'Colorbar is too short.';
    return tickProblem(ticksWithT(cb), cb.scale);
  }

  // Result: {rows, cols, cells[r][c] = {rgb, t, value, deltaE, flagged}, samples}
  // or {error} when the panel is not fully calibrated.
  function extractPanel(img, panel) {
    const error = panelProblem(panel);
    if (error) return { error };
    const cb = panel.colorbar;
    const samples = sampleColorbar(img, cb.start, cb.end, cb.halfWidth, cb.nSamples);
    const valueAt = makeValueFn(ticksWithT(cb), cb.scale);
    const { rows, cols } = panel.grid;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const rgb = sampleCell(img, panel.grid, r, c);
        const { t, deltaE } = labToT(rgbToLab(rgb), samples, panel.settings.distance);
        row.push({ rgb, t, value: valueAt(t), deltaE, flagged: deltaE > panel.settings.maxDeltaE });
      }
      cells.push(row);
    }
    return { rows, cols, cells, samples };
  }

  Object.assign(CM, { panelProblem, extractPanel });
})((globalThis.Colormeris ??= {}));
