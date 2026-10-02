(function (CM) {
  'use strict';
  const { roiCsv, formatNumber, pixelArea, metricValue, shortNumber, roiTableModel } = CM;

  // ROI tool, DOM: the sidebar cards (Regions, Scale bar, Results) and their
  // buttons, the results table, CSV download and TSV copy. Set up by roi-tool.js.
  //
  // rctx: { ws, state, selectedRoi, roiColor, deleteSelected } (see roi-tool.js).

  const SHAPE_NAMES = { ellipse: 'Ellipse', rect: 'Rectangle', polygon: 'Polygon' };
  const METRIC_NAMES = {
    sum: 'Total signal',
    mean: 'Mean over region',
    max: 'Max',
    meanSignal: 'Mean over signal pixels',
    signalPx: 'Signal area (px)',
    areaPx: 'Region area (px)',
    sumArea: 'Total signal × area',
    signalArea: 'Signal area',
    area: 'Region area',
  };

  function setupRoiSidebar(rctx) {
    const { ws, state } = rctx;
    const { $, app, viewer } = ws;

    function renderSidebar(panel) {
      renderRois(panel);
      renderScale(panel);
      renderResults(panel);
    }

    let roiListKey = '';
    function renderRois(panel) {
      if (state.selectedId && !panel.rois.some((r) => r.id === state.selectedId)) state.selectedId = null;
      const list = $('roi-list');
      const key = JSON.stringify([panel.id, state.selectedId, panel.rois.map((r) => [r.id, r.name, r.shape, r.replicate, Object.keys(r.offsets).length]), panel.grid.rows, panel.grid.cols, !!panel.grid.corners]);
      if (key !== roiListKey) {
        roiListKey = key;
        list.replaceChildren(
          ...panel.rois.map((roi) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.className = 'chip roi-item';
            btn.setAttribute('aria-pressed', String(roi.id === state.selectedId));
            const sw = document.createElement('span');
            sw.className = `shape-icon ${roi.shape}`;
            sw.style.setProperty('--roi-color', rctx.roiColor(panel, roi));
            const copies = roi.replicate ? (panel.grid.corners ? panel.grid.rows * panel.grid.cols : 0) : 1;
            const nudged = Object.keys(roi.offsets).length;
            const meta = document.createElement('span');
            meta.className = 'chip-meta';
            meta.textContent = roi.replicate ? `×${copies}${nudged ? `, ${nudged} nudged` : ''}` : 'single';
            btn.append(sw, Object.assign(document.createElement('span'), { className: 'chip-label', textContent: roi.name }), meta);
            btn.title = `${SHAPE_NAMES[roi.shape]}${roi.replicate ? ' copied into every box' : ''}`;
            btn.addEventListener('click', () => {
              state.selectedId = roi.id === state.selectedId ? null : roi.id;
              ws.changed();
            });
            li.append(btn);
            return li;
          }),
        );
      }
      $('roi-empty').hidden = panel.rois.length > 0;
      $('roi-hint').hidden = !panel.rois.length;
      const sel = rctx.selectedRoi();
      $('roi-edit').hidden = !sel;
      if (sel) {
        ws.setValue($('roi-name'), sel.name);
        $('roi-reset').disabled = !sel.replicate || !Object.keys(sel.offsets).length;
      }
      const n = panel.rois.length;
      ws.setBadge($('roi-state'), n ? `${n} region${n === 1 ? '' : 's'}` : 'none', n > 0);
      $('grid-clear').disabled = !panel.grid.corners;
    }

    function renderScale(panel) {
      const sc = panel.scale;
      $('scale-clear').disabled = !sc;
      if (sc) {
        ws.setValue($('scale-length'), sc.length);
        ws.setValue($('scale-unit'), sc.unit);
        const px = Math.hypot(sc.p2.x - sc.p1.x, sc.p2.y - sc.p1.y);
        $('scale-info').textContent = `${px.toFixed(1)} px = ${sc.length} ${sc.unit} · ${(px / sc.length).toFixed(2)} px per ${sc.unit} · one pixel = ${formatNumber(pixelArea(sc))} ${sc.unit}²`;
      } else {
        $('scale-info').textContent = 'Click both ends of a scale bar (or any known distance) to report areas in real units.';
      }
      ws.setBadge($('scale-state'), sc ? `${sc.length} ${sc.unit}` : 'pixels', !!sc);
      for (const opt of $('result-metric').querySelectorAll('[data-scaled]')) {
        opt.disabled = !sc;
        opt.textContent = opt.textContent.replace(/\((unit|cm|mm)²\)/, `(${sc ? sc.unit : 'unit'}²)`);
      }
      if (!sc && ['sumArea', 'signalArea', 'area'].includes(state.metric)) state.metric = 'sum';
      ws.setValue($('result-metric'), state.metric);
    }

    function renderResults(panel) {
      const res = ws.resultFor(panel);
      const table = $('roi-result-table');
      $('roi-dl-csv').disabled = $('roi-copy-tsv').disabled = !!res.error;
      if (res.error) {
        $('roi-result-problem').textContent = res.error;
        $('roi-result-summary').textContent = '';
        table.replaceChildren();
        return;
      }
      $('roi-result-problem').textContent = '';
      const flagged = res.rows.reduce((s, r) => s + r.stats.flaggedPx, 0);
      const unit = res.unit ? ` · areas in ${res.unit}²` : ' · pixel units';
      const signal = res.rows.reduce((s, r) => s + r.stats.signalPx, 0);
      $('roi-result-summary').textContent =
        `${panel.rois.length} region${panel.rois.length === 1 ? '' : 's'} · ${res.rows.length} measurement${res.rows.length === 1 ? '' : 's'}${unit}` +
        (flagged ? ` · ${((100 * flagged) / Math.max(1, signal)).toFixed(1)}% of signal pixels matched no colorbar color (ΔE > ${panel.settings.maxDeltaE}); cells over 10% are outlined` : '');
      const model = roiTableModel(panel, res);
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      hr.append(th(METRIC_NAMES[state.metric], true), ...model.rois.map((r) => th(r.name)));
      thead.append(hr);
      const tbody = document.createElement('tbody');
      for (const row of model.rows) {
        const tr = document.createElement('tr');
        tr.append(th(row.label, true));
        for (const roi of model.rois) {
          const td = document.createElement('td');
          const r = row.cells.get(roi.id);
          if (r) {
            const value = metricValue(r.stats, state.metric);
            td.textContent = value === null ? '' : shortNumber(value);
            td.title = `${row.label} · ${roi.name}\nsum ${formatNumber(r.stats.sum)}\nmean ${formatNumber(r.stats.mean)}\nmax ${formatNumber(r.stats.max)}\nsignal ${r.stats.signalPx} of ${r.stats.areaPx} px`;
            // Outline when a noticeable share of the signal matched no colorbar color.
            if (r.stats.flaggedPx > 0.1 * r.stats.signalPx) td.classList.add('flagged');
          }
          if (row.row !== null) {
            td.dataset.r = row.row;
            td.dataset.c = row.col;
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.replaceChildren(thead, tbody);
    }

    function th(text, rowhead = false) {
      const el = document.createElement('th');
      el.textContent = text;
      if (rowhead) el.className = 'rowhead';
      return el;
    }

    async function copyTsv() {
      const panel = ws.activePanel();
      const res = ws.resultFor(panel);
      if (res.error) return;
      const model = roiTableModel(panel, res);
      const lines = [[METRIC_NAMES[state.metric], ...model.rois.map((r) => r.name)].join('\t')];
      for (const row of model.rows) {
        lines.push([row.label, ...model.rois.map((roi) => {
          const r = row.cells.get(roi.id);
          const v = r ? metricValue(r.stats, state.metric) : null;
          return v === null ? '' : formatNumber(v);
        })].join('\t'));
      }
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        ws.toast('Table copied — paste into a spreadsheet.');
      } catch {
        ws.toast('Clipboard is not available here.', true);
      }
    }

    // ---------------------------------------------------------------- bindings

    ws.bindText('roi-name', (p, v) => {
      const roi = p.rois.find((r) => r.id === state.selectedId);
      if (roi) roi.name = v;
    });
    $('roi-reset').addEventListener('click', () => {
      const roi = rctx.selectedRoi();
      if (roi) ws.commit((p) => (p.rois.find((r) => r.id === roi.id).offsets = {}));
    });
    $('roi-delete').addEventListener('click', () => rctx.deleteSelected());
    $('grid-clear').addEventListener('click', () => {
      const panel = ws.activePanel();
      if (panel.rois.some((r) => r.replicate) && !confirm('Regions copied into every box will have no copies without a grid. Remove the grid?')) return;
      ws.commit((p) => (p.grid.corners = null));
    });
    $('scale-place').addEventListener('click', () => ws.setMode(app.mode?.type === 'scale' ? null : 'scale'));
    $('scale-clear').addEventListener('click', () => ws.commit((p) => (p.scale = null)));
    ws.bindNumber('scale-length', (p, v) => {
      if (p.scale && v > 0) p.scale.length = v;
    });
    $('scale-unit').addEventListener('change', (e) => {
      if (ws.activePanel().scale) ws.commit((p) => (p.scale.unit = e.target.value));
    });
    $('result-metric').addEventListener('change', (e) => {
      state.metric = e.target.value;
      ws.changed();
    });
    $('toggle-mask').addEventListener('change', (e) => {
      state.showMask = e.target.checked;
      viewer.requestDraw();
    });
    $('roi-dl-csv').addEventListener('click', () => {
      const p = ws.activePanel();
      const r = ws.resultFor(p);
      if (!r.error) ws.download(new Blob([roiCsv([{ panel: p, result: r }])], { type: 'text/csv' }), ws.csvName(p, '_rois'));
    });
    $('roi-copy-tsv').addEventListener('click', copyTsv);
    $('roi-result-table').addEventListener('pointerover', (e) => {
      const td = e.target.closest('td[data-r]');
      app.tableCell = td ? { row: Number(td.dataset.r), col: Number(td.dataset.c) } : null;
      viewer.requestDraw();
    });
    $('roi-result-table').addEventListener('pointerleave', () => {
      app.tableCell = null;
      viewer.requestDraw();
    });

    return { renderSidebar };
  }

  Object.assign(CM, { setupRoiSidebar });
})((globalThis.Colormeris ??= {}));
