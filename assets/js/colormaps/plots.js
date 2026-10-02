(function (CM) {
  'use strict';

  // SVG plots of the colormap viewer: axes, line and dot series with a
  // hover guide, figures with captions, and the per-position profile of a map
  // (L*, chroma, hue, ΔE2000 steps) used by the detail view and Compare.
  function setupCmapPlots(ctx) {
    const { el, svgEl, viewData, metrics, rev, isRev, showTip, hideTip } = ctx;

    // The four plots sit in one row, each with a square plot box (as
    // matplotlib's set_box_aspect(1)): PH − M.t − M.b equals PW − M.l − M.r.
    const M = { l: 42, r: 12, t: 10, b: 34 };
    const PW = 240;
    const PH = PW - M.l - M.r + M.t + M.b;

    // A "nice" axis maximum and tick step for values from 0 to `max`.
    function niceAxis(max) {
      const pow = 10 ** Math.floor(Math.log10(Math.max(max, 1e-6) / 5));
      const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => max / s <= 5);
      const top = Math.ceil(max / step - 1e-9) * step;
      const ticks = [];
      for (let v = 0; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
      return { top, ticks };
    }

    function svgText(cls, attrs, str) {
      const t = svgEl('text', { class: cls, ...attrs });
      t.textContent = str;
      return t;
    }

    // Grid, ticks, frame and axis labels, shared by the single and the compare
    // plots. Returns the scales: x in 0–1, y in data units.
    function drawAxes(svg, { W, H, m, yMax, yTicks, xTicks, xLabel, yLabel }) {
      const px = (t) => m.l + t * (W - m.l - m.r);
      const py = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
      for (const v of yTicks) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: m.l, x2: W - m.r, y1: py(v), y2: py(v) }));
        svg.append(svgText('cmap-tick', { x: m.l - 6, y: py(v) + 3.5, 'text-anchor': 'end' }, String(v)));
      }
      for (const { x, label } of xTicks) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: px(x), x2: px(x), y1: m.t, y2: H - m.b }));
        svg.append(svgText('cmap-tick', { x: px(x), y: H - m.b + 14, 'text-anchor': 'middle' }, label));
      }
      svg.append(svgEl('rect', { class: 'cmap-axes', x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'none' }));
      svg.append(svgText('cmap-axis-label', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle' }, xLabel));
      svg.append(svgText('cmap-axis-label', { transform: `translate(11 ${(m.t + H - m.b) / 2}) rotate(-90)`, 'text-anchor': 'middle' }, yLabel));
      return { px, py };
    }

    // Segments in the sample colors, or dots. `halo` adds a mid-tone
    // outline so lines that cross stay readable.
    function drawSeries(parent, { points, mode, dotR, halo }, px, py) {
      if (mode === 'line') {
        const segs = [];
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i];
          const b = points[i + 1];
          if (a.y == null || b.y == null) continue;
          segs.push({ x1: px(a.x), y1: py(a.y), x2: px(b.x), y2: py(b.y), color: CM.rgbToHex(a.color) });
        }
        if (halo) for (const { color, ...xy } of segs) parent.append(svgEl('line', { class: 'cmap-halo', ...xy }));
        for (const { color, ...xy } of segs) parent.append(svgEl('line', { class: 'cmap-seg', ...xy, stroke: color }));
      } else {
        const cls = dotR > 3 ? 'cmap-dot' : halo ? 'cmap-pt cmap-pt-halo' : 'cmap-pt';
        for (const p of points) {
          if (p.y == null) continue;
          parent.append(svgEl('circle', { class: cls, cx: px(p.x), cy: py(p.y), r: dotR, fill: CM.rgbToHex(p.color) }));
        }
      }
    }

    // Line or dot plot of one quantity against position (0–1).
    //   points  [{ x, y (null = skip), color: rgb, pos, value }]  value is the tooltip line
    //   mode    'line' (segments in the sample colors) or 'dots'
    //   ref     optional dashed line { x1, y1, x2, y2, label }
    //   W, H    size; the defaults give a square plot box (the detail view
    //           passes a smaller, still square one)
    function linePlot({ map, title, yLabel, xLabel = 'Position', yMax, yTicks, xTicks, points, mode, ref, dotR = 3, W = PW, H = PH }) {
      const svg = svgEl('svg', {
        class: 'cmap-plot', viewBox: `0 0 ${W} ${H}`, role: 'img',
        'aria-label': `${title} of ${map.name} against position`,
      });
      const { px, py } = drawAxes(svg, { W, H, m: M, yMax, yTicks, xTicks, xLabel, yLabel });

      if (ref) {
        svg.append(svgEl('line', { class: 'cmap-linear', x1: px(ref.x1), y1: py(ref.y1), x2: px(ref.x2), y2: py(ref.y2) }));
        const low = ref.y2 > yMax / 2;
        svg.append(svgText('cmap-linear-label', { x: px(ref.x2) - 4, y: py(ref.y2) + (low ? 14 : -6), 'text-anchor': 'end' }, ref.label));
      }
      drawSeries(svg, { points, mode, dotR }, px, py);
      const guide = svgEl('line', { class: 'cmap-guide', y1: M.t, y2: H - M.b, visibility: 'hidden' });
      svg.append(guide);

      svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width * W - M.l) / (W - M.l - M.r);
        let p = points[0];
        for (const q of points) if (Math.abs(q.x - x) < Math.abs(p.x - x)) p = q;
        guide.setAttribute('x1', px(p.x));
        guide.setAttribute('x2', px(p.x));
        guide.setAttribute('visibility', 'visible');
        const hex = CM.rgbToHex(p.color);
        showTip({
          hex, title: `${map.name} · ${title}`,
          text: [hex, `rgb(${p.color[0]}, ${p.color[1]}, ${p.color[2]})`, p.pos, p.value],
        }, e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', () => { guide.setAttribute('visibility', 'hidden'); hideTip(); });
      return svg;
    }

    // `compact` puts the caption in a tooltip on the title, to keep plots short.
    function figure(title, svg, caption, { compact = false } = {}) {
      const fig = el('div', { class: 'cmap-fig' });
      const head = el('div', { class: 'cmap-fig-title' }, title);
      // Center the title over the x axis, not the whole plot: pad by the
      // plot margins as a share of the width (the svg fills the figure).
      const W = svg.viewBox?.baseVal?.width;
      if (W) {
        head.style.paddingLeft = `${(M.l / W) * 100}%`;
        head.style.paddingRight = `${(M.r / W) * 100}%`;
      }
      fig.append(head, svg);
      if (caption && compact) {
        head.title = caption;
        head.append(el('span', { class: 'cmap-fig-info', 'aria-hidden': 'true' }, ' ⓘ'));
        svg.setAttribute('aria-description', caption);
        // The same tooltip when hovering the plot itself, not only its title.
        const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        tip.textContent = caption;
        svg.prepend(tip);
      } else if (caption) {
        fig.append(el('div', { class: 'cmap-fig-cap muted' }, caption));
      }
      return fig;
    }

    const POS_TICKS = [0, 0.25, 0.5, 0.75, 1].map((x) => ({ x, label: String(x) }));

    // Per-position values of one map (in the current direction) and a point
    // builder shared by the single plots and the comparison plot.
    function profile(map, reversed = isRev(map)) {
      const colors = viewData(map, 'orig', reversed).colors;
      const Ls = viewData(map, 'orig', reversed).L;
      const m = metrics(map);
      const C = rev(m.lch.C, reversed);
      const h = rev(m.lch.h, reversed);
      const n = colors.length;
      const qual = map.kind === 'qualitative';
      const xOf = (i) => (n > 1 ? i / (n - 1) : 0.5);
      const posOf = (i) => (qual ? `color ${i + 1} of ${n}` : `t = ${xOf(i).toFixed(3)}`);
      const pts = (ys, fmt, skip) => colors.map((c, i) => ({
        x: xOf(i), y: skip && skip(i) ? null : ys[i], color: c, pos: posOf(i), value: fmt(ys[i]),
      }));
      return { colors, Ls, m, C, h, n, qual, xOf, pts, reversed };
    }

    // ΔE2000 between neighbors, one point per step, in the color at its middle.
    function stepPoints(map, { colors, n, reversed }) {
      const steps = rev(metrics(map).steps, reversed);
      const k = steps.length;
      return steps.map((v, i) => {
        const t = (i + 0.5) / k;
        return {
          x: t, y: v, color: colors[Math.round(t * (n - 1))],
          pos: `t = ${(i / k).toFixed(3)}–${((i + 1) / k).toFixed(3)}`, value: `ΔE2000 = ${v.toFixed(2)}`,
        };
      });
    }

    const HUE_MIN_CHROMA = 5;

    return { M, PW, PH, niceAxis, drawAxes, drawSeries, linePlot, figure, POS_TICKS, profile, stepPoints, HUE_MIN_CHROMA };
  }

  Object.assign(CM, { setupCmapPlots });
})((globalThis.Colormeris ??= {}));
