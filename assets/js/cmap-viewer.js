(function (CM) {
  'use strict';

  // The colormap viewer page (colormaps.html). Every colormap is shown as five
  // vector SVG strips (as seen, three color-vision-deficiency simulations,
  // grayscale), with hover values and an expandable L* plot. The data comes
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

    // ---- L* plot ----

    const PW = 600;
    const PH = 240;
    const M = { l: 46, r: 14, t: 12, b: 38 };
    const px = (t) => M.l + t * (PW - M.l - M.r);
    const py = (L) => M.t + (1 - L / 100) * (PH - M.t - M.b);

    function buildPlot(map) {
      const vd = viewData(map, 'orig');
      const n = vd.colors.length;
      const qual = map.kind === 'qualitative';
      const tOf = (i) => (n > 1 ? i / (n - 1) : 0.5);
      const svg = svgEl('svg', {
        class: 'cmap-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img',
        'aria-label': `Lightness L* of ${map.name} against position`,
      });
      for (const L of [0, 20, 40, 60, 80, 100]) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: M.l, x2: PW - M.r, y1: py(L), y2: py(L) }));
        const t = svgEl('text', { class: 'cmap-tick', x: M.l - 6, y: py(L) + 3.5, 'text-anchor': 'end' });
        t.textContent = L;
        svg.append(t);
      }
      for (const x of [0, 0.25, 0.5, 0.75, 1]) {
        svg.append(svgEl('line', { class: 'cmap-grid', x1: px(x), x2: px(x), y1: M.t, y2: PH - M.b }));
        const t = svgEl('text', { class: 'cmap-tick', x: px(x), y: PH - M.b + 15, 'text-anchor': 'middle' });
        t.textContent = x;
        svg.append(t);
      }
      svg.append(svgEl('rect', { class: 'cmap-axes', x: M.l, y: M.t, width: PW - M.l - M.r, height: PH - M.t - M.b, fill: 'none' }));
      const xl = svgEl('text', { class: 'cmap-axis-label', x: (M.l + PW - M.r) / 2, y: PH - 6, 'text-anchor': 'middle' });
      xl.textContent = 'Position';
      const yl = svgEl('text', { class: 'cmap-axis-label', transform: `translate(12 ${(M.t + PH - M.b) / 2}) rotate(-90)`, 'text-anchor': 'middle' });
      yl.textContent = 'Lightness L*';
      svg.append(xl, yl);

      if (!qual) {
        svg.append(svgEl('line', { class: 'cmap-linear', x1: px(0), y1: py(vd.L[0]), x2: px(1), y2: py(vd.L[n - 1]) }));
        const lab = svgEl('text', { class: 'cmap-linear-label', x: px(1) - 4, y: py(vd.L[n - 1]) + (vd.L[n - 1] > 50 ? 14 : -6), 'text-anchor': 'end' });
        lab.textContent = 'linear';
        svg.append(lab);
        for (let i = 0; i < n - 1; i++) {
          svg.append(svgEl('line', {
            class: 'cmap-seg', x1: px(tOf(i)), y1: py(vd.L[i]), x2: px(tOf(i + 1)), y2: py(vd.L[i + 1]),
            stroke: CM.rgbToHex(vd.colors[i]),
          }));
        }
      } else {
        for (let i = 0; i < n; i++) {
          svg.append(svgEl('circle', { class: 'cmap-dot', cx: px(tOf(i)), cy: py(vd.L[i]), r: 5, fill: CM.rgbToHex(vd.colors[i]) }));
        }
      }
      const guide = svgEl('line', { class: 'cmap-guide', y1: M.t, y2: PH - M.b, visibility: 'hidden' });
      svg.append(guide);

      function nearest(clientX) {
        const r = svg.getBoundingClientRect();
        const t = ((clientX - r.left) / r.width * PW - M.l) / (PW - M.l - M.r);
        return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
      }
      svg.addEventListener('pointermove', (e) => {
        const i = nearest(e.clientX);
        guide.setAttribute('x1', px(tOf(i)));
        guide.setAttribute('x2', px(tOf(i)));
        guide.setAttribute('visibility', 'visible');
        showTip(tipInfo(map, 'L* plot', vd.colors, vd.L, i), e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', () => { guide.setAttribute('visibility', 'hidden'); hideTip(); });
      return svg;
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
        ul.append(el('li', { class: 'muted' }, 'Qualitative colors have no order, so monotonicity and linearity do not apply.'));
        return ul;
      }
      add('Monotonic', `${s.monotonic ? 'yes' : 'no'} (${s.reversals} reversal${s.reversals === 1 ? '' : 's'})`);
      add('Linearity R² (line fit)', s.r2 == null ? '— (flat)' : s.r2.toFixed(3));
      add('Max deviation from linear', `${s.maxDev.toFixed(1)} L*`);
      add('L* range', `${s.range[0].toFixed(0)}–${s.range[1].toFixed(0)}`);
      return ul;
    }

    function fillPanel(entry) {
      entry.panel.replaceChildren(buildPlot(entry.map), statsList(entry.map));
    }

    function toggle(entry) {
      entry.open = !entry.open;
      entry.button.setAttribute('aria-expanded', String(entry.open));
      entry.panel.hidden = !entry.open;
      if (entry.open) fillPanel(entry);
      else entry.panel.replaceChildren();
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
        'aria-label': `Lightness plot for ${map.name}`, title: 'Show L* plot',
      });
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      row.append(button);

      const panel = el('div', { class: 'cmap-panel', id: panelId, hidden: '' });
      item.append(row, panel);
      item.dataset.name = map.name.toLowerCase();
      const entry = { map, item, strips, panel, button, open: false };
      button.addEventListener('click', () => toggle(entry));
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
      const revLabel = el('label', { class: 'cmap-rev' });
      const rev = el('input', { type: 'checkbox' });
      revLabel.append(rev, ' Reversed');
      const jump = el('nav', { class: 'cmap-jump', 'aria-label': 'Sections' });
      for (const [g, title] of SECTIONS) jump.append(el('a', { href: `#cmap-sec-${g}` }, title));
      bar.append(search, revLabel, jump);
      search.addEventListener('input', applyFilter);
      rev.addEventListener('change', () => {
        reversed = rev.checked;
        for (const entry of items) {
          for (const s of entry.strips) if (s._cm.rendered) renderStrip(s);
          if (entry.open) fillPanel(entry);
        }
        hideTip();
      });
      return { bar, search };
    }

    function applyFilter() {
      const q = ui.search.value.trim().toLowerCase();
      for (const entry of items) entry.item.hidden = q !== '' && !entry.item.dataset.name.includes(q);
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
      sec.append(el('p', { class: 'muted' }, 'CVD views simulate Machado et al. (2009) at full severity in linear RGB, the same model matplotlib’s docs use via colorspacious. Grayscale is each color’s CIELAB L*.'));
      const ol2 = el('ol', { start: String(refOrder.length + 1) });
      for (const k of ['machado', 'cielab']) ol2.append(refItem(k));
      sec.append(ol2);
      sec.append(el('p', { class: 'muted small' }, `Colormap data comes from ${data.source} ${data.version}.`));
      return sec;
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
    inner.append(el('p', { class: 'cmap-intro' }, 'Each colormap is shown as seen, as simulated for three kinds of color-vision deficiency, and in grayscale. Hover a strip for its hex and RGB values, click to copy the hex, or open a row to see its lightness (L*) profile. A colormap that is not monotonic in L* makes the figure harder to read, in grayscale and in color.'));
    const ui = buildControls();
    inner.append(ui.bar);

    for (const [group, title] of SECTIONS) {
      const maps = data.maps.filter((m) => m.group === group);
      if (!maps.length) continue;
      const sec = el('section', { class: 'cmap-section', id: `cmap-sec-${group}` });
      sec.append(el('h2', {}, title), headerRow());
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
