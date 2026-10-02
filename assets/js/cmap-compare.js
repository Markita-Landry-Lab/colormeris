(function (CM) {
  'use strict';

  // The Compare tab of the colormap viewer (colormaps.html): up to 10 maps
  // side by side as strips, four plots with every map on the same axes, and a
  // sortable table of the numbers, and every map applied to a sine-wave test
  // image. While maps are chosen, a tray at the bottom
  // of the Browse tab lists them. The choice lives in ?compare=.

  // Same size and square plot box as the plots of one map, so the four
  // quantities sit in one row; names are in the shared legend below.
  const CMP_METRICS = [
    { key: 'L', label: 'Lightness L*', yLabel: 'L*' },
    { key: 'step', label: 'Perceptual step ΔE2000', yLabel: 'ΔE2000 per step' },
    { key: 'C', label: 'Chroma C*', yLabel: 'C*' },
    { key: 'h', label: 'Hue h°', yLabel: 'h (°)' },
  ];

  function setupCmapCompare(ctx) {
    const {
      el, svgEl, pct, VIEWS, state, items, mapByName, viewData, metrics, profile, stepPoints, niceAxis,
      drawAxes, drawSeries, figure, POS_TICKS, PW, PH, M, HUE_MIN_CHROMA, stripSvg, makeStrip,
      showTip, hideTip, ratingPills, ratingCells, headerRow, applyStripView,
    } = ctx;
    const MAX_CMP = CM.COMPARE_MAX;
    const CP = { W: PW, H: PH, m: M };
    const selected = state.selected;
    const cmp = {}; // elements of the compare view, set by buildCompare
    let cmpSort = null; // { id, dir } for the numbers table; null = selection order
    let allCols = false; // the numbers table shows only the key columns until asked
    let sinePat = 'waves'; // test image of the sine section: 'waves' or 'bumps'
    let sineView = 'orig'; // one of VIEWS

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

      // Same tooltips as the plots of one map, so the plot row stays short.
      const caps = {
        L: 'A straight rising or falling line reads best, in color and in grayscale.',
        step: 'ΔE2000 between neighboring colors. A flat line means equal steps in the data look like equal steps in color.',
        C: 'Colorfulness: 0 is gray.',
        h: `Hue wraps around at 360°, so it is drawn as dots. Colors with C* < ${HUE_MIN_CHROMA} (grays) are left out, since their hue is not defined.`,
      };
      return { fig: figure(metric.label, svg, caps[key], { compact: true }), svg, groups };
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
    // `key` columns are shown by default; the rest on "All numbers". Columns of
    // one group sit next to each other, under one group header.
    const NUM_COLS = [
      { id: 'name', label: 'Colormap', key: true, get: (f) => f.map.name.toLowerCase() },
      { id: 'range', group: 'Lightness', key: true, label: 'L* range', hint: 'Spread of lightness. Wider means more contrast.', best: 'max', dp: 0,
        get: (f) => f.ls.range[1] - f.ls.range[0], show: (f) => `${f.ls.range[0].toFixed(0)}–${f.ls.range[1].toFixed(0)}` },
      { id: 'mono', group: 'Lightness', label: 'Monotonic', hint: 'Does L* only rise or only fall? Fewer reversals are better.', best: 'min', dp: 0,
        get: (f) => (f.qual ? null : f.ls.reversals), show: (f) => (f.qual ? '—' : `${f.ls.monotonic ? 'yes' : 'no'} (${f.ls.reversals})`) },
      { id: 'r2', group: 'Lightness', label: 'L* R²', hint: 'How close L* is to a straight line. Higher is better.', best: 'max', dp: 3,
        get: (f) => (f.qual ? null : f.ls.r2), show: (f) => (f.qual || f.ls.r2 == null ? '—' : f.ls.r2.toFixed(3)) },
      { id: 'cv', group: 'Uniformity', key: true, label: 'Step CV', hint: 'Variation of the ΔE2000 steps. Lower is better.', best: 'min', dp: 2,
        get: (f) => (f.qual ? null : f.m.stepStats.cv), show: (f) => (f.qual ? '—' : f.m.stepStats.cv.toFixed(2)) },
      { id: 'max', group: 'Uniformity', label: 'Max step ΔE', hint: 'Largest ΔE2000 jump between neighbors. Lower is better.', best: 'min', dp: 2,
        get: (f) => (f.qual ? null : f.m.stepStats.max), show: (f) => (f.qual ? '—' : f.m.stepStats.max.toFixed(2)) },
      { id: 'cvd', group: 'Color vision', key: true, label: 'Worst CVD view', hint: 'Smallest ΔE2000 in the worst color-vision view, and the share of the map’s own separation it keeps. Higher is better.', best: 'max', dp: 1,
        get: (f) => f.m.cvdWorst, show: (f) => `${f.worstLabel} ${f.m.cvdWorst.toFixed(1)} ΔE (${pct(f.m.cvdRatio)})` },
      { id: 'gray', group: 'Color vision', label: 'Gray min ΔL*', hint: 'Smallest L* difference in grayscale. Higher is better.', best: 'max', dp: 1,
        get: (f) => f.m.separations.gray?.min ?? null, show: (f) => (f.m.separations.gray ? f.m.separations.gray.min.toFixed(1) : '—') },
      { id: 'levels', group: 'Readability', key: true, label: 'Levels', hint: `Distinguishable levels from end to end (each ${CM.READ_DE} ΔE apart). Higher is better.`, best: 'max', dp: 0,
        get: (f) => f.m.readability?.orig.levels ?? null, show: (f) => (f.m.readability ? String(f.m.readability.orig.levels) : '—') },
      { id: 'flat', group: 'Readability', label: 'Flat %', hint: 'Share of the map where values 5% apart look almost the same. Lower is better.', best: 'min', dp: 2,
        get: (f) => f.m.readability?.orig.flat ?? null, show: (f) => (f.m.readability ? pct(f.m.readability.orig.flat) : '—') },
      { id: 'amb', group: 'Readability', key: true, label: 'Ambiguous %', hint: 'Share of the map whose color has a look-alike elsewhere. Lower is better.', best: 'min', dp: 2,
        get: (f) => f.m.readability?.orig.ambiguous ?? null, show: (f) => (f.m.readability ? pct(f.m.readability.orig.ambiguous) : '—') },
      { id: 'rating', group: 'Ratings', label: 'Ratings', noSort: true },
    ];

    function facts(map) {
      const m = metrics(map);
      const worst = CM.worstCvd(m);
      return { map, m, ls: CM.lightnessStats(viewData(map, 'orig').L), qual: map.kind === 'qualitative', worstLabel: VIEWS.find((v) => v.key === worst).label };
    }

    function compareTable(list) {
      const cols = NUM_COLS.filter((c) => allCols || c.key);
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
      for (const c of cols) {
        if (!c.best) continue;
        const vals = rows.map((f) => c.get(f)).filter((v) => v != null).map((v) => rnd(c, v));
        if (vals.length < 2) continue;
        const b = c.best === 'max' ? Math.max(...vals) : Math.min(...vals);
        if (vals.some((v) => v !== b)) best[c.id] = b;
      }

      const table = el('table', { class: 'cmap-nums' });
      // Group headers over runs of columns of the same group.
      const groupRow = el('tr', { class: 'cmap-groups' });
      for (let i = 0; i < cols.length;) {
        let j = i + 1;
        while (j < cols.length && cols[j].group && cols[j].group === cols[i].group) j++;
        groupRow.append(el('th', { scope: 'colgroup', colspan: String(j - i) }, cols[i].group || ''));
        i = j;
      }
      const head = el('tr');
      for (const c of cols) {
        const th = el('th', { scope: 'col', 'data-col': c.id });
        if (c.noSort) {
          th.textContent = c.label;
        } else {
          th.setAttribute('aria-sort', cmpSort?.id === c.id ? (cmpSort.dir > 0 ? 'ascending' : 'descending') : 'none');
          const b = el('button', { type: 'button', class: 'cmap-th', title: `${c.hint ? `${c.hint} ` : ''}Click to sort.` }, c.label);
          b.addEventListener('click', () => {
            // none -> ascending -> descending -> back to selection order
            if (cmpSort?.id !== c.id) cmpSort = { id: c.id, dir: 1 };
            else cmpSort = cmpSort.dir > 0 ? { id: c.id, dir: -1 } : null;
            renderTable(list);
            cmp.table.querySelector(`th[data-col="${c.id}"] button`)?.focus();
          });
          th.append(b);
        }
        if (c.hint && c.noSort) th.title = c.hint;
        head.append(th);
      }
      const thead = el('thead');
      thead.append(groupRow, head);
      const tbody = el('tbody');
      for (const f of rows) {
        const tr = el('tr');
        const th = el('th', { scope: 'row' });
        th.append(el('code', {}, f.map.name), miniStrip(f.map));
        tr.append(th);
        for (const c of cols.slice(1)) {
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
        const cell = el('div', { class: j === 0 ? 'cmap-cell main' : 'cmap-cell', 'data-view': v.key });
        cell.append(el('span', { class: 'cmap-cap' }, v.label), makeStrip(map, v, true));
        row.append(cell);
      });
      row.append(...ratingCells(map));
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

    // ---- sine-wave test images ----

    const SINE_N = 256; // pixels per side
    const SINE_PATTERNS = [
      { key: 'waves', label: 'Sine waves', cap: 'Two tilted sine waves and rings around an off-center point, added up and stretched to the whole range: smooth hills (high values), dips (low values) and saddles that never repeat. The data has no edges, so any edge or band you see comes from the colormap.' },
      { key: 'bumps', label: 'Equal bumps', cap: 'A smooth ramp from low (top left) to high (bottom right) with 36 bumps of exactly the same height, one at every level. A perceptually uniform sequential map shows every bump equally clearly and the ramp without bands. Other maps hide bumps where they are flat and make others stand out, so equal changes look unequal.' },
    ];
    const sineValues = new Map(); // pattern key -> values, computed once

    function sineCanvas(map, values) {
      const qual = map.kind === 'qualitative';
      const colors = viewData(map, sineView).colors;
      const cv = el('canvas', {
        class: 'cmap-sine-img', width: String(SINE_N), height: String(SINE_N), role: 'img',
        'aria-label': `${map.name} applied to the ${SINE_PATTERNS.find((p) => p.key === sinePat).label.toLowerCase()} test image`,
      });
      const g = cv.getContext('2d');
      const img = g.createImageData(SINE_N, SINE_N);
      CM.paintValues(values, CM.colorsLut(colors, qual), img.data);
      g.putImageData(img, 0, 0);
      cv.addEventListener('pointermove', (e) => {
        const r = cv.getBoundingClientRect();
        const i = Math.min(SINE_N - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * SINE_N)));
        const j = Math.min(SINE_N - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * SINE_N)));
        const k = (j * SINE_N + i) * 4;
        const c = [img.data[k], img.data[k + 1], img.data[k + 2]];
        const hex = CM.rgbToHex(c);
        showTip({ hex, title: map.name, text: [`value ${values[j * SINE_N + i].toFixed(3)}`, hex, `rgb(${c[0]}, ${c[1]}, ${c[2]})`] }, e.clientX, e.clientY);
      });
      cv.addEventListener('pointerleave', hideTip);
      return cv;
    }

    function renderSine(list) {
      if (!sineValues.has(sinePat)) sineValues.set(sinePat, CM.sinePattern(SINE_N, sinePat));
      const values = sineValues.get(sinePat);
      const grid = el('div', { class: 'cmap-sine-grid' });
      for (const map of list) {
        const fig = el('figure', { class: 'cmap-sine-fig' });
        const cap = el('figcaption');
        cap.append(el('code', {}, map.name));
        fig.append(sineCanvas(map, values), cap);
        grid.append(fig);
      }
      cmp.sineCap.textContent = SINE_PATTERNS.find((p) => p.key === sinePat).cap;
      cmp.sine.replaceChildren(grid);
    }

    // A row of pressed-state buttons; `onPick(key)` after the choice changes.
    function choiceTabs(label, options, current, onPick) {
      const tabs = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': label });
      for (const o of options) {
        const b = el('button', { type: 'button', 'aria-pressed': String(o.key === current) }, o.label);
        b.addEventListener('click', () => {
          for (const x of tabs.children) x.setAttribute('aria-pressed', String(x === b));
          onPick(o.key);
        });
        tabs.append(b);
      }
      return tabs;
    }

    function renderStrips(list) {
      const box = el('div', { class: 'cmap-compare-rows' });
      box.append(headerRow());
      list.forEach((map, i) => {
        const item = el('div', { class: 'cmap-item' });
        item.append(compareRow(map, i, list));
        box.append(item);
      });
      applyStripView(box);
      cmp.strips.replaceChildren(box);
    }

    function renderTable(list) {
      const wrap = el('div', { class: 'cmap-table-wrap' });
      wrap.append(compareTable(list));
      cmp.table.replaceChildren(wrap);
    }

    function render() {
      const list = selected.map((n) => mapByName.get(n));
      cmp.count.textContent = list.length ? `Comparing ${list.length} of up to ${MAX_CMP}` : 'Compare';
      cmp.empty.hidden = list.length > 0;
      cmp.body.hidden = !list.length;
      cmp.clear.disabled = cmp.copyLink.disabled = !list.length;
      const full = list.length >= MAX_CMP;
      cmp.picker.disabled = full;
      cmp.picker.title = full ? `Up to ${MAX_CMP} maps can be compared` : '';
      hideTip();
      if (!list.length) {
        for (const k of ['strips', 'plot', 'table', 'sine']) cmp[k].replaceChildren();
        return;
      }
      renderStrips(list);
      cmp.plot.replaceChildren(comparePlot(list));
      renderTable(list);
      renderSine(list);
    }

    function syncButtons() {
      const full = selected.length >= MAX_CMP;
      for (const e of items) {
        const on = selected.includes(e.map.name);
        e.item.classList.toggle('compared', on);
        e.cmpBtn.setAttribute('aria-pressed', String(on));
        e.cmpBtn.disabled = !on && full;
        e.cmpBtn.title = on ? `Remove ${e.map.name} from comparison` : full ? `Up to ${MAX_CMP} maps can be compared` : `Add ${e.map.name} to comparison`;
      }
    }

    // ---- tray (Browse tab) ----

    const tray = el('div', { class: 'cmap-tray', hidden: '', role: 'region', 'aria-label': 'Comparison' });
    const trayChips = el('div', { class: 'cmap-tray-chips' });
    const trayOpen = el('a', { class: 'btn small primary', href: '#compare' }, 'Open comparison');
    const trayClear = el('button', { type: 'button', class: 'btn small' }, 'Clear');
    trayClear.addEventListener('click', () => { selected.length = 0; commit(); });
    tray.append(el('span', { class: 'cmap-tray-label' }, 'Comparing'), trayChips, trayOpen, trayClear);

    function syncTray() {
      tray.hidden = !(selected.length && state.tab === 'browse');
      document.body.classList.toggle('cmap-tray-on', !tray.hidden);
      trayChips.replaceChildren(...selected.map((name) => {
        const chip = el('span', { class: 'cmap-chip' });
        chip.append(miniStrip(mapByName.get(name)), el('code', {}, name));
        const x = el('button', { type: 'button', class: 'cmap-chip-x', 'aria-label': `Remove ${name} from comparison`, title: 'Remove' }, '×');
        x.addEventListener('click', () => {
          removeCompared(name);
          // Keep the keyboard in the tray: on the next chip, or on Clear.
          (trayChips.querySelector('.cmap-chip-x') || (tray.hidden ? null : trayClear))?.focus();
        });
        chip.append(x);
        return chip;
      }));
    }

    // `focus` names the button to focus again, since the view is rebuilt.
    function commit(focus) {
      ctx.updateUrl();
      syncButtons();
      render();
      syncTray();
      ctx.onCompareChange();
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
      commit();
    }

    function moveCompared(name, d) {
      const i = selected.indexOf(name);
      const j = i + d;
      if (i < 0 || j < 0 || j >= selected.length) return;
      [selected[i], selected[j]] = [selected[j], selected[i]];
      commit({ name, act: d < 0 ? 'up' : 'down' });
    }

    function removeCompared(name) {
      const i = selected.indexOf(name);
      if (i < 0) return;
      selected.splice(i, 1);
      commit(state.tab === 'compare' && selected.length ? { name: selected[Math.min(i, selected.length - 1)], act: 'remove' } : null);
    }

    function buildCompare() {
      const sec = el('section', { class: 'cmap-compare', id: 'cmap-compare', 'aria-labelledby': 'cmap-compare-count', hidden: '' });
      const head = el('div', { class: 'cmap-compare-head' });
      const count = el('h2', { id: 'cmap-compare-count', tabindex: '-1' });
      const clear = el('button', { type: 'button', class: 'btn small' }, 'Clear');
      const copyLink = el('button', { type: 'button', class: 'btn small' }, 'Copy link');
      clear.addEventListener('click', () => { selected.length = 0; commit(); });
      let timer = 0;
      copyLink.addEventListener('click', async () => {
        let msg = 'Copied';
        try { await navigator.clipboard.writeText(location.href); } catch (err) { console.warn('Could not copy', err); msg = 'Copy failed'; }
        copyLink.textContent = msg;
        clearTimeout(timer);
        timer = setTimeout(() => { copyLink.textContent = 'Copy link'; }, 1500);
      });
      head.append(count, clear, copyLink);

      // Add maps by name, as an alternative to the + in Browse.
      const picker = CM.createMapPicker(ctx, {
        id: 'cmap-cmp',
        label: 'Add a colormap',
        placeholder: 'Add a colormap: type to search',
        current: () => null,
        onChoose: (name) => setCompared(name, true),
      });
      const add = el('div', { class: 'cmap-compare-add' });
      add.append(picker.box);

      const empty = el('p', { class: 'muted' });
      const link = el('a', { href: '#browse' }, 'Browse');
      empty.append('No colormaps chosen yet. In ', link, ', press + on a row to add it (up to 10).');

      const strips = el('div');
      const plot = el('div');
      const table = el('div');
      const numsHead = el('div', { class: 'cmap-nums-head' });
      const allBtn = el('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false' }, 'All numbers');
      allBtn.addEventListener('click', () => {
        allCols = !allCols;
        allBtn.setAttribute('aria-pressed', String(allCols));
        allBtn.classList.toggle('active', allCols);
        renderTable(selected.map((n) => mapByName.get(n)));
      });
      numsHead.append(el('h3', {}, 'Numbers'), allBtn);

      const sine = el('div');
      const sineCap = el('p', { class: 'cmap-fig-cap muted' });
      const current = () => selected.map((n) => mapByName.get(n));
      const sineHead = el('div', { class: 'cmap-sine-head' });
      sineHead.append(
        el('h3', {}, 'Sine wave test'),
        choiceTabs('Test image', SINE_PATTERNS, sinePat, (k) => { sinePat = k; renderSine(current()); }),
        choiceTabs('View', VIEWS, sineView, (k) => { sineView = k; renderSine(current()); }),
      );

      const body = el('div', { class: 'cmap-compare-body' });
      const h3 = (t) => el('h3', {}, t);
      body.append(h3('Colormaps'), strips, h3('Profiles'), plot, numsHead, table, sineHead, sineCap, sine);
      sec.append(head, add, empty, body);
      Object.assign(cmp, { sec, picker: picker.input, count, strips, plot, table, sine, sineCap, empty, body, clear, copyLink });
      return sec;
    }

    buildCompare();
    return { sec: cmp.sec, tray, render, syncButtons, syncTray, setCompared };
  }

  Object.assign(CM, { setupCmapCompare });
})((globalThis.Colormeris ??= {}));
