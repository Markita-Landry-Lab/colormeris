(function (CM) {
  'use strict';

  // The colormap viewer page (colormaps.html). Every colormap is shown as five
  // vector SVG strips (as seen, three color-vision-deficiency simulations,
  // grayscale), with hover values and an expandable plot set. The data comes
  // from cmap-data.js, so the page needs no fetch and works from file://.

  const SECTIONS = [
    ['sequential', 'Sequential'],
    ['diverging', 'Diverging'],
    ['cyclic', 'Cyclic'],
    ['rainbow', 'Rainbow'],
    ['others', 'Others'],
  ];
  const VIEWS = [
    { key: 'orig', label: 'Colormap' },
    { key: 'protanopia', label: 'Protanopia' },
    { key: 'deuteranopia', label: 'Deuteranopia' },
    { key: 'tritanopia', label: 'Tritanopia' },
    { key: 'gray', label: 'Grayscale' },
  ];
  const SORTS = [
    ['default', 'Default order'],
    ['name', 'Name'],
    ['uniform', 'Most uniform'],
    ['cvd', 'Most CVD-safe'],
    ['gray', 'Most grayscale-safe'],
    ['linear', 'Most linear L*'],
    ['readable', 'Most readable'],
  ];
  // [id, label, hint, key in rating]
  const FILTERS = [
    ['uniform', 'Uniform', 'Only colormaps rated uniform', 'uniform'],
    ['cvd', 'CVD-safe', 'Only colormaps rated CVD-safe', 'cvdSafe'],
    ['gray', 'Gray-safe', 'Only colormaps rated grayscale-safe', 'graySafe'],
    ['readable', 'Readable', 'Only colormaps rated readable (values can be read back from the colors)', 'readable'],
  ];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Hex colors 'rrggbb' packed in one string -> [[r,g,b], …].
  function unpack(str) {
    const out = [];
    for (let i = 0; i + 6 <= str.length; i += 6) {
      out.push([0, 2, 4].map((k) => parseInt(str.slice(i + k, i + k + 2), 16)));
    }
    return out;
  }

  const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const roundRgb = (rgb) => rgb.map(clamp8);

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    if (text != null) e.textContent = text;
    return e;
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }

  function setupColormapViewer(root) {
    const data = CM.cmapData;
    if (!data) throw new Error('cmap-data.js did not load');

    let reversed = false;
    let uid = 0;
    const cache = new Map(); // `${name}|${reversed}` -> { view key -> { colors, L } }
    const baseOf = new Map(); // name -> original colors, unpacked once
    const items = []; // { map, item, strips: [el], panel, open }
    const mapByName = new Map(data.maps.map((m) => [m.name, m]));
    // Maps chosen for comparison, in the order they were added. Lives in ?compare=.
    const selected = CM.parseCompare(new URLSearchParams(location.search).get('compare'), data.maps.map((m) => m.name));
    let cmpSort = null; // { id, dir } for the numbers table; null = selection order

    // ---- colors per view (computed once per map and direction) ----

    function base(map) {
      if (!baseOf.has(map.name)) baseOf.set(map.name, unpack(map.colors));
      return baseOf.get(map.name);
    }

    function viewData(map, view) {
      const key = `${map.name}|${reversed}`;
      let entry = cache.get(key);
      if (!entry) {
        let orig = base(map);
        if (reversed) orig = orig.slice().reverse();
        entry = { orig: { colors: orig } };
        for (const type of CM.CVD_TYPES) entry[type] = { colors: orig.map((c) => roundRgb(CM.simulateCvd(c, type))) };
        entry.gray = { colors: orig.map((c) => roundRgb(CM.grayscale(c))) };
        cache.set(key, entry);
      }
      const v = entry[view];
      if (!v.L) v.L = v.colors.map((c) => CM.lightness(c));
      return v;
    }

    // ---- strips ----

    function stripSvg(colors, qualitative) {
      const n = colors.length;
      const hex = (c) => CM.rgbToHex(c);
      let inner;
      if (qualitative) {
        inner = colors.map((c, i) => `<rect x="${i}" width="1" height="1" fill="${hex(c)}" shape-rendering="crispEdges"/>`).join('');
      } else {
        const id = `cmg${++uid}`;
        const stops = colors.map((c, i) => `<stop offset="${(i / (n - 1)).toFixed(5)}" stop-color="${hex(c)}"/>`).join('');
        inner = `<defs><linearGradient id="${id}">${stops}</linearGradient></defs><rect width="${n}" height="1" fill="url(#${id})"/>`;
      }
      return `<svg viewBox="0 0 ${n} 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">${inner}</svg>`;
    }

    function renderStrip(strip) {
      const { map, view } = strip._cm;
      const svg = strip.querySelector('svg');
      if (svg) svg.remove();
      strip.insertAdjacentHTML('afterbegin', stripSvg(viewData(map, view).colors, map.kind === 'qualitative'));
      strip._cm.rendered = true;
    }

    // Build strips only when they come near the viewport: 87 maps x 5 strips.
    const observer = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          renderStrip(e.target);
        }
      }, { rootMargin: '400px 0px' })
      : null;

    // `eager` renders at once: the comparison panel rebuilds its few strips often.
    function makeStrip(map, view, eager = false) {
      const strip = el('div', {
        class: 'cmap-strip',
        tabindex: '0',
        role: 'img',
        'aria-label': `${map.name} ${view.label}`,
      });
      strip._cm = { map, view: view.key, rendered: false, probe: null };
      strip.append(el('div', { class: 'cmap-marker', hidden: '' }));
      if (observer && !eager) observer.observe(strip);
      else renderStrip(strip);
      return strip;
    }

    // ---- shared tooltip ----

    const tip = el('div', { class: 'cmap-tip', role: 'tooltip', hidden: '' });
    const tipSwatch = el('span', { class: 'cmap-tip-swatch' });
    const tipTitle = el('div', { class: 'cmap-tip-title' });
    const tipLines = el('div', { class: 'cmap-tip-lines' });
    const tipCopied = el('div', { class: 'cmap-tip-copied', hidden: '' }, 'Copied');
    const tipHead = el('div', { class: 'cmap-tip-head' });
    tipHead.append(tipSwatch, tipTitle);
    tip.append(tipHead, tipLines, tipCopied);
    document.body.append(tip);
    let copiedTimer = 0;
    let tipMarker = null; // marker element to hide with the tooltip

    function tipInfo(map, viewLabel, colors, Ls, i) {
      const n = colors.length;
      const c = colors[i];
      const hex = CM.rgbToHex(c);
      const pos = map.kind === 'qualitative' ? `color ${i + 1} of ${n}` : `t = ${(n > 1 ? i / (n - 1) : 0).toFixed(3)}`;
      return { hex, c, text: [hex, `rgb(${c[0]}, ${c[1]}, ${c[2]})`, pos, `L* = ${Ls[i].toFixed(1)}`], title: `${map.name} · ${viewLabel}` };
    }

    function placeTip(x, y) {
      // Measure first, then keep the tooltip fully inside the viewport.
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      let left = x + 14;
      let top = y + 16;
      if (left + w > vw - 4) left = x - w - 14;
      if (top + h > vh - 4) top = y - h - 12;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, top)}px`;
    }

    function showTip(info, x, y) {
      tip.hidden = false;
      tipSwatch.style.background = info.hex;
      tipTitle.textContent = info.title;
      tipLines.replaceChildren(...info.text.map((t, k) => el('div', { class: k === 0 ? 'cmap-tip-hex' : '' }, t)));
      tipCopied.hidden = true;
      placeTip(x, y);
    }

    function hideTip() {
      tip.hidden = true;
      if (tipMarker) tipMarker.hidden = true;
      tipMarker = null;
    }

    function flashCopied() {
      tipCopied.hidden = false;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { tipCopied.hidden = true; }, 1200);
    }

    // ---- strip interaction (delegated) ----

    function indexAt(strip, clientX) {
      const r = strip.getBoundingClientRect();
      const n = viewData(strip._cm.map, strip._cm.view).colors.length;
      const f = r.width ? (clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(n - 1, Math.floor(f * n)));
    }

    function probe(strip, i, x, y) {
      const { map, view } = strip._cm;
      const label = VIEWS.find((v) => v.key === view).label;
      const vd = viewData(map, view);
      const marker = strip.querySelector('.cmap-marker');
      if (tipMarker && tipMarker !== marker) tipMarker.hidden = true;
      tipMarker = marker;
      marker.hidden = false;
      marker.style.left = `${((i + 0.5) / vd.colors.length) * 100}%`;
      strip._cm.probe = i;
      const info = tipInfo(map, label, vd.colors, vd.L, i);
      strip._cm.lastHex = info.hex;
      showTip(info, x, y);
    }

    root.addEventListener('pointermove', (e) => {
      const strip = e.target.closest?.('.cmap-strip');
      if (!strip || !strip._cm.rendered) { if (!e.target.closest?.('.cmap-plot')) hideTip(); return; }
      probe(strip, indexAt(strip, e.clientX), e.clientX, e.clientY);
    });
    root.addEventListener('pointerleave', hideTip);
    root.addEventListener('click', (e) => {
      const strip = e.target.closest?.('.cmap-strip');
      if (!strip) return;
      const i = indexAt(strip, e.clientX);
      probe(strip, i, e.clientX, e.clientY);
      copy(strip._cm.lastHex);
    });

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        flashCopied();
      } catch (err) {
        console.warn('Could not copy', err);
      }
    }

    // Keyboard probe: arrows move by one sample, Shift by ten, Home/End jump.
    root.addEventListener('keydown', (e) => {
      const strip = e.target.closest?.('.cmap-strip');
      if (!strip || e.target !== strip) return;
      const n = viewData(strip._cm.map, strip._cm.view).colors.length;
      let i = strip._cm.probe ?? (e.key === 'ArrowLeft' ? n : -1);
      if (e.key === 'ArrowRight') i += e.shiftKey ? 10 : 1;
      else if (e.key === 'ArrowLeft') i -= e.shiftKey ? 10 : 1;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if ((e.key === 'Enter' || e.key === 'c') && strip._cm.lastHex) { copy(strip._cm.lastHex); return; }
      else return;
      e.preventDefault();
      i = Math.max(0, Math.min(n - 1, i));
      const r = strip.getBoundingClientRect();
      probe(strip, i, r.left + ((i + 0.5) / n) * r.width, r.bottom - 12);
    });
    root.addEventListener('focusout', (e) => {
      if (e.target.closest?.('.cmap-strip')) hideTip();
    });

    // ---- metrics (computed once per map, on the original colors) ----

    const metricsOf = new Map();
    function metrics(map) {
      let m = metricsOf.get(map.name);
      if (!m) {
        m = CM.colormapMetrics(base(map), { kind: map.kind, cyclic: map.group === 'cyclic' });
        metricsOf.set(map.name, m);
      }
      return m;
    }

    const rev = (a) => (reversed ? a.slice().reverse() : a);

    // Smallest separation in one view, with positions that follow Reversed.
    function sepOf(map, key) {
      const s = metrics(map).separations[key];
      if (!s || !reversed) return s;
      if (map.kind === 'qualitative') {
        const n = base(map).length;
        return { min: s.min, t: [n - 1 - s.t[1], n - 1 - s.t[0]] };
      }
      return { min: s.min, t: [1 - s.t[1], 1 - s.t[0]] };
    }

    // ---- plots ----

    // The four plots sit in one row, each with a square plot box (as
    // matplotlib's set_box_aspect(1)): PH − M.t − M.b equals PW − M.l − M.r.
    const M = { l: 42, r: 12, t: 10, b: 34 };
    const PW = 240;
    const PH = PW - M.l - M.r + M.t + M.b;
    const px = (t) => M.l + t * (PW - M.l - M.r);

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
    function linePlot({ map, title, yLabel, xLabel = 'Position', yMax, yTicks, xTicks, points, mode, ref, dotR = 3 }) {
      const svg = svgEl('svg', {
        class: 'cmap-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img',
        'aria-label': `${title} of ${map.name} against position`,
      });
      const { py } = drawAxes(svg, { W: PW, H: PH, m: M, yMax, yTicks, xTicks, xLabel, yLabel });

      if (ref) {
        svg.append(svgEl('line', { class: 'cmap-linear', x1: px(ref.x1), y1: py(ref.y1), x2: px(ref.x2), y2: py(ref.y2) }));
        const low = ref.y2 > yMax / 2;
        svg.append(svgText('cmap-linear-label', { x: px(ref.x2) - 4, y: py(ref.y2) + (low ? 14 : -6), 'text-anchor': 'end' }, ref.label));
      }
      drawSeries(svg, { points, mode, dotR }, px, py);
      const guide = svgEl('line', { class: 'cmap-guide', y1: M.t, y2: PH - M.b, visibility: 'hidden' });
      svg.append(guide);

      svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width * PW - M.l) / (PW - M.l - M.r);
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

    function figure(title, svg, caption) {
      const fig = el('div', { class: 'cmap-fig' });
      fig.append(el('div', { class: 'cmap-fig-title' }, title), svg);
      if (caption) fig.append(el('div', { class: 'cmap-fig-cap muted' }, caption));
      return fig;
    }

    const POS_TICKS = [0, 0.25, 0.5, 0.75, 1].map((x) => ({ x, label: String(x) }));

    // Per-position values of one map (in the current direction) and a point
    // builder shared by the single plots and the comparison plot.
    function profile(map) {
      const colors = viewData(map, 'orig').colors;
      const Ls = viewData(map, 'orig').L;
      const m = metrics(map);
      const C = rev(m.lch.C);
      const h = rev(m.lch.h);
      const n = colors.length;
      const qual = map.kind === 'qualitative';
      const xOf = (i) => (n > 1 ? i / (n - 1) : 0.5);
      const posOf = (i) => (qual ? `color ${i + 1} of ${n}` : `t = ${xOf(i).toFixed(3)}`);
      const pts = (ys, fmt, skip) => colors.map((c, i) => ({
        x: xOf(i), y: skip && skip(i) ? null : ys[i], color: c, pos: posOf(i), value: fmt(ys[i]),
      }));
      return { colors, Ls, m, C, h, n, qual, xOf, pts };
    }

    // ΔE2000 between neighbors, one point per step, in the color at its middle.
    function stepPoints(map, { colors, n }) {
      const steps = rev(metrics(map).steps);
      const k = steps.length;
      return steps.map((v, i) => {
        const t = (i + 0.5) / k;
        return {
          x: t, y: v, color: colors[Math.round(t * (n - 1))],
          pos: `t = ${(i / k).toFixed(3)}–${((i + 1) / k).toFixed(3)}`, value: `ΔE2000 = ${v.toFixed(2)}`,
        };
      });
    }

    function buildPlots(map) {
      const { colors, Ls, m, C, h, n, qual, xOf, pts } = profile(map);
      const mode = qual ? 'dots' : 'line';
      const dotR = qual ? 4.5 : 1.8;
      let xTicks = POS_TICKS;
      let xLabel = 'Position';
      if (qual) {
        const every = Math.ceil(n / 10);
        xTicks = [];
        for (let i = 0; i < n; i += every) xTicks.push({ x: xOf(i), label: String(i + 1) });
        xLabel = 'Color number';
      }
      const grid = el('div', { class: 'cmap-plots' });

      const lin = qual ? null : { x1: 0, y1: Ls[0], x2: 1, y2: Ls[n - 1], label: 'linear' };
      grid.append(figure('Lightness L*', linePlot({
        map, title: 'Lightness L*', yLabel: 'L*', yMax: 100, yTicks: [0, 20, 40, 60, 80, 100], xTicks, xLabel,
        points: pts(Ls, (v) => `L* = ${v.toFixed(1)}`), mode, ref: lin, dotR,
      })));

      if (!qual) {
        const stepPts = stepPoints(map, { colors, n });
        const k = stepPts.length;
        const axis = niceAxis(Math.max(...stepPts.map((p) => p.y)) * 1.05);
        const mean = m.stepStats.mean;
        grid.append(figure('Perceptual step ΔE2000', linePlot({
          map, title: 'Perceptual step ΔE2000', yLabel: `ΔE2000 per 1/${k} step`, yMax: axis.top, yTicks: axis.ticks, xTicks,
          points: stepPts, mode: 'line', ref: { x1: 0, y1: mean, x2: 1, y2: mean, label: 'mean' },
        }), 'A flat line means equal steps in the data look like equal steps in color.'));
      }

      const cAxis = niceAxis(Math.max(100, Math.max(...C) * 1.05));
      grid.append(figure('Chroma C*', linePlot({
        map, title: 'Chroma C*', yLabel: 'C*', yMax: cAxis.top, yTicks: cAxis.ticks, xTicks, xLabel,
        points: pts(C, (v) => `C* = ${v.toFixed(1)}`), mode, dotR,
      })));

      grid.append(figure('Hue h°', linePlot({
        map, title: 'Hue h°', yLabel: 'h (°)', yMax: 360, yTicks: [0, 90, 180, 270, 360], xTicks, xLabel,
        points: pts(h, (v) => `h = ${v.toFixed(0)}°`, (i) => C[i] < HUE_MIN_CHROMA), mode: 'dots', dotR: qual ? 4.5 : 1.8,
      }), `Hue wraps around at 360°, so it is drawn as dots. Colors with C* < ${HUE_MIN_CHROMA} (grays) are left out, since their hue is not defined.`));
      return grid;
    }

    const HUE_MIN_CHROMA = 5;

    // Table of the smallest differences, one row per view.
    function sepTable(entry) {
      const { map } = entry;
      const qual = map.kind === 'qualitative';
      const m = metrics(map);
      const table = el('table', { class: 'cmap-sep' });
      table.append(el('caption', {}, qual ? 'Smallest difference between any two colors' : 'Smallest difference between values at least 10% apart'));
      const head = el('tr');
      for (const t of ['View', 'Min', 'Between', 'Confused colors']) head.append(el('th', { scope: 'col' }, t));
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      const tbody = el('tbody');
      const cvdKeys = CM.CVD_TYPES;
      const worst = cvdKeys.reduce((a, b) => (m.separations[b].min < m.separations[a].min ? b : a), cvdKeys[0]);
      VIEWS.forEach((v, vi) => {
        const s = sepOf(map, v.key);
        if (!s) return;
        const colors = viewData(map, v.key).colors;
        const n = colors.length;
        const idx = s.t.map((t) => (qual ? t : Math.round(t * (n - 1))));
        const tr = el('tr', v.key === worst ? { class: 'worst' } : {});
        const th = el('th', { scope: 'row' }, v.label);
        if (v.key === worst) th.append(el('span', { class: 'cmap-worst-tag' }, ' lowest'));
        tr.append(th);
        tr.append(el('td', {}, `${s.min.toFixed(1)} ${v.key === 'gray' ? 'ΔL*' : 'ΔE'}`));
        tr.append(el('td', {}, qual ? `color ${s.t[0] + 1} ↔ ${s.t[1] + 1}` : `${s.t[0].toFixed(2)} ↔ ${s.t[1].toFixed(2)}`));
        const sw = el('td', { class: 'cmap-sep-sw' });
        for (const i of idx) {
          const hex = CM.rgbToHex(colors[i]);
          sw.append(el('span', { class: 'cmap-sw', style: `background:${hex}`, title: hex }));
        }
        tr.append(sw);
        tr.addEventListener('pointerenter', () => showPair(entry.strips[vi], s.t, qual, n));
        tr.addEventListener('pointerleave', () => clearPair(entry.strips[vi]));
        tbody.append(tr);
      });
      table.append(tbody);
      return table;
    }

    // Two marker lines on a strip at the positions of a confused pair.
    function showPair(strip, ts, qual, n) {
      clearPair(strip);
      for (const t of ts) {
        const f = qual ? (t + 0.5) / n : t;
        const mk = el('div', { class: 'cmap-marker cmap-pair' });
        mk.style.left = `${Math.min(f * 100, 99.6)}%`;
        strip.append(mk);
      }
    }

    function clearPair(strip) {
      for (const mk of strip.querySelectorAll('.cmap-pair')) mk.remove();
    }

    function statsList(map) {
      const vd = viewData(map, 'orig');
      const s = CM.lightnessStats(vd.L);
      const ul = el('ul', { class: 'cmap-stats' });
      const add = (label, value) => {
        const li = el('li');
        li.append(el('span', { class: 'muted' }, `${label}: `), el('strong', {}, value));
        ul.append(li);
      };
      if (map.kind === 'qualitative') {
        add('L* range', `${s.range[0].toFixed(0)}–${s.range[1].toFixed(0)}`);
        ul.append(el('li', { class: 'muted' }, 'Qualitative colors have no order, so monotonicity, linearity and steps do not apply.'));
        return ul;
      }
      const st = metrics(map).stepStats;
      add('Monotonic', `${s.monotonic ? 'yes' : 'no'} (${s.reversals} reversal${s.reversals === 1 ? '' : 's'})`);
      add('Linearity R² (line fit)', s.r2 == null ? '— (flat)' : s.r2.toFixed(3));
      add('Max deviation from linear', `${s.maxDev.toFixed(1)} L*`);
      add('L* range', `${s.range[0].toFixed(0)}–${s.range[1].toFixed(0)}`);
      add('Steps', `mean ΔE ${st.mean.toFixed(2)}, max ${st.max.toFixed(2)}, variation CV ${st.cv.toFixed(2)}`);
      return ul;
    }

    // Spans are on the original map; flip them with the Reversed toggle.
    const spansOf = (spans) => (reversed ? spans.map(([a, b]) => [1 - b, 1 - a]).reverse() : spans);

    function readTable(map) {
      const r = metrics(map).readability;
      const table = el('table', { class: 'cmap-sep' });
      table.append(el('caption', {}, `Differences under ${CM.READ_DE} ΔE (ΔL* for grayscale) are too small to rely on when reading values back`));
      const head = el('tr');
      for (const t of ['View', 'Distinguishable levels', 'Flat zones', 'Ambiguous']) head.append(el('th', { scope: 'col' }, t));
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      for (const v of VIEWS) {
        const x = r[v.key];
        const tr = el('tr');
        tr.append(el('th', { scope: 'row' }, v.label));
        for (const t of [String(x.levels), pct(x.flat), pct(x.ambiguous)]) tr.append(el('td', {}, t));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      return table;
    }

    // The strip with two thin tracks below it: where values are flat, and where
    // a color has a look-alike elsewhere. Positions are percentages, so it scales.
    function readTracks(map, viewKey) {
      const r = metrics(map).readability[viewKey];
      const box = el('div', { class: 'cmap-tracks' });
      const strip = el('div', { class: 'cmap-track-strip', role: 'img', 'aria-label': `${map.name} ${VIEWS.find((v) => v.key === viewKey).label}` });
      strip.innerHTML = stripSvg(viewData(map, viewKey).colors, false);
      const track = (label, cls, spans, what) => {
        box.append(el('span', { class: 'cmap-track-label' }, label));
        const t = el('div', { class: `cmap-track ${cls}`, role: 'img', 'aria-label': spans.length ? `${label}: ${spans.map(([a, b]) => `${a.toFixed(2)} to ${b.toFixed(2)}`).join(', ')}` : `${label}: none` });
        for (const [a, b] of spans) {
          const s = el('span', { title: `${what}: t = ${a.toFixed(2)}–${b.toFixed(2)}` });
          s.style.left = `${a * 100}%`;
          s.style.width = `${(b - a) * 100}%`;
          t.append(s);
        }
        box.append(t);
      };
      box.append(el('span'), strip);
      track('Flat', 'flat', spansOf(r.flatSpans), 'Flat');
      track('Ambiguous', 'ambiguous', spansOf(r.ambiguousSpans), 'Look-alike elsewhere');
      return box;
    }

    function readBlock(entry) {
      const { map } = entry;
      const sec = el('div', { class: 'cmap-read' });
      sec.append(el('h4', {}, 'Reading values back'));
      if (map.kind === 'qualitative') {
        sec.append(el('p', { class: 'muted' }, 'This does not apply to qualitative colormaps, since their colors have no order.'));
        return sec;
      }
      sec.append(readTable(map));
      const tabs = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': 'View for the zones' });
      const holder = el('div');
      const show = () => holder.replaceChildren(readTracks(map, entry.readView));
      for (const v of VIEWS) {
        const b = el('button', { type: 'button', 'aria-pressed': String(v.key === entry.readView) }, v.label);
        b.addEventListener('click', () => {
          entry.readView = v.key;
          for (const x of tabs.children) x.setAttribute('aria-pressed', String(x === b));
          show();
        });
        tabs.append(b);
      }
      show();
      sec.append(tabs, holder);
      sec.append(el('p', { class: 'cmap-fig-cap muted' }, `Flat: values ${pct(CM.READ_WINDOW)} of the range apart look almost the same. Ambiguous: the color also appears at a value at least 10% away, so it could mean either.`));
      return sec;
    }

    function fillPanel(entry) {
      for (const s of entry.strips) clearPair(s);
      entry.panel.replaceChildren(buildPlots(entry.map), statsList(entry.map), sepTable(entry), readBlock(entry));
    }

    function toggle(entry, open = !entry.open) {
      if (open === entry.open) return;
      entry.open = open;
      entry.button.setAttribute('aria-expanded', String(entry.open));
      entry.panel.hidden = !entry.open;
      if (entry.open) fillPanel(entry);
      else entry.panel.replaceChildren();
    }

    // ---- ratings ----

    const WORD = { yes: 'yes', partly: 'partly', no: 'no' };
    const GLYPH = { yes: '✓', partly: '~', no: '✕' };

    function ratingPills(map) {
      const m = metrics(map);
      const qual = map.kind === 'qualitative';
      const worst = CM.CVD_TYPES.reduce((a, b) => (m.separations[b].min < m.separations[a].min ? b : a), CM.CVD_TYPES[0]);
      const g = m.separations.gray;
      const pills = [];
      if (!qual) {
        pills.push(['Uniform', m.rating.uniform,
          `Perceptually uniform: ${m.rating.uniform}. ΔE2000 steps vary by ${Math.round(m.stepStats.cv * 100)}% (CV ${m.stepStats.cv.toFixed(2)}).`]);
      }
      pills.push(['CVD', m.rating.cvdSafe,
        `CVD-safe: ${m.rating.cvdSafe}. Worst view (${worst}) keeps ${Math.round(m.cvdRatio * 100)}% of the separation (min ΔE ${m.cvdWorst.toFixed(1)}).`]);
      pills.push(['Gray', m.rating.graySafe,
        `Grayscale-safe: ${m.rating.graySafe}. ${qual ? 'Two colors differ' : 'Two values 10% apart differ'} by only ${g.min.toFixed(1)} L*.`]);
      if (m.readability) {
        const { orig } = m.readability;
        pills.push(['Readable', m.rating.readable,
          `Readable: ${m.rating.readable}. ${pct(orig.flat)} of the map is flat (values ${pct(CM.READ_WINDOW)} apart differ by < ${CM.READ_DE} ΔE); ${pct(orig.ambiguous)} has a look-alike color elsewhere; ${orig.levels} distinguishable levels.`]);
      }
      const wrap = el('div', { class: 'cmap-badges' });
      for (const [label, r, title] of pills) {
        const b = el('span', { class: `cmap-pill ${r}`, title });
        b.append(el('span', { class: 'cmap-glyph', 'aria-hidden': 'true' }, GLYPH[r]), `${label}`);
        b.append(el('span', { class: 'sr-only' }, `: ${WORD[r]}`));
        wrap.append(b);
      }
      return wrap;
    }

    // ---- comparison ----

    const MAX_CMP = CM.COMPARE_MAX;
    // Same size and square plot box as the plots of one map, so the four
    // quantities sit in one row; names are in the shared legend below.
    const CP = { W: PW, H: PH, m: M };
    const CMP_METRICS = [
      { key: 'L', label: 'Lightness L*', yLabel: 'L*' },
      { key: 'step', label: 'Perceptual step ΔE2000', yLabel: 'ΔE2000 per step' },
      { key: 'C', label: 'Chroma C*', yLabel: 'C*' },
      { key: 'h', label: 'Hue h°', yLabel: 'h (°)' },
    ];
    const cmp = {}; // elements of the compare panel, set by buildCompare

    function cmpSeries(map, key) {
      const p = profile(map);
      if (key === 'L') return { points: p.pts(p.Ls, (v) => `L* = ${v.toFixed(1)}`), mode: p.qual ? 'dots' : 'line', dotR: p.qual ? 4 : 0 };
      if (key === 'C') return { points: p.pts(p.C, (v) => `C* = ${v.toFixed(1)}`), mode: p.qual ? 'dots' : 'line', dotR: p.qual ? 4 : 0 };
      if (key === 'h') {
        return { points: p.pts(p.h, (v) => `h = ${v.toFixed(0)}°`, (i) => p.C[i] < HUE_MIN_CHROMA), mode: 'dots', dotR: p.qual ? 4 : 2.2 };
      }
      // Qualitative maps have no neighbors in order, so no steps.
      if (p.qual) return { points: null };
      return { points: stepPoints(map, p), mode: 'line', dotR: 0 };
    }

    function cmpAxis(key, series) {
      const ys = series.flatMap((s) => (s.points || []).map((p) => p.y).filter((y) => y != null));
      const top = Math.max(...ys, 0);
      if (key === 'L') return { yMax: 100, yTicks: [0, 20, 40, 60, 80, 100] };
      if (key === 'h') return { yMax: 360, yTicks: [0, 90, 180, 270, 360] };
      const axis = niceAxis(key === 'C' ? Math.max(100, top * 1.05) : Math.max(top * 1.05, 1));
      return { yMax: axis.top, yTicks: axis.ticks };
    }

    function miniStrip(map) {
      const d = el('span', { class: 'cmap-mini' });
      d.innerHTML = stripSvg(viewData(map, 'orig').colors, map.kind === 'qualitative');
      return d;
    }

    // One plot of one quantity with every compared map. `setActive(i)`
    // highlights map i in all four plots and the legend.
    function compareFigure(list, metric, setActive) {
      const { W, H, m } = CP;
      const key = metric.key;
      const series = list.map((map) => ({ map, ...cmpSeries(map, key) }));
      const svg = svgEl('svg', {
        class: 'cmap-plot', viewBox: `0 0 ${W} ${H}`, role: 'img',
        'aria-label': `${metric.label} of ${list.map((x) => x.name).join(', ')} against position`,
      });
      const { px, py } = drawAxes(svg, { W, H, m, ...cmpAxis(key, series), xTicks: POS_TICKS, xLabel: 'Position', yLabel: metric.yLabel });

      const groups = series.map((s) => {
        if (!s.points) return null;
        const g = svgEl('g', { class: 'cmap-series' });
        drawSeries(g, { points: s.points, mode: s.mode, dotR: s.dotR || 3, halo: true }, px, py);
        svg.append(g);
        return g;
      });

      const guide = svgEl('line', { class: 'cmap-guide', y1: m.t, y2: H - m.b, visibility: 'hidden' });
      const ring = svgEl('circle', { class: 'cmap-ring', r: 4, visibility: 'hidden' });
      svg.append(guide, ring);

      // The line closest to the pointer (by y), at the sample closest in x.
      svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const sx = ((e.clientX - r.left) / r.width) * W;
        const sy = ((e.clientY - r.top) / r.height) * H;
        const t = (sx - m.l) / (W - m.l - m.r);
        let best = null;
        series.forEach((s, gi) => {
          if (!s.points) return;
          let p = null;
          for (const q of s.points) if (q.y != null && (!p || Math.abs(q.x - t) < Math.abs(p.x - t))) p = q;
          if (!p) return;
          const d = Math.abs(py(p.y) - sy);
          if (!best || d < best.d) best = { gi, p, d, map: s.map };
        });
        if (!best) return;
        setActive(best.gi);
        guide.setAttribute('x1', px(best.p.x));
        guide.setAttribute('x2', px(best.p.x));
        guide.setAttribute('visibility', 'visible');
        ring.setAttribute('cx', px(best.p.x));
        ring.setAttribute('cy', py(best.p.y));
        ring.setAttribute('visibility', 'visible');
        const hex = CM.rgbToHex(best.p.color);
        showTip({
          hex, title: `${best.map.name} · ${metric.label}`,
          text: [hex, `rgb(${best.p.color[0]}, ${best.p.color[1]}, ${best.p.color[2]})`, best.p.pos, best.p.value],
        }, e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', () => {
        guide.setAttribute('visibility', 'hidden');
        ring.setAttribute('visibility', 'hidden');
        setActive(-1);
        hideTip();
      });

      const caps = {
        step: 'A flat line means equal steps in the data look like equal steps in color.',
        h: `Colors with C* < ${HUE_MIN_CHROMA} (grays) are left out, since their hue is not defined.`,
      };
      return { fig: figure(metric.label, svg, caps[key]), svg, groups };
    }

    // The four quantities side by side, with one legend for all of them.
    function comparePlot(list) {
      const figs = [];
      const legend = el('ul', { class: 'cmap-legend' });
      const lis = list.map((map, i) => {
        const li = el('li');
        li.append(el('span', { class: 'cmap-legend-name' }, map.name), miniStrip(map));
        li.addEventListener('pointerenter', () => setActive(i));
        li.addEventListener('pointerleave', () => setActive(-1));
        legend.append(li);
        return li;
      });
      function setActive(gi) {
        for (const f of figs) {
          f.svg.classList.toggle('has-active', gi >= 0);
          f.groups.forEach((g, i) => g && g.classList.toggle('active', i === gi));
        }
        lis.forEach((li, i) => li.classList.toggle('active', i === gi));
      }
      const grid = el('div', { class: 'cmap-plots' });
      for (const metric of CMP_METRICS) {
        const f = compareFigure(list, metric, setActive);
        figs.push(f);
        grid.append(f.fig);
      }

      const wrap = el('div', { class: 'cmap-plot-wrap' });
      wrap.append(grid, legend);
      const qual = list.filter((map) => map.kind === 'qualitative').map((map) => map.name);
      if (qual.length) {
        wrap.append(el('p', { class: 'cmap-fig-cap muted' }, `Qualitative maps (${qual.join(', ')}) have no order: their colors are spread evenly from 0 to 1 as dots, and they have no step plot.`));
      }
      return wrap;
    }

    // Numbers for the table: get() gives the value to sort and rank by (null = n/a).
    const pct = (v) => `${Math.round(v * 100)}%`;
    const NUM_COLS = [
      { id: 'name', label: 'Colormap', get: (f) => f.map.name.toLowerCase() },
      { id: 'range', label: 'L* range', hint: 'Spread of lightness. Wider means more contrast.', best: 'max', dp: 0,
        get: (f) => f.ls.range[1] - f.ls.range[0], show: (f) => `${f.ls.range[0].toFixed(0)}–${f.ls.range[1].toFixed(0)}` },
      { id: 'mono', label: 'Monotonic', hint: 'Does L* only rise or only fall? Fewer reversals are better.', best: 'min', dp: 0,
        get: (f) => (f.qual ? null : f.ls.reversals), show: (f) => (f.qual ? '—' : `${f.ls.monotonic ? 'yes' : 'no'} (${f.ls.reversals})`) },
      { id: 'r2', label: 'L* R²', hint: 'How close L* is to a straight line. Higher is better.', best: 'max', dp: 3,
        get: (f) => (f.qual ? null : f.ls.r2), show: (f) => (f.qual || f.ls.r2 == null ? '—' : f.ls.r2.toFixed(3)) },
      { id: 'cv', label: 'Step CV', hint: 'Variation of the ΔE2000 steps. Lower is better.', best: 'min', dp: 2,
        get: (f) => (f.qual ? null : f.m.stepStats.cv), show: (f) => (f.qual ? '—' : f.m.stepStats.cv.toFixed(2)) },
      { id: 'max', label: 'Max step ΔE', hint: 'Largest ΔE2000 jump between neighbors. Lower is better.', best: 'min', dp: 2,
        get: (f) => (f.qual ? null : f.m.stepStats.max), show: (f) => (f.qual ? '—' : f.m.stepStats.max.toFixed(2)) },
      { id: 'cvd', label: 'Worst CVD view', hint: 'Smallest ΔE2000 in the worst color-vision view, and the share of the map’s own separation it keeps. Higher is better.', best: 'max', dp: 1,
        get: (f) => f.m.cvdWorst, show: (f) => `${f.worstLabel} ${f.m.cvdWorst.toFixed(1)} ΔE (${pct(f.m.cvdRatio)})` },
      { id: 'gray', label: 'Gray min ΔL*', hint: 'Smallest L* difference in grayscale. Higher is better.', best: 'max', dp: 1,
        get: (f) => f.m.separations.gray?.min ?? null, show: (f) => (f.m.separations.gray ? f.m.separations.gray.min.toFixed(1) : '—') },
      { id: 'levels', label: 'Levels', hint: `Distinguishable levels from end to end (each ${CM.READ_DE} ΔE apart). Higher is better.`, best: 'max', dp: 0,
        get: (f) => f.m.readability?.orig.levels ?? null, show: (f) => (f.m.readability ? String(f.m.readability.orig.levels) : '—') },
      { id: 'flat', label: 'Flat %', hint: 'Share of the map where values 5% apart look almost the same. Lower is better.', best: 'min', dp: 2,
        get: (f) => f.m.readability?.orig.flat ?? null, show: (f) => (f.m.readability ? pct(f.m.readability.orig.flat) : '—') },
      { id: 'amb', label: 'Ambiguous %', hint: 'Share of the map whose color has a look-alike elsewhere. Lower is better.', best: 'min', dp: 2,
        get: (f) => f.m.readability?.orig.ambiguous ?? null, show: (f) => (f.m.readability ? pct(f.m.readability.orig.ambiguous) : '—') },
      { id: 'rating', label: 'Ratings', noSort: true },
    ];

    function facts(map) {
      const m = metrics(map);
      const worst = CM.CVD_TYPES.reduce((a, b) => (m.separations[b].min < m.separations[a].min ? b : a), CM.CVD_TYPES[0]);
      return { map, m, ls: CM.lightnessStats(viewData(map, 'orig').L), qual: map.kind === 'qualitative', worstLabel: VIEWS.find((v) => v.key === worst).label };
    }

    function compareTable(list) {
      const rows = list.map(facts);
      if (cmpSort) {
        const col = NUM_COLS.find((c) => c.id === cmpSort.id);
        const keyed = rows.map((f, i) => ({ f, i, v: col.get(f) }));
        keyed.sort((a, b) => {
          if ((a.v == null) !== (b.v == null)) return a.v == null ? 1 : -1; // n/a always last
          if (a.v == null || a.v === b.v) return a.i - b.i;
          return (a.v < b.v ? -1 : 1) * cmpSort.dir;
        });
        rows.splice(0, rows.length, ...keyed.map((k) => k.f));
      }
      // Best per column; nothing is marked when all values are equal. Values
      // are compared as shown (rounded to dp), so ties that look equal count as equal.
      const rnd = (c, v) => Math.round(v * 10 ** c.dp) / 10 ** c.dp;
      const best = {};
      for (const c of NUM_COLS) {
        if (!c.best) continue;
        const vals = rows.map((f) => c.get(f)).filter((v) => v != null).map((v) => rnd(c, v));
        if (vals.length < 2) continue;
        const b = c.best === 'max' ? Math.max(...vals) : Math.min(...vals);
        if (vals.some((v) => v !== b)) best[c.id] = b;
      }

      const table = el('table', { class: 'cmap-nums' });
      const head = el('tr');
      for (const c of NUM_COLS) {
        const th = el('th', { scope: 'col' });
        if (c.noSort) {
          th.textContent = c.label;
        } else {
          th.setAttribute('aria-sort', cmpSort?.id === c.id ? (cmpSort.dir > 0 ? 'ascending' : 'descending') : 'none');
          const b = el('button', { type: 'button', class: 'cmap-th', title: `${c.hint ? `${c.hint} ` : ''}Click to sort.` }, c.label);
          b.addEventListener('click', () => {
            // none -> ascending -> descending -> back to selection order
            if (cmpSort?.id !== c.id) cmpSort = { id: c.id, dir: 1 };
            else cmpSort = cmpSort.dir > 0 ? { id: c.id, dir: -1 } : null;
            renderCompareTable(selected.map((n) => mapByName.get(n)));
            cmp.table.querySelector(`th:nth-child(${NUM_COLS.indexOf(c) + 1}) button`)?.focus();
          });
          th.append(b);
        }
        if (c.hint && c.noSort) th.title = c.hint;
        head.append(th);
      }
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      for (const f of rows) {
        const tr = el('tr');
        const th = el('th', { scope: 'row' });
        th.append(el('code', {}, f.map.name), miniStrip(f.map));
        tr.append(th);
        for (const c of NUM_COLS.slice(1)) {
          const td = el('td');
          if (c.id === 'rating') {
            td.append(ratingPills(f.map));
          } else {
            td.textContent = c.show(f);
            if (best[c.id] != null && c.get(f) != null && rnd(c, c.get(f)) === best[c.id]) {
              td.className = 'best';
              td.title = 'Best in this column';
              td.append(el('span', { class: 'sr-only' }, ' (best)'));
            }
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      return table;
    }

    function compareRow(map, i, list) {
      const row = el('div', { class: 'cmap-row' });
      const name = el('div', { class: 'cmap-name' });
      name.append(el('code', {}, map.name), ratingPills(map));
      row.append(name);
      VIEWS.forEach((v, j) => {
        const cell = el('div', { class: j === 0 ? 'cmap-cell main' : 'cmap-cell' });
        cell.append(el('span', { class: 'cmap-cap' }, v.label), makeStrip(map, v, true));
        row.append(cell);
      });
      const actions = el('div', { class: 'cmap-actions' });
      const btn = (act, label, path, disabled) => {
        const b = el('button', {
          class: 'cmap-toggle cmap-sm', type: 'button', title: `${label} ${map.name}`, 'aria-label': `${label} ${map.name}`,
          'data-act': act, 'data-name': map.name,
        });
        if (disabled) b.disabled = true;
        b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        actions.append(b);
        return b;
      };
      btn('up', 'Move up', 'M4 10l4-4 4 4', i === 0).addEventListener('click', () => moveCompared(map.name, -1));
      btn('down', 'Move down', 'M4 6l4 4 4-4', i === list.length - 1).addEventListener('click', () => moveCompared(map.name, 1));
      btn('remove', 'Remove from comparison:', 'M4 4l8 8M12 4l-8 8').addEventListener('click', () => removeCompared(map.name));
      row.append(actions);
      return row;
    }

    function renderCompareStrips(list) {
      const box = el('div', { class: 'cmap-compare-rows' });
      box.append(headerRow());
      list.forEach((map, i) => {
        const item = el('div', { class: 'cmap-item' });
        item.append(compareRow(map, i, list));
        box.append(item);
      });
      cmp.strips.replaceChildren(box);
    }

    const renderComparePlot = (list) => cmp.plot.replaceChildren(comparePlot(list));

    function renderCompareTable(list) {
      const wrap = el('div', { class: 'cmap-table-wrap' });
      wrap.append(compareTable(list));
      cmp.table.replaceChildren(wrap);
    }

    function renderCompare() {
      const list = selected.map((n) => mapByName.get(n));
      cmp.sec.hidden = !list.length;
      ui.cmpBtn.hidden = !list.length;
      ui.cmpBtn.textContent = `Compare (${list.length})`;
      cmp.count.textContent = `Comparing ${list.length} of up to ${MAX_CMP}`;
      hideTip();
      if (!list.length) {
        for (const k of ['strips', 'plot', 'table']) cmp[k].replaceChildren();
        return;
      }
      renderCompareStrips(list);
      renderComparePlot(list);
      renderCompareTable(list);
    }

    // The link carries the selection, so a comparison can be shared as is.
    function updateUrl() {
      const params = new URLSearchParams(location.search);
      params.delete('compare');
      const rest = params.toString();
      const mine = selected.length ? `compare=${selected.map(encodeURIComponent).join(',')}` : '';
      const qs = [rest, mine].filter(Boolean).join('&');
      try {
        history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
      } catch (err) {
        console.warn('Could not update the link', err); // for example some file:// setups
      }
    }

    function syncCompareButtons() {
      const full = selected.length >= MAX_CMP;
      for (const e of items) {
        const on = selected.includes(e.map.name);
        e.item.classList.toggle('compared', on);
        e.cmpBtn.setAttribute('aria-pressed', String(on));
        e.cmpBtn.disabled = !on && full;
        e.cmpBtn.title = on ? `Remove ${e.map.name} from comparison` : full ? `Up to ${MAX_CMP} maps can be compared` : `Add ${e.map.name} to comparison`;
      }
    }

    // `focus` names the button to focus again, since the panel is rebuilt.
    function commitCompare(focus) {
      updateUrl();
      syncCompareButtons();
      renderCompare();
      if (!focus) return;
      const q = (act) => cmp.sec.querySelector(`button[data-act="${act}"][data-name="${CSS.escape(focus.name)}"]`);
      let b = q(focus.act);
      if (!b || b.disabled) b = q(focus.act === 'up' ? 'down' : 'up');
      (b && !b.disabled ? b : cmp.count).focus();
    }

    function setCompared(name, on) {
      const i = selected.indexOf(name);
      if (on && i < 0 && selected.length < MAX_CMP) selected.push(name);
      else if (!on && i >= 0) selected.splice(i, 1);
      else return;
      commitCompare();
    }

    function moveCompared(name, d) {
      const i = selected.indexOf(name);
      const j = i + d;
      if (i < 0 || j < 0 || j >= selected.length) return;
      [selected[i], selected[j]] = [selected[j], selected[i]];
      commitCompare({ name, act: d < 0 ? 'up' : 'down' });
    }

    function removeCompared(name) {
      const i = selected.indexOf(name);
      if (i < 0) return;
      selected.splice(i, 1);
      commitCompare(selected.length ? { name: selected[Math.min(i, selected.length - 1)], act: 'remove' } : null);
    }

    function buildCompare() {
      const sec = el('section', { class: 'cmap-compare', id: 'cmap-compare', 'aria-labelledby': 'cmap-compare-count', hidden: '' });
      const head = el('div', { class: 'cmap-compare-head' });
      const count = el('h2', { id: 'cmap-compare-count', tabindex: '-1' });
      const clear = el('button', { type: 'button', class: 'btn small' }, 'Clear');
      const copyLink = el('button', { type: 'button', class: 'btn small' }, 'Copy link');
      clear.addEventListener('click', () => { selected.length = 0; commitCompare(); });
      let timer = 0;
      copyLink.addEventListener('click', async () => {
        let msg = 'Copied';
        try { await navigator.clipboard.writeText(location.href); } catch (err) { console.warn('Could not copy', err); msg = 'Copy failed'; }
        copyLink.textContent = msg;
        clearTimeout(timer);
        timer = setTimeout(() => { copyLink.textContent = 'Copy link'; }, 1500);
      });
      head.append(count, clear, copyLink);

      const strips = el('div');
      const plot = el('div');
      const table = el('div');
      const h3 = (t) => el('h3', {}, t);
      sec.append(head, h3('Colormaps'), strips, h3('Profiles'), plot, h3('Numbers'), table);
      Object.assign(cmp, { sec, count, strips, plot, table });
      return sec;
    }

    // ---- page ----

    const refOrder = []; // keys in order of first appearance
    const refNumber = (key) => {
      let i = refOrder.indexOf(key);
      if (i < 0) { refOrder.push(key); i = refOrder.length - 1; }
      return i + 1;
    };

    function makeRow(map) {
      const item = el('div', { class: 'cmap-item' });
      const row = el('div', { class: 'cmap-row' });
      const panelId = `cmap-panel-${++uid}`;

      const name = el('div', { class: 'cmap-name' });
      const keys = CM.citeFor(map.name);
      name.title = keys.map((k) => CM.CMAP_REFS[k].text).join('\n\n');
      name.append(el('code', {}, map.name));
      keys.forEach((k, j) => {
        const sup = el('sup');
        sup.append(el('a', { href: `#ref-${k}`, 'aria-label': `Reference ${refNumber(k)}` }, String(refNumber(k))));
        if (j) name.append(' ');
        name.append(sup);
      });
      name.append(ratingPills(map));
      row.append(name);

      const strips = [];
      VIEWS.forEach((v, j) => {
        const cell = el('div', { class: j === 0 ? 'cmap-cell main' : 'cmap-cell' });
        cell.append(el('span', { class: 'cmap-cap' }, v.label));
        const strip = makeStrip(map, v);
        strips.push(strip);
        cell.append(strip);
        row.append(cell);
      });

      const button = el('button', {
        class: 'cmap-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId,
        'aria-label': `Plots for ${map.name}`, title: 'Show plots and details',
      });
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const cmpBtn = el('button', { class: 'cmap-toggle cmap-cmp', type: 'button', 'aria-pressed': 'false' });
      cmpBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="i-add" d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path class="i-on" d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const actions = el('div', { class: 'cmap-actions' });
      actions.append(cmpBtn, button);
      row.append(actions);

      const panel = el('div', { class: 'cmap-panel', id: panelId, hidden: '' });
      item.append(row, panel);
      item.dataset.name = map.name.toLowerCase();
      const entry = { map, item, strips, panel, button, cmpBtn, open: false, readView: 'orig', order: items.length };
      button.addEventListener('click', () => { toggle(entry); syncAll(); });
      cmpBtn.addEventListener('click', () => setCompared(map.name, cmpBtn.getAttribute('aria-pressed') !== 'true'));
      items.push(entry);
      return item;
    }

    function headerRow() {
      const h = el('div', { class: 'cmap-head', 'aria-hidden': 'true' });
      h.append(el('span', {}, 'Name'));
      for (const v of VIEWS) h.append(el('span', {}, v.label));
      h.append(el('span'));
      return h;
    }

    function buildControls() {
      const bar = el('div', { class: 'cmap-controls' });
      const search = el('input', { type: 'search', placeholder: 'Search colormaps…', 'aria-label': 'Search colormaps', class: 'cmap-search' });
      const revLabel = el('label', { class: 'check' });
      const rev = el('input', { type: 'checkbox' });
      revLabel.append(rev, 'Reversed');
      // One button for all L* plots: it expands the visible rows unless they are all open.
      const all = el('button', { type: 'button', class: 'btn small' }, 'Expand all');
      // Shown only while maps are selected; jumps to the comparison panel.
      const cmpBtn = el('button', { type: 'button', class: 'btn small', hidden: '' }, 'Compare (0)');
      cmpBtn.addEventListener('click', () => cmp.sec.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      const sortLabel = el('label', { class: 'cmap-sort' });
      const sort = el('select', { 'aria-label': 'Sort colormaps' });
      for (const [v, t] of SORTS) sort.append(el('option', { value: v }, t));
      sortLabel.append(el('span', { class: 'muted' }, 'Sort'), sort);
      const filters = el('div', { class: 'cmap-filters' });
      filters.append(el('span', { class: 'muted' }, 'Only'));
      const boxes = {};
      for (const [k, t, tip] of FILTERS) {
        const l = el('label', { class: 'check', title: tip });
        boxes[k] = el('input', { type: 'checkbox' });
        l.append(boxes[k], t);
        filters.append(l);
        boxes[k].addEventListener('change', () => { applyFilter(); syncAll(); });
      }
      const jump = el('nav', { class: 'cmap-jump', 'aria-label': 'Sections' });
      for (const [g, title] of SECTIONS) jump.append(el('a', { href: `#cmap-sec-${g}` }, title));
      bar.append(search, sortLabel, filters, revLabel, all, cmpBtn, jump);
      sort.addEventListener('change', applySort);
      search.addEventListener('input', () => { applyFilter(); syncAll(); });
      all.addEventListener('click', () => {
        const visible = items.filter((e) => !e.item.hidden);
        const open = !visible.every((e) => e.open);
        for (const e of visible) toggle(e, open);
        syncAll();
      });
      rev.addEventListener('change', () => {
        reversed = rev.checked;
        for (const entry of items) {
          for (const s of entry.strips) if (s._cm.rendered) renderStrip(s);
          if (entry.open) fillPanel(entry);
        }
        hideTip();
        if (selected.length) renderCompare();
      });
      return { bar, search, all, sort, boxes, cmpBtn };
    }

    function syncAll() {
      const visible = items.filter((e) => !e.item.hidden);
      ui.all.textContent = visible.length && visible.every((e) => e.open) ? 'Collapse all' : 'Expand all';
    }

    // Sorting only reorders rows inside each sub-heading box; sections stay put.
    const SORT_KEYS = {
      name: (a, b) => a.map.name.toLowerCase().localeCompare(b.map.name.toLowerCase()),
      uniform: (a, b) => (metrics(a.map).rating.uniform == null) - (metrics(b.map).rating.uniform == null)
        || metrics(a.map).stepStats.cv - metrics(b.map).stepStats.cv,
      cvd: (a, b) => metrics(b.map).cvdRatio - metrics(a.map).cvdRatio || metrics(b.map).cvdWorst - metrics(a.map).cvdWorst,
      gray: (a, b) => (metrics(b.map).separations.gray?.min ?? -1) - (metrics(a.map).separations.gray?.min ?? -1),
      linear: (a, b) => linearity(b) - linearity(a),
      readable: (a, b) => {
        const ra = metrics(a.map).readability;
        const rb = metrics(b.map).readability;
        if (!ra || !rb) return (ra == null) - (rb == null); // qualitative last
        return (ra.orig.flat + ra.orig.ambiguous) - (rb.orig.flat + rb.orig.ambiguous) || rb.orig.levels - ra.orig.levels;
      },
    };

    function linearity(entry) {
      if (entry.map.kind === 'qualitative') return -2;
      if (entry.r2 === undefined) entry.r2 = CM.lightnessStats(viewData(entry.map, 'orig').L).r2;
      return entry.r2 ?? -1;
    }

    function applySort() {
      const cmp = SORT_KEYS[ui.sort.value];
      for (const box of root.querySelectorAll('.cmap-sub')) {
        const rows = items.filter((e) => e.item.parentNode === box);
        rows.sort((a, b) => (cmp ? cmp(a, b) : 0) || a.order - b.order);
        for (const e of rows) box.append(e.item);
      }
    }

    function applyFilter() {
      const q = ui.search.value.trim().toLowerCase();
      for (const entry of items) {
        const r = metrics(entry.map).rating;
        const fails = FILTERS.some(([k, , , key]) => ui.boxes[k].checked && r[key] !== 'yes');
        entry.item.hidden = (q !== '' && !entry.item.dataset.name.includes(q)) || fails;
      }
      for (const sub of root.querySelectorAll('.cmap-sub')) {
        sub.hidden = !sub.querySelector('.cmap-item:not([hidden])');
      }
      let shown = 0;
      for (const sec of root.querySelectorAll('.cmap-section')) {
        sec.hidden = !sec.querySelector('.cmap-item:not([hidden])');
        if (!sec.hidden) shown++;
      }
      empty.hidden = shown > 0;
    }

    function buildReferences() {
      const sec = el('section', { class: 'cmap-refs' });
      sec.append(el('h2', {}, 'References'));
      const ol = el('ol');
      for (const k of refOrder) ol.append(refItem(k));
      sec.append(ol);
      sec.append(el('h3', {}, 'Methods'));
      sec.append(el('p', { class: 'muted' }, 'CVD views simulate Machado et al. (2009) at full severity in linear RGB, the same model matplotlib’s docs use via colorspacious. Grayscale is each color’s CIELAB L*. Color differences are CIEDE2000 (ΔE2000).'));
      const ol2 = el('ol', { start: String(refOrder.length + 1) });
      for (const k of ['machado', 'cielab', 'ciede2000']) ol2.append(refItem(k));
      sec.append(ol2);
      sec.append(el('p', { class: 'muted small' }, `Colormap data comes from ${data.source} ${data.version}.`));
      return sec;
    }

    // ---- identify a colormap from a figure ----

    const ID_MAX_SIDE = 4000; // larger images are scaled down before sampling
    const ID_MAX_PIXELS = 40000; // whole-image mode looks at about this many pixels
    const ID_TIE = 0.01; // maps whose scores differ by less than this have the same colors

    function identifyMaps() {
      return data.maps.map((m) => ({ name: m.name, kind: m.kind, rgbs: base(m) }));
    }

    // Matches within ID_TIE of the best remaining one are the same colors (gray,
    // gist_gray, binary reversed), so they share one entry.
    function groupTies(list, max = 5) {
      const groups = [];
      for (const r of list) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(r.score - g.lead.score) < ID_TIE) g.ties.push(r);
        else if (groups.length < max) groups.push({ lead: r, ties: [] });
        else break;
      }
      return groups;
    }

    function miniOf(map, flip) {
      const d = el('span', { class: 'cmap-mini' });
      const colors = flip ? base(map).slice().reverse() : base(map);
      d.innerHTML = stripSvg(colors, map.kind === 'qualitative');
      return d;
    }

    // Show a map's row: clear any search and filters that hide it, open it, scroll to it.
    function showRow(name) {
      const entry = items.find((e) => e.map.name === name);
      if (!entry) return;
      if (entry.item.hidden) {
        ui.search.value = '';
        for (const b of Object.values(ui.boxes)) b.checked = false;
        applyFilter();
      }
      toggle(entry, true);
      syncAll();
      entry.item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function buildIdentify() {
      const d = el('details', { class: 'cmap-method cmap-identify' });
      d.append(el('summary', {}, 'Identify a colormap from a figure'));
      d.append(el('p', { class: 'muted' }, 'Give an image of a figure and find which colormap it uses. The image stays in your browser.'));

      const file = el('input', { type: 'file', accept: 'image/*', hidden: '' });
      const choose = el('button', { type: 'button', class: 'btn small' }, 'Choose image…');
      const whole = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Use the whole image');
      const clear = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Clear');
      const bar = el('div', { class: 'cmap-id-bar' });
      bar.append(choose, whole, clear);
      const hint = el('p', { class: 'cmap-id-hint' }, 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).');
      const zone = el('div', { class: 'cmap-drop' });
      zone.append(bar, hint);

      const canvas = el('canvas', { class: 'cmap-id-canvas', hidden: '', role: 'img', tabindex: '0', 'aria-label': 'Your figure. Drag along the colorbar from one end to the other.' });
      const sampled = el('div', { class: 'cmap-id-sampled', hidden: '' });
      const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });
      const verdict = el('p', { class: 'cmap-id-verdict', 'aria-live': 'polite' });
      const explain = el('p', { class: 'cmap-fig-cap muted', hidden: '' }, 'The score is the average ΔE2000 between the sampled colors and the map (the worst 10% are ignored). Below 3 is the same map; 3 to 6 is a close relative.');
      const list = el('ol', { class: 'cmap-id-list' });
      d.append(zone, file, canvas, sampled, status, verdict, list, explain);

      let src = null; // offscreen canvas with the full-resolution image
      let img = null; // its ImageData
      let line = null; // { start, end } in image pixels
      let drag = null;

      // Pointer positions are relative to the content box: the border is not part of the image.
      const scale = () => canvas.width / (canvas.clientWidth || canvas.width);

      function redraw() {
        const g = canvas.getContext('2d');
        g.drawImage(src, 0, 0);
        if (!line) return;
        const k = scale();
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--bar-color').trim() || '#f29900';
        g.lineCap = 'round';
        for (const [w, c] of [[4.5 * k, 'rgba(0,0,0,0.75)'], [2 * k, accent]]) {
          g.strokeStyle = c;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(line.start.x, line.start.y);
          g.lineTo(line.end.x, line.end.y);
          g.stroke();
        }
        // Circle at the start, so the direction is clear.
        g.fillStyle = accent;
        g.strokeStyle = 'rgba(0,0,0,0.75)';
        g.lineWidth = 1.5 * k;
        g.beginPath();
        g.arc(line.start.x, line.start.y, 4.5 * k, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillRect(line.end.x - 3 * k, line.end.y - 3 * k, 6 * k, 6 * k);
        g.strokeRect(line.end.x - 3 * k, line.end.y - 3 * k, 6 * k, 6 * k);
      }

      function reset(keepImage) {
        line = null;
        drag = null;
        sampled.hidden = true;
        sampled.replaceChildren();
        list.replaceChildren();
        verdict.textContent = '';
        explain.hidden = true;
        status.textContent = '';
        if (!keepImage) {
          src = null;
          img = null;
          canvas.hidden = true;
          whole.disabled = true;
          clear.disabled = true;
          file.value = '';
        } else if (src) redraw();
      }

      function fail(msg) {
        reset(false);
        status.textContent = msg;
      }

      function load(f) {
        if (!f || !/^image\//.test(f.type)) { fail('That file is not an image. Use a PNG, JPEG, WebP or GIF.'); return; }
        const url = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => {
          URL.revokeObjectURL(url);
          try {
            const k = Math.min(1, ID_MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight));
            const w = Math.max(1, Math.round(im.naturalWidth * k));
            const h = Math.max(1, Math.round(im.naturalHeight * k));
            src = document.createElement('canvas');
            src.width = w;
            src.height = h;
            const g = src.getContext('2d', { willReadFrequently: true });
            g.fillStyle = '#fff'; // transparent pixels count as white, as readPixel does
            g.fillRect(0, 0, w, h);
            g.drawImage(im, 0, 0, w, h);
            img = g.getImageData(0, 0, w, h);
            canvas.width = w;
            canvas.height = h;
            reset(true);
            canvas.hidden = false;
            whole.disabled = false;
            clear.disabled = false;
            hint.textContent = 'Drag along the colorbar from one end to the other. Drag from the low end to the high end to read the direction. Or use the whole image if there is no colorbar.';
            redraw();
          } catch (err) {
            console.warn('Could not read the image', err);
            fail('Could not read that image.');
          }
        };
        im.onerror = () => { URL.revokeObjectURL(url); fail('Could not open that image.'); };
        im.src = url;
      }

      function pointAt(e) {
        const r = canvas.getBoundingClientRect();
        const k = scale();
        return {
          x: Math.max(0, Math.min(canvas.width - 1, (e.clientX - r.left - canvas.clientLeft) * k)),
          y: Math.max(0, Math.min(canvas.height - 1, (e.clientY - r.top - canvas.clientTop) * k)),
        };
      }

      const hexOf = (rgb) => CM.rgbToHex(rgb.map(clamp8));

      function showVerdict(best, level, extra) {
        const nm = best.reversed ? `${best.name} (reversed)` : best.name;
        const sc = best.score.toFixed(1);
        verdict.replaceChildren();
        if (level === 'exact') verdict.append('Best match: ', el('strong', {}, nm), ` (ΔE ${sc}).`);
        else if (level === 'close') verdict.append('Closest: ', el('strong', {}, nm), ` (ΔE ${sc}). Not an exact match; it may be a relative or a map from another library.`);
        else verdict.append(`No good match among the matplotlib colormaps (best ΔE ${sc}).`);
        if (extra) verdict.append(' ', extra);
      }

      function renderResults(results, { dir }) {
        list.replaceChildren();
        explain.hidden = !results.length;
        if (!results.length) { verdict.textContent = 'Could not find any colors to match.'; return; }
        const groups = groupTies(results);
        const best = groups[0].lead;
        showVerdict(best, CM.matchLevel(best.score));
        if (dir && best.reversed) {
          const last = base(mapByName.get(best.name)).slice(-1)[0];
          const sw = el('span', { class: 'cmap-sw', style: `background:${hexOf(last)}`, title: hexOf(last) });
          status.replaceChildren('Reversed means the end where you started is the map’s last color ', sw, '.');
        }
        for (const { lead, ties } of groups) {
          const map = mapByName.get(lead.name);
          const li = el('li', { class: 'cmap-id-item' });
          const name = el('span', { class: 'cmap-id-name' });
          name.append(el('code', {}, lead.name));
          if (lead.reversed) name.append(' (reversed)');
          if (ties.length) {
            name.append(el('span', { class: 'muted' }, ` (same colors: ${ties.map((t) => (t.reversed ? `${t.name} reversed` : t.name)).join(', ')})`));
          }
          const nums = el('span', { class: 'cmap-id-score' }, `ΔE ${lead.score.toFixed(1)}${lead.coverage != null ? `, covers ${pct(lead.coverage)}` : ''}`);
          const act = el('span', { class: 'cmap-id-actions' });
          const show = el('button', { type: 'button', class: 'btn small' }, 'Show');
          show.setAttribute('aria-label', `Show ${lead.name} in the list`);
          show.addEventListener('click', () => {
            showRow(lead.name);
            if (lead.reversed && !reversed) status.textContent = `${lead.name} matches reversed. Turn on Reversed to see it that way.`;
          });
          const cmpB = el('button', { type: 'button', class: 'btn small' });
          const syncCmp = () => {
            const on = selected.includes(lead.name);
            cmpB.textContent = on ? 'In comparison' : 'Compare';
            cmpB.disabled = on || selected.length >= MAX_CMP;
            cmpB.setAttribute('aria-label', `Compare ${lead.name}`);
          };
          syncCmp();
          cmpB.addEventListener('click', () => { setCompared(lead.name, true); syncCmp(); });
          act.append(show, cmpB);
          li.append(miniOf(map, lead.reversed), name, nums, act);
          list.append(li);
        }
      }

      function runColorbar(a, b) {
        const k = CM.refineColorbar(img, a, b);
        let start = a;
        let end = b;
        let half = 2;
        if (k) { ({ start, end } = k); half = k.halfWidth; }
        line = { start, end };
        redraw();
        const samples = CM.sampleColorbar(img, start, end, half, 256);
        if (samples.length < 2) { fail('That line is too short.'); return; }
        const rgbs = samples.map((s) => s.rgb);
        sampled.hidden = false;
        sampled.replaceChildren(el('span', { class: 'muted' }, k ? 'Colors along the line (snapped to the colorbar)' : 'Colors along the line'));
        const strip = el('div', { class: 'cmap-id-strip', role: 'img', 'aria-label': 'Sampled colors' });
        strip.innerHTML = stripSvg(rgbs.map(roundRgb), false);
        sampled.append(strip);
        status.textContent = '';
        renderResults(CM.identifyColorbar(rgbs, identifyMaps()), { dir: true });
      }

      function runWhole() {
        if (!img) return;
        line = null;
        redraw();
        const step = Math.max(1, Math.ceil(Math.sqrt((img.width * img.height) / ID_MAX_PIXELS)));
        const px = [];
        for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) px.push(CM.readPixel(img, x, y));
        sampled.hidden = true;
        status.textContent = 'The direction cannot be known this way. A line along the colorbar is more reliable.';
        renderResults(CM.identifyColors(px, identifyMaps()), { dir: false });
        verdict.append(' Whole image: the score is how close the image’s colors are to the nearest color of each map.');
      }

      canvas.addEventListener('pointerdown', (e) => {
        if (!img || e.button > 0) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drag = { start: pointAt(e), px: e.clientX, py: e.clientY };
        line = null;
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        line = { start: drag.start, end: pointAt(e) };
        redraw();
      });
      const finish = (e) => {
        if (!drag) return;
        const { start, px, py } = drag;
        drag = null;
        if (e.type === 'pointercancel' || Math.hypot(e.clientX - px, e.clientY - py) < 8) { line = null; redraw(); return; }
        runColorbar(start, pointAt(e));
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);

      choose.addEventListener('click', () => file.click());
      file.addEventListener('change', () => { if (file.files[0]) load(file.files[0]); });
      whole.addEventListener('click', runWhole);
      clear.addEventListener('click', () => { reset(false); hint.textContent = 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).'; });

      const fileOf = (dt) => [...(dt?.files || [])].find((f) => /^image\//.test(f.type)) || [...(dt?.files || [])][0];
      for (const t of [zone, canvas]) {
        t.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
        t.addEventListener('dragleave', () => zone.classList.remove('over'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          zone.classList.remove('over');
          load(fileOf(e.dataTransfer));
        });
      }
      // Paste works anywhere on the page while the panel is open.
      document.addEventListener('paste', (e) => {
        if (!d.open || e.target.closest?.('input[type="search"], textarea')) return;
        const f = fileOf(e.clipboardData);
        if (!f) return;
        e.preventDefault();
        load(f);
      });
      return d;
    }

    function buildMethod() {
      const R = CM.CMAP_RATING;
      const pc = (v) => `${Math.round(v * 100)}%`;
      const d = el('details', { class: 'cmap-method' });
      d.append(el('summary', {}, 'How the ratings work'));
      d.append(el('p', {}, 'Each colormap gets up to four ratings: yes (✓), partly (~) or no (✕). They are rules of thumb tuned on the matplotlib maps, not standards. Hover a pill for the numbers.'));
      const ul = el('ul');
      const li = (head, ...parts) => {
        const x = el('li');
        x.append(el('strong', {}, `${head} `), ...parts);
        ul.append(x);
      };
      li('Uniform.', `We measure the color difference (ΔE2000) between neighbors among 64 evenly spaced colors. The rating uses how much these steps vary, as the coefficient of variation (CV = standard deviation / mean): yes at CV ≤ ${R.uniform.yes}, partly up to ${R.uniform.partly}. A uniform map shows equal steps in the data as equal steps in color. Qualitative maps are not rated.`);
      li('CVD-safe.', `For the map and for each CVD view we find the smallest ΔE2000 between two values at least 10% of the map apart (cyclic maps count around the circle, qualitative maps compare all pairs). The worst CVD view must keep at least ${pc(R.cvd.yes.ratio)} of the map’s own smallest difference and at least ${R.cvd.yes.min} ΔE for yes, or ${pc(R.cvd.partly.ratio)} and ${R.cvd.partly.min} ΔE for partly.`);
      li('Grayscale-safe.', `The same search on L* alone: values 10% apart differ by at least ${R.gray.yes} L* for yes, or ${R.gray.partly} L* for partly.`);
      const RD = R.readable;
      li('Readable.', `Can you read a value back from a color, as Colormeris does? A color in a figure is off by a few ΔE (compression, print, blending), so differences under ${CM.READ_DE} ΔE2000 are not relied on. Flat is the share of the map where values ${pc(CM.READ_WINDOW)} of the range apart differ by less than that. Ambiguous is the share whose color has a look-alike (under ${CM.READ_DE} ΔE) at a value at least 10% away. Yes needs at most ${pc(RD.flat.yes)} flat and ${pc(RD.ambiguous.yes)} ambiguous; partly at most ${pc(RD.flat.partly)} and ${pc(RD.ambiguous.partly)}. This is not the same as Uniform: jet is readable, since its colors are all different, but not uniform. Qualitative maps are not rated.`);
      d.append(ul);
      const p = el('p', { class: 'muted' }, 'A ΔE2000 of about 2 is roughly the smallest difference you notice side by side. Color differences use CIEDE2000 (');
      p.append(el('a', { href: '#ref-ciede2000' }, 'Sharma, Wu & Dalal 2005'), ').');
      d.append(p);
      return d;
    }

    function refItem(k) {
      const ref = CM.CMAP_REFS[k];
      const li = el('li', { id: `ref-${k}` });
      li.append(ref.text);
      if (ref.url) {
        li.append(' ');
        li.append(el('a', { href: ref.url, target: '_blank', rel: 'noopener' }, 'Link'));
      }
      return li;
    }

    root.replaceChildren();
    const inner = el('div', { class: 'cmap-inner' });
    inner.append(el('h1', {}, 'Colormaps'));
    inner.append(el('p', { class: 'cmap-intro' }, 'Each colormap is shown as seen, as simulated for three kinds of color-vision deficiency, and in grayscale. Hover a strip for its hex and RGB values, click to copy the hex, or open a row to see its lightness (L*), step, chroma and hue profiles and how far apart its values stay in each view. The pills under each name rate it as uniform, CVD-safe, grayscale-safe and readable. A colormap that is not monotonic in L* makes the figure harder to read, in grayscale and in color.'));
    inner.append(buildMethod(), buildIdentify());
    const ui = buildControls();
    // Controls and column names share one sticky bar, so they stay readable
    // while scrolling instead of one floating header per section.
    const top = el('div', { class: 'cmap-top' });
    top.append(ui.bar, headerRow());
    inner.append(top, buildCompare());

    for (const [group, title] of SECTIONS) {
      const maps = data.maps.filter((m) => m.group === group);
      if (!maps.length) continue;
      const sec = el('section', { class: 'cmap-section', id: `cmap-sec-${group}` });
      sec.append(el('h2', {}, title));
      const subs = [];
      for (const m of maps) if (!subs.includes(m.sub)) subs.push(m.sub);
      for (const sub of subs) {
        const box = el('div', { class: 'cmap-sub' });
        if (sub) box.append(el('h3', {}, sub));
        for (const m of maps.filter((x) => x.sub === sub)) box.append(makeRow(m));
        sec.append(box);
      }
      inner.append(sec);
    }
    const empty = el('p', { class: 'muted', hidden: '' }, 'No colormap matches your search.');
    inner.append(empty, buildReferences());
    root.append(inner);
    syncCompareButtons();
    renderCompare();
    return { items, setReversed(v) { reversed = !!v; } };
  }

  function showStartupError(err) {
    console.error(err);
    const e = document.createElement('div');
    e.setAttribute('role', 'alert');
    e.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;padding:10px 14px;background:#b3261e;color:#fff;font:14px system-ui,sans-serif';
    e.textContent = `The colormap viewer could not start (${err?.message || err}). Try a hard refresh (Ctrl+Shift+R). If it persists, report the first error in the browser console.`;
    document.body.prepend(e);
  }

  Object.assign(CM, { setupColormapViewer });

  // Scripts are deferred, so the DOM is parsed when this runs.
  const root = typeof document !== 'undefined' && document.getElementById('cmap-root');
  if (root) {
    try {
      setupColormapViewer(root);
    } catch (err) {
      showStartupError(err);
    }
  }
})((globalThis.Colormeris ??= {}));
