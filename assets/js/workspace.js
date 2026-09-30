(function (CM) {
  'use strict';
  const { Viewer, fileKind, openPdf, renderPdfPage, imageToCanvas, canvasImageData, canvasToPngBlob, sha256Hex, createProject, createPanel, parseLabelText, ticksWithT, rescalePanel, rectCorners, detectGridSize, bilinear, cellAt, readPixel, projectT, pointAtT, colorAtT, buildProjectZip, readProjectZip, safeFileName, panelFileBases, rgbToHex } = CM;

  // Shared workspace for the Colormeris tools: source loading and PDF pages,
  // the zoomable viewer, panels, the grid and colorbar calibration, undo,
  // keyboard shortcuts and project zips. Tools (heatmap.js, ivis.js) register
  // with addTool and plug in their results and overlay through the hooks in
  // TOOL_HOOKS. One project holds the panels of every tool (panel.tool); the
  // active tool (setTool) shows and edits its own panels, and a project zip
  // carries the data of all tools.
  //
  // TOOL_HOOKS (all optional unless noted):
  //   kind                      'heatmap' | 'ivis' (required)
  //   title                     page title while the tool is active
  //   computeResult(panel, img) result object or {error} (required)
  //   resultKey(panel)          JSON-able key of everything computeResult depends on
  //   panelProblem(panel)       what is missing before results, or null (required)
  //   panelFiles(panels, results, bases) → [{path, content}] data files for the zip
  //   hasCalibration(panel)     extra test for unsaved work
  //   sections                  ids of tool sidebar cards shown once a file is loaded
  //   renderSidebar(panel, light)
  //   modeTexts                 {mode: [texts by clicks so far] | (mode) => text}
  //   onModeChange(type)
  //   onClick(mode, p, e)       return true when handled
  //   hitTest(p, tol)           tool handles, checked after the shared ones
  //   onHandleDrag(handle, p, e) / onHandleDrop(handle)
  //   wantsDrag(), onDragStart(p, e), onDragMove(p, e), onDragEnd(p, e)
  //   drawUnderGrid / drawOverGrid (ctx, v, panel, active)
  //   drawOverlay(ctx, v, active, panelsOnPage)
  //   drawModePreview(ctx, v, mode, hover)
  //   hoverText(panel, cell, p) text for the status bar
  //   onHoverCell(cell)
  //   onKey(e)                  return true when handled
  //   gridTexts                 mode texts for placing the grid
  function createWorkspace() {
  const $ = (id) => document.getElementById(id);
  const tools = {};
  let tool = null; // the active tool
  const toolFor = (panel) => tools[panel.tool] || tool;

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
    pages: new Map(), // page number → {canvas, imageData} of rendered pages
    lastActive: new Map(), // `${tool}|${page}` → id of the panel last active there
    history: [],
    future: [],
    drag: null,
    hoverCell: null,
    tableCell: null,
    showOverlay: true,
  };

  let tickSeq = 1;
  const newTickId = () => `t${tickSeq++}`;

  const currentPage = () => app.project.source?.page || 1;
  // Panels belonging to the page on screen; only these are drawn and edited.
  const pagePanels = () => app.project.panels.filter((p) => p.page === currentPage() && p.tool === tool.kind);
  const activeKey = (page = currentPage()) => `${tool.kind}|${page}`;
  const activePanel = () => {
    const here = pagePanels();
    return here.find((p) => p.id === app.project.activePanelId) || here[0] || app.project.panels[0];
  };

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
    // Undoing a change made on another page takes you back to that page.
    const target = app.project.panels.find((p) => p.id === snap.activePanelId);
    if (target && target.tool !== tool.kind) {
      setTool(target.tool, { quiet: true });
      if (target.page !== currentPage()) {
        goToPage(target.page, { keepActive: true });
        return;
      }
      app.project.activePanelId = target.id;
    }
    if (target && target.page !== currentPage()) {
      goToPage(target.page, { keepActive: true });
      return;
    }
    ensurePagePanel(currentPage());
    changed();
  }

  // Move between two history stacks. The saved counterpart keeps the panel of
  // the change being undone/redone as active, so both directions land on the
  // page where the change was made.
  function step(from, to) {
    if (!from.length) return;
    const snap = from.pop();
    const current = snapshot();
    current.activePanelId = snap.activePanelId;
    to.push(current);
    restore(snap);
  }

  const undo = () => step(app.history, app.future);
  const redo = () => step(app.future, app.history);

  // Apply a mutation with an undo point.
  function commit(fn) {
    pushHistory();
    fn(activePanel());
    changed();
  }

  // ---------------------------------------------------------------- extraction

  // Extract a panel from the image of its own page.
  function resultFor(panel) {
    if (!app.sourceCanvas) return { error: 'Load a file first.' };
    const image = app.pages.get(panel.page)?.imageData;
    if (!image) return { error: `Page ${panel.page} is not rendered yet.` };
    const t = toolFor(panel);
    const key = JSON.stringify([panel.page, panel.tool, t.resultKey ? t.resultKey(panel) : [panel.grid, panel.colorbar, panel.settings]]);
    const hit = app.cache.get(panel.id);
    if (hit && hit.key === key) return hit.result;
    const result = t.computeResult(panel, image);
    app.cache.set(panel.id, { key, result });
    return result;
  }

  // ---------------------------------------------------------------- viewer

  const viewer = new Viewer($('viewer'), {
    onClick,
    hitTest,
    onHandleDrag,
    onHandleDrop: (handle) => {
      app.drag = null;
      tool.onHandleDrop?.(handle);
      // Re-detect the cell count after moving a corner unless the user set it by hand.
      const panel = activePanel();
      if (handle.kind === 'corner' && panel.grid.autoSize) applyDetectedSize(panel, { onlyIfChanged: true });
      changed();
    },
    onHover,
    drawOverlay,
    wantsLoupe: () => !!app.mode,
    wantsDrag: () => !!tool.wantsDrag?.(),
    onDragStart: (p, e) => tool.onDragStart?.(p, e),
    onDragMove: (p, e) => tool.onDragMove?.(p, e),
    onDragEnd: (p, e) => tool.onDragEnd?.(p, e),
  });

  function onClick(p, e) {
    const mode = app.mode;
    if (tool.onClick?.(mode, p, e)) return;
    if (!mode) return;
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
        commit((panel) => {
          panel.grid.corners = rectCorners(a, b);
          applyDetectedSize(panel);
        });
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

  // Prefill rows/columns from the colors inside the grid.
  function applyDetectedSize(panel, { onlyIfChanged = false } = {}) {
    if (!panel.grid.corners || !app.imageData) return;
    const d = detectGridSize(app.imageData, panel.grid.corners);
    const changedSize = d.rows !== panel.grid.rows || d.cols !== panel.grid.cols;
    panel.grid.rows = d.rows;
    panel.grid.cols = d.cols;
    panel.grid.autoSize = true;
    if (onlyIfChanged && !changedSize) return;
    const uncertain = Math.min(d.rowConfidence, d.colConfidence) < 1.3 || d.rows === 1 || d.cols === 1;
    toast(
      uncertain
        ? `Detected ${d.rows} × ${d.cols} cells, but not confidently. Please check Rows and Columns.`
        : `Detected ${d.rows} × ${d.cols} cells. Edit Rows and Columns if that's wrong.`,
    );
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
    return tool.hitTest?.(p, tol) || null;
  }

  const SHARED_HANDLES = new Set(['corner', 'barStart', 'barEnd', 'tick']);

  function onHandleDrag(handle, p, e) {
    if (!app.drag) {
      pushHistory();
      app.drag = handle;
    }
    const panel = activePanel();
    if (!SHARED_HANDLES.has(handle.kind)) {
      tool.onHandleDrag?.(handle, p, e);
    } else if (handle.kind === 'corner') {
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
    $('status-cell').textContent = tool.hoverText?.(panel, cell, p) || '';
  }

  function setHoverCell(cell) {
    const same = cell && app.hoverCell && cell.row === app.hoverCell.row && cell.col === app.hoverCell.col;
    if (same || (!cell && !app.hoverCell)) return;
    app.hoverCell = cell;
    tool.onHoverCell?.(cell);
    viewer.requestDraw();
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
    tool.drawUnderGrid?.(ctx, v, panel, active);

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

    tool.drawOverGrid?.(ctx, v, panel, active);
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
      const label = Number.isFinite(k.value) ? tickLabel(k.value) : '?';
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

  // Compact tick text: 1.4e9 rather than 1400000000.
  function tickLabel(v) {
    const a = Math.abs(v);
    return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential().replace('e+', 'e') : String(v);
  }

  function drawOverlay(ctx, v) {
    if (app.showOverlay) {
      const active = activePanel();
      for (const panel of pagePanels()) {
        if (panel === active) continue;
        ctx.globalAlpha = 0.35;
        drawGrid(ctx, v, panel, false);
        drawColorbar(ctx, v, panel, false);
      }
      ctx.globalAlpha = 1;
      drawGrid(ctx, v, active, true);
      drawColorbar(ctx, v, active, true);
      tool.drawOverlay?.(ctx, v, active, pagePanels());
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
    if (m) tool.drawModePreview?.(ctx, v, m, hover);
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
    grid: ['Click the outer top-left corner of the grid.', 'Click the outer bottom-right corner.'],
    colorbar: ['Click one end of the colorbar (middle of the bar).', 'Click the other end. Hold Alt to disable axis snapping.'],
    tick: ['Click a labelled tick on the colorbar, then type its value. Press Done when finished.'],
  };
  const modeTexts = (type) => tool.modeTexts?.[type] || (type === 'grid' && tool.gridTexts) || MODE_TEXT[type];

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
    tool.onModeChange?.(type);
    viewer.requestDraw();
  }

  function updateModebar() {
    const m = app.mode;
    $('modebar').hidden = !m;
    if (!m) return;
    const texts = modeTexts(m.type);
    $('modebar-text').textContent = typeof texts === 'function' ? texts(m) : texts[Math.min(m.points.length, texts.length - 1)];
    $('mode-done').textContent = m.type === 'tick' || m.done ? 'Done' : 'Cancel';
  }

  // ---------------------------------------------------------------- sidebar rendering

  function setValue(el, value) {
    if (document.activeElement !== el && el.value !== String(value)) el.value = value;
  }

  const changeListeners = [];
  function changed({ light = false } = {}) {
    viewer.requestDraw();
    renderSidebar(light);
    for (const fn of changeListeners) fn();
  }

  function renderSidebar(light = false) {
    const loaded = !!app.sourceCanvas;
    for (const t of Object.values(tools)) for (const id of t.sections || []) $(id).hidden = true;
    for (const id of ['sec-source', 'sec-panels', 'sec-grid', 'sec-colorbar', 'sec-settings', ...(tool.sections || [])]) $(id).hidden = !loaded;
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
    if ($('grid-row-labels')) setValue($('grid-row-labels'), g.rowLabels.join('\n'));
    if ($('grid-col-labels')) setValue($('grid-col-labels'), g.colLabels.join('\n'));
    if ($('grid-box-labels')) setValue($('grid-box-labels'), g.boxLabels.join('\n'));
    setBadge($('grid-state'), g.corners ? `${g.rows} × ${g.cols}` : 'not placed', !!g.corners);
    $('grid-zoom').disabled = !g.corners;
    $('grid-detect').disabled = !g.corners;

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

    tool.renderSidebar?.(panel, light);
    renderBarStrip(panel);
  }

  function setBadge(el, text, ok) {
    el.textContent = text;
    el.className = `badge ${ok ? 'ok' : 'todo'}`;
  }

  function renderPanels(active) {
    const list = $('panel-list');
    const multiPage = (app.project.source?.pageCount || 1) > 1;
    $('panel-page-note').textContent = multiPage ? `on page ${currentPage()}` : '';
    list.replaceChildren(
      ...pagePanels().map((p) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = `btn small${p === active ? ' active' : ''}`;
        const dot = document.createElement('span');
        const problem = toolFor(p).panelProblem(p);
        const review = !problem && ws.reviewStatus?.(p);
        dot.className = `status-dot${problem ? '' : review === 'rejected' ? ' rejected' : ' done'}`;
        btn.append(dot, document.createTextNode(p.name || '(unnamed)'));
        btn.title = problem || (review === 'rejected' ? `Rejected in review${p.review.note ? `: ${p.review.note}` : ''}` : review === 'accepted' ? 'Calibrated and accepted' : 'Calibrated');
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
    $('panel-delete').textContent = pagePanels().length < 2 ? 'Clear' : 'Delete';
    renderOtherPages();
  }

  // Links to other pages that already have panels.
  function renderOtherPages() {
    const byPage = new Map();
    for (const p of app.project.panels) {
      if (p.page === currentPage()) continue;
      if (!byPage.has(p.page)) byPage.set(p.page, []);
      byPage.get(p.page).push(p.name || '(unnamed)');
    }
    const box = $('other-pages');
    box.hidden = byPage.size === 0;
    const items = [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, names]) => {
        const btn = document.createElement('button');
        btn.className = 'btn small ghost';
        btn.textContent = `Page ${page}: ${names.join(', ')}`;
        btn.title = `Go to page ${page}`;
        btn.addEventListener('click', () => goToPage(page));
        return btn;
      });
    box.replaceChildren(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'Other pages:' }), ...items);
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
      const project = createProject(tool.kind);
      project.activePanelId = project.panels[0].id;
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
      app.lastActive.clear();
      app.pages = new Map([[1, { canvas, imageData: canvasImageData(canvas) }]]);
      app.cache.clear();
      showPage(1);
      status('');
      sha256Hex(file).then((h) => (project.source.sha256 = h));
    } catch (err) {
      console.error(err);
      status('');
      toast(`Could not open ${file.name}: ${err.message}`, true);
    }
  }

  function hasCalibration() {
    return app.project.panels.some((p) => p.grid.corners || p.colorbar.start || toolFor(p).hasCalibration?.(p));
  }

  // Display a page that is already in app.pages.
  function showPage(page, { keepView = false } = {}) {
    const entry = app.pages.get(page);
    app.sourceCanvas = entry.canvas;
    app.imageData = entry.imageData;
    app.project.source.width = entry.canvas.width;
    app.project.source.height = entry.canvas.height;
    viewer.setSource(entry.canvas, { keepView });
    onHover(null);
    updateSourceUi();
    changed();
  }

  // Rendered image of a page, rendering it from the PDF when needed.
  async function ensurePage(page) {
    if (app.pages.has(page)) return app.pages.get(page);
    if (!app.pdfDoc) return null;
    const { canvas } = await renderPdfPage(app.pdfDoc, page, app.project.source.renderScale);
    const entry = { canvas, imageData: canvasImageData(canvas) };
    app.pages.set(page, entry);
    return entry;
  }

  function isEmptyPanel(p) {
    return !p.grid.corners && !p.colorbar.start && !p.grid.rowLabels.length && !p.grid.colLabels.length && !p.grid.boxLabels.length && !p.rois.length;
  }

  // Every page shown gets at least one panel of the active tool to calibrate.
  function ensurePagePanel(page, settings) {
    if (app.project.panels.some((p) => p.page === page && p.tool === tool.kind)) return;
    const panel = createPanel(nextPanelName(), page, tool.kind);
    settings ??= app.project.panels.find((p) => p.tool === tool.kind)?.settings;
    if (settings) panel.settings = { ...settings };
    app.project.panels.push(panel);
  }

  function nextPanelName() {
    const used = new Set(app.project.panels.map((p) => p.name));
    let n = app.project.panels.filter((p) => p.tool === tool.kind).length + 1;
    while (used.has(`Panel ${n}`)) n++;
    return `Panel ${n}`;
  }
  function updateSourceUi() {
    const s = app.project.source;
    $('source-label').textContent = s.fileName;
    $('source-label').title = s.fileName;
    $('source-label').classList.remove('muted');
    // Page controls also work for a reopened project that has several page images but no PDF.
    const isPdf = !!app.pdfDoc || s.pageCount > 1;
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

  // Switch the view to another PDF page. Panels stay with the page they were
  // made on; the new page shows its own panels (or a fresh one).
  async function goToPage(page, { keepActive = false } = {}) {
    const s = app.project.source;
    if (!s) return;
    page = Math.min(s.pageCount, Math.max(1, Math.round(page) || 1));
    if (page === s.page) {
      updateSourceUi();
      return;
    }
    try {
      status(`Rendering page ${page}…`);
      if (!(await ensurePage(page))) throw new Error('the page image is not available');
      setMode(null);
      const oldPage = s.page;
      const leaving = activePanel();
      app.lastActive.set(activeKey(oldPage), leaving.id);
      // Drop untouched placeholder panels left on the page being left.
      app.project.panels = app.project.panels.filter((p) => p.page !== oldPage || !isEmptyPanel(p));
      s.page = page;
      ensurePagePanel(page, leaving.tool === tool.kind ? leaving.settings : undefined);
      if (!keepActive || !pagePanels().some((p) => p.id === app.project.activePanelId)) {
        const remembered = app.lastActive.get(activeKey(page));
        app.project.activePanelId = pagePanels().some((p) => p.id === remembered) ? remembered : pagePanels()[0].id;
      }
      app.tableCell = null;
      app.hoverCell = null;
      showPage(page);
      status('');
    } catch (err) {
      console.error(err);
      status('');
      updateSourceUi();
      toast(`Could not show page ${page}: ${err.message}`, true);
    }
  }

  // Re-render at another resolution. All panel coordinates scale with it.
  async function changeScale(scale) {
    const s = app.project.source;
    if (!app.pdfDoc || Math.abs(scale - s.renderScale) < 1e-9) return;
    try {
      status('Rendering…');
      const r = await renderPdfPage(app.pdfDoc, s.page, scale);
      const factor = r.scale / s.renderScale;
      app.project.panels.forEach((p) => rescalePanel(p, factor));
      app.history = []; // coordinates changed space; older snapshots no longer apply
      app.future = [];
      s.renderScale = r.scale;
      app.pages = new Map([[s.page, { canvas: r.canvas, imageData: canvasImageData(r.canvas) }]]);
      app.cache.clear();
      showPage(s.page);
      if (r.scale < scale) toast(`Resolution limited to ${Math.round(72 * r.scale)} dpi by the browser canvas size.`);
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
    const { project, pageImages, originalFile } = await readProjectZip(window.JSZip, file);
    const src = project.source || {};
    app.pdfDoc = null;
    const origFile = originalFile ? new File([originalFile.blob], originalFile.name, { type: src.mime || '' }) : null;
    if (origFile && fileKind(origFile) === 'pdf') {
      try {
        app.pdfDoc = await openPdf(origFile);
      } catch (err) {
        console.warn('Could not reopen the original PDF', err);
      }
    }
    const pages = new Map();
    for (const [page, blob] of pageImages) {
      const canvas = await imageToCanvas(blob);
      pages.set(page, { canvas, imageData: canvasImageData(canvas) });
    }
    const page = src.page || 1;
    project.source = {
      fileName: src.fileName || origFile?.name || 'source.png',
      mime: src.mime || null,
      page,
      pageCount: app.pdfDoc ? app.pdfDoc.numPages : Math.max(src.pageCount || 1, ...pages.keys()),
      renderScale: src.renderScale || 1,
      width: src.width || 0,
      height: src.height || 0,
      sha256: src.sha256 || null,
    };
    app.project = project;
    app.pages = pages;
    app.cache.clear();
    app.lastActive.clear();
    if (!app.pages.has(page)) {
      if (app.pdfDoc) await ensurePage(page);
      else if (origFile) {
        const canvas = await imageToCanvas(origFile);
        // An image re-decoded at a different size than recorded: scale the calibration.
        if (src.width && canvas.width !== src.width) project.panels.forEach((p) => rescalePanel(p, canvas.width / src.width));
        app.pages.set(page, { canvas, imageData: canvasImageData(canvas) });
      } else throw new Error('The project zip contains no source image.');
    }
    project.panels.forEach((p) => p.colorbar.ticks.forEach((k) => (k.id = newTickId())));
    ensurePagePanel(page);
    project.activePanelId = pagePanels()[0].id;
    app.originalFile = origFile;
    app.history = [];
    app.future = [];
    showPage(page);
    status('');
    if (origFile && !project.source.sha256) sha256Hex(origFile).then((h) => (project.source.sha256 = h));
    const pageCount = new Set(project.panels.map((p) => p.page)).size;
    const counts = Object.values(tools)
      .map((t) => [t, project.panels.filter((p) => p.tool === t.kind && !isEmptyPanel(p)).length])
      .filter(([, n]) => n)
      .map(([t, n]) => `${n} ${t.label || t.kind} panel${n === 1 ? '' : 's'}`);
    toast(`Opened project with ${counts.join(' and ') || 'no calibrated panels'}${pageCount > 1 ? ` on ${pageCount} pages` : ''}.`);
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
      // Every page that has panels (plus the one on screen) goes into the zip.
      const pages = [...new Set([currentPage(), ...app.project.panels.map((p) => p.page)])].sort((a, b) => a - b);
      const pagePngs = new Map();
      for (const page of pages) {
        const entry = await ensurePage(page);
        if (entry) pagePngs.set(page, await canvasToPngBlob(entry.canvas));
      }
      const results = app.project.panels.map(resultFor);
      const incomplete = results.filter((r) => r.error).length;
      // Data files of every tool, with file names unique across all panels.
      const bases = panelFileBases(app.project.panels);
      const files = Object.values(tools).flatMap((t) => {
        const idx = app.project.panels.map((p, i) => (p.tool === t.kind ? i : -1)).filter((i) => i >= 0);
        if (!idx.length || !t.panelFiles) return [];
        return t.panelFiles(idx.map((i) => app.project.panels[i]), idx.map((i) => results[i]), idx.map((i) => bases[i]));
      });
      for (const extra of ws.zipExtras) files.push(...extra());
      const blob = await buildProjectZip(window.JSZip, {
        project: app.project,
        sourceFile: app.originalFile,
        pagePngs,
        files,
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
  $('page-prev').addEventListener('click', () => goToPage(currentPage() - 1));
  $('page-next').addEventListener('click', () => goToPage(currentPage() + 1));
  $('page-input').addEventListener('change', (e) => goToPage(Number(e.target.value)));
  $('scale-select').addEventListener('change', (e) => changeScale(Number(e.target.value)));

  // Panels
  $('panel-add').addEventListener('click', () => {
    pushHistory();
    const prev = activePanel();
    const panel = createPanel(nextPanelName(), currentPage(), tool.kind);
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
    const here = pagePanels();
    const panel = activePanel();
    const last = here.length < 2;
    if (!confirm(last ? `Clear panel "${panel.name}"? A page always keeps one panel.` : `Delete panel "${panel.name}"?`)) return;
    pushHistory();
    const i = here.indexOf(panel);
    const at = app.project.panels.indexOf(panel);
    if (last) {
      // Every page keeps one panel, so deleting the last one swaps in an empty panel.
      const blank = createPanel(panel.name, panel.page, panel.tool);
      blank.settings = { ...panel.settings };
      app.project.panels.splice(at, 1, blank);
      app.project.activePanelId = blank.id;
    } else {
      app.project.panels.splice(at, 1);
      app.project.activePanelId = here[i === 0 ? 1 : i - 1].id;
    }
    setMode(null);
    changed();
  });
  bindText('panel-name', (p, v) => (p.name = v));
  $('panel-name').addEventListener('input', () => renderPanels(activePanel()));

  // Grid
  $('grid-place').addEventListener('click', () => setMode(app.mode?.type === 'grid' ? null : 'grid'));
  $('grid-zoom').addEventListener('click', () => activePanel().grid.corners && zoomToPoints(activePanel().grid.corners));
  bindNumber('grid-rows', (p, v) => {
    p.grid.rows = Math.min(1000, Math.max(1, Math.round(v)));
    p.grid.autoSize = false;
  });
  bindNumber('grid-cols', (p, v) => {
    p.grid.cols = Math.min(1000, Math.max(1, Math.round(v)));
    p.grid.autoSize = false;
  });
  $('grid-detect').addEventListener('click', () => commit((p) => applyDetectedSize(p)));
  if ($('grid-row-labels')) bindText('grid-row-labels', (p, v) => (p.grid.rowLabels = parseLabelText(v)));
  if ($('grid-col-labels')) bindText('grid-col-labels', (p, v) => (p.grid.colLabels = parseLabelText(v)));
  if ($('grid-box-labels')) bindText('grid-box-labels', (p, v) => (p.grid.boxLabels = parseLabelText(v)));
  for (const [id, key] of [['grid-row-labels', 'rows'], ['grid-col-labels', 'cols']].filter(([id]) => $(id))) {
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

  // Matching settings (both tools)
  $('set-distance').addEventListener('change', (e) => commit((p) => (p.settings.distance = e.target.value)));
  bindNumber('set-maxde', (p, v) => (p.settings.maxDeltaE = Math.max(0, v)));

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
    if (tool.onKey?.(e)) return;
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

  // ---------------------------------------------------------------- tools

  function addTool(config) {
    tools[config.kind] = config;
  }

  // Make another tool active. The loaded file, pages and all panels stay; the
  // tool shows its own panels on the current page (creating one if needed).
  function setTool(kind, { quiet = false } = {}) {
    if (!tools[kind] || tool?.kind === kind) return;
    if (tool) {
      setMode(null);
      if (app.sourceCanvas) {
        app.lastActive.set(activeKey(), activePanel()?.id);
        // Drop the old tool's untouched placeholder panels on this page.
        const kept = app.project.panels.filter((p) => !(p.tool === tool.kind && p.page === currentPage() && isEmptyPanel(p)));
        if (kept.length) app.project.panels = kept;
      }
    }
    tool = tools[kind];
    for (const el of document.querySelectorAll('[data-tool]')) el.hidden = el.dataset.tool !== kind;
    for (const a of document.querySelectorAll('[data-tool-link]')) {
      if (a.dataset.toolLink === kind) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (tool.title) document.title = tool.title;
    // Keep the URL (#heatmap / #ivis) in step, e.g. when undo switches tools.
    if (location.hash !== `#${kind}`) history.replaceState(null, '', `#${kind}`);
    app.tableCell = null;
    app.hoverCell = null;
    if (app.sourceCanvas) {
      ensurePagePanel(currentPage());
      const remembered = app.lastActive.get(activeKey());
      app.project.activePanelId = pagePanels().some((p) => p.id === remembered) ? remembered : pagePanels()[0].id;
    }
    if (!quiet) changed();
  }

  const ws = {
    addTool,
    setTool,
    tool: () => tool,
    app,
    $,
    COLORS,
    viewer,
    activePanel,
    pagePanels,
    currentPage,
    commit,
    pushHistory,
    changed,
    setMode,
    updateModebar,
    resultFor,
    toast,
    status,
    download,
    csvName,
    zoomToPoints,
    bindNumber,
    bindText,
    setValue,
    setBadge,
    strokeDual,
    polyPath,
    drawHandle,
    snapAxis,
    render: () => renderSidebar(),
    // Used by the agent API (agent.js).
    openFile,
    goToPage,
    undo,
    redo,
    canUndo: () => app.history.length > 0,
    canRedo: () => app.future.length > 0,
    exportZip,
    newTickId,
    zipExtras: [], // functions returning [{path, content}] added to project zips
    onChange: (fn) => changeListeners.push(fn),
    reviewStatus: null, // (panel) → 'accepted' | 'rejected' | 'stale' | null, set by agent.js
  };
  return ws;
  }

  Object.assign(CM, { createWorkspace });
})((globalThis.Colormeris ??= {}));
