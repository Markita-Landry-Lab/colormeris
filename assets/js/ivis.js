(function (CM) {
  'use strict';
  const {
    quantifyPanel,
    roiPanelProblem,
    makeClassifier,
    colorbarProblem,
    createRoi,
    roiInstances,
    shapeOutline,
    boxOffset,
    offsetKey,
    fromBox,
    toBox,
    boxGeom,
    geomToBox,
    pointInPolygon,
    centroid,
    cellAt,
    boxLabel,
    roiCsv,
    formatNumber,
    pixelArea,
  } = CM;

  // IVIS tool: quantify luminescence overlays inside drawn regions (ellipses,
  // rectangles, polygons). Colored pixels are read through the colorbar and
  // grayscale pixels (the photograph) count as no signal. With a grid, a region
  // drawn in one box is copied into every box (see roi.js).

  const PALETTE = ['#00e5ff', '#ffd400', '#7cff4f', '#ff6ad5', '#ff8c1a', '#b18cff', '#ffffff', '#4fa3ff'];
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

  // setupIvisTool(ws) registers the tool with a workspace (workspace.js).
  function setupIvisTool(ws) {
  const { $, app, viewer } = ws;
  const state = {
    selectedId: null, // selected region
    draft: null, // {shape, a, b, equal} while dragging a new ellipse/rect
    showMask: false,
    mask: null, // {key, canvas}
    metric: 'sum',
  };

  ws.addTool({
    kind: 'ivis',
    label: 'IVIS',
    title: 'Colormeris · IVIS',
    computeResult: (panel, image) => quantifyPanel(image, panel),
    resultKey: (panel) => [panel.grid, panel.colorbar, panel.settings, panel.rois, panel.scale],
    panelProblem: roiPanelProblem,
    panelFiles: (panels, results, bases) =>
      panels.flatMap((p, i) => (results[i].error ? [] : [{ path: `data/${bases[i]}_rois.csv`, content: roiCsv([{ panel: p, result: results[i] }]) }])),
    hasCalibration: (p) => p.rois.length > 0 || !!p.scale,
    sections: ['sec-rois', 'sec-scale', 'sec-iv-results'],
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

  const selectedRoi = () => ws.activePanel().rois.find((r) => r.id === state.selectedId) || null;
  const roiColor = (panel, roi) => PALETTE[panel.rois.indexOf(roi) % PALETTE.length];

  // ---------------------------------------------------------------- coordinates

  // Image point → the region's own coordinates in copy (row, col).
  function toLocal(roi, grid, row, col, p) {
    if (!roi.replicate) return { x: p.x, y: p.y };
    const q = toBox(grid, p, row, col);
    const o = boxOffset(roi, row, col);
    return { x: q.x - o.dx, y: q.y - o.dy };
  }

  // The region's own coordinates in copy (row, col) → image point.
  function fromLocal(roi, grid, row, col, q) {
    if (!roi.replicate) return { x: q.x, y: q.y };
    const o = boxOffset(roi, row, col);
    return fromBox(grid, { x: q.x + o.dx, y: q.y + o.dy }, row, col);
  }

  // Editable points of a shape in its own coordinates: bounding-box corners for
  // ellipses/rects, vertices for polygons.
  function controlPoints(roi) {
    const g = roi.geom;
    if (roi.shape === 'polygon') return g.points;
    return [
      { x: g.cx - g.rx, y: g.cy - g.ry },
      { x: g.cx + g.rx, y: g.cy - g.ry },
      { x: g.cx + g.rx, y: g.cy + g.ry },
      { x: g.cx - g.rx, y: g.cy + g.ry },
    ];
  }

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
    for (const s of ['ellipse', 'rect', 'polygon']) $(`tool-${s}`).classList.toggle('active', type === s);
    $('scale-place').classList.toggle('active', type === 'scale');
    if (type !== 'ellipse' && type !== 'rect') state.draft = null;
  }

  // ---------------------------------------------------------------- editing regions

  function hitTest(p, tol) {
    if (app.mode) return null;
    const panel = ws.activePanel();
    const sel = selectedRoi();
    if (sel) {
      for (const inst of roiInstances(sel, panel.grid)) {
        const pts = controlPoints(sel).map((q) => fromLocal(sel, panel.grid, inst.row, inst.col, q));
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
      const q = toLocal(roi, grid, handle.row, handle.col, p);
      const opposite = controlPoints(roi)[(handle.i + 2) % 4];
      roi.geom = e.shiftKey ? equalGeom(opposite, q, roi.replicate ? boxPixelSize(grid) : { w: 1, h: 1 }) : boxGeom(opposite, q, false);
      // Keep dragging whichever corner is now under the pointer.
      const pts = controlPoints(roi);
      handle.i = pts.reduce((best, c, i) => (Math.hypot(c.x - q.x, c.y - q.y) < Math.hypot(pts[best].x - q.x, pts[best].y - q.y) ? i : best), 0);
    } else if (handle.kind === 'roiVertex') {
      roi.geom.points[handle.i] = toLocal(roi, grid, handle.row, handle.col, p);
    }
    ws.changed({ light: true });
  }

  // Size of one grid box in pixels (box coordinates span 1 × 1).
  function boxPixelSize(grid) {
    const c = grid.corners;
    return {
      w: Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) / grid.cols,
      h: Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) / grid.rows,
    };
  }

  // Like boxGeom(a, b, true) but equal in pixels when one unit is w × h pixels,
  // so Shift gives a real circle/square for regions stored in box coordinates.
  function equalGeom(a, b, { w, h }) {
    const s = Math.max(Math.abs(b.x - a.x) * w, Math.abs(b.y - a.y) * h) / 2;
    const rx = s / w;
    const ry = s / h;
    return { cx: a.x + Math.sign(b.x - a.x || 1) * rx, cy: a.y + Math.sign(b.y - a.y || 1) * ry, rx, ry };
  }

  function translateGeom(shape, geom, dx, dy) {
    if (shape === 'polygon') return { points: geom.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
    return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
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
  for (const shape of ['ellipse', 'rect', 'polygon']) ws.addHotkey(shape, () => toggleTool(shape), { tool: 'ivis' });

  function toggleTool(type) {
    ws.setMode(app.mode?.type === type ? null : type);
  }

  // ---------------------------------------------------------------- overlay

  function drawOverlay(ctx, v, panel) {
    if (state.showMask) drawMask(ctx, v, panel);
    const result = ws.resultFor(panel);
    const byInstance = new Map();
    if (!result.error) for (const r of result.rows) byInstance.set(`${r.roi.id}|${r.row},${r.col}`, r);
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const roi of panel.rois) {
      const color = roiColor(panel, roi);
      const selected = roi.id === state.selectedId;
      for (const inst of roiInstances(roi, panel.grid)) {
        ws.polyPath(ctx, v, inst.outline);
        if (selected) {
          ctx.globalAlpha = 0.15;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ws.strokeDual(ctx, color, selected ? 2.5 : 1.5);
        // Label with the current metric when the copy is big enough on screen.
        const xs = inst.outline.map((q) => q.x);
        const ys = inst.outline.map((q) => q.y);
        const widthPx = (Math.max(...xs) - Math.min(...xs)) * v.scale;
        if (widthPx < 36) continue;
        const r = byInstance.get(`${roi.id}|${inst.row},${inst.col}`) || byInstance.get(`${roi.id}|null,null`);
        const value = r ? metricValue(r.stats, state.metric) : null;
        const label = value === null || value === undefined ? roi.name : `${roi.name}: ${shortNumber(value)}`;
        const s = v.toScreen({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...ys) });
        const w = ctx.measureText(label).width;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(label, s.x - w / 2, s.y - 3);
        ctx.fillStyle = color;
        ctx.fillText(label, s.x - w / 2, s.y - 3);
      }
    }
    const sel = selectedRoi();
    if (sel) {
      const color = roiColor(panel, sel);
      for (const inst of roiInstances(sel, panel.grid)) {
        for (const q of controlPoints(sel)) ws.drawHandle(ctx, v, fromLocal(sel, panel.grid, inst.row, inst.col, q), color, sel.shape === 'polygon' ? 'circle' : 'square');
      }
    }
    if (panel.scale) drawScale(ctx, v, panel.scale);
  }

  function drawScale(ctx, v, scale) {
    const a = v.toScreen(scale.p1);
    const b = v.toScreen(scale.p2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ws.strokeDual(ctx, '#22d3ee', 2);
    for (const q of [scale.p1, scale.p2]) ws.drawHandle(ctx, v, q, '#22d3ee', 'circle');
    const label = `${scale.length} ${scale.unit}`;
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const w = ctx.measureText(label).width;
    const mx = (a.x + b.x) / 2 - w / 2;
    const my = Math.min(a.y, b.y) - 6;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(label, mx, my);
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(label, mx, my);
  }

  function drawModePreview(ctx, v, m, hover) {
    if ((m.type === 'ellipse' || m.type === 'rect') && state.draft) {
      const roi = { shape: m.type, geom: boxGeom(state.draft.a, state.draft.b, state.draft.equal) };
      ws.polyPath(ctx, v, shapeOutline(roi));
      ws.strokeDual(ctx, '#00e5ff', 1.5, [6, 4]);
    } else if (m.type === 'polygon' && m.points.length) {
      const pts = hover ? [...m.points, hover] : m.points;
      ctx.beginPath();
      pts.forEach((q, i) => {
        const s = v.toScreen(q);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ws.strokeDual(ctx, '#00e5ff', 1.5, [6, 4]);
      m.points.forEach((q, i) => ws.drawHandle(ctx, v, q, i === 0 ? '#ffd400' : '#00e5ff', 'circle'));
    } else if (m.type === 'scale' && m.points.length === 1 && hover) {
      const a = v.toScreen(m.points[0]);
      const b = v.toScreen(ws.snapAxis(m.points[0], hover));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ws.strokeDual(ctx, '#22d3ee', 1.5, [6, 4]);
    }
  }

  // Tint pixels counted as signal (magenta) and flagged colors (red).
  function drawMask(ctx, v, panel) {
    if (colorbarProblem(panel)) return;
    const img = app.imageData;
    const key = JSON.stringify([ws.currentPage(), img.width, panel.colorbar, panel.settings]);
    if (state.mask?.key !== key) {
      const classify = makeClassifier(img, panel);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const mctx = canvas.getContext('2d');
      const out = mctx.createImageData(img.width, img.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const c = classify([d[i], d[i + 1], d[i + 2]]);
        if (!c.signal) continue;
        if (c.flagged) out.data.set([255, 40, 40, 170], i);
        else out.data.set([255, 0, 200, 120], i);
      }
      mctx.putImageData(out, 0, 0);
      state.mask = { key, canvas };
    }
    ctx.imageSmoothingEnabled = v.scale < 2;
    ctx.drawImage(state.mask.canvas, v.ox, v.oy, img.width * v.scale, img.height * v.scale);
  }

  function hoverText(panel, cell, p) {
    const box = cell ? boxLabel(panel.grid, cell.row, cell.col) : '';
    const hit = regionAt(p);
    if (!hit) return box;
    const result = ws.resultFor(panel);
    const r = result.error ? null : result.rows.find((x) => x.roi === hit.roi && (hit.row === null || (x.row === hit.row && x.col === hit.col)));
    const where = box ? `${box} · ` : '';
    if (!r) return `${where}${hit.roi.name}`;
    const s = r.stats;
    return `${where}${hit.roi.name}: sum ${shortNumber(s.sum)} · mean ${shortNumber(s.mean)} · max ${shortNumber(s.max)} · signal ${s.signalPx}/${s.areaPx} px`;
  }

  // ---------------------------------------------------------------- sidebar

  function metricValue(stats, metric) {
    const v = stats[metric];
    return v === undefined ? null : v;
  }

  function shortNumber(v) {
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-2) return v.toExponential(2).replace('e+', 'e');
    return String(Number(v.toPrecision(4)));
  }

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
          btn.className = `btn small roi-item${roi.id === state.selectedId ? ' active' : ''}`;
          const sw = document.createElement('span');
          sw.className = `shape-icon ${roi.shape}`;
          sw.style.setProperty('--roi-color', roiColor(panel, roi));
          const copies = roi.replicate ? (panel.grid.corners ? panel.grid.rows * panel.grid.cols : 0) : 1;
          const nudged = Object.keys(roi.offsets).length;
          const meta = document.createElement('span');
          meta.className = 'muted';
          meta.textContent = roi.replicate ? `×${copies}${nudged ? `, ${nudged} nudged` : ''}` : 'single';
          btn.append(sw, document.createTextNode(roi.name), meta);
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
    const sel = selectedRoi();
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

  // Table: one row per box (or "Image" without a grid), one column per region.
  function tableModel(panel, result) {
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

  function renderResults(panel) {
    const res = ws.resultFor(panel);
    const table = $('iv-result-table');
    $('iv-dl-csv').disabled = $('iv-copy-tsv').disabled = !!res.error;
    if (res.error) {
      $('iv-result-problem').textContent = res.error;
      $('iv-result-summary').textContent = '';
      table.replaceChildren();
      return;
    }
    $('iv-result-problem').textContent = '';
    const flagged = res.rows.reduce((s, r) => s + r.stats.flaggedPx, 0);
    const unit = res.unit ? ` · areas in ${res.unit}²` : ' · pixel units';
    const signal = res.rows.reduce((s, r) => s + r.stats.signalPx, 0);
    $('iv-result-summary').textContent =
      `${panel.rois.length} region${panel.rois.length === 1 ? '' : 's'} · ${res.rows.length} measurement${res.rows.length === 1 ? '' : 's'}${unit}` +
      (flagged ? ` · ${((100 * flagged) / Math.max(1, signal)).toFixed(1)}% of signal pixels matched no colorbar color (ΔE > ${panel.settings.maxDeltaE}); cells over 10% are outlined` : '');
    const model = tableModel(panel, res);
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
    const model = tableModel(panel, res);
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

  for (const s of ['ellipse', 'rect', 'polygon']) $(`tool-${s}`).addEventListener('click', () => toggleTool(s));
  ws.bindText('roi-name', (p, v) => {
    const roi = p.rois.find((r) => r.id === state.selectedId);
    if (roi) roi.name = v;
  });
  $('roi-reset').addEventListener('click', () => {
    const roi = selectedRoi();
    if (roi) ws.commit((p) => (p.rois.find((r) => r.id === roi.id).offsets = {}));
  });
  $('roi-delete').addEventListener('click', deleteSelected);
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
  $('iv-dl-csv').addEventListener('click', () => {
    const p = ws.activePanel();
    const r = ws.resultFor(p);
    if (!r.error) ws.download(new Blob([roiCsv([{ panel: p, result: r }])], { type: 'text/csv' }), ws.csvName(p, '_rois'));
  });
  $('iv-copy-tsv').addEventListener('click', copyTsv);
  $('iv-result-table').addEventListener('pointerover', (e) => {
    const td = e.target.closest('td[data-r]');
    app.tableCell = td ? { row: Number(td.dataset.r), col: Number(td.dataset.c) } : null;
    viewer.requestDraw();
  });
  $('iv-result-table').addEventListener('pointerleave', () => {
    app.tableCell = null;
    viewer.requestDraw();
  });

  }

  Object.assign(CM, { setupIvisTool });
})((globalThis.Colormeris ??= {}));
