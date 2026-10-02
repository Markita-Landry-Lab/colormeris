(function (CM) {
  'use strict';
  const {
    extractField,
    sampleProfiles,
    mapProblem,
    mapAt,
    axisCoords,
    axisT,
    mapPanelFiles,
    createAxisTick,
    createProfile,
    bilinear,
    colorAtT,
    formatNumber,
    FLAG_DELTA_E,
    FLAG_LOW,
    FLAG_HIGH,
    setupMapSidebar,
  } = CM;

  // Map tool: read near-continuous fields (spectroscopy maps, fluorescence
  // images) as a dense value matrix with axis coordinates, plus line profiles.
  // The grid is the plot area (TOOL_HOOKS plotArea), sampled in bins of
  // map.bin pixels (see map/field.js).
  //
  // This file sets up the tool, draws over the image and handles clicks and
  // drags; map-sidebar.js renders the cards. They share `mctx`.

  const AXIS_COLORS = { x: '#7cff4f', y: '#ffd400' };
  const PROFILE_COLOR = '#00e5ff';

  // setupMapTool(ws) registers the tool with a workspace (workspace/workspace.js).
  function setupMapTool(ws) {
  const { $, app, viewer } = ws;
  const state = {
    selectedId: null, // selected profile
    showRecon: false,
    showFlags: false,
    field: new Map(), // panel id → {key, image, result}
    layers: new WeakMap(), // field values array → {recon, flags} canvases
  };
  const selectedProfile = () => ws.activePanel().map.profiles.find((l) => l.id === state.selectedId) || null;
  const mctx = { ws, state, selectedProfile, AXIS_COLORS, PROFILE_COLOR };
  const { renderSidebar, focusAxisTick } = setupMapSidebar(mctx);

  // The field is the slow part (every pixel goes through the colorbar), so it
  // is cached apart from the profiles: drawing or dragging a profile must not
  // read the whole map again.
  function computeResult(panel, image) {
    const key = JSON.stringify([panel.grid.corners, panel.colorbar, panel.settings, panel.map.bin, panel.map.x, panel.map.y]);
    let hit = state.field.get(panel.id);
    if (!hit || hit.key !== key || hit.image !== image) {
      hit = { key, image, result: extractField(image, panel) };
      state.field.set(panel.id, hit);
    }
    return { ...hit.result, profiles: sampleProfiles(image, panel) };
  }

  ws.addTool({
    kind: 'map',
    label: 'Map',
    title: 'Colormeris · Map',
    plotArea: true,
    computeResult,
    resultKey: (panel) => [panel.grid.corners, panel.colorbar, panel.settings, panel.map],
    panelProblem: mapProblem,
    panelFiles: (panels, results, bases) => panels.flatMap((p, i) => mapPanelFiles(p, results[i], bases[i])),
    hasCalibration: (p) => p.map.x.ticks.length > 0 || p.map.y.ticks.length > 0 || p.map.profiles.length > 0,
    sections: ['sec-axes', 'sec-profiles', 'sec-map-results'],
    gridTexts: ['Click the top-left corner of the plot area (inside the axes).', 'Click the bottom-right corner.'],
    modeTexts: {
      xtick: ['Click a labelled tick on the x axis, then type its value. Press Done when finished.'],
      ytick: ['Click a labelled tick on the y axis, then type its value. Press Done when finished.'],
      profile: ['Click the start of the profile line.', 'Click its end. Hold Alt to disable axis snapping.'],
    },
    onModeChange,
    onClick,
    hitTest,
    onHandleDrag,
    drawUnderGrid,
    drawOverGrid,
    drawOverlay,
    drawModePreview,
    hoverText,
    onKey,
    renderSidebar,
  });

  // ---------------------------------------------------------------- overlay

  // Offscreen layers of a field, one pixel per bin: the reconstruction (each
  // value repainted with its colorbar color) and the flags.
  function layersFor(result) {
    let hit = state.layers.get(result.values);
    if (!hit) {
      hit = {};
      state.layers.set(result.values, hit);
    }
    if (state.showRecon && !hit.recon) {
      hit.recon = paintLayer(result, (i) => [...colorAtT(result.samples, result.t[i]), 255]);
    }
    if (state.showFlags && !hit.flags) {
      hit.flags = paintLayer(result, (i) => {
        const f = result.flags[i];
        if (f & FLAG_DELTA_E) return [255, 40, 40, 200];
        if (f & FLAG_HIGH) return [255, 0, 200, 170];
        if (f & FLAG_LOW) return [0, 229, 255, 170];
        return null;
      });
    }
    return hit;
  }

  function paintLayer(result, colorOf) {
    const canvas = document.createElement('canvas');
    canvas.width = result.cols;
    canvas.height = result.rows;
    const c2d = canvas.getContext('2d');
    const out = c2d.createImageData(result.cols, result.rows);
    for (let i = 0; i < result.values.length; i++) {
      const color = colorOf(i);
      if (color) out.data.set(color, i * 4);
    }
    c2d.putImageData(out, 0, 0);
    return canvas;
  }

  // Draw a one-pixel-per-bin layer over the plot area, mapping its corners to
  // the plot's top-left, top-right and bottom-left corners.
  function drawLayer(ctx, v, panel, layer) {
    const [tl, tr, , bl] = panel.grid.corners.map((q) => v.toScreen(q));
    ctx.save();
    ctx.transform((tr.x - tl.x) / layer.width, (tr.y - tl.y) / layer.width, (bl.x - tl.x) / layer.height, (bl.y - tl.y) / layer.height, tl.x, tl.y);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  function drawUnderGrid(ctx, v, panel, active) {
    if (!active || !state.showRecon) return;
    const result = ws.resultFor(panel);
    if (!result.error) drawLayer(ctx, v, panel, layersFor(result).recon);
  }

  function drawOverGrid(ctx, v, panel, active) {
    if (!active || !state.showFlags) return;
    const result = ws.resultFor(panel);
    if (!result.error) drawLayer(ctx, v, panel, layersFor(result).flags);
  }

  function drawOverlay(ctx, v, panel) {
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const key of ['x', 'y']) {
      for (const k of panel.map[key].ticks) {
        ws.drawHandle(ctx, v, k, AXIS_COLORS[key], 'circle');
        if (Number.isFinite(k.value)) label(ctx, v.toScreen(k), formatNumber(k.value), AXIS_COLORS[key], key === 'x' ? 'below' : 'left');
      }
    }
    for (const l of panel.map.profiles) {
      const a = v.toScreen(l.a);
      const b = v.toScreen(l.b);
      const selected = l.id === state.selectedId;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ws.strokeDual(ctx, PROFILE_COLOR, selected ? 2.5 : 1.5);
      ws.drawHandle(ctx, v, l.a, PROFILE_COLOR, 'square');
      ws.drawHandle(ctx, v, l.b, PROFILE_COLOR, 'circle');
      label(ctx, a, l.name, PROFILE_COLOR, 'above');
    }
  }

  function label(ctx, s, text, color, where) {
    const w = ctx.measureText(text).width;
    const x = where === 'left' ? s.x - w - 8 : s.x - (where === 'above' ? 0 : w / 2);
    const y = where === 'below' ? s.y + 18 : where === 'left' ? s.y + 5 : s.y - 6;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function drawModePreview(ctx, v, m, hover) {
    if (!hover) return;
    const panel = ws.activePanel();
    if ((m.type === 'xtick' || m.type === 'ytick') && panel.grid.corners) {
      // The line through the plot at the pointer's axis position.
      const t = axisT(panel, m.type === 'xtick' ? 'x' : 'y', hover);
      const c = panel.grid.corners;
      const [p, q] = m.type === 'xtick' ? [bilinear(c, t, 0), bilinear(c, t, 1)] : [bilinear(c, 0, t), bilinear(c, 1, t)];
      line(ctx, v, p, q, AXIS_COLORS[m.type[0]]);
    } else if (m.type === 'profile' && m.points.length === 1) {
      line(ctx, v, m.points[0], ws.snapAxis(m.points[0], hover), PROFILE_COLOR);
    }
  }

  function line(ctx, v, p, q, color) {
    const a = v.toScreen(p);
    const b = v.toScreen(q);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ws.strokeDual(ctx, color, 1.5, [6, 4]);
  }

  function hoverText(panel, cell, p) {
    if (!panel.grid.corners) return '';
    const at = axisCoords(panel, p);
    if (at.u < 0 || at.u >= 1 || at.v < 0 || at.v >= 1) return '';
    const x = at.x !== null ? `x ${formatNumber(at.x)}` : `x ${at.px.toFixed(1)} px`;
    const y = at.y !== null ? `y ${formatNumber(at.y)}` : `y ${at.py.toFixed(1)} px`;
    const hit = mapAt(ws.resultFor(panel), panel, p);
    if (!hit) return `${x}, ${y}`;
    const end = hit.flags & FLAG_HIGH ? ' · at colorbar top' : hit.flags & FLAG_LOW ? ' · at colorbar bottom' : '';
    return `${x}, ${y}: ${formatNumber(hit.value)}  (ΔE ${hit.deltaE.toFixed(1)}${end})`;
  }

  // ---------------------------------------------------------------- clicks and drags

  function onModeChange(type) {
    ws.setPressed($('axis-x-add'), type === 'xtick');
    ws.setPressed($('axis-y-add'), type === 'ytick');
    ws.setPressed($('profile-add'), type === 'profile');
  }

  function nextProfileName(panel) {
    let n = 1;
    const used = new Set(panel.map.profiles.map((l) => l.name));
    while (used.has(`Profile ${n}`)) n++;
    return `Profile ${n}`;
  }

  function onClick(mode, p, e) {
    if (mode?.type === 'xtick' || mode?.type === 'ytick') {
      const key = mode.type[0];
      const tick = createAxisTick(p);
      ws.commit((pn) => pn.map[key].ticks.push(tick));
      focusAxisTick(key, tick.id);
      return true;
    }
    if (mode?.type === 'profile') {
      const q = mode.points.length === 1 && !e.altKey ? ws.snapAxis(mode.points[0], p) : p;
      mode.points.push(q);
      if (mode.points.length < 2) {
        ws.updateModebar();
        return true;
      }
      const [a, b] = mode.points;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 3) {
        mode.points.pop();
        ws.toast('Too short; click the other end of the profile.', true);
        return true;
      }
      ws.setMode(null);
      const profile = createProfile(a, b, { name: nextProfileName(ws.activePanel()) });
      ws.commit((pn) => pn.map.profiles.push(profile));
      state.selectedId = profile.id;
      ws.changed();
      return true;
    }
    if (mode) return false;
    // No mode: clicking a profile selects it.
    const hit = profileAt(p, 6 / viewer.scale);
    state.selectedId = hit ? hit.id : null;
    ws.changed();
    return true;
  }

  function profileAt(p, tol) {
    for (const l of ws.activePanel().map.profiles) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / len2));
      if (Math.hypot(l.a.x + t * dx - p.x, l.a.y + t * dy - p.y) <= tol) return l;
    }
    return null;
  }

  function hitTest(p, tol) {
    if (app.mode) return null;
    const panel = ws.activePanel();
    const near = (q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol;
    for (const l of panel.map.profiles) {
      if (near(l.a)) return { kind: 'profileEnd', id: l.id, end: 'a' };
      if (near(l.b)) return { kind: 'profileEnd', id: l.id, end: 'b' };
    }
    for (const key of ['x', 'y']) for (const k of panel.map[key].ticks) if (near(k)) return { kind: 'axisTick', key, id: k.id };
    const l = profileAt(p, tol);
    return l ? { kind: 'profileMove', id: l.id, last: p } : null;
  }

  function onHandleDrag(handle, p, e) {
    const panel = ws.activePanel();
    if (handle.kind === 'axisTick') {
      const k = panel.map[handle.key].ticks.find((x) => x.id === handle.id);
      if (k) Object.assign(k, { x: p.x, y: p.y });
    } else {
      const l = panel.map.profiles.find((x) => x.id === handle.id);
      if (!l) return;
      state.selectedId = l.id;
      if (handle.kind === 'profileEnd') {
        const other = handle.end === 'a' ? l.b : l.a;
        l[handle.end] = e.altKey ? p : ws.snapAxis(other, p);
      } else {
        const dx = p.x - handle.last.x;
        const dy = p.y - handle.last.y;
        handle.last = p;
        l.a = { x: l.a.x + dx, y: l.a.y + dy };
        l.b = { x: l.b.x + dx, y: l.b.y + dy };
      }
    }
    ws.changed({ light: true });
  }

  function deleteSelected() {
    const l = selectedProfile();
    if (!l) return;
    ws.commit((p) => (p.map.profiles = p.map.profiles.filter((x) => x.id !== l.id)));
    state.selectedId = null;
    ws.changed();
  }
  mctx.deleteSelected = deleteSelected;

  function onKey(e) {
    const t = e.target;
    const typing = t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
    if (typing || e.metaKey || e.ctrlKey || !app.sourceCanvas) return false;
    if (!app.mode && (e.key === 'Delete' || e.key === 'Backspace') && selectedProfile()) {
      e.preventDefault();
      deleteSelected();
      return true;
    }
    return false;
  }

  // Axis ticks need the plot area: their position is measured along it.
  function toggleMode(type) {
    if (app.mode?.type === type) return ws.setMode(null);
    if ((type === 'xtick' || type === 'ytick') && !ws.activePanel().grid.corners) {
      ws.toast('Place the plot area first.', true);
      return;
    }
    ws.setMode(type);
    // Ticks are added until Done, like colorbar ticks.
    if (type !== 'profile') {
      app.mode.done = true;
      ws.updateModebar();
    }
  }
  mctx.toggleMode = toggleMode;
  for (const type of ['xtick', 'ytick', 'profile']) ws.addHotkey(type, () => toggleMode(type), { tool: 'map' });
  }

  Object.assign(CM, { setupMapTool });
})((globalThis.Colormeris ??= {}));
