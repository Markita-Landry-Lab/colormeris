(function (CM) {
  'use strict';
  const {
    extractField,
    sampleProfiles,
    mapProblem,
    mapAt,
    axisCoords,
    axisT,
    onAxisEdge,
    mapPanelFiles,
    createAxisTick,
    createProfile,
    pastedProfiles,
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
  // One color per profile, by its place in the list: on the image, on its
  // chip and in the plot. Mid-tones that read on images and on the light or
  // dark plot; no red (flagged samples) or yellow (the trace).
  const PROFILE_COLORS = ['#00c2e0', '#e040a0', '#f59f00', '#40c057', '#845ef7'];

  // setupMapTool(ws) registers the tool with a workspace (workspace/workspace.js).
  function setupMapTool(ws) {
  const { $, app, viewer } = ws;
  const state = {
    selectedId: null, // selected profile, edited in the card
    overlay: new Set(), // more selected profiles, plotted with it
    profileNorm: 'raw', // profile plot and CSV: 'raw', or divided by each 'max' or 'mean'
    trace: null, // {id, i}: traced sample of a profile (see map-sidebar.js)
    sweep: null, // the edited profile moving across the plot (see map-sidebar.js)
    showRecon: false,
    showFlags: false,
    field: new Map(), // panel id → {key, image, result}
    layers: new WeakMap(), // field values array → {recon, flags} canvases
  };
  const selectedProfile = () => ws.activePanel().map.profiles.find((l) => l.id === state.selectedId) || null;
  const isSelected = (id) => id === state.selectedId || state.overlay.has(id);
  // All selected profiles, in list order.
  const selectedProfiles = () => ws.activePanel().map.profiles.filter((l) => isSelected(l.id));
  const profileColor = (panel, l) => PROFILE_COLORS[Math.max(0, panel.map.profiles.indexOf(l)) % PROFILE_COLORS.length];

  // Select profile id (null: none). With add, toggle it in the selection
  // instead; a profile added becomes the one edited.
  function selectProfile(id, { add = false } = {}) {
    if (!add || !id) {
      state.selectedId = id;
      state.overlay.clear();
    } else if (isSelected(id)) {
      state.overlay.delete(id);
      if (state.selectedId === id) {
        state.selectedId = [...state.overlay].pop() ?? null;
        state.overlay.delete(state.selectedId);
      }
    } else {
      if (state.selectedId) state.overlay.add(state.selectedId);
      state.selectedId = id;
    }
    ws.changed();
  }

  const mctx = { ws, state, selectedProfile, selectedProfiles, isSelected, selectProfile, profileColor, AXIS_COLORS };
  const { renderSidebar, focusAxisTick, setTrace, stopSweep, toggleSweep } = setupMapSidebar(mctx);

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
        const q = onAxisEdge(panel, key, k);
        ws.drawHandle(ctx, v, q, AXIS_COLORS[key], 'circle');
        if (Number.isFinite(k.value)) label(ctx, v.toScreen(q), formatNumber(k.value), AXIS_COLORS[key], key === 'x' ? 'below' : 'left');
      }
    }
    for (const l of panel.map.profiles) {
      const a = v.toScreen(l.a);
      const b = v.toScreen(l.b);
      const color = profileColor(panel, l);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ws.strokeDual(ctx, color, isSelected(l.id) ? 2.5 : 1.5);
      ws.drawHandle(ctx, v, l.a, color, 'square');
      ws.drawHandle(ctx, v, l.b, color, 'circle');
      label(ctx, a, l.name, color, 'above');
    }
    drawTrace(ctx, v, panel);
  }

  // The traced sample of the selected profile: a ring on the line and its value.
  function drawTrace(ctx, v, panel) {
    const samples = state.trace && panel.map.profiles.some((l) => l.id === state.trace.id) ? ws.resultFor(panel).profiles?.[state.trace.id] : null;
    const s = Array.isArray(samples) ? samples[state.trace.i] : null;
    if (!s || s.outside) return;
    const q = v.toScreen({ x: s.px, y: s.py });
    ctx.beginPath();
    ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI);
    ws.strokeDual(ctx, '#ffd400', 2);
    // Four significant digits, as in the profile plot's readout.
    label(ctx, { x: q.x + 10, y: q.y + 4 }, String(Number(s.value.toPrecision(4))), '#ffd400', 'above');
  }

  // Pointer over the image near a selected profile → trace the nearest
  // sample of the closest one.
  function traceFromImage(panel, p) {
    if (app.mode) return setTrace(null);
    let best = null;
    for (const l of selectedProfiles()) {
      const samples = ws.resultFor(panel).profiles?.[l.id];
      if (!Array.isArray(samples) || samples.length < 2) continue;
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const len2 = dx * dx + dy * dy;
      const t = ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / len2;
      const dist = Math.abs((p.x - l.a.x) * dy - (p.y - l.a.y) * dx) / Math.sqrt(len2);
      if (t < 0 || t > 1 || dist > Math.max(l.halfWidth, 0) + 8 / viewer.scale) continue;
      const i = Math.round(t * (samples.length - 1));
      if (samples[i].outside) continue;
      if (!best || dist < best.dist) best = { dist, trace: { id: l.id, i } };
    }
    setTrace(best ? best.trace : null);
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
      // The line through the plot at the pointer's axis position, and where
      // the tick will go on the edge.
      const key = m.type[0];
      const q = onAxisEdge(panel, key, hover);
      const t = axisT(panel, key, q);
      const c = panel.grid.corners;
      const [a, b] = key === 'x' ? [bilinear(c, t, 0), q] : [q, bilinear(c, 1, t)];
      line(ctx, v, a, b, AXIS_COLORS[key]);
      ws.drawHandle(ctx, v, q, AXIS_COLORS[key], 'circle');
    } else if (m.type === 'profile' && m.points.length === 1) {
      // In the color the new profile will get.
      line(ctx, v, m.points[0], ws.snapAxis(m.points[0], hover), PROFILE_COLORS[panel.map.profiles.length % PROFILE_COLORS.length]);
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
    traceFromImage(panel, p);
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
    if (type) stopSweep();
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
      const tick = createAxisTick(onAxisEdge(ws.activePanel(), key, p));
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
      selectProfile(profile.id);
      return true;
    }
    if (mode) return false;
    // No mode: clicking a profile selects it; Shift- or Cmd-click adds it to
    // the selection (or takes it out), to overlay several in the plot.
    const hit = profileAt(p, 6 / viewer.scale);
    const add = e.shiftKey || e.metaKey || e.ctrlKey;
    if (add && !hit) return true;
    selectProfile(hit ? hit.id : null, { add });
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
    for (const key of ['x', 'y']) for (const k of panel.map[key].ticks) if (near(onAxisEdge(panel, key, k))) return { kind: 'axisTick', key, id: k.id };
    const l = profileAt(p, tol);
    return l ? { kind: 'profileMove', id: l.id, start: p, a: l.a, b: l.b } : null;
  }

  function onHandleDrag(handle, p, e) {
    // The drag takes the line; a sweep would pull it back each frame.
    stopSweep();
    const panel = ws.activePanel();
    if (handle.kind === 'axisTick') {
      const k = panel.map[handle.key].ticks.find((x) => x.id === handle.id);
      if (k) Object.assign(k, onAxisEdge(panel, handle.key, p));
    } else {
      // Ctrl- or Cmd-dragging a line moves a copy of it and leaves the original.
      if (handle.kind === 'profileMove' && !handle.started) {
        handle.started = true;
        const src = panel.map.profiles.find((x) => x.id === handle.id);
        if (src && (e.ctrlKey || e.metaKey)) {
          const [copy] = pastedProfiles(panel, [src], null);
          panel.map.profiles.push(copy);
          handle.id = copy.id;
          state.overlay.clear();
        }
      }
      const l = panel.map.profiles.find((x) => x.id === handle.id);
      if (!l) return;
      // Dragging a selected profile keeps the selection; it becomes the one edited.
      if (!isSelected(l.id)) state.overlay.clear();
      else if (state.selectedId !== l.id) {
        state.overlay.delete(l.id);
        state.overlay.add(state.selectedId);
      }
      state.selectedId = l.id;
      if (handle.kind === 'profileEnd') {
        const other = handle.end === 'a' ? l.b : l.a;
        l[handle.end] = e.altKey ? p : ws.snapAxis(other, p);
      } else {
        // Moved by the offset from where the drag started; with Shift only
        // along its larger component, so the line moves straight across or down.
        let dx = p.x - handle.start.x;
        let dy = p.y - handle.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        l.a = { x: handle.a.x + dx, y: handle.a.y + dy };
        l.b = { x: handle.b.x + dx, y: handle.b.y + dy };
      }
    }
    ws.changed({ light: true });
  }

  // Deletes every selected profile.
  function deleteSelected() {
    const ids = new Set(selectedProfiles().map((l) => l.id));
    if (!ids.size) return;
    ws.commit((p) => (p.map.profiles = p.map.profiles.filter((x) => !ids.has(x.id))));
    selectProfile(null);
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

  $('viewer').addEventListener('pointerleave', () => ws.tool().kind === 'map' && setTrace(null));

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

  // Copy and paste profiles, also between panels and pages. The clipboard is
  // this tab's, not the system's: profiles mean nothing outside a figure.
  let clipboard = null; // {panelId, corners, profiles, pastes}
  function copyProfiles() {
    const profiles = selectedProfiles();
    if (!profiles.length || app.mode) return false;
    const panel = ws.activePanel();
    clipboard = { panelId: panel.id, corners: structuredClone(panel.grid.corners), profiles: structuredClone(profiles), pastes: 0 };
    ws.toast(`Copied ${profiles.length} profile${profiles.length === 1 ? '' : 's'}.`);
  }
  function pasteProfiles() {
    if (!clipboard || app.mode) return false;
    const panel = ws.activePanel();
    // In the panel they came from, each paste lands a bit lower and to the
    // right (12 screen px), so copies do not hide the original.
    const step = panel.id === clipboard.panelId ? (12 * ++clipboard.pastes) / viewer.scale : 0;
    const copies = pastedProfiles(panel, clipboard.profiles, panel.id === clipboard.panelId ? null : clipboard.corners, { x: step, y: step });
    ws.commit((p) => p.map.profiles.push(...copies));
    state.selectedId = copies.at(-1).id;
    state.overlay.clear();
    for (const l of copies.slice(0, -1)) state.overlay.add(l.id);
    ws.changed();
    ws.toast(`Pasted ${copies.length} profile${copies.length === 1 ? '' : 's'}.`);
  }
  ws.addHotkey('copyProfiles', copyProfiles, { tool: 'map' });
  ws.addHotkey('pasteProfiles', pasteProfiles, { tool: 'map' });
  ws.addHotkey('sweepProfile', () => (selectedProfile() && !app.mode ? toggleSweep() : false), { tool: 'map' });
  }

  Object.assign(CM, { setupMapTool });
})((globalThis.Colormeris ??= {}));
