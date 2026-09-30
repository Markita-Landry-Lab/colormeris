(function (CM) {
  'use strict';
  const { createWorkspace, extractPanel, panelProblem, effectiveLabels, cellSamplePolygon, colorAtT, rgbToHex, formatNumber, toWideCsv, toLongCsv, heatmapPanelFiles } = CM;

  // Heatmap tool: extract one value per grid cell by matching the cell's color
  // against the calibrated colorbar.

  const state = { showRecon: false };

  const ws = createWorkspace({
    kind: 'heatmap',
    otherToolUrl: 'ivis.html',
    computeResult: (panel, image) => extractPanel(image, panel),
    resultKey: (panel) => [panel.grid, panel.colorbar, panel.settings],
    panelProblem,
    panelFiles: (panels, results, bases) => panels.flatMap((p, i) => heatmapPanelFiles(p, results[i], bases[i])),
    sections: ['sec-results'],
    gridTexts: ['Click the outer top-left corner of the heatmap.', 'Click the outer bottom-right corner.'],
    renderSidebar,
    drawUnderGrid,
    drawOverGrid,
    hoverText,
    onHoverCell: (cell) => highlightTableCell(cell),
  });
  const { $, app, viewer } = ws;

  // ---------------------------------------------------------------- overlay

  // Reconstruction: repaint each sampled area with the color its value maps to.
  function drawUnderGrid(ctx, v, panel, active) {
    if (!active || !state.showRecon) return;
    const result = ws.resultFor(panel);
    if (!result.cells) return;
    const g = panel.grid;
    for (let r = 0; r < g.rows; r++) {
      for (let k = 0; k < g.cols; k++) {
        ws.polyPath(ctx, v, cellSamplePolygon(g, r, k));
        ctx.fillStyle = rgbToHex(colorAtT(result.samples, result.cells[r][k].t));
        ctx.fill();
      }
    }
  }

  // Sampled areas (when cells are large enough to read) and flagged cells.
  function drawOverGrid(ctx, v, panel, active) {
    if (!active) return;
    const g = panel.grid;
    const c = g.corners;
    const cellPx = Math.min(
      (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) / g.cols) * v.scale,
      (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) / g.rows) * v.scale,
    );
    if (cellPx > 10 && !state.showRecon) {
      for (let r = 0; r < g.rows; r++) {
        for (let k = 0; k < g.cols; k++) {
          ws.polyPath(ctx, v, cellSamplePolygon(g, r, k));
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    const result = ws.resultFor(panel);
    if (!result.cells) return;
    for (let r = 0; r < g.rows; r++) {
      for (let k = 0; k < g.cols; k++) {
        if (!result.cells[r][k].flagged) continue;
        ws.polyPath(ctx, v, cellSamplePolygon(g, r, k));
        ctx.lineWidth = 2;
        ctx.strokeStyle = ws.COLORS.flag;
        ctx.stroke();
      }
    }
  }

  function hoverText(panel, cell) {
    if (!cell) return '';
    const rl = effectiveLabels(panel.grid.rowLabels, panel.grid.rows, 'R')[cell.row];
    const cl = effectiveLabels(panel.grid.colLabels, panel.grid.cols, 'C')[cell.col];
    const c = ws.resultFor(panel).cells?.[cell.row]?.[cell.col];
    return c ? `${rl} / ${cl}: ${formatNumber(c.value)}  (ΔE ${c.deltaE.toFixed(1)})` : `${rl} / ${cl}`;
  }

  // ---------------------------------------------------------------- sidebar

  function renderSidebar(panel) {
    ws.setValue($('grid-fraction'), panel.grid.sampleFraction);
    $('grid-fraction-out').textContent = `${Math.round(panel.grid.sampleFraction * 100)}%`;
    renderResults(panel);
  }

  function renderResults(panel) {
    const res = ws.resultFor(panel);
    const table = $('result-table');
    $('dl-csv').disabled = $('dl-long').disabled = $('copy-tsv').disabled = !!res.error;
    if (res.error) {
      $('result-problem').textContent = res.error;
      $('result-summary').textContent = '';
      table.replaceChildren();
      return;
    }
    $('result-problem').textContent = '';
    const values = res.cells.flat().map((c) => c.value);
    const flagged = res.cells.flat().filter((c) => c.flagged).length;
    $('result-summary').textContent =
      `${res.rows} × ${res.cols} cells · range ${formatNumber(Math.min(...values))} – ${formatNumber(Math.max(...values))}` +
      ` · ${flagged ? `${flagged} flagged (ΔE > ${panel.settings.maxDeltaE}) — outlined in red` : 'no flagged cells'}`;

    const rowLabels = effectiveLabels(panel.grid.rowLabels, res.rows, 'R');
    const colLabels = effectiveLabels(panel.grid.colLabels, res.cols, 'C');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.append(th('', true), ...colLabels.map((l) => th(l)));
    thead.append(hr);
    const tbody = document.createElement('tbody');
    res.cells.forEach((row, r) => {
      const tr = document.createElement('tr');
      tr.append(th(rowLabels[r], true));
      row.forEach((c, k) => {
        const td = document.createElement('td');
        td.textContent = Number(c.value.toPrecision(4)).toString();
        td.style.background = rgbToHex(c.rgb);
        td.style.color = luminance(c.rgb) > 0.45 ? '#111' : '#fff';
        td.title = `${rowLabels[r]} / ${colLabels[k]}\nvalue ${formatNumber(c.value)}\nΔE ${c.deltaE.toFixed(2)}`;
        td.dataset.r = r;
        td.dataset.c = k;
        if (c.flagged) td.classList.add('flagged');
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.replaceChildren(thead, tbody);
    highlightTableCell(app.hoverCell);
  }

  function th(text, rowhead = false) {
    const el = document.createElement('th');
    el.textContent = text;
    if (rowhead) el.className = 'rowhead';
    return el;
  }

  function luminance([r, g, b]) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function highlightTableCell(cell) {
    const table = $('result-table');
    table.querySelector('td.hl')?.classList.remove('hl');
    if (cell) table.querySelector(`td[data-r="${cell.row}"][data-c="${cell.col}"]`)?.classList.add('hl');
    viewer.requestDraw();
  }

  async function copyTsv() {
    const panel = ws.activePanel();
    const res = ws.resultFor(panel);
    if (res.error) return;
    const tsv = toWideCsv(panel, res)
      .trim()
      .split('\n')
      .map((line) => line.replace(/"([^"]|"")*"|,/g, (m) => (m === ',' ? '\t' : m.slice(1, -1).replace(/""/g, '"'))))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      ws.toast('Table copied — paste into a spreadsheet.');
    } catch {
      ws.toast('Clipboard is not available here.', true);
    }
  }

  // ---------------------------------------------------------------- bindings

  ws.bindNumber('grid-fraction', (p, v) => (p.grid.sampleFraction = v));
  $('toggle-recon').addEventListener('change', (e) => {
    state.showRecon = e.target.checked;
    viewer.requestDraw();
  });
  $('dl-csv').addEventListener('click', () => {
    const p = ws.activePanel();
    const r = ws.resultFor(p);
    if (!r.error) ws.download(new Blob([toWideCsv(p, r)], { type: 'text/csv' }), ws.csvName(p));
  });
  $('dl-long').addEventListener('click', () => {
    const p = ws.activePanel();
    const r = ws.resultFor(p);
    if (!r.error) ws.download(new Blob([toLongCsv([{ panel: p, result: r }])], { type: 'text/csv' }), ws.csvName(p, '_long'));
  });
  $('copy-tsv').addEventListener('click', copyTsv);
  $('result-table').addEventListener('pointerover', (e) => {
    const td = e.target.closest('td');
    app.tableCell = td ? { row: Number(td.dataset.r), col: Number(td.dataset.c) } : null;
    viewer.requestDraw();
  });
  $('result-table').addEventListener('pointerleave', () => {
    app.tableCell = null;
    viewer.requestDraw();
  });

  ws.render();
})((globalThis.Colormeris ??= {}));
