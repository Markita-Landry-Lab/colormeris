(function (CM) {
  'use strict';
  const { Viewer, fileKind, openPdf, renderPdfPage, imageToCanvas, canvasImageData, canvasToPngBlob, sha256Hex, createProject, createPanel, effectiveLabels, parseLabelText, ticksWithT, rescalePanel, rectCorners, bilinear, cellAt, cellSamplePolygon, readPixel, projectT, pointAtT, colorAtT, extractPanel, panelProblem, toWideCsv, toLongCsv, buildProjectZip, readProjectZip, safeFileName, formatNumber, rgbToHex } = CM;

  // Application wiring: state, UI, canvas interaction and import/export.


  const $ = (id) => document.getElementById(id);

  const COLORS = { grid: '#e22bd0', bar: '#f29900', flag: '#ff3b30', highlight: '#ffd400', outline: 'rgba(0,0,0,0.65)' };
  const SNAP_DEGREES = 3;

  const app = {
    project: createProject(),
    sourceCanvas: null,
    imageData: null,
    originalFile: null,
    pdfDoc: null,
    mode: null, // {type: 'grid' | 'colorbar' | 'tick', points: []}
    cache: new Map(), // panel id → {key, result}
    history: [],
    future: [],
    drag: null,
    hoverCell: null,
    tableCell: null,
    showOverlay: true,
    showRecon: false,
  };

  let tickSeq = 1;
  const newTickId = () => `t${tickSeq++}`;

  const activePanel = () => app.project.panels.find((p) => p.id === app.project.activePanelId) || app.project.panels[0];

  // ---------------------------------------------------------------- history

  function snapshot() {
    return structuredClone({ panels: app.project.panels, activePanelId: app.project.activePanelId });
  }

  function pushHistory() {
    app.history.push(snapshot());
    if (app.history.length > 200) app.history.shift();
    app.future = [];
  }

  function restore(snap) {
    app.project.panels = snap.panels;
    app.project.activePanelId = snap.activePanelId;
    changed();
  }

  function undo() {
    if (!app.history.length) return;
    app.future.push(snapshot());
    restore(app.history.pop());
  }

  function redo() {
    if (!app.future.length) return;
    app.history.push(snapshot());
    restore(app.future.pop());
  }

  // Apply a mutation with an undo point.
  function commit(fn) {
    pushHistory();
    fn(activePanel());
    changed();
  }

  // ---------------------------------------------------------------- extraction

  function resultFor(panel) {
    if (!app.imageData) return { error: 'Load a file first.' };
    const key = JSON.stringify([panel.grid, panel.colorbar, panel.settings]);
    const hit = app.cache.get(panel.id);
    if (hit && hit.key === key) return hit.result;
    const result = extractPanel(app.imageData, panel);
    app.cache.set(panel.id, { key, result });
    return result;
  }

  // ---------------------------------------------------------------- viewer

  const viewer = new Viewer($('viewer'), {
    onClick,
    hitTest,
    onHandleDrag,
    onHandleDrop: () => {
      app.drag = null;
      changed();
    },
    onHover,
    drawOverlay,
    wantsLoupe: () => !!app.mode,
  });

  function onClick(p, e) {
    const mode = app.mode;
    if (!mode) {
      return;
    }
    if (mode.type === 'grid') {
      mode.points.push(p);
      if (mode.points.length === 2) {
        const [a, b] = mode.points;
        if (Math.abs(a.x - b.x) < 2 || Math.abs(a.y - b.y) < 2) {
          mode.points.pop();
          toast('Grid is too small; click the opposite corner.', true);
          return;
        }
        setMode(null);
        commit((panel) => (panel.grid.corners = rectCorners(a, b)));
      } else updateModebar();
    } else if (mode.type === 'colorbar') {
      const q = mode.points.length === 1 && !e.altKey ? snapAxis(mode.points[0], p) : p;
      mode.points.push(q);
      if (mode.points.length === 2) {
        const [a, b] = mode.points;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 3) {
          mode.points.pop();
          toast('Colorbar is too short; click the other end.', true);
          return;
        }
        setMode(null);
        commit((panel) => {
          panel.colorbar.start = a;
          panel.colorbar.end = b;
        });
        const panel = activePanel();
        if (panel.colorbar.ticks.length < 2) setMode('tick');
      } else updateModebar();
    } else if (mode.type === 'tick') {
      const panel = activePanel();
      const { start, end } = panel.colorbar;
      const t = projectT(start, end, p);
      if (t < -0.1 || t > 1.1) {
        toast('Click on (or next to) the colorbar line to place a tick.', true);
        return;
      }
      const id = newTickId();
      commit((pn) => pn.colorbar.ticks.push({ id, ...pointAtT(start, end, t), value: NaN }));
      focusTick(id);
    }
  }

  function snapAxis(a, b) {
    const angle = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    if (angle > 90 - SNAP_DEGREES) return { x: a.x, y: b.y };
    if (angle < SNAP_DEGREES) return { x: b.x, y: a.y };
    return b;
  }

  function hitTest(p, tol) {
    if (app.mode?.type === 'grid' || app.mode?.type === 'colorbar' || !app.showOverlay) return null;
    const panel = activePanel();
    const near = (q) => q && Math.hypot(q.x - p.x, q.y - p.y) <= tol;
    for (const k of panel.colorbar.ticks) if (near(k)) return { kind: 'tick', id: k.id };
    if (near(panel.colorbar.start)) return { kind: 'barStart' };
    if (near(panel.colorbar.end)) return { kind: 'barEnd' };
    const corners = panel.grid.corners;
    if (corners) for (let i = 0; i < 4; i++) if (near(corners[i])) return { kind: 'corner', i };
    return null;
  }

  function onHandleDrag(handle, p, e) {
    if (!app.drag) {
      pushHistory();
      app.drag = handle;
    }
    const panel = activePanel();
    if (handle.kind === 'corner') {
      const c = panel.grid.corners;
      if ($('grid-rect').checked) {
        const opposite = c[(handle.i + 2) % 4];
        panel.grid.corners = rectCorners(p, opposite);
        // Keep dragging the corner that is now under the pointer.
        handle.i = panel.grid.corners.findIndex((q) => q.x === p.x && q.y === p.y);
      } else {
        c[handle.i] = p;
      }
    } else if (handle.kind === 'barStart' || handle.kind === 'barEnd') {
      const cb = panel.colorbar;
      const other = handle.kind === 'barStart' ? cb.end : cb.start;
      const q = e.altKey ? p : snapAxis(other, p);
      // Keep ticks at the same relative position along the bar.
      const ts = ticksWithT(cb).map((k) => k.t);
      if (handle.kind === 'barStart') cb.start = q;
      else cb.end = q;
      cb.ticks.forEach((k, i) => Object.assign(k, pointAtT(cb.start, cb.end, ts[i])));
    } else if (handle.kind === 'tick') {
      const cb = panel.colorbar;
      const k = cb.ticks.find((x) => x.id === handle.id);
      if (k) Object.assign(k, pointAtT(cb.start, cb.end, projectT(cb.start, cb.end, p)));
    }
    changed({ light: true });
  }

  function onHover(p) {
    if (!p || !app.imageData) {
      $('status-pos').textContent = '';
      $('status-color').textContent = '';
      $('status-swatch').hidden = true;
      $('status-cell').textContent = '';
      setHoverCell(null);
      return;
    }
    const inside = p.x >= 0 && p.y >= 0 && p.x < app.imageData.width && p.y < app.imageData.height;
    $('status-pos').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}`;
    if (inside) {
      const rgb = readPixel(app.imageData, p.x - 0.5, p.y - 0.5);
      const hex = rgbToHex(rgb);
      $('status-swatch').hidden = false;
      $('status-swatch').style.background = hex;
      $('status-color').textContent = hex;
    } else {
      $('status-swatch').hidden = true;
      $('status-color').textContent = '';
    }
    const panel = activePanel();
    const cell = panel.grid.corners ? cellAt(panel.grid, p) : null;
    setHoverCell(cell);
    if (cell) {
      const rl = effectiveLabels(panel.grid.rowLabels, panel.grid.rows, 'R')[cell.row];
      const cl = effectiveLabels(panel.grid.colLabels, panel.grid.cols, 'C')[cell.col];
      const res = resultFor(panel);
      const c = res.cells?.[cell.row]?.[cell.col];
      $('status-cell').textContent = c ? `${rl} / ${cl}: ${formatNumber(c.value)}  (ΔE ${c.deltaE.toFixed(1)})` : `${rl} / ${cl}`;
    } else $('status-cell').textContent = '';
  }

  function setHoverCell(cell) {
    const same = cell && app.hoverCell && cell.row === app.hoverCell.row && cell.col === app.hoverCell.col;
    if (same || (!cell && !app.hoverCell)) return;
    app.hoverCell = cell;
    highlightTableCell(cell);
  }

  // ---------------------------------------------------------------- overlay drawing

  function strokeDual(ctx, color, width, dash) {
    ctx.setLineDash(dash || []);
    ctx.lineWidth = width + 2;
    ctx.strokeStyle = COLORS.outline;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function polyPath(ctx, v, pts) {
    ctx.beginPath();
    pts.forEach((q, i) => {
      const s = v.toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  function drawHandle(ctx, v, p, color, shape = 'square') {
    const s = v.toScreen(p);
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    else ctx.rect(s.x - 5, s.y - 5, 10, 10);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  function drawGrid(ctx, v, panel, active) {
    const g = panel.grid;
    if (!g.corners) return;
    const c = g.corners;
    const result = active ? resultFor(panel) : null;
    const cellPx = Math.min(
      (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) / g.cols) * v.scale,
      (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) / g.rows) * v.scale,
    );

    if (active && app.showRecon && result?.cells) {
      for (let r = 0; r < g.rows; r++) {
        for (let k = 0; k < g.cols; k++) {
          polyPath(ctx, v, cellSamplePolygon(g, r, k));
          ctx.fillStyle = rgbToHex(colorAtT(result.samples, result.cells[r][k].t));
          ctx.fill();
        }
      }
    }

    // Internal lines.
    ctx.beginPath();
    for (let k = 1; k < g.cols; k++) {
      const a = v.toScreen(bilinear(c, k / g.cols, 0));
      const b = v.toScreen(bilinear(c, k / g.cols, 1));
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let r = 1; r < g.rows; r++) {
      const a = v.toScreen(bilinear(c, 0, r / g.rows));
      const b = v.toScreen(bilinear(c, 1, r / g.rows));
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.globalAlpha *= 0.8;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.stroke();
    ctx.globalAlpha /= 0.8;

    // Sample boxes, only when cells are large enough to read.
    if (active && cellPx > 10 && !app.showRecon) {
      for (let r = 0; r < g.rows; r++) {
        for (let k = 0; k < g.cols; k++) {
          polyPath(ctx, v, cellSamplePolygon(g, r, k));
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    if (active && result?.cells) {
      for (let r = 0; r < g.rows; r++) {
        for (let k = 0; k < g.cols; k++) {
          if (!result.cells[r][k].flagged) continue;
          polyPath(ctx, v, cellSamplePolygon(g, r, k));
          ctx.lineWidth = 2;
          ctx.strokeStyle = COLORS.flag;
          ctx.stroke();
        }
      }
    }

    polyPath(ctx, v, c);
    strokeDual(ctx, COLORS.grid, 2);

    const hl = active && (app.tableCell || app.hoverCell);
    if (hl && hl.row < g.rows && hl.col < g.cols) {
      const corners = [
        bilinear(c, hl.col / g.cols, hl.row / g.rows),
        bilinear(c, (hl.col + 1) / g.cols, hl.row / g.rows),
        bilinear(c, (hl.col + 1) / g.cols, (hl.row + 1) / g.rows),
        bilinear(c, hl.col / g.cols, (hl.row + 1) / g.rows),
      ];
      polyPath(ctx, v, corners);
      strokeDual(ctx, COLORS.highlight, 2);
    }

    if (active) c.forEach((q) => drawHandle(ctx, v, q, COLORS.grid));
  }

  function drawColorbar(ctx, v, panel, active) {
    const cb = panel.colorbar;
    if (!cb.start || !cb.end) return;
    const a = v.toScreen(cb.start);
    const b = v.toScreen(cb.end);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;

    if (active && cb.halfWidth > 0) {
      const w = cb.halfWidth * v.scale;
      ctx.beginPath();
      ctx.moveTo(a.x + nx * w, a.y + ny * w);
      ctx.lineTo(b.x + nx * w, b.y + ny * w);
      ctx.moveTo(a.x - nx * w, a.y - ny * w);
      ctx.lineTo(b.x - nx * w, b.y - ny * w);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(242,153,0,0.7)';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    strokeDual(ctx, COLORS.bar, 2);

    if (!active) return;
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const k of cb.ticks) {
      const s = v.toScreen(k);
      ctx.beginPath();
      ctx.moveTo(s.x - nx * 12, s.y - ny * 12);
      ctx.lineTo(s.x + nx * 12, s.y + ny * 12);
      strokeDual(ctx, COLORS.bar, 2);
      drawHandle(ctx, v, k, COLORS.bar, 'circle');
      const label = Number.isFinite(k.value) ? String(k.value) : '?';
      const lx = s.x + nx * 18 + (nx >= 0 ? 0 : -ctx.measureText(label).width);
      const ly = s.y + ny * 18;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, ly);
    }
    drawHandle(ctx, v, cb.start, COLORS.bar);
    drawHandle(ctx, v, cb.end, COLORS.bar);
  }

  function drawOverlay(ctx, v) {
    if (app.showOverlay) {
      const active = activePanel();
      for (const panel of app.project.panels) {
        if (panel === active) continue;
        ctx.globalAlpha = 0.35;
        drawGrid(ctx, v, panel, false);
        drawColorbar(ctx, v, panel, false);
      }
      ctx.globalAlpha = 1;
      drawGrid(ctx, v, active, true);
      drawColorbar(ctx, v, active, true);
    }

    // Rubber band while placing.
    const m = app.mode;
    const hover = v.hover?.img;
    if (m && m.points.length === 1 && hover) {
      const a = m.points[0];
      if (m.type === 'grid') {
        polyPath(ctx, v, rectCorners(a, hover));
        strokeDual(ctx, COLORS.grid, 1.5, [6, 4]);
      } else if (m.type === 'colorbar') {
        const b = snapAxis(a, hover);
        const sa = v.toScreen(a);
        const sb = v.toScreen(b);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        strokeDual(ctx, COLORS.bar, 1.5, [6, 4]);
      }
    }
    if (m && hover && m.type === 'tick') {
      const cb = activePanel().colorbar;
      const q = v.toScreen(pointAtT(cb.start, cb.end, projectT(cb.start, cb.end, hover)));
      ctx.beginPath();
      ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      strokeDual(ctx, COLORS.bar, 1.5, [3, 3]);
    }
  }

  // ---------------------------------------------------------------- modes

  const MODE_TEXT = {
    grid: ['Click the outer top-left corner of the heatmap.', 'Click the outer bottom-right corner.'],
    colorbar: ['Click one end of the colorbar (middle of the bar).', 'Click the other end. Hold Alt to disable axis snapping.'],
    tick: ['Click a labelled tick on the colorbar, then type its value. Press Done when finished.'],
  };

  function setMode(type) {
    if (type && !app.sourceCanvas) return;
    if (type === 'tick') {
      const cb = activePanel().colorbar;
      if (!cb.start || !cb.end) {
        toast('Place the colorbar ends first.', true);
        return;
      }
    }
    app.mode = type ? { type, points: [] } : null;
    updateModebar();
    $('grid-place').classList.toggle('active', type === 'grid');
    $('bar-place').classList.toggle('active', type === 'colorbar');
    $('tick-add').classList.toggle('active', type === 'tick');
    viewer.requestDraw();
  }

  function updateModebar() {
    const m = app.mode;
    $('modebar').hidden = !m;
    if (!m) return;
    const texts = MODE_TEXT[m.type];
    $('modebar-text').textContent = texts[Math.min(m.points.length, texts.length - 1)];
    $('mode-done').textContent = m.type === 'tick' ? 'Done' : 'Cancel';
  }

  // ---------------------------------------------------------------- sidebar rendering

  function setValue(el, value) {
    if (document.activeElement !== el && el.value !== String(value)) el.value = value;
  }

  function changed({ light = false } = {}) {
    viewer.requestDraw();
    renderSidebar(light);
  }

  function renderSidebar(light = false) {
    const loaded = !!app.sourceCanvas;
    for (const id of ['sec-source', 'sec-panels', 'sec-grid', 'sec-colorbar', 'sec-results']) $(id).hidden = !loaded;
    $('empty-state').hidden = loaded;
    $('view-tools').hidden = !loaded;
    $('btn-export-zip').disabled = !loaded;
    $('btn-undo').disabled = !app.history.length;
    $('btn-redo').disabled = !app.future.length;
    if (!loaded) return;

    const panel = activePanel();
    if (!light) renderPanels(panel);

    // Grid
    const g = panel.grid;
    setValue($('grid-rows'), g.rows);
    setValue($('grid-cols'), g.cols);
    setValue($('grid-fraction'), g.sampleFraction);
    $('grid-fraction-out').textContent = `${Math.round(g.sampleFraction * 100)}%`;
    setValue($('grid-row-labels'), g.rowLabels.join('\n'));
    setValue($('grid-col-labels'), g.colLabels.join('\n'));
    setBadge($('grid-state'), g.corners ? `${g.rows} × ${g.cols}` : 'not placed', !!g.corners);
    $('grid-zoom').disabled = !g.corners;

    // Colorbar
    const cb = panel.colorbar;
    setValue($('bar-scale'), cb.scale);
    setValue($('bar-halfwidth'), Math.round(cb.halfWidth * 10) / 10);
    const validTicks = ticksWithT(cb).filter((k) => Number.isFinite(k.value)).length;
    setBadge(
      $('bar-state'),
      !cb.start ? 'not placed' : `${validTicks} tick${validTicks === 1 ? '' : 's'}`,
      !!cb.start && validTicks >= 2,
    );
    $('tick-add').disabled = !cb.start;
    $('bar-zoom').disabled = !cb.start;
    renderTicks(cb);

    // Settings
    setValue($('set-distance'), panel.settings.distance);
    setValue($('set-maxde'), panel.settings.maxDeltaE);

    renderResults(panel);
    renderBarStrip(panel);
  }

  function setBadge(el, text, ok) {
    el.textContent = text;
    el.className = `badge ${ok ? 'ok' : 'todo'}`;
  }

  function renderPanels(active) {
    const list = $('panel-list');
    list.replaceChildren(
      ...app.project.panels.map((p) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = `btn small${p === active ? ' active' : ''}`;
        const dot = document.createElement('span');
        dot.className = `status-dot${panelProblem(p) ? '' : ' done'}`;
        btn.append(dot, document.createTextNode(p.name || '(unnamed)'));
        btn.title = panelProblem(p) || 'Calibrated';
        btn.addEventListener('click', () => {
          if (p.id === app.project.activePanelId) return;
          setMode(null);
          app.project.activePanelId = p.id;
          app.tableCell = null;
          changed();
        });
        li.append(btn);
        return li;
      }),
    );
    setValue($('panel-name'), active.name);
    $('panel-delete').disabled = app.project.panels.length < 2;
  }

  let tickKey = '';
  function renderTicks(cb) {
    const ticks = ticksWithT(cb);
    const tbody = $('tick-list');
    const key = ticks.map((k) => k.id).join(',');
    $('tick-empty').hidden = ticks.length > 0;
    tbody.closest('table').hidden = ticks.length === 0;
    if (key !== tickKey) {
      tickKey = key;
      tbody.replaceChildren(
        ...ticks.map((k) => {
          const tr = document.createElement('tr');
          tr.dataset.id = k.id;
          const input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.placeholder = 'value';
          input.addEventListener('focus', () => pushHistory());
          input.addEventListener('input', () => {
            const tick = activePanel().colorbar.ticks.find((x) => x.id === k.id);
            if (tick) tick.value = input.value === '' ? NaN : Number(input.value);
            changed({ light: true });
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
          });
          const pos = document.createElement('td');
          pos.className = 'pos';
          const del = document.createElement('button');
          del.className = 'btn icon small';
          del.textContent = '×';
          del.title = 'Remove tick';
          del.setAttribute('aria-label', 'Remove tick');
          del.addEventListener('click', () =>
            commit((p) => (p.colorbar.ticks = p.colorbar.ticks.filter((x) => x.id !== k.id))),
          );
          const tdIn = document.createElement('td');
          tdIn.append(input);
          const tdDel = document.createElement('td');
          tdDel.append(del);
          tr.append(tdIn, pos, tdDel);
          return tr;
        }),
      );
    }
    for (const k of ticks) {
      const tr = tbody.querySelector(`tr[data-id="${k.id}"]`);
      if (!tr) continue;
      const input = tr.querySelector('input');
      setValue(input, Number.isFinite(k.value) ? k.value : '');
      tr.classList.toggle('invalid', !Number.isFinite(k.value));
      tr.querySelector('.pos').textContent = `${(k.t * 100).toFixed(1)}% along`;
    }
  }

  function focusTick(id) {
    requestAnimationFrame(() => {
      const input = $('tick-list').querySelector(`tr[data-id="${id}"] input`);
      input?.focus();
    });
  }

  function renderBarStrip(panel) {
    const canvas = $('bar-strip');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const res = resultFor(panel);
    const samples = res.samples;
    const cb = panel.colorbar;
    if (!samples && (!cb.start || !cb.end || !app.imageData)) return;
    // Draw the raw sampled colors even when ticks are incomplete.
    const w = canvas.width;
    const h = canvas.height;
    const n = 128;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let rgb;
      if (samples) rgb = colorAtT(samples, t);
      else rgb = readPixel(app.imageData, ...Object.values(pointAtT(cb.start, cb.end, t)));
      ctx.fillStyle = rgbToHex(rgb);
      ctx.fillRect(Math.floor((i / n) * w), 0, Math.ceil(w / n) + 1, h);
    }
    ctx.fillStyle = '#000';
    for (const k of ticksWithT(cb)) {
      if (!Number.isFinite(k.t)) continue;
      const x = Math.round(Math.min(1, Math.max(0, k.t)) * (w - 1));
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(x - 2, 0, 4, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, 0, 2, h);
    }
  }

  function renderResults(panel) {
    const res = resultFor(panel);
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

  // ---------------------------------------------------------------- loading

  async function openFile(file) {
    if (!file) return;
    const kind = fileKind(file);
    if (kind === 'unknown') {
      toast(`Unsupported file type: ${file.name}`, true);
      return;
    }
    try {
      if (kind === 'zip') {
        await openProjectZip(file);
        return;
      }
      if (hasCalibration() && !confirm('Opening a new file starts a new project and discards the current calibration. Continue?')) return;
      setMode(null);
      status(`Loading ${file.name}…`);
      const project = createProject();
      project.name = file.name.replace(/\.[^.]+$/, '');
      project.source = { fileName: file.name, mime: file.type || null, page: 1, pageCount: 1, renderScale: 1, width: 0, height: 0, sha256: null };
      app.pdfDoc = null;
      let canvas;
      if (kind === 'pdf') {
        app.pdfDoc = await openPdf(file);
        project.source.pageCount = app.pdfDoc.numPages;
        const scale = Number($('scale-select').value);
        const r = await renderPdfPage(app.pdfDoc, 1, scale);
        canvas = r.canvas;
        project.source.renderScale = r.scale;
      } else {
        canvas = await imageToCanvas(file);
      }
      app.project = project;
      app.originalFile = file;
      app.history = [];
      app.future = [];
      setSource(canvas);
      status('');
      sha256Hex(file).then((h) => (project.source.sha256 = h));
    } catch (err) {
      console.error(err);
      status('');
      toast(`Could not open ${file.name}: ${err.message}`, true);
    }
  }

  function hasCalibration() {
    return app.project.panels.some((p) => p.grid.corners || p.colorbar.start);
  }

  function setSource(canvas, { keepView = false } = {}) {
    app.sourceCanvas = canvas;
    app.imageData = canvasImageData(canvas);
    app.project.source.width = canvas.width;
    app.project.source.height = canvas.height;
    app.cache.clear();
    viewer.setSource(canvas, { keepView });
    onHover(null);
    updateSourceUi();
    changed();
  }

  function updateSourceUi() {
    const s = app.project.source;
    $('source-label').textContent = s.fileName;
    $('source-label').title = s.fileName;
    $('source-label').classList.remove('muted');
    const isPdf = !!app.pdfDoc;
    $('pdf-controls').hidden = !isPdf;
    $('source-info').textContent =
      `${s.fileName} · ${s.width} × ${s.height} px` + (isPdf ? ` · page ${s.page} of ${s.pageCount}` : '');
    if (isPdf) {
      $('page-input').max = s.pageCount;
      setValue($('page-input'), s.page);
      $('page-count').textContent = `of ${s.pageCount}`;
      $('page-prev').disabled = s.page <= 1;
      $('page-next').disabled = s.page >= s.pageCount;
      const opt = [...$('scale-select').options].find((o) => Math.abs(Number(o.value) - s.renderScale) < 1e-6);
      if (opt) $('scale-select').value = opt.value;
    }
  }

  async function rerenderPdf(page, scale) {
    if (!app.pdfDoc) return;
    const s = app.project.source;
    page = Math.min(s.pageCount, Math.max(1, page));
    if (page === s.page && Math.abs(scale - s.renderScale) < 1e-9) return;
    try {
      status(`Rendering page ${page}…`);
      const r = await renderPdfPage(app.pdfDoc, page, scale);
      const factor = r.scale / s.renderScale;
      const samePage = page === s.page;
      if (Math.abs(factor - 1) > 1e-9) {
        pushHistory();
        app.project.panels.forEach((p) => rescalePanel(p, factor));
        app.history = []; // coordinates changed space; older snapshots no longer apply
        app.future = [];
      }
      s.page = page;
      s.renderScale = r.scale;
      setSource(r.canvas, { keepView: false });
      if (samePage && r.scale < scale) toast(`Resolution limited to ${Math.round(72 * r.scale)} dpi by the browser canvas size.`);
      status('');
    } catch (err) {
      console.error(err);
      status('');
      toast(`Could not render page: ${err.message}`, true);
    }
  }

  async function openProjectZip(file) {
    if (hasCalibration() && !confirm('Opening a project replaces the current one. Continue?')) return;
    setMode(null);
    status(`Opening ${file.name}…`);
    const { project, pageImage, originalFile } = await readProjectZip(window.JSZip, file);
    const src = project.source || {};
    let canvas;
    app.pdfDoc = null;
    const origFile = originalFile ? new File([originalFile.blob], originalFile.name, { type: src.mime || '' }) : null;
    if (origFile && fileKind(origFile) === 'pdf') {
      try {
        app.pdfDoc = await openPdf(origFile);
      } catch (err) {
        console.warn('Could not reopen the original PDF', err);
      }
    }
    if (pageImage) canvas = await imageToCanvas(pageImage);
    else if (app.pdfDoc) canvas = (await renderPdfPage(app.pdfDoc, src.page || 1, src.renderScale || 3)).canvas;
    else if (origFile) canvas = await imageToCanvas(origFile);
    else throw new Error('The project zip contains no source image.');

    project.source = {
      fileName: src.fileName || origFile?.name || 'source.png',
      mime: src.mime || null,
      page: src.page || 1,
      pageCount: app.pdfDoc ? app.pdfDoc.numPages : src.pageCount || 1,
      renderScale: src.renderScale || 1,
      width: src.width || canvas.width,
      height: src.height || canvas.height,
      sha256: src.sha256 || null,
    };
    if (project.source.width !== canvas.width) {
      const factor = canvas.width / project.source.width;
      project.panels.forEach((p) => rescalePanel(p, factor));
    }
    project.panels.forEach((p) => p.colorbar.ticks.forEach((k) => (k.id = newTickId())));
    app.project = project;
    app.originalFile = origFile;
    app.history = [];
    app.future = [];
    setSource(canvas);
    status('');
    if (origFile && !project.source.sha256) sha256Hex(origFile).then((h) => (project.source.sha256 = h));
    toast(`Opened project with ${project.panels.length} panel${project.panels.length === 1 ? '' : 's'}.`);
  }

  // ---------------------------------------------------------------- export

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function csvName(panel, suffix = '') {
    return `${safeFileName(app.project.name)}_${safeFileName(panel.name)}${suffix}.csv`;
  }

  async function exportZip() {
    if (!window.JSZip) {
      toast('Zip library failed to load.', true);
      return;
    }
    try {
      status('Building zip…');
      const results = app.project.panels.map(resultFor);
      const incomplete = results.filter((r) => r.error).length;
      const pagePng = await canvasToPngBlob(app.sourceCanvas);
      const blob = await buildProjectZip(window.JSZip, {
        project: app.project,
        results,
        sourceFile: app.originalFile,
        pagePng,
      });
      download(blob, `colormeris-${safeFileName(app.project.name)}.zip`);
      status('');
      if (incomplete) toast(`${incomplete} panel${incomplete === 1 ? ' is' : 's are'} not fully calibrated; saved calibration without data.`);
    } catch (err) {
      console.error(err);
      status('');
      toast(`Export failed: ${err.message}`, true);
    }
  }

  async function copyTsv() {
    const panel = activePanel();
    const res = resultFor(panel);
    if (res.error) return;
    const tsv = toWideCsv(panel, res)
      .trim()
      .split('\n')
      .map((line) => line.replace(/"([^"]|"")*"|,/g, (m) => (m === ',' ? '\t' : m.slice(1, -1).replace(/""/g, '"'))))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      toast('Table copied — paste into a spreadsheet.');
    } catch {
      toast('Clipboard is not available here.', true);
    }
  }

  // ---------------------------------------------------------------- misc UI

  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 3000);
  }

  function status(msg) {
    $('status-msg').textContent = msg;
  }

  function zoomToPoints(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = 20;
    viewer.zoomTo(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
  }

  function bindNumber(id, apply) {
    const el = $(id);
    el.addEventListener('focus', () => pushHistory());
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (el.value === '' || !Number.isFinite(v)) return;
      apply(activePanel(), v);
      changed({ light: true });
    });
    el.addEventListener('change', () => changed());
  }

  function bindText(id, apply) {
    const el = $(id);
    el.addEventListener('focus', () => pushHistory());
    el.addEventListener('input', () => {
      apply(activePanel(), el.value);
      changed({ light: true });
    });
    el.addEventListener('change', () => changed());
  }

  // File inputs, drag & drop, paste
  for (const id of ['file-input', 'file-input-2']) {
    $(id).addEventListener('change', (e) => {
      openFile(e.target.files[0]);
      e.target.value = '';
    });
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    openFile(e.dataTransfer?.files?.[0]);
  });
  window.addEventListener('paste', (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const blob = item.getAsFile();
    const ext = item.type.split('/')[1] || 'png';
    openFile(new File([blob], `pasted-image.${ext}`, { type: item.type }));
  });

  // Header
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-export-zip').addEventListener('click', exportZip);

  // Source
  $('page-prev').addEventListener('click', () => rerenderPdf(app.project.source.page - 1, app.project.source.renderScale));
  $('page-next').addEventListener('click', () => rerenderPdf(app.project.source.page + 1, app.project.source.renderScale));
  $('page-input').addEventListener('change', (e) => rerenderPdf(Math.round(Number(e.target.value)) || 1, app.project.source.renderScale));
  $('scale-select').addEventListener('change', (e) => rerenderPdf(app.project.source.page, Number(e.target.value)));

  // Panels
  $('panel-add').addEventListener('click', () => {
    pushHistory();
    const prev = activePanel();
    const panel = createPanel(`Panel ${app.project.panels.length + 1}`);
    panel.settings = { ...prev.settings };
    app.project.panels.push(panel);
    app.project.activePanelId = panel.id;
    app.tableCell = null;
    setMode(null);
    changed();
    $('panel-name').focus();
    $('panel-name').select();
  });
  $('panel-delete').addEventListener('click', () => {
    if (app.project.panels.length < 2) return;
    const panel = activePanel();
    if (!confirm(`Delete panel "${panel.name}"?`)) return;
    pushHistory();
    const i = app.project.panels.indexOf(panel);
    app.project.panels.splice(i, 1);
    app.project.activePanelId = app.project.panels[Math.max(0, i - 1)].id;
    setMode(null);
    changed();
  });
  bindText('panel-name', (p, v) => (p.name = v));
  $('panel-name').addEventListener('input', () => renderPanels(activePanel()));

  // Grid
  $('grid-place').addEventListener('click', () => setMode(app.mode?.type === 'grid' ? null : 'grid'));
  $('grid-zoom').addEventListener('click', () => activePanel().grid.corners && zoomToPoints(activePanel().grid.corners));
  bindNumber('grid-rows', (p, v) => (p.grid.rows = Math.min(1000, Math.max(1, Math.round(v)))));
  bindNumber('grid-cols', (p, v) => (p.grid.cols = Math.min(1000, Math.max(1, Math.round(v)))));
  bindNumber('grid-fraction', (p, v) => (p.grid.sampleFraction = v));
  bindText('grid-row-labels', (p, v) => (p.grid.rowLabels = parseLabelText(v)));
  bindText('grid-col-labels', (p, v) => (p.grid.colLabels = parseLabelText(v)));
  for (const [id, key] of [['grid-row-labels', 'rows'], ['grid-col-labels', 'cols']]) {
    // Pasting a label list sets the matching grid dimension when the grid is still default-sized.
    $(id).addEventListener('change', () => {
      const p = activePanel();
      const labels = key === 'rows' ? p.grid.rowLabels : p.grid.colLabels;
      if (labels.length > 1 && labels.length !== p.grid[key] && confirm(`Set ${key} to ${labels.length} to match the labels?`)) {
        commit((pn) => (pn.grid[key] = labels.length));
      }
    });
  }

  // Colorbar
  $('bar-place').addEventListener('click', () => {
    if (app.mode?.type === 'colorbar') return setMode(null);
    const cb = activePanel().colorbar;
    if (cb.ticks.length && !confirm('Placing the colorbar again removes its ticks. Continue?')) return;
    if (cb.ticks.length) commit((p) => (p.colorbar.ticks = []));
    setMode('colorbar');
  });
  $('tick-add').addEventListener('click', () => setMode(app.mode?.type === 'tick' ? null : 'tick'));
  $('bar-zoom').addEventListener('click', () => {
    const cb = activePanel().colorbar;
    if (cb.start) zoomToPoints([cb.start, cb.end]);
  });
  $('bar-scale').addEventListener('change', (e) => commit((p) => (p.colorbar.scale = e.target.value)));
  bindNumber('bar-halfwidth', (p, v) => (p.colorbar.halfWidth = Math.min(50, Math.max(0, v))));

  // Results
  $('toggle-recon').addEventListener('change', (e) => {
    app.showRecon = e.target.checked;
    viewer.requestDraw();
  });
  $('set-distance').addEventListener('change', (e) => commit((p) => (p.settings.distance = e.target.value)));
  bindNumber('set-maxde', (p, v) => (p.settings.maxDeltaE = Math.max(0, v)));
  $('dl-csv').addEventListener('click', () => {
    const p = activePanel();
    const r = resultFor(p);
    if (!r.error) download(new Blob([toWideCsv(p, r)], { type: 'text/csv' }), csvName(p));
  });
  $('dl-long').addEventListener('click', () => {
    const p = activePanel();
    const r = resultFor(p);
    if (!r.error) download(new Blob([toLongCsv([{ panel: p, result: r }])], { type: 'text/csv' }), csvName(p, '_long'));
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

  // View tools
  $('mode-done').addEventListener('click', () => setMode(null));
  $('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
  $('zoom-fit').addEventListener('click', () => viewer.fit());
  $('toggle-overlay').addEventListener('change', (e) => {
    app.showOverlay = e.target.checked;
    viewer.requestDraw();
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Escape') {
      if (typing) t.blur();
      else setMode(null);
      return;
    }
    if (typing || mod || e.altKey || !app.sourceCanvas) return;
    const k = e.key.toLowerCase();
    if (k === 'f') viewer.fit();
    else if (k === '+' || k === '=') viewer.zoomBy(1.25);
    else if (k === '-') viewer.zoomBy(0.8);
    else if (k === 'g') setMode(app.mode?.type === 'grid' ? null : 'grid');
    else if (k === 'b') $('bar-place').click();
    else if (k === 't') setMode(app.mode?.type === 'tick' ? null : 'tick');
  });

  window.addEventListener('beforeunload', (e) => {
    if (hasCalibration()) e.preventDefault();
  });

  renderSidebar();
})((globalThis.Colormeris ??= {}));
