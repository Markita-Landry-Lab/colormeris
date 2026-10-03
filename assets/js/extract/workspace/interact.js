(function (CM) {
  'use strict';
  const { rectCorners, detectGridSize, cellAt, readPixel, rgbToHex, projectT, pointAtT, ticksWithT } = CM;

  // Pointer input on the viewer: clicks while placing the grid, colorbar and
  // ticks, dragging handles (grid corners, colorbar ends, the bar, ticks) and
  // the status bar under the pointer. Tool handles go to the tool's hooks.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (setMode, commit, changed, focusTick, ...).
  function setupWorkspaceInteract(w) {
    const { $, app } = w;

    const SNAP_DEGREES = 3;

    function onClick(p, e) {
      const mode = app.mode;
      if (w.tool().onClick?.(mode, p, e)) return;
      if (!mode) return;
      if (mode.type === 'grid') {
        mode.points.push(p);
        if (mode.points.length === 2) {
          const [a, b] = mode.points;
          if (Math.abs(a.x - b.x) < 2 || Math.abs(a.y - b.y) < 2) {
            mode.points.pop();
            w.toast('Grid is too small; click the opposite corner.', true);
            return;
          }
          w.setMode(null);
          w.commit((panel) => {
            panel.grid.corners = rectCorners(a, b);
            if (!w.tool().plotArea) applyDetectedSize(panel);
          });
        } else w.updateModebar();
      } else if (mode.type === 'colorbar') {
        const q = mode.points.length === 1 && !e.altKey ? snapAxis(mode.points[0], p) : p;
        mode.points.push(q);
        if (mode.points.length === 2) {
          const [a, b] = mode.points;
          if (Math.hypot(b.x - a.x, b.y - a.y) < 3) {
            mode.points.pop();
            w.toast('Colorbar is too short; click the other end.', true);
            return;
          }
          w.setMode(null);
          w.commit((panel) => {
            panel.colorbar.start = a;
            panel.colorbar.end = b;
          });
          const panel = w.activePanel();
          if (panel.colorbar.ticks.length < 2) w.setMode('tick');
        } else w.updateModebar();
      } else if (mode.type === 'tick') {
        const panel = w.activePanel();
        const { start, end } = panel.colorbar;
        const t = projectT(start, end, p);
        if (t < -0.1 || t > 1.1) {
          w.toast('Click on (or next to) the colorbar line to place a tick.', true);
          return;
        }
        const id = w.newTickId();
        w.commit((pn) => pn.colorbar.ticks.push({ id, ...pointAtT(start, end, t), value: NaN }));
        w.focusTick(id);
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
      w.toast(
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
      const panel = w.activePanel();
      const near = (q) => q && Math.hypot(q.x - p.x, q.y - p.y) <= tol;
      for (const k of panel.colorbar.ticks) if (near(k)) return { kind: 'tick', id: k.id };
      if (near(panel.colorbar.start)) return { kind: 'barStart' };
      if (near(panel.colorbar.end)) return { kind: 'barEnd' };
      const corners = panel.grid.corners;
      if (corners) for (let i = 0; i < 4; i++) if (near(corners[i])) return { kind: 'corner', i };
      const own = w.tool().hitTest?.(p, tol);
      if (own) return own;
      // The line itself moves the whole calibration (not while adding ticks,
      // where a click on the line places one).
      const { start, end } = panel.colorbar;
      if (start && end && app.mode?.type !== 'tick') {
        const t = Math.min(1, Math.max(0, projectT(start, end, p)));
        const q = pointAtT(start, end, t);
        if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return { kind: 'bar', last: p };
      }
      return null;
    }

    function onHandleDrop(handle) {
      app.drag = null;
      w.tool().onHandleDrop?.(handle);
      // Re-detect the cell count after moving a corner unless the user set it by hand.
      const panel = w.activePanel();
      if (handle.kind === 'corner' && panel.grid.autoSize && !w.tool().plotArea) applyDetectedSize(panel, { onlyIfChanged: true });
      w.changed();
    }

    const SHARED_HANDLES = new Set(['corner', 'barStart', 'barEnd', 'bar', 'tick']);

    function onHandleDrag(handle, p, e) {
      if (!app.drag) {
        w.pushHistory();
        app.drag = handle;
      }
      const panel = w.activePanel();
      if (!SHARED_HANDLES.has(handle.kind)) {
        w.tool().onHandleDrag?.(handle, p, e);
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
        // "follow": ticks keep their relative position along the bar.
        // "fixed": they keep their distance from the end that is not dragged,
        // so lengthening the bar leaves them in place and rotating turns them
        // with it. Distances are taken once, at the start of the drag:
        // re-projecting the moved ticks on every event shrank them towards the
        // fixed end whenever the line turned.
        const fixed = $('bar-tick-mode').value === 'fixed';
        const len = () => Math.hypot(cb.end.x - cb.start.x, cb.end.y - cb.start.y);
        handle.ts ??= ticksWithT(cb).map((k) => k.t);
        handle.len ??= len();
        if (handle.kind === 'barStart') cb.start = q;
        else cb.end = q;
        const L = len() || 1e-9;
        const tAt = (t0) => (handle.kind === 'barEnd' ? (t0 * handle.len) / L : 1 - ((1 - t0) * handle.len) / L);
        // Ticks typed along a known colormap have no page point to move.
        cb.ticks.forEach((k, i) => Number.isFinite(k.x) && Object.assign(k, pointAtT(cb.start, cb.end, fixed ? tAt(handle.ts[i]) : handle.ts[i])));
      } else if (handle.kind === 'bar') {
        // Move the line and its ticks together, by the pointer's step since the last event.
        const cb = panel.colorbar;
        const dx = p.x - handle.last.x;
        const dy = p.y - handle.last.y;
        handle.last = p;
        for (const q of [cb.start, cb.end, ...cb.ticks.filter((k) => Number.isFinite(k.x))]) {
          q.x += dx;
          q.y += dy;
        }
      } else if (handle.kind === 'tick') {
        const cb = panel.colorbar;
        const k = cb.ticks.find((x) => x.id === handle.id);
        if (k) Object.assign(k, pointAtT(cb.start, cb.end, projectT(cb.start, cb.end, p)));
      }
      w.changed({ light: true });
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
      const panel = w.activePanel();
      const cell = panel.grid.corners ? cellAt(panel.grid, p) : null;
      setHoverCell(cell);
      $('status-cell').textContent = w.tool().hoverText?.(panel, cell, p) || '';
    }

    function setHoverCell(cell) {
      const same = cell && app.hoverCell && cell.row === app.hoverCell.row && cell.col === app.hoverCell.col;
      if (same || (!cell && !app.hoverCell)) return;
      app.hoverCell = cell;
      w.tool().onHoverCell?.(cell);
      w.viewer.requestDraw();
    }

    return { onClick, hitTest, onHandleDrag, onHandleDrop, onHover, applyDetectedSize, snapAxis };
  }

  Object.assign(CM, { setupWorkspaceInteract });
})((globalThis.Colormeris ??= {}));
