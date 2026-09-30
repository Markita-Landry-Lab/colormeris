// Combine grid sampling and colorbar calibration into a value matrix.

import { rgbToLab } from './color.js';
import { sampleColorbar, makeValueFn, labToT, tickProblem } from './colormap.js';
import { sampleCell } from './grid.js';
import { ticksWithT } from './state.js';

// Returns a description of what is still missing before extraction, or null.
export function panelProblem(panel) {
  if (!panel.grid.corners) return 'Set the heatmap grid corners.';
  const cb = panel.colorbar;
  if (!cb.start || !cb.end) return 'Set the colorbar start and end.';
  if (Math.hypot(cb.end.x - cb.start.x, cb.end.y - cb.start.y) < 2) return 'Colorbar is too short.';
  return tickProblem(ticksWithT(cb), cb.scale);
}

// Result: {rows, cols, cells[r][c] = {rgb, t, value, deltaE, flagged}, samples}
// or {error} when the panel is not fully calibrated.
export function extractPanel(img, panel) {
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
