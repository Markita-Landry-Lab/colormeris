(function (CM) {
  'use strict';
  const {
    quantifyPanel,
    roiPanelProblem,
    createRoi,
    roiInstances,
    offsetKey,
    boxOffset,
    toBox,
    boxGeom,
    geomToBox,
    pointInPolygon,
    centroid,
    cellAt,
    roiCsv,
    roiToLocal,
    roiFromLocal,
    roiControlPoints,
    gridBoxSize,
    equalBoxGeom,
    translateGeom,
    setupRoiOverlay,
    setupRoiSidebar,
  } = CM;

  // ROI tool: quantify luminescence overlays inside drawn regions (ellipses,
  // rectangles, polygons). Colored pixels are read through the colorbar and
  // grayscale pixels (the photograph) count as no signal. With a grid, a region
  // drawn in one box is copied into every box (see roi/geometry.js).
  //
  // This file sets up the tool and handles drawing and editing regions.
  // roi-overlay.js draws over the image, roi-sidebar.js renders the cards; the
  // three share `rctx` (state, selection, colors, hit testing).

  const PALETTE = ['#00e5ff', '#ffd400', '#7cff4f', '#ff6ad5', '#ff8c1a', '#b18cff', '#ffffff', '#4fa3ff'];

  // setupRoiTool(ws) registers the tool with a workspace (workspace/workspace.js).
  function setupRoiTool(ws) {
  const { $, app, viewer } = ws;
  const state = {
    selectedId: null, // selected region
    draft: null, // {shape, a, b, equal} while dragging a new ellipse/rect
    showMask: false,
    mask: null, // {key, canvas}
    metric: 'sum',
  };
  const selectedRoi = () => ws.activePanel().rois.find((r) => r.id === state.selectedId) || null;
  const roiColor = (panel, roi) => PALETTE[panel.rois.indexOf(roi) % PALETTE.length];
  const rctx = { ws, state, selectedRoi, roiColor, regionAt, deleteSelected };
  const { drawOverlay, drawModePreview, hoverText } = setupRoiOverlay(rctx);
  const { renderSidebar } = setupRoiSidebar(rctx);

  ws.addTool({
    kind: 'roi',
    label: 'ROI',
    title: 'Colormeris · ROI',
    computeResult: (panel, image) => quantifyPanel(image, panel),
    resultKey: (panel) => [panel.grid, panel.colorbar, panel.settings, panel.rois, panel.scale],
    panelProblem: roiPanelProblem,
    panelFiles: (panels, results, bases) =>
      panels.flatMap((p, i) => (results[i].error ? [] : [{ path: `data/${bases[i]}_rois.csv`, content: roiCsv([{ panel: p, result: results[i] }]) }])),
    hasCalibration: (p) => p.rois.length > 0 || !!p.scale,
    sections: ['sec-rois', 'sec-scale', 'sec-roi-results'],
    gridTexts: ['Click the outer top-left corner of the grid of boxes.', 'Click the outer bottom-right corner.'],
    modeTexts: {
      ellipse: ['Drag to draw an ellipse. Hold Shift for a circle.'],
      rect: ['Drag to draw a rectangle. Hold Shift for a square.'],
      polygon: (m) =>
        m.points.length < 3
          ? `Click to add points (${m.points.length} so far).`
          : 'Click the first point, double-click or press Enter to close. Backspace removes the last point.',
      scale: ['Click one end of the scale bar.', 'Click the other end. Hold Alt to disable axis snapping.'],
    },
    onModeChange,
    onClick,
    hitTest,
    onHandleDrag,
    wantsDrag: () => ws.app.mode?.type === 'ellipse' || ws.app.mode?.type === 'rect',
    onDragStart: (p, e) => {
      state.draft = { shape: ws.app.mode.type, a: p, b: p, equal: e.shiftKey };
    },
    onDragMove: (p, e) => {
      if (!state.draft) return;
      state.draft.b = p;
      state.draft.equal = e.shiftKey;
      ws.viewer.requestDraw();
    },
    onDragEnd: finishDraft,
    drawOverlay,
    drawModePreview,
    hoverText,
    onKey,
    renderSidebar,
  });

  // ---------------------------------------------------------------- drawing regions

  function nextRoiName(panel) {
    let n = 1;
    const used = new Set(panel.rois.map((r) => r.name));
    while (used.has(`ROI ${n}`)) n++;
    return `ROI ${n}`;
  }

  // Add a region drawn in image pixels; copy it into every box when asked.
  function placeShape(shape, geomPx) {
    const panel = ws.activePanel();
    const grid = panel.grid;
    const centre = shape === 'polygon' ? centroid(geomPx.points) : { x: geomPx.cx, y: geomPx.cy };
    let roi;
    const cell = grid.corners ? cellAt(grid, centre) : null;
    if ($('roi-replicate').checked && cell) {
      roi = createRoi(shape, geomToBox(shape, geomPx, grid, cell.row, cell.col), { name: nextRoiName(panel) });
    } else {
      roi = createRoi(shape, geomPx, { name: nextRoiName(panel), replicate: false });
      if ($('roi-replicate').checked && grid.corners) ws.toast('Drawn outside the grid, so it was added as a single region.');
    }
    ws.setMode(null);
    ws.commit((p) => p.rois.push(roi));
    state.selectedId = roi.id;
    ws.changed();
  }

  function finishDraft(p, e) {
    const d = state.draft;
    state.draft = null;
    if (!d) return;
    const geom = boxGeom(d.a, p, e.shiftKey);
    if (geom.rx < 1.5 || geom.ry < 1.5) {
      ws.toast('That region is too small; drag a larger shape.', true);
      viewer.requestDraw();
      return;
    }
    placeShape(d.shape, geom);
  }

  function closePolygon() {
    const m = app.mode;
    if (m?.type !== 'polygon') return;
    if (m.points.length < 3) {
      ws.toast('A polygon needs at least 3 points.', true);
      return;
    }
    placeShape('polygon', { points: m.points.slice() });
  }

  function onClick(mode, p, e) {
    if (mode?.type === 'polygon') {
      const tol = 8 / viewer.scale;
      const first = mode.points[0];
      if (mode.points.length >= 3 && (e.detail >= 2 || Math.hypot(p.x - first.x, p.y - first.y) <= tol)) closePolygon();
      else {
        mode.points.push(p);
        ws.updateModebar();
        viewer.requestDraw();
      }
      return true;
    }
    if (mode?.type === 'scale') {
      const q = mode.points.length === 1 && !e.altKey ? ws.snapAxis(mode.points[0], p) : p;
      mode.points.push(q);
      if (mode.points.length < 2) {
        ws.updateModebar();
        return true;
      }
      const [p1, p2] = mode.points;
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 3) {
        mode.points.pop();
        ws.toast('Too short; click the other end of the scale bar.', true);
        return true;
      }
      ws.setMode(null);
      const length = Number($('scale-length').value) > 0 ? Number($('scale-length').value) : 1;
      ws.commit((pn) => (pn.scale = { p1, p2, length, unit: $('scale-unit').value }));
      $('scale-length').focus();
      $('scale-length').select();
      return true;
    }
    if (mode?.type === 'ellipse' || mode?.type === 'rect') return true; // shapes are dragged, not clicked
    if (mode) return false;
    // No tool: clicking a region selects it.
    const hit = regionAt(p);
    state.selectedId = hit ? hit.roi.id : null;
    ws.changed();
    return true;
  }

  // Topmost region copy containing p (selected region first).
  function regionAt(p) {
    const panel = ws.activePanel();
    const order = [...panel.rois].sort((a, b) => (b.id === state.selectedId) - (a.id === state.selectedId));
    for (const roi of order) {
      for (const inst of roiInstances(roi, panel.grid)) {
        if (pointInPolygon(p, inst.outline)) return { roi, row: inst.row, col: inst.col };
      }
    }
    return null;
  }

  function onModeChange(type) {
    for (const s of ['ellipse', 'rect', 'polygon']) ws.setPressed($(`tool-${s}`), type === s);
    ws.setPressed($('scale-place'), type === 'scale');
    if (type !== 'ellipse' && type !== 'rect') state.draft = null;
  }

  // ---------------------------------------------------------------- editing regions

  function hitTest(p, tol) {
    if (app.mode) return null;
    const panel = ws.activePanel();
    const sel = selectedRoi();
    if (sel) {
      for (const inst of roiInstances(sel, panel.grid)) {
        const pts = roiControlPoints(sel).map((q) => roiFromLocal(sel, panel.grid, inst.row, inst.col, q));
        const i = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
        if (i >= 0) return { kind: sel.shape === 'polygon' ? 'roiVertex' : 'roiCorner', roiId: sel.id, row: inst.row, col: inst.col, i };
      }
    }
    const hit = regionAt(p);
    return hit ? { kind: 'roiMove', roiId: hit.roi.id, row: hit.row, col: hit.col } : null;
  }

  function onHandleDrag(handle, p, e) {
    const panel = ws.activePanel();
    const roi = panel.rois.find((r) => r.id === handle.roiId);
    if (!roi) return;
    state.selectedId = roi.id;
    const grid = panel.grid;
    if (handle.kind === 'roiMove') {
      // Remember where the drag started, in the region's box coordinates.
      if (!handle.start) {
        handle.start = roi.replicate ? toBox(grid, p, handle.row, handle.col) : p;
        handle.geom = structuredClone(roi.geom);
        handle.offset = { ...boxOffset(roi, handle.row, handle.col) };
      }
      const now = roi.replicate ? toBox(grid, p, handle.row, handle.col) : p;
      const dx = now.x - handle.start.x;
      const dy = now.y - handle.start.y;
      if (roi.replicate && !e.altKey) {
        // Nudge this box's copy only.
        roi.offsets[offsetKey(handle.row, handle.col)] = { dx: handle.offset.dx + dx, dy: handle.offset.dy + dy };
      } else {
        roi.geom = translateGeom(roi.shape, handle.geom, dx, dy);
        if (roi.replicate) roi.offsets[offsetKey(handle.row, handle.col)] = handle.offset;
      }
    } else if (handle.kind === 'roiCorner') {
      const q = roiToLocal(roi, grid, handle.row, handle.col, p);
      const opposite = roiControlPoints(roi)[(handle.i + 2) % 4];
      roi.geom = e.shiftKey ? equalBoxGeom(opposite, q, roi.replicate ? gridBoxSize(grid) : { w: 1, h: 1 }) : boxGeom(opposite, q, false);
      // Keep dragging whichever corner is now under the pointer.
      const pts = roiControlPoints(roi);
      handle.i = pts.reduce((best, c, i) => (Math.hypot(c.x - q.x, c.y - q.y) < Math.hypot(pts[best].x - q.x, pts[best].y - q.y) ? i : best), 0);
    } else if (handle.kind === 'roiVertex') {
      roi.geom.points[handle.i] = roiToLocal(roi, grid, handle.row, handle.col, p);
    }
    ws.changed({ light: true });
  }

  function deleteSelected() {
    const roi = selectedRoi();
    if (!roi) return;
    ws.commit((p) => (p.rois = p.rois.filter((r) => r.id !== roi.id)));
    state.selectedId = null;
    ws.changed();
  }

  function onKey(e) {
    const t = e.target;
    const typing = t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
    if (typing || e.metaKey || e.ctrlKey || !app.sourceCanvas) return false;
    const m = app.mode;
    if (m?.type === 'polygon') {
      if (e.key === 'Enter') {
        closePolygon();
        return true;
      }
      if (e.key === 'Backspace') {
        m.points.pop();
        ws.updateModebar();
        viewer.requestDraw();
        e.preventDefault();
        return true;
      }
    }
    if (!m && (e.key === 'Delete' || e.key === 'Backspace') && selectedRoi()) {
      e.preventDefault();
      deleteSelected();
      return true;
    }
    return false;
  }
  for (const shape of ['ellipse', 'rect', 'polygon']) ws.addHotkey(shape, () => toggleTool(shape), { tool: 'roi' });

  function toggleTool(type) {
    ws.setMode(app.mode?.type === type ? null : type);
  }

  // ---------------------------------------------------------------- bindings

  for (const s of ['ellipse', 'rect', 'polygon']) $(`tool-${s}`).addEventListener('click', () => toggleTool(s));

  }

  Object.assign(CM, { setupRoiTool });
})((globalThis.Colormeris ??= {}));
