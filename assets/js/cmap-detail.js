(function (CM) {
  'use strict';

  // The detail view of one colormap in the viewer (colormaps.html). On wide
  // screens it opens in a drawer at the right, so the list stays in place; on
  // narrower ones it opens under its row. One map at a time. The rating
  // sentences and the four plots (short, captions in tooltips) come first;
  // the numbers, where values get confused and the references are folded.

  const WIDE = '(min-width: 1200px)';
  // Plot height in viewBox units, drawn at 1:1: short enough for the four
  // plots to fit above the folds. The width follows, for a square plot box.
  const PLOT_H = 150;

  function setupCmapDetail(ctx) {
    const {
      el, pct, VIEWS, GLYPH, state, items, metrics, viewData, sepOf, profile, stepPoints, niceAxis,
      linePlot, figure, POS_TICKS, M, HUE_MIN_CHROMA, stripCanvas, makeStrip, refNumber, refItem, hideTip,
    } = ctx;
    const wide = window.matchMedia(WIDE);
    const drawer = el('aside', { class: 'cmap-drawer', id: 'cmap-drawer', hidden: '', 'aria-label': 'Colormap details' });
    const folds = new Set(); // folds the user opened; kept when another map is opened
    let current = null; // { entry, box, strips, cmpBtn }
    let mode = null; // where the open detail is shown: 'drawer', 'inline' or null

    // ---- plots ----

    function plotFigs(map) {
      const { colors, Ls, m, C, h, n, qual, xOf, pts, reversed } = profile(map);
      const mode = qual ? 'dots' : 'line';
      const dotR = qual ? 4.5 : 1.8;
      // Three position ticks: five crowd the small square plots.
      let xTicks = POS_TICKS.filter((t) => t.x % 0.5 === 0);
      let xLabel = 'Position';
      if (qual) {
        const every = Math.ceil(n / 10);
        xTicks = [];
        for (let i = 0; i < n; i += every) xTicks.push({ x: xOf(i), label: String(i + 1) });
        xLabel = 'Color number';
      }
      const out = {};
      const H = PLOT_H;
      const W = PLOT_H - M.t - M.b + M.l + M.r; // plot box as wide as it is tall
      const opt = { compact: true };
      const lin = qual ? null : { x1: 0, y1: Ls[0], x2: 1, y2: Ls[n - 1], label: 'linear' };
      out.L = figure('Lightness L*', linePlot({
        map, title: 'Lightness L*', yLabel: 'L*', yMax: 100, yTicks: [0, 20, 40, 60, 80, 100], xTicks, xLabel,
        points: pts(Ls, (v) => `L* = ${v.toFixed(1)}`), mode, ref: lin, dotR, W, H,
      }), qual ? null : 'A straight rising or falling line reads best, in color and in grayscale.', opt);

      if (!qual) {
        const stepPts = stepPoints(map, { colors, n, reversed });
        const k = stepPts.length;
        const axis = niceAxis(Math.max(...stepPts.map((p) => p.y)) * 1.05);
        const mean = m.stepStats.mean;
        out.step = figure('Perceptual step ΔE2000', linePlot({
          map, title: 'Perceptual step ΔE2000', yLabel: 'ΔE2000 per step', yMax: axis.top, yTicks: axis.ticks, xTicks,
          points: stepPts, mode: 'line', ref: { x1: 0, y1: mean, x2: 1, y2: mean, label: 'mean' }, W, H,
        }), `ΔE2000 between neighbors, in steps of 1/${k} of the map. A flat line means equal steps in the data look like equal steps in color.`, opt);
      }

      const cAxis = niceAxis(Math.max(100, Math.max(...C) * 1.05));
      out.C = figure('Chroma C*', linePlot({
        map, title: 'Chroma C*', yLabel: 'C*', yMax: cAxis.top, yTicks: cAxis.ticks, xTicks, xLabel,
        points: pts(C, (v) => `C* = ${v.toFixed(1)}`), mode, dotR, W, H,
      }), 'Colorfulness: 0 is gray.', opt);

      out.h = figure('Hue h°', linePlot({
        map, title: 'Hue h°', yLabel: 'h (°)', yMax: 360, yTicks: [0, 90, 180, 270, 360], xTicks, xLabel,
        points: pts(h, (v) => `h = ${v.toFixed(0)}°`, (i) => C[i] < HUE_MIN_CHROMA), mode: 'dots', dotR: qual ? 4.5 : 1.8, W, H,
      }), `Hue wraps around at 360°, so it is drawn as dots. Colors with C* < ${HUE_MIN_CHROMA} (grays) are left out, since their hue is not defined.`, opt);
      return out;
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

    // ---- numbers per view ----

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

    // One row per view: the smallest separation (with the confused colors) and
    // how well values read back. Hovering a row marks the pair on its strip above.
    function viewTable(map, strips) {
      const qual = map.kind === 'qualitative';
      const m = metrics(map);
      const r = m.readability;
      const worst = CM.worstCvd(m);
      const table = el('table', { class: 'cmap-sep' });
      table.append(el('caption', {}, qual
        ? 'Smallest difference between any two colors'
        : `Smallest difference between values at least 10% apart, and reading values back (differences under ${CM.READ_DE} ΔE are not relied on)`));
      const head = el('tr');
      const cols = ['View', 'Min', 'Between', 'Confused', 'Levels', 'Flat', 'Ambiguous'];
      const tips = [null, 'Smallest ΔE2000 (ΔL* for grayscale)', null, 'The two colors that are closest',
        `Distinguishable levels from end to end (each ${CM.READ_DE} ΔE apart)`,
        `Share where values ${pct(CM.READ_WINDOW)} apart look almost the same`,
        'Share whose color has a look-alike at least 10% away'];
      cols.forEach((t, i) => head.append(el('th', tips[i] ? { scope: 'col', title: tips[i] } : { scope: 'col' }, t)));
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      VIEWS.forEach((v, vi) => {
        const s = sepOf(map, v.key);
        if (!s) return;
        const colors = viewData(map, v.key).colors;
        const n = colors.length;
        const idx = s.t.map((t) => (qual ? t : Math.round(t * (n - 1))));
        const tr = el('tr', v.key === worst ? { class: 'worst' } : {});
        const th = el('th', { scope: 'row' }, v.label);
        if (v.key === worst) th.append(el('span', { class: 'cmap-worst-tag' }, ' worst'));
        tr.append(th);
        tr.append(el('td', {}, `${s.min.toFixed(1)} ${v.key === 'gray' ? 'ΔL*' : 'ΔE'}`));
        tr.append(el('td', {}, qual ? `${s.t[0] + 1} ↔ ${s.t[1] + 1}` : `${s.t[0].toFixed(2)} ↔ ${s.t[1].toFixed(2)}`));
        const sw = el('td', { class: 'cmap-sep-sw' });
        for (const i of idx) {
          const hex = CM.rgbToHex(colors[i]);
          sw.append(el('span', { class: 'cmap-sw', style: `background:${hex}`, title: hex }));
        }
        tr.append(sw);
        const x = r?.[v.key];
        for (const t of x ? [String(x.levels), pct(x.flat), pct(x.ambiguous)] : ['—', '—', '—']) tr.append(el('td', {}, t));
        tr.addEventListener('pointerenter', () => showPair(strips[vi], s.t, qual, n));
        tr.addEventListener('pointerleave', () => clearPair(strips[vi]));
        tbody.append(tr);
      });
      table.append(thead, tbody);
      const wrap = el('div', { class: 'cmap-table-wrap' });
      wrap.append(table);
      return wrap;
    }

    // ---- where values get confused ----

    // Spans are on the original map; flip them when the map is shown reversed.
    const spansOf = (map, spans) => (ctx.isRev(map) ? spans.map(([a, b]) => [1 - b, 1 - a]).reverse() : spans);

    // The strip with two thin tracks below it: where values are flat, and where
    // a color has a look-alike elsewhere. Positions are percentages, so it scales.
    function readTracks(map, viewKey) {
      const r = metrics(map).readability[viewKey];
      const box = el('div', { class: 'cmap-tracks' });
      const strip = el('div', { class: 'cmap-track-strip', role: 'img', 'aria-label': `${map.name} ${VIEWS.find((v) => v.key === viewKey).label}` });
      strip.append(stripCanvas(viewData(map, viewKey).colors, false));
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
      track('Flat', 'flat', spansOf(map, r.flatSpans), 'Flat');
      track('Ambiguous', 'ambiguous', spansOf(map, r.ambiguousSpans), 'Look-alike elsewhere');
      return box;
    }

    // Starts on the worst CVD view: the colormap as seen is usually the least interesting.
    function zones(map) {
      const sec = el('div', { class: 'cmap-read' });
      let view = CM.worstCvd(metrics(map));
      const tabs = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': 'View for the zones' });
      const holder = el('div', { class: 'cmap-read-holder' });
      const show = () => holder.replaceChildren(readTracks(map, view));
      for (const v of VIEWS) {
        const b = el('button', { type: 'button', 'aria-pressed': String(v.key === view) }, v.label);
        b.addEventListener('click', () => {
          view = v.key;
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

    // ---- building and placing ----

    function fold(id, title, kids) {
      const d = el('details', { class: 'cmap-fold' });
      d.open = folds.has(id);
      d.append(el('summary', {}, title), ...kids);
      d.addEventListener('toggle', () => (d.open ? folds.add(id) : folds.delete(id)));
      return d;
    }

    function cmpLabel(btn, name) {
      const on = state.selected.includes(name);
      const full = !on && state.selected.length >= CM.COMPARE_MAX;
      btn.textContent = on ? 'In comparison ✓' : 'Add to comparison';
      btn.setAttribute('aria-pressed', String(on));
      btn.disabled = full;
      btn.title = full ? `Up to ${CM.COMPARE_MAX} maps can be compared` : on ? 'Remove from the comparison' : 'Add to the comparison';
    }

    function build(entry) {
      const { map } = entry;
      const qual = map.kind === 'qualitative';
      const box = el('div', { class: 'cmap-detail' });

      const head = el('div', { class: 'cmap-detail-head' });
      const title = el('h2', { tabindex: '-1' });
      title.append(el('code', {}, map.name));
      const cmpBtn = el('button', { type: 'button', class: 'btn small' });
      cmpLabel(cmpBtn, map.name);
      cmpBtn.addEventListener('click', () => ctx.setCompared(map.name, !state.selected.includes(map.name)));
      const close = el('button', { type: 'button', class: 'cmap-toggle', 'aria-label': 'Close details', title: 'Close (Esc)' });
      close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      close.addEventListener('click', () => api.close({ focus: true }));
      const expand = el('button', { type: 'button', class: 'btn small subtle' });
      head.append(title, expand, cmpBtn, close);

      // All five views, whatever the list shows; the table below marks pairs on them.
      const stripBox = el('div', { class: 'cmap-detail-strips' });
      const strips = VIEWS.map((v) => {
        const s = makeStrip(map, v, true);
        stripBox.append(el('span', { class: 'cmap-cap-side' }, v.label), s);
        return s;
      });

      const notes = el('ul', { class: 'cmap-notes' });
      for (const n of CM.ratingNotes(metrics(map), { qual })) {
        const li = el('li');
        const pill = el('span', { class: `cmap-pill ${n.rating}` });
        pill.append(el('span', { class: 'cmap-glyph', 'aria-hidden': 'true' }, GLYPH[n.rating]), n.label);
        pill.append(el('span', { class: 'sr-only' }, `: ${n.rating}.`));
        li.append(pill, el('span', {}, n.text));
        notes.append(li);
      }
      if (qual) notes.append(el('li', { class: 'muted' }, 'Qualitative maps are not rated for uniformity or readability, since their colors have no order.'));

      const figs = plotFigs(map);
      const plots = el('div', { class: 'cmap-plots cmap-detail-plots' });
      for (const f of [figs.L, figs.step, figs.C, figs.h]) if (f) plots.append(f);

      const keys = CM.citeFor(map.name);
      const refs = el('ol', { class: 'cmap-detail-refs' });
      for (const k of keys) {
        const li = refItem(k, { id: false });
        li.value = refNumber(k);
        refs.append(li);
      }

      const fs = [fold('views', 'Numbers: lightness and per view', [statsList(map), viewTable(map, strips)])];
      if (!qual) fs.push(fold('zones', 'Where values get confused', [zones(map)]));
      if (keys.length) fs.push(fold('refs', 'References', [refs]));
      box.append(head, stripBox, notes, plots, ...fs);

      // One button for all folds: it opens them unless they are all open.
      const sync = () => {
        const all = fs.every((d) => d.open);
        expand.textContent = all ? 'Collapse all' : 'Expand all';
        expand.setAttribute('aria-expanded', String(all));
      };
      expand.addEventListener('click', () => {
        const open = !fs.every((d) => d.open);
        for (const d of fs) d.open = open;
      });
      for (const d of fs) d.addEventListener('toggle', sync);
      sync();
      return { box, strips, cmpBtn, title };
    }

    // The part of the detail at the top of the drawer's visible area, with its
    // offset from there, so the same part can be shown after a move.
    function drawerAnchor() {
      if (drawer.hidden || !current) return null;
      const y = drawer.getBoundingClientRect().top + (parseFloat(getComputedStyle(drawer).paddingTop) || 0);
      for (const el of current.box.children) {
        const r = el.getBoundingClientRect();
        if (r.bottom > y) return { el, offset: r.top - y, height: r.height };
      }
      return null;
    }

    // Drawer on wide screens (only on the Browse tab), under the row otherwise.
    // Returns { to: 'drawer' | 'inline', el, offset } when the open detail
    // moved (el, offset: what was at the top of the drawer), else null.
    function place() {
      const inDrawer = !!current && wide.matches;
      const from = mode;
      const top = from === 'drawer' && !inDrawer ? drawerAnchor() : null;
      drawer.hidden = !(inDrawer && state.tab === 'browse');
      document.body.classList.toggle('cmap-drawer-open', !drawer.hidden);
      if (!current) { mode = null; drawer.replaceChildren(); return null; }
      const { entry, box } = current;
      mode = inDrawer ? 'drawer' : 'inline';
      if (inDrawer) {
        entry.panel.hidden = true;
        if (box.parentNode !== drawer) drawer.replaceChildren(box);
        const bar = document.querySelector('.topbar');
        document.documentElement.style.setProperty('--cmap-drawer-top', `${bar ? Math.round(bar.getBoundingClientRect().bottom) : 0}px`);
        entry.button.setAttribute('aria-controls', drawer.id);
      } else {
        drawer.replaceChildren();
        if (box.parentNode !== entry.panel) entry.panel.replaceChildren(box);
        entry.panel.hidden = false;
        entry.button.setAttribute('aria-controls', entry.panel.id);
      }
      return from && from !== mode ? { to: mode, ...top } : null;
    }

    function teardown() {
      const { entry, box } = current;
      entry.item.classList.remove('open');
      entry.button.setAttribute('aria-expanded', 'false');
      entry.panel.hidden = true;
      box.remove();
      current = null;
      mode = null;
      hideTip();
    }

    const api = {
      drawer,
      open(name) {
        const entry = items.find((e) => e.map.name === name);
        if (!entry) return;
        if (current) teardown();
        state.open = name;
        entry.item.classList.add('open');
        entry.button.setAttribute('aria-expanded', 'true');
        current = { entry, ...build(entry) };
        place();
        if (!drawer.hidden) drawer.scrollTop = 0;
        ctx.updateUrl();
      },
      close({ focus = false } = {}) {
        if (!current) return;
        const { entry } = current;
        teardown();
        state.open = null;
        place();
        ctx.updateUrl();
        if (focus) entry.button.focus();
      },
      // Rebuild after Reversed changes; the open folds stay open.
      refresh() {
        if (!current) return;
        const { entry } = current;
        current.box.remove();
        Object.assign(current, build(entry));
        place();
      },
      syncCompare() {
        if (current) cmpLabel(current.cmpBtn, current.entry.map.name);
      },
      // The open map's row in the list, or null.
      openItem: () => current?.entry.item ?? null,
      // Scroll the drawer so `el` (part of the detail) sits `offset` below its
      // top; a negative offset scales with el's change in height, as in the list.
      revealInDrawer(el, offset = 0, height = 0) {
        if (drawer.hidden || !drawer.contains(el)) return;
        const y = drawer.getBoundingClientRect().top + (parseFloat(getComputedStyle(drawer).paddingTop) || 0);
        const r = el.getBoundingClientRect();
        if (offset < 0 && height > 0) offset *= r.height / height;
        drawer.scrollTop += r.top - y - offset;
      },
      place,
    };

    // place() runs on every resize from the viewer, which also keeps the
    // reader's place in the page (the media query alone can miss a change).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !current || e.defaultPrevented) return;
      if (e.target.closest?.('input, select, textarea') || document.querySelector(':popover-open')) return;
      api.close({ focus: true });
    });
    return api;
  }

  Object.assign(CM, { setupCmapDetail });
})((globalThis.Colormeris ??= {}));
