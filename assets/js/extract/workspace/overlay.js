(function (CM) {
  'use strict';
  const { bilinear, rectCorners, pointAtT, projectT } = CM;

  // What the workspace draws over the image: grids, colorbars with their
  // ticks, handles and rubber bands while placing. Tools draw their own parts
  // through the drawUnderGrid / drawOverGrid / drawOverlay / drawModePreview hooks.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (activePanel, pagePanels, snapAxis).
  function setupWorkspaceOverlay(w) {
    const { app } = w;

    function strokeDual(ctx, color, width, dash) {
      ctx.setLineDash(dash || []);
      ctx.lineWidth = width + 2;
      ctx.strokeStyle = w.COLORS.outline;
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
      w.tool().drawUnderGrid?.(ctx, v, panel, active);

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
      ctx.strokeStyle = w.COLORS.grid;
      ctx.stroke();
      ctx.globalAlpha /= 0.8;

      w.tool().drawOverGrid?.(ctx, v, panel, active);
      polyPath(ctx, v, c);
      strokeDual(ctx, w.COLORS.grid, 2);

      const hl = active && (app.tableCell || app.hoverCell);
      if (hl && hl.row < g.rows && hl.col < g.cols) {
        const corners = [
          bilinear(c, hl.col / g.cols, hl.row / g.rows),
          bilinear(c, (hl.col + 1) / g.cols, hl.row / g.rows),
          bilinear(c, (hl.col + 1) / g.cols, (hl.row + 1) / g.rows),
          bilinear(c, hl.col / g.cols, (hl.row + 1) / g.rows),
        ];
        polyPath(ctx, v, corners);
        strokeDual(ctx, w.COLORS.highlight, 2);
      }

      if (active) c.forEach((q) => drawHandle(ctx, v, q, w.COLORS.grid));
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
        const hw = cb.halfWidth * v.scale;
        ctx.beginPath();
        ctx.moveTo(a.x + nx * hw, a.y + ny * hw);
        ctx.lineTo(b.x + nx * hw, b.y + ny * hw);
        ctx.moveTo(a.x - nx * hw, a.y - ny * hw);
        ctx.lineTo(b.x - nx * hw, b.y - ny * hw);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(242,153,0,0.7)';
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      strokeDual(ctx, w.COLORS.bar, 2);

      if (!active) return;
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const k of cb.ticks) {
        const s = v.toScreen(k);
        ctx.beginPath();
        ctx.moveTo(s.x - nx * 12, s.y - ny * 12);
        ctx.lineTo(s.x + nx * 12, s.y + ny * 12);
        strokeDual(ctx, w.COLORS.bar, 2);
        drawHandle(ctx, v, k, w.COLORS.bar, 'circle');
        const label = Number.isFinite(k.value) ? tickLabel(k.value) : '?';
        const lx = s.x + nx * 18 + (nx >= 0 ? 0 : -ctx.measureText(label).width);
        const ly = s.y + ny * 18;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, lx, ly);
      }
      drawHandle(ctx, v, cb.start, w.COLORS.bar);
      drawHandle(ctx, v, cb.end, w.COLORS.bar);
    }

    // Compact tick text: 1.4e9 rather than 1400000000.
    function tickLabel(v) {
      const a = Math.abs(v);
      return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential().replace('e+', 'e') : String(v);
    }

    function drawOverlay(ctx, v) {
      if (app.showOverlay) {
        const active = w.activePanel();
        for (const panel of w.pagePanels()) {
          if (panel === active) continue;
          ctx.globalAlpha = 0.35;
          drawGrid(ctx, v, panel, false);
          drawColorbar(ctx, v, panel, false);
        }
        ctx.globalAlpha = 1;
        drawGrid(ctx, v, active, true);
        drawColorbar(ctx, v, active, true);
        w.tool().drawOverlay?.(ctx, v, active, w.pagePanels());
      }

      // Rubber band while placing.
      const m = app.mode;
      const hover = v.hover?.img;
      if (m && m.points.length === 1 && hover) {
        const a = m.points[0];
        if (m.type === 'grid') {
          polyPath(ctx, v, rectCorners(a, hover));
          strokeDual(ctx, w.COLORS.grid, 1.5, [6, 4]);
        } else if (m.type === 'colorbar') {
          const b = w.snapAxis(a, hover);
          const sa = v.toScreen(a);
          const sb = v.toScreen(b);
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.lineTo(sb.x, sb.y);
          strokeDual(ctx, w.COLORS.bar, 1.5, [6, 4]);
        }
      }
      if (m) w.tool().drawModePreview?.(ctx, v, m, hover);
      if (m && hover && m.type === 'tick') {
        const cb = w.activePanel().colorbar;
        const q = v.toScreen(pointAtT(cb.start, cb.end, projectT(cb.start, cb.end, hover)));
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
        strokeDual(ctx, w.COLORS.bar, 1.5, [3, 3]);
      }
    }

    return { strokeDual, polyPath, drawHandle, drawOverlay };
  }

  Object.assign(CM, { setupWorkspaceOverlay });
})((globalThis.Colormeris ??= {}));
