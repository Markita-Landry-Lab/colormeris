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
  ];
  // [id, label, hint, key in rating]
  const FILTERS = [
    ['uniform', 'Uniform', 'Only colormaps rated uniform', 'uniform'],
    ['cvd', 'CVD-safe', 'Only colormaps rated CVD-safe', 'cvdSafe'],
    ['gray', 'Gray-safe', 'Only colormaps rated grayscale-safe', 'graySafe'],
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

    function makeStrip(map, view) {
      const strip = el('div', {
        class: 'cmap-strip',
        tabindex: '0',
        role: 'img',
        'aria-label': `${map.name} ${view.label}`,
      });
      strip._cm = { map, view: view.key, rendered: false, probe: null };
      strip.append(el('div', { class: 'cmap-marker', hidden: '' }));
      if (observer) observer.observe(strip);
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

    const PW = 420;
    const PH = 200;
    const M = { l: 42, r: 12, t: 10, b: 34 };
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

    // Line or dot plot of one quantity against position (0–1).
    //   points  [{ x, y (null = skip), color: rgb, pos, value }]  value is the tooltip line
    //   mode    'line' (segments in the sample colors) or 'dots'
    //   ref     optional dashed line { x1, y1, x2, y2, label }
    function linePlot({ map, title, yLabel, xLabel = 'Position', yMax, yTicks, xTicks, points, mode, ref, dotR = 3 }) {
      const py = (v) => M.t + (1 - v / yMax) * (PH - M.t - M.b);
      const svg = svgEl('svg', {
        class: 'cmap-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img',
        'aria-label': `${title} of ${map.name} against position`,
      });
      const text = (cls, attrs, str) => {
        const t = svgEl('text', { class: cls, ...attrs });
        t.textContent = str;
        return t;
      };
      for (const v of yTicks) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: M.l, x2: PW - M.r, y1: py(v), y2: py(v) }));
        svg.append(text('cmap-tick', { x: M.l - 6, y: py(v) + 3.5, 'text-anchor': 'end' }, String(v)));
      }
      for (const { x, label } of xTicks) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: px(x), x2: px(x), y1: M.t, y2: PH - M.b }));
        svg.append(text('cmap-tick', { x: px(x), y: PH - M.b + 14, 'text-anchor': 'middle' }, label));
      }
      svg.append(svgEl('rect', { class: 'cmap-axes', x: M.l, y: M.t, width: PW - M.l - M.r, height: PH - M.t - M.b, fill: 'none' }));
      svg.append(text('cmap-axis-label', { x: (M.l + PW - M.r) / 2, y: PH - 4, 'text-anchor': 'middle' }, xLabel));
      svg.append(text('cmap-axis-label', { transform: `translate(11 ${(M.t + PH - M.b) / 2}) rotate(-90)`, 'text-anchor': 'middle' }, yLabel));

      if (ref) {
        svg.append(svgEl('line', { class: 'cmap-linear', x1: px(ref.x1), y1: py(ref.y1), x2: px(ref.x2), y2: py(ref.y2) }));
        const low = ref.y2 > yMax / 2;
        svg.append(text('cmap-linear-label', { x: px(ref.x2) - 4, y: py(ref.y2) + (low ? 14 : -6), 'text-anchor': 'end' }, ref.label));
      }
      if (mode === 'line') {
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i];
          const b = points[i + 1];
          if (a.y == null || b.y == null) continue;
          svg.append(svgEl('line', { class: 'cmap-seg', x1: px(a.x), y1: py(a.y), x2: px(b.x), y2: py(b.y), stroke: CM.rgbToHex(a.color) }));
        }
      } else {
        for (const p of points) {
          if (p.y == null) continue;
          svg.append(svgEl('circle', { class: dotR > 3 ? 'cmap-dot' : 'cmap-pt', cx: px(p.x), cy: py(p.y), r: dotR, fill: CM.rgbToHex(p.color) }));
        }
      }
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

    function buildPlots(map) {
      const colors = viewData(map, 'orig').colors;
      const Ls = viewData(map, 'orig').L;
      const m = metrics(map);
      const C = rev(m.lch.C);
      const h = rev(m.lch.h);
      const n = colors.length;
      const qual = map.kind === 'qualitative';
      const xOf = (i) => (n > 1 ? i / (n - 1) : 0.5);
      const posOf = (i) => (qual ? `color ${i + 1} of ${n}` : `t = ${xOf(i).toFixed(3)}`);
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
      const pts = (ys, fmt, skip) => colors.map((c, i) => ({
        x: xOf(i), y: skip && skip(i) ? null : ys[i], color: c, pos: posOf(i), value: fmt(ys[i]),
      }));
      const grid = el('div', { class: 'cmap-plots' });

      const lin = qual ? null : { x1: 0, y1: Ls[0], x2: 1, y2: Ls[n - 1], label: 'linear' };
      grid.append(figure('Lightness L*', linePlot({
        map, title: 'Lightness L*', yLabel: 'L*', yMax: 100, yTicks: [0, 20, 40, 60, 80, 100], xTicks, xLabel,
        points: pts(Ls, (v) => `L* = ${v.toFixed(1)}`), mode, ref: lin, dotR,
      })));

      if (!qual) {
        const steps = rev(m.steps);
        const k = steps.length;
        const axis = niceAxis(Math.max(...steps) * 1.05);
        const stepPts = steps.map((v, i) => {
          const t = (i + 0.5) / k;
          return {
            x: t, y: v, color: colors[Math.round(t * (n - 1))],
            pos: `t = ${(i / k).toFixed(3)}–${((i + 1) / k).toFixed(3)}`, value: `ΔE2000 = ${v.toFixed(2)}`,
          };
        });
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

    function fillPanel(entry) {
      for (const s of entry.strips) clearPair(s);
      entry.panel.replaceChildren(buildPlots(entry.map), statsList(entry.map), sepTable(entry));
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
      const wrap = el('div', { class: 'cmap-badges' });
      for (const [label, r, title] of pills) {
        const b = el('span', { class: `cmap-pill ${r}`, title });
        b.append(el('span', { class: 'cmap-glyph', 'aria-hidden': 'true' }, GLYPH[r]), `${label}`);
        b.append(el('span', { class: 'sr-only' }, `: ${WORD[r]}`));
        wrap.append(b);
      }
      return wrap;
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
      row.append(button);

      const panel = el('div', { class: 'cmap-panel', id: panelId, hidden: '' });
      item.append(row, panel);
      item.dataset.name = map.name.toLowerCase();
      const entry = { map, item, strips, panel, button, open: false, order: items.length };
      button.addEventListener('click', () => { toggle(entry); syncAll(); });
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
      bar.append(search, sortLabel, filters, revLabel, all, jump);
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
      });
      return { bar, search, all, sort, boxes };
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

    function buildMethod() {
      const R = CM.CMAP_RATING;
      const pc = (v) => `${Math.round(v * 100)}%`;
      const d = el('details', { class: 'cmap-method' });
      d.append(el('summary', {}, 'How the ratings work'));
      d.append(el('p', {}, 'Each colormap gets three ratings: yes (✓), partly (~) or no (✕). They are rules of thumb tuned on the matplotlib maps, not standards. Hover a pill for the numbers.'));
      const ul = el('ul');
      const li = (head, ...parts) => {
        const x = el('li');
        x.append(el('strong', {}, `${head} `), ...parts);
        ul.append(x);
      };
      li('Uniform.', `We measure the color difference (ΔE2000) between neighbors among 64 evenly spaced colors. The rating uses how much these steps vary, as the coefficient of variation (CV = standard deviation / mean): yes at CV ≤ ${R.uniform.yes}, partly up to ${R.uniform.partly}. A uniform map shows equal steps in the data as equal steps in color. Qualitative maps are not rated.`);
      li('CVD-safe.', `For the map and for each CVD view we find the smallest ΔE2000 between two values at least 10% of the map apart (cyclic maps count around the circle, qualitative maps compare all pairs). The worst CVD view must keep at least ${pc(R.cvd.yes.ratio)} of the map’s own smallest difference and at least ${R.cvd.yes.min} ΔE for yes, or ${pc(R.cvd.partly.ratio)} and ${R.cvd.partly.min} ΔE for partly.`);
      li('Grayscale-safe.', `The same search on L* alone: values 10% apart differ by at least ${R.gray.yes} L* for yes, or ${R.gray.partly} L* for partly.`);
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
    inner.append(el('p', { class: 'cmap-intro' }, 'Each colormap is shown as seen, as simulated for three kinds of color-vision deficiency, and in grayscale. Hover a strip for its hex and RGB values, click to copy the hex, or open a row to see its lightness (L*), step, chroma and hue profiles and how far apart its values stay in each view. The pills under each name rate it as uniform, CVD-safe and grayscale-safe. A colormap that is not monotonic in L* makes the figure harder to read, in grayscale and in color.'));
    inner.append(buildMethod());
    const ui = buildControls();
    // Controls and column names share one sticky bar, so they stay readable
    // while scrolling instead of one floating header per section.
    const top = el('div', { class: 'cmap-top' });
    top.append(ui.bar, headerRow());
    inner.append(top);

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
