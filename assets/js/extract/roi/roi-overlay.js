(function (CM) {
  'use strict';
  const { roiInstances, shapeOutline, boxGeom, colorbarProblem, makeClassifier, boxLabel, roiControlPoints, roiFromLocal, metricValue, shortNumber } = CM;

  // ROI tool, DOM: what the tool draws over the image (regions with their
  // labels, edit handles, the scale bar, the signal mask, previews while
  // drawing) and the status-bar hover text. Set up by roi-tool.js.
  //
  // rctx: { ws, state, selectedRoi, roiColor, regionAt } (see roi-tool.js).
  function setupRoiOverlay(rctx) {
    const { ws, state } = rctx;

    function drawOverlay(ctx, v, panel) {
      if (state.showMask) drawMask(ctx, v, panel);
      const result = ws.resultFor(panel);
      const byInstance = new Map();
      if (!result.error) for (const r of result.rows) byInstance.set(`${r.roi.id}|${r.row},${r.col}`, r);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      for (const roi of panel.rois) {
        const color = rctx.roiColor(panel, roi);
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
      const sel = rctx.selectedRoi();
      if (sel) {
        const color = rctx.roiColor(panel, sel);
        for (const inst of roiInstances(sel, panel.grid)) {
          for (const q of roiControlPoints(sel)) ws.drawHandle(ctx, v, roiFromLocal(sel, panel.grid, inst.row, inst.col, q), color, sel.shape === 'polygon' ? 'circle' : 'square');
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
      const img = ws.app.imageData;
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
      const hit = rctx.regionAt(p);
      if (!hit) return box;
      const result = ws.resultFor(panel);
      const r = result.error ? null : result.rows.find((x) => x.roi === hit.roi && (hit.row === null || (x.row === hit.row && x.col === hit.col)));
      const where = box ? `${box} · ` : '';
      if (!r) return `${where}${hit.roi.name}`;
      const s = r.stats;
      return `${where}${hit.roi.name}: sum ${shortNumber(s.sum)} · mean ${shortNumber(s.mean)} · max ${shortNumber(s.max)} · signal ${s.signalPx}/${s.areaPx} px`;
    }

    return { drawOverlay, drawModePreview, hoverText };
  }

  Object.assign(CM, { setupRoiOverlay });
})((globalThis.Colormeris ??= {}));
