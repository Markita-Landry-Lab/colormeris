(function (CM) {
  'use strict';

  // The colormap viewer page (colormaps.html), in five tabs:
  //   Browse    every colormap as five vector SVG strips (as seen, three
  //             color-vision-deficiency simulations, grayscale) with rating
  //             columns; one map at a time opens in the detail view (cmap-detail.js)
  //   Compare   up to 10 maps side by side (cmap-compare.js)
  //   Identify  find the colormap of a figure (cmap-identify-ui.js)
  //   Recolor   redraw a figure in another colormap (cmap-recolor-ui.js)
  //   CVD       a figure next to a color-vision-deficiency simulation (cmap-cvd-ui.js)
  // The tab, the open map and the comparison live in the URL. The data comes
  // from cmap-data.js, so the page needs no fetch and works from file://.

  // [group, title, open at first]. With over 300 maps, all start closed.
  const SECTIONS = [
    ['sequential', 'Sequential', false],
    ['diverging', 'Diverging', false],
    ['cyclic', 'Cyclic', false],
    ['rainbow', 'Rainbow', false],
    ['others', 'Others', false],
  ];
  const VIEWS = [
    { key: 'orig', label: 'Colormap', short: 'Colormap' },
    { key: 'protanopia', label: 'Protanopia', short: 'Protan' },
    { key: 'deuteranopia', label: 'Deuteranopia', short: 'Deutan' },
    { key: 'tritanopia', label: 'Tritanopia', short: 'Tritan' },
    { key: 'gray', label: 'Grayscale', short: 'Gray' },
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
  // The rating columns of the list: key in rating, header, full name, sort key.
  const RATING_COLS = [
    { key: 'uniform', abbr: 'U', label: 'Uniform', sort: 'uniform' },
    { key: 'cvdSafe', abbr: 'CVD', label: 'CVD-safe', sort: 'cvd' },
    { key: 'graySafe', abbr: 'Gray', label: 'Grayscale-safe', sort: 'gray' },
    { key: 'readable', abbr: 'Read', label: 'Readable', sort: 'readable' },
  ];
  // [id, label, hint, key in rating]
  const FILTERS = [
    ['uniform', 'Uniform', 'Only colormaps rated uniform', 'uniform'],
    ['cvd', 'CVD-safe', 'Only colormaps rated CVD-safe', 'cvdSafe'],
    ['gray', 'Gray-safe', 'Only colormaps rated grayscale-safe', 'graySafe'],
    ['readable', 'Readable', 'Only colormaps rated readable (values can be read back from the colors)', 'readable'],
  ];
  const GLYPH = { yes: '✓', partly: '~', no: '✕' };
  const PILL = { uniform: 'Uniform', cvdSafe: 'CVD', graySafe: 'Gray', readable: 'Readable' };
  const VIEW_KEY = 'colormeris.cmapView'; // localStorage: 'all' or one view key
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
  const pct = (v) => `${Math.round(v * 100)}%`;

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

  // Storage can be missing or throw (private windows, file://); the default is fine then.
  function loadStripView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'all' || VIEWS.some((x) => x.key === v)) return v;
    } catch { /* use the default */ }
    return 'all';
  }

  function saveStripView(v) {
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* not remembered */ }
  }

  // Native popovers open in the middle of the screen; put them under their button.
  function anchorPopover(btn, pop) {
    btn.setAttribute('popovertarget', pop.id);
    const place = () => {
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, vw - pop.offsetWidth - 8)))}px`;
    };
    pop.addEventListener('beforetoggle', (e) => { if (e.newState === 'open') place(); });
    pop.addEventListener('toggle', (e) => {
      btn.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState === 'open') place(); // again, now that its width is known
    });
  }

  function setupColormapViewer(root) {
    const data = CM.cmapData;
    if (!data) throw new Error('cmap-data.js did not load');

    const names = data.maps.map((m) => m.name);
    const route = CM.parseViewerRoute(location.search, location.hash, names);
    // Shared with the detail, compare and identify modules. `selected` is the
    // comparison (?compare=), `open` the map in the detail view (?map=).
    const state = {
      reversed: false, selected: route.compare, open: null, tab: 'browse', stripView: loadStripView(), sort: null,
    };
    let uid = 0;
    const cache = new Map(); // `${name}|${reversed}` -> { view key -> { colors, L } }
    const baseOf = new Map(); // name -> original colors, unpacked once
    const items = []; // { map, item, strips: [el], panel, button, cmpBtn, order }
    const mapByName = new Map(data.maps.map((m) => [m.name, m]));

    // ---- colors per view (computed once per map and direction) ----

    function base(map) {
      if (!baseOf.has(map.name)) baseOf.set(map.name, unpack(map.colors));
      return baseOf.get(map.name);
    }

    // `reversed` defaults to the Browse setting; the Compare tab passes its own per map.
    function viewData(map, view, reversed = state.reversed) {
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
      strip.insertAdjacentHTML('afterbegin', stripSvg(viewData(map, view, strip._cm.rev).colors, map.kind === 'qualitative'));
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
    function makeStrip(map, view, eager = false, reversed = undefined) {
      const strip = el('div', {
        class: 'cmap-strip',
        tabindex: '0',
        role: 'img',
        'aria-label': `${map.name} ${view.label}`,
      });
      strip._cm = { map, view: view.key, rendered: false, probe: null, rev: reversed };
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
      const n = viewData(strip._cm.map, strip._cm.view, strip._cm.rev).colors.length;
      const f = r.width ? (clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(n - 1, Math.floor(f * n)));
    }

    function probe(strip, i, x, y) {
      const { map, view } = strip._cm;
      const label = VIEWS.find((v) => v.key === view).label;
      const vd = viewData(map, view, strip._cm.rev);
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
      const n = viewData(strip._cm.map, strip._cm.view, strip._cm.rev).colors.length;
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

    const rev = (a, reversed = state.reversed) => (reversed ? a.slice().reverse() : a);

    // Smallest separation in one view, with positions that follow Reversed.
    function sepOf(map, key) {
      const s = metrics(map).separations[key];
      if (!s || !state.reversed) return s;
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
    function profile(map, reversed = state.reversed) {
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

    // ---- ratings ----

    const notesOf = (map) => CM.ratingNotes(metrics(map), { qual: map.kind === 'qualitative' });

    // Pills under the name: on phones in the list, and in the comparison table.
    function ratingPills(map) {
      const wrap = el('div', { class: 'cmap-badges' });
      for (const n of notesOf(map)) {
        const b = el('span', { class: `cmap-pill ${n.rating}`, title: `${n.label}: ${n.rating}. ${n.text}` });
        b.append(el('span', { class: 'cmap-glyph', 'aria-hidden': 'true' }, GLYPH[n.rating]), PILL[n.key]);
        b.append(el('span', { class: 'sr-only' }, `: ${n.rating}`));
        wrap.append(b);
      }
      return wrap;
    }

    // One glyph per rating column, so ratings can be scanned down the list.
    function ratingCells(map) {
      const notes = notesOf(map);
      return RATING_COLS.map((c) => {
        const n = notes.find((x) => x.key === c.key);
        if (!n) return el('span', { class: 'cmap-rc na', title: `${c.label}: does not apply to qualitative maps` }, '—');
        const s = el('span', { class: `cmap-rc ${n.rating}`, title: `${c.label}: ${n.rating}. ${n.text}` });
        s.append(el('span', { 'aria-hidden': 'true' }, GLYPH[n.rating]), el('span', { class: 'sr-only' }, `${c.label}: ${n.rating}`));
        return s;
      });
    }

    // ---- references ----

    const refOrder = []; // keys in order of first appearance in the list
    const refNumber = (key) => {
      let i = refOrder.indexOf(key);
      if (i < 0) { refOrder.push(key); i = refOrder.length - 1; }
      return i + 1;
    };

    // `id` is left out for copies (the detail view), so the footer keeps the anchors.
    function refItem(k, { id = true } = {}) {
      const ref = CM.CMAP_REFS[k];
      const li = el('li', id ? { id: `ref-${k}` } : {});
      li.append(ref.text);
      if (ref.url) {
        li.append(' ');
        li.append(el('a', { href: ref.url, target: '_blank', rel: 'noopener' }, 'Link'));
      }
      return li;
    }

    // ---- list rows ----

    function makeRow(map) {
      const item = el('div', { class: 'cmap-item' });
      const row = el('div', { class: 'cmap-row' });
      const panelId = `cmap-panel-${++uid}`;
      for (const k of CM.citeFor(map.name)) refNumber(k); // footer numbers follow the list order

      const name = el('div', { class: 'cmap-name' });
      const code = el('code', { class: 'cmap-name-link', title: `Show details of ${map.name}` }, map.name);
      name.append(code, ratingPills(map));
      row.append(name);

      const strips = [];
      VIEWS.forEach((v, j) => {
        const cell = el('div', { class: j === 0 ? 'cmap-cell main' : 'cmap-cell', 'data-view': v.key });
        cell.append(el('span', { class: 'cmap-cap' }, v.label));
        const strip = makeStrip(map, v);
        strips.push(strip);
        cell.append(strip);
        row.append(cell);
      });
      row.append(...ratingCells(map));

      const button = el('button', {
        class: 'cmap-toggle cmap-open-btn', type: 'button', 'aria-expanded': 'false',
        'aria-label': `Details of ${map.name}`, title: 'Show plots and details',
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
      const entry = { map, item, strips, panel, button, cmpBtn, order: items.length };
      const toggleDetail = () => (state.open === map.name ? detail.close() : detail.open(map.name));
      button.addEventListener('click', toggleDetail);
      code.addEventListener('click', toggleDetail);
      cmpBtn.addEventListener('click', () => compare.setCompared(map.name, cmpBtn.getAttribute('aria-pressed') !== 'true'));
      items.push(entry);
      return item;
    }

    // Column names. In the list they sort and explain the ratings; the
    // comparison reuses a plain copy.
    function headerRow(interactive = false) {
      const h = el('div', { class: 'cmap-head' });
      if (!interactive) h.setAttribute('aria-hidden', 'true');
      h.append(interactive ? sortButton('name', 'Name', 'Sort by name') : el('span', {}, 'Name'));
      for (const v of VIEWS) h.append(el('span', { 'data-view': v.key }, v.label));
      for (const c of RATING_COLS) {
        const cell = el('span', { class: 'cmap-head-rc', title: c.label });
        cell.append(interactive ? sortButton(c.sort, c.abbr, `${c.label}: best first, then worst first`) : c.abbr);
        h.append(cell);
      }
      const end = el('span', { class: 'cmap-head-end' });
      if (interactive) end.append(...methodButton());
      h.append(end);
      return h;
    }

    // ---- how the ratings work (popover in the header, and the footer) ----

    function methodList() {
      const text = CM.ratingMethod();
      const ul = el('ul');
      for (const c of RATING_COLS) {
        const li = el('li');
        li.append(el('strong', {}, `${c.label}. `), text[c.key]);
        ul.append(li);
      }
      return ul;
    }

    function methodButton() {
      const btn = el('button', { type: 'button', class: 'cmap-help', 'aria-label': 'How the ratings work', title: 'How the ratings work', 'aria-expanded': 'false' }, '?');
      const pop = el('div', { id: 'cmap-pop-method', popover: '', class: 'cmap-pop cmap-pop-wide' });
      pop.append(el('div', { class: 'cmap-pop-title' }, 'How the ratings work'));
      pop.append(el('p', {}, 'Yes (✓), partly (~) or no (✕). Rules of thumb tuned on the matplotlib maps, not standards. Hover a glyph for the numbers.'));
      pop.append(methodList());
      const more = el('a', { href: '#cmap-about' }, 'Methods and references');
      more.addEventListener('click', () => pop.hidePopover());
      const p = el('p', { class: 'muted' });
      p.append(more);
      pop.append(p);
      popovers.push([btn, pop]);
      return [btn, pop];
    }

    // ---- controls ----

    const popovers = []; // [button, popover], anchored once both are in the page

    function sortButton(key, text, title) {
      const b = el('button', { type: 'button', class: 'cmap-th', 'data-sort': key, title }, text);
      b.addEventListener('click', () => {
        // none -> best first (A–Z for names) -> reversed -> back to the default order
        const s = state.sort;
        if (s?.key !== key) state.sort = { key, dir: 1 };
        else state.sort = s.dir > 0 ? { key, dir: -1 } : null;
        applySort();
      });
      return b;
    }

    function buildControls() {
      const bar = el('div', { class: 'cmap-controls' });
      const search = el('input', { type: 'search', placeholder: 'Search colormaps…', 'aria-label': 'Search colormaps', class: 'cmap-search' });

      // Which strips the rows show: all five (default) or one view, wider.
      const viewWrap = el('div', { class: 'cmap-viewsel' });
      const views = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': 'Strips to show' });
      const viewBtns = [['all', 'All 5'], ...VIEWS.map((v) => [v.key, v.short])].map(([k, t]) => {
        const b = el('button', { type: 'button', 'data-view-key': k, title: k === 'all' ? 'Show all five views' : `Show only ${VIEWS.find((v) => v.key === k).label}` }, t);
        b.addEventListener('click', () => setStripView(k));
        views.append(b);
        return b;
      });
      viewWrap.append(el('span', { class: 'muted' }, 'Views'), views);

      // Filters: keep maps rated yes.
      const filtBtn = el('button', { type: 'button', class: 'btn small', 'aria-expanded': 'false' }, 'Filters');
      const filtPop = el('div', { id: 'cmap-pop-filters', popover: '', class: 'cmap-pop' });
      filtPop.append(el('div', { class: 'cmap-pop-title' }, 'Only maps rated yes for'));
      const boxes = {};
      for (const [k, t, tip] of FILTERS) {
        const l = el('label', { class: 'check', title: tip });
        boxes[k] = el('input', { type: 'checkbox' });
        l.append(boxes[k], t);
        filtPop.append(l);
        boxes[k].addEventListener('change', applyFilter);
      }
      // Sources: none ticked shows every library.
      filtPop.append(el('div', { class: 'cmap-pop-title' }, 'Only maps from'));
      const sources = {};
      for (const src of data.sources) {
        const n = data.maps.filter((m) => m.source === src.key).length;
        if (!n) continue;
        const l = el('label', { class: 'check', title: `Only colormaps from ${src.label}` });
        sources[src.key] = el('input', { type: 'checkbox' });
        l.append(sources[src.key], `${src.label} (${n})`);
        filtPop.append(l);
        sources[src.key].addEventListener('change', applyFilter);
      }
      const presets = el('div', { class: 'cmap-pop-row' });
      const allYes = el('button', { type: 'button', class: 'btn small', title: 'Tick all four ratings; the sources stay as they are' }, 'All ratings ✓');
      const none = el('button', { type: 'button', class: 'btn small' }, 'Clear');
      allYes.addEventListener('click', () => { for (const b of Object.values(boxes)) b.checked = true; applyFilter(); });
      none.addEventListener('click', () => { clearFilters(); applyFilter(); });
      presets.append(allYes, none);
      filtPop.append(presets);
      popovers.push([filtBtn, filtPop]);

      // Less used: direction and the full list of sort orders.
      const moreBtn = el('button', { type: 'button', class: 'btn small', 'aria-label': 'More options', title: 'More options', 'aria-expanded': 'false' }, '⋯');
      const morePop = el('div', { id: 'cmap-pop-more', popover: '', class: 'cmap-pop' });
      const revLabel = el('label', { class: 'check' });
      const rev = el('input', { type: 'checkbox' });
      revLabel.append(rev, 'Reversed');
      const sortLabel = el('label', { class: 'cmap-sort' });
      const sort = el('select', { 'aria-label': 'Sort colormaps' });
      for (const [v, t] of SORTS) sort.append(el('option', { value: v }, t));
      sortLabel.append(el('span', { class: 'muted' }, 'Sort'), sort);
      morePop.append(revLabel, sortLabel);
      popovers.push([moreBtn, morePop]);

      bar.append(search, viewWrap, filtBtn, moreBtn, filtPop, morePop);
      sort.addEventListener('change', () => {
        state.sort = sort.value === 'default' ? null : { key: sort.value, dir: 1 };
        applySort();
      });
      search.addEventListener('input', applyFilter);
      rev.addEventListener('change', () => {
        state.reversed = rev.checked;
        for (const entry of items) {
          for (const s of entry.strips) if (s._cm.rendered) renderStrip(s);
        }
        hideTip();
        detail.refresh();
        compare.render();
      });
      return { bar, search, sort, boxes, sources, filtBtn, viewBtns, rev };
    }

    function setStripView(k) {
      state.stripView = k;
      saveStripView(k);
      applyStripView(root);
    }

    // Hide the strips of the other views (they are built lazily, so hidden ones cost little).
    function applyStripView(scope) {
      const k = state.stripView;
      root.classList.toggle('cmap-single', k !== 'all');
      for (const c of scope.querySelectorAll('.cmap-cell[data-view], .cmap-head [data-view]')) {
        c.hidden = k !== 'all' && c.dataset.view !== k;
      }
      for (const b of ui.viewBtns) b.setAttribute('aria-pressed', String(b.dataset.viewKey === k));
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
      const s = state.sort;
      const cmp = s && SORT_KEYS[s.key];
      for (const box of root.querySelectorAll('.cmap-browse .cmap-sub')) {
        const rows = items.filter((e) => e.item.parentNode === box);
        rows.sort((a, b) => (cmp ? cmp(a, b) * s.dir : 0) || a.order - b.order);
        for (const e of rows) box.append(e.item);
      }
      ui.sort.value = s ? s.key : 'default';
      for (const b of top.querySelectorAll('.cmap-th[data-sort]')) {
        const on = s?.key === b.dataset.sort;
        b.dataset.dir = on ? (s.dir > 0 ? 'first' : 'last') : '';
        b.setAttribute('aria-pressed', String(on));
      }
    }

    const filterBoxes = () => [...Object.values(ui.boxes), ...Object.values(ui.sources)];

    function filtering() {
      return ui.search.value.trim() !== '' || filterBoxes().some((b) => b.checked);
    }

    function clearFilters() {
      for (const b of filterBoxes()) b.checked = false;
    }

    function applyFilter() {
      const q = ui.search.value.trim().toLowerCase();
      const on = FILTERS.filter(([k]) => ui.boxes[k].checked);
      const srcs = Object.keys(ui.sources).filter((k) => ui.sources[k].checked);
      for (const entry of items) {
        const r = metrics(entry.map).rating;
        const fails = on.some(([, , , key]) => r[key] !== 'yes') || (srcs.length > 0 && !srcs.includes(entry.map.source));
        entry.item.hidden = (q !== '' && !entry.item.dataset.name.includes(q)) || fails;
      }
      for (const sub of root.querySelectorAll('.cmap-browse .cmap-sub')) {
        sub.hidden = !sub.querySelector('.cmap-item:not([hidden])');
      }
      // While searching or filtering, sections with matches open and show how many.
      const active = filtering();
      let shown = 0;
      for (const sec of sections) {
        const n = sec.querySelectorAll('.cmap-item:not([hidden])').length;
        sec.hidden = n === 0;
        sec._count.textContent = active ? `${n} of ${sec._total}` : String(sec._total);
        sec.open = active ? n > 0 : sec._userOpen;
        if (n) shown++;
      }
      empty.hidden = shown > 0;
      const nOn = on.length + srcs.length;
      ui.filtBtn.textContent = nOn ? `Filters (${nOn})` : 'Filters';
      ui.filtBtn.classList.toggle('active', nOn > 0);
    }

    // Show a map in the list: clear the search and filters that hide it, open
    // its section and its details, scroll to it.
    function showRow(name, { smooth = true } = {}) {
      const entry = items.find((e) => e.map.name === name);
      if (!entry) return;
      goTab('browse');
      if (entry.item.hidden) {
        ui.search.value = '';
        clearFilters();
        applyFilter();
      }
      const sec = entry.item.closest('.cmap-section');
      if (sec && !sec.open) { sec.open = true; sec._userOpen = true; }
      detail.open(name);
      // Above 820px only the page pane scrolls; scrollIntoView would also
      // scroll the overflow-hidden document and push the top bar away.
      const behavior = smooth ? 'smooth' : 'auto';
      if (getComputedStyle(root).overflowY === 'auto') {
        const r = entry.item.getBoundingClientRect();
        const p = root.getBoundingClientRect();
        root.scrollBy({ top: r.top - p.top - (p.height - r.height) / 2, behavior });
      } else {
        entry.item.scrollIntoView({ behavior, block: 'center' });
      }
    }

    // ---- tabs ----

    const TAB_TITLES = { browse: 'Browse', compare: 'Compare', identify: 'Identify', recolor: 'Recolor', cvd: 'CVD' };
    const tabLinks = new Map();

    function buildTabs() {
      const nav = el('nav', { class: 'cmap-viewtabs', 'aria-label': 'Colormap tools' });
      for (const t of CM.VIEWER_TABS) {
        const a = el('a', { href: `#${t}` }, TAB_TITLES[t]);
        tabLinks.set(t, a);
        nav.append(a);
      }
      return nav;
    }

    function syncTabs() {
      const n = state.selected.length;
      tabLinks.get('compare').textContent = n ? `Compare (${n})` : 'Compare';
    }

    function setTab(tab, { scroll = true } = {}) {
      if (!CM.VIEWER_TABS.includes(tab)) return;
      const changed = tab !== state.tab;
      state.tab = tab;
      for (const [t, a] of tabLinks) {
        if (t === tab) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      const browsing = tab === 'browse';
      ui.bar.hidden = !browsing;
      header.hidden = !browsing;
      browse.hidden = !browsing;
      compare.sec.hidden = tab !== 'compare';
      identify.sec.hidden = tab !== 'identify';
      recolor.sec.hidden = tab !== 'recolor';
      cvd.sec.hidden = tab !== 'cvd';
      if (tab === 'cvd') cvd.show();
      hideTip();
      detail.place();
      compare.syncTray();
      // A new tab starts at its top; the list keeps its place within Browse.
      if (changed && scroll) { root.scrollTop = 0; window.scrollTo(0, 0); }
    }

    // Switch tabs from code (Identify's Show button), as a history entry.
    function goTab(tab) {
      if (location.hash !== `#${tab}`) {
        try {
          history.pushState(history.state, '', `${location.pathname}${location.search}#${tab}`);
        } catch (err) {
          console.warn('Could not update the link', err);
        }
      }
      setTab(tab);
    }

    // The link carries the tab, the comparison and the open map, so any view
    // can be shared as is.
    function updateUrl() {
      const params = new URLSearchParams(location.search);
      params.delete('compare');
      params.delete('map');
      const mine = [
        state.selected.length ? `compare=${state.selected.map(encodeURIComponent).join(',')}` : '',
        state.open ? `map=${encodeURIComponent(state.open)}` : '',
      ];
      const qs = [params.toString(), ...mine].filter(Boolean).join('&');
      try {
        history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
      } catch (err) {
        console.warn('Could not update the link', err); // for example some file:// setups
      }
    }

    // ---- footer: ratings, methods, references ----

    function buildFooter() {
      const d = el('details', { class: 'cmap-about', id: 'cmap-about' });
      d.append(el('summary', {}, 'About the ratings, methods and references'));
      d.append(el('h3', {}, 'How the ratings work'));
      d.append(el('p', {}, 'Each colormap gets up to four ratings: yes (✓), partly (~) or no (✕). They are rules of thumb tuned on the Matplotlib maps, not standards. Hover a rating for the numbers.'));
      d.append(methodList());
      const p = el('p', { class: 'muted' }, 'A ΔE2000 of about 2 is roughly the smallest difference you notice side by side. Color differences use CIEDE2000 (');
      p.append(el('a', { href: '#ref-ciede2000' }, 'Sharma, Wu & Dalal 2005'), ').');
      d.append(p);

      d.append(el('h3', {}, 'References'));
      const ol = el('ol');
      for (const k of refOrder) ol.append(refItem(k));
      d.append(ol);
      d.append(el('h3', {}, 'Methods'));
      d.append(el('p', { class: 'muted' }, 'CVD views simulate Machado et al. (2009) at full severity in linear RGB, the same model matplotlib’s docs use via colorspacious. Grayscale is each color’s CIELAB L*. Color differences are CIEDE2000 (ΔE2000). The CVD tab also offers Brettel et al. (1997) and Viénot et al. (1999), and Machado et al. at partial severity, following the DaltonLens review.'));
      const ol2 = el('ol', { start: String(refOrder.length + 1) });
      for (const k of ['machado', 'cielab', 'ciede2000', 'brettel', 'vienot', 'daltonlens']) ol2.append(refItem(k));
      d.append(ol2);
      const versions = data.sources.map((src) => `${src.label} ${src.version}`);
      d.append(el('p', { class: 'muted small' }, `Colormap data comes from ${versions.slice(0, -1).join(', ')}${versions.length > 1 ? ' and ' : ''}${versions.at(-1)}.`));
      return d;
    }

    // ---- keep the reader's place when the window is resized ----

    // A resize reflows the list and can move the open detail between the
    // drawer and the list, so the page length changes and the content under
    // the reader would jump. We remember what is at the top of the visible
    // area (below the sticky bar) and put it back there after each resize.
    const ANCHORS = '.cmap-item > .cmap-row, .cmap-panel .cmap-detail > *, .cmap-section > summary, .cmap-sub > h3, '
      + '.cmap-compare-head, .cmap-compare-body > *, .cmap-identify > *, .cmap-recolor > *, .cmap-cvd > *, .cmap-about';

    // Above 820px only the page pane scrolls; below it the document does.
    const paneScrolls = () => getComputedStyle(root).overflowY === 'auto';

    function visibleTop() {
      let y = paneScrolls() ? root.getBoundingClientRect().top : 0;
      if (getComputedStyle(top).position === 'sticky') y = Math.max(y, top.getBoundingClientRect().bottom);
      return y;
    }

    function findAnchor() {
      const y = visibleTop();
      for (const el of root.querySelectorAll(ANCHORS)) {
        if (!el.offsetParent) continue; // hidden, or in a folded section
        const r = el.getBoundingClientRect();
        if (r.bottom > y) return { el, offset: r.top - y, height: r.height };
      }
      return null;
    }

    // Put `el` back `offset` below the visible top. When it is partly scrolled
    // past (offset < 0) and its height changed (the plots go from 2 × 2 to one
    // row), keep the same share of it scrolled past instead of the same pixels.
    function alignTo(el, offset, height) {
      const r = el.getBoundingClientRect();
      if (offset < 0 && height > 0) offset *= r.height / height;
      const delta = r.top - visibleTop() - offset;
      if (Math.abs(delta) < 1) return;
      if (paneScrolls()) root.scrollTop += delta;
      else window.scrollBy(0, delta);
    }

    function keepPlaceOnResize() {
      let anchor = findAnchor();
      // Saved at once, at most every 50 ms, plus once after the last event.
      // Not with requestAnimationFrame or only a timer: both are paused or
      // slowed in background windows, which would leave a stale anchor.
      let timer = 0;
      let last = 0;
      const save = () => {
        clearTimeout(timer);
        timer = 0;
        last = performance.now();
        anchor = findAnchor();
      };
      const later = () => {
        if (performance.now() - last > 50) save();
        else if (!timer) timer = setTimeout(save, 50);
      };
      // Scrolling, and clicks or folds that change the layout without a scroll.
      root.addEventListener('scroll', later, { passive: true });
      window.addEventListener('scroll', later, { passive: true });
      root.addEventListener('click', later);
      root.addEventListener('toggle', later, true);

      window.addEventListener('resize', () => {
        // Widening past 820px would leave the document scrolled with no
        // scrollbar, hiding the whole page.
        if (window.innerWidth > 820 && window.scrollY) window.scrollTo(0, 0);
        const before = anchor;
        const moved = detail.place();
        const row = detail.openItem()?.querySelector('.cmap-row');
        if (moved && row && state.tab === 'browse') {
          if (moved.to === 'inline') {
            // From the drawer into the list: show the part that was at the
            // top of the drawer (or the row, with the detail under it).
            if (moved.el) alignTo(moved.el, moved.offset, moved.height);
            else alignTo(row, 0);
          } else {
            // Into the drawer: show there the part that was on screen, and
            // keep its row in view in the list.
            if (before?.el.closest('.cmap-detail')) {
              detail.revealInDrawer(before.el, before.offset, before.height);
              alignTo(row, 0);
            } else if (before) alignTo(before.el, before.offset, before.height);
          }
        } else if (before?.el.isConnected) {
          alignTo(before.el, before.offset, before.height);
        }
        save();
      });
    }

    // ---- page ----

    const ctx = {
      CM, el, svgEl, pct, clamp8, roundRgb, VIEWS, GLYPH, data, state, items, mapByName,
      base, viewData, metrics, sepOf, rev, stripSvg, makeStrip, renderStrip, showTip, hideTip,
      niceAxis, drawAxes, drawSeries, linePlot, figure, profile, stepPoints, POS_TICKS, PW, PH, M, HUE_MIN_CHROMA,
      ratingPills, ratingCells, headerRow, applyStripView, refNumber, refItem, updateUrl, showRow, goTab,
      // Late bound: the modules call each other through these.
      setCompared: (name, on) => compare.setCompared(name, on),
      onCompareChange: () => { syncTabs(); detail.syncCompare(); },
      openDetail: (name) => detail.open(name),
      recolorFigure: (file, line) => { goTab('recolor'); recolor.open(file, line); },
    };
    const detail = CM.setupCmapDetail(ctx);
    const compare = CM.setupCmapCompare(ctx);
    const identify = CM.setupCmapIdentify(ctx);
    const recolor = CM.setupCmapRecolor(ctx);
    const cvd = CM.setupCmapCvd(ctx);

    root.replaceChildren();
    const inner = el('div', { class: 'cmap-inner' });
    inner.append(el('h1', {}, 'Colormaps'));
    inner.append(el('p', { class: 'cmap-intro' }, `The ${data.maps.length} colormaps of Matplotlib, CMasher, Crameri’s Scientific colour maps, cmocean, colorcet, seaborn and CARTOColors as seen, as simulated for three kinds of color-vision deficiency, and in grayscale, rated for uniformity, CVD and grayscale safety, and how well values can be read back. Hover a strip for its values; click to copy the hex.`));
    const ui = buildControls();
    const header = headerRow(true);
    // Tabs, controls and column names share one sticky bar, so they stay
    // readable while scrolling instead of one floating header per section.
    const top = el('div', { class: 'cmap-top' });
    top.append(buildTabs(), ui.bar, header);

    const browse = el('div', { class: 'cmap-browse' });
    const sections = [];
    for (const [group, title, open] of SECTIONS) {
      const maps = data.maps.filter((m) => m.group === group);
      if (!maps.length) continue;
      const sec = el('details', { class: 'cmap-section', id: `cmap-sec-${group}` });
      sec.open = open;
      const sum = el('summary');
      const count = el('span', { class: 'cmap-count' }, String(maps.length));
      sum.append(el('h2', {}, title), count);
      sec.append(sum);
      Object.assign(sec, { _userOpen: open, _count: count, _total: maps.length });
      // Remember what the user chose, to restore it when a search is cleared.
      sum.addEventListener('click', () => { if (!filtering()) sec._userOpen = !sec.open; });
      const subs = [];
      for (const m of maps) if (!subs.includes(m.sub)) subs.push(m.sub);
      for (const sub of subs) {
        const box = el('div', { class: 'cmap-sub' });
        if (sub) box.append(el('h3', {}, sub));
        for (const m of maps.filter((x) => x.sub === sub)) box.append(makeRow(m));
        sec.append(box);
      }
      sections.push(sec);
      browse.append(sec);
    }
    const empty = el('p', { class: 'muted', hidden: '' }, 'No colormap matches your search.');
    browse.append(empty);
    const footer = buildFooter();
    inner.append(top, browse, compare.sec, identify.sec, recolor.sec, cvd.sec, footer);
    root.append(inner, detail.drawer, compare.tray);
    for (const [btn, pop] of popovers) anchorPopover(btn, pop);

    // Links into the footer open it first, so the target is visible.
    root.addEventListener('click', (e) => {
      if (e.target.closest?.('a[href^="#ref-"], a[href="#cmap-about"]')) footer.open = true;
    });
    window.addEventListener('hashchange', () => {
      const r = CM.parseViewerRoute(location.search, location.hash, names);
      if (r.tab) setTab(r.tab);
      else if (/^#(ref-|cmap-about)/.test(location.hash)) footer.open = true;
    });

    applyStripView(root);
    compare.syncButtons();
    compare.render();
    syncTabs();
    setTab(route.tab || 'browse', { scroll: false });
    // Every history entry gets its tab, so Back returns to the right one.
    if (!location.hash) {
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}#${state.tab}`); } catch { /* file:// */ }
    }
    if (route.map) showRow(route.map, { smooth: false });
    keepPlaceOnResize();
    return { items, setReversed(v) { state.reversed = !!v; } };
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
