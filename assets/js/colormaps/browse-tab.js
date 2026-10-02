(function (CM) {
  'use strict';

  // The Browse tab of the colormap viewer: one row per map in folding
  // sections (five strips, rating columns, reverse / compare / details
  // buttons), the controls (search, views, filters, sort, Reversed) and the
  // column header that sorts. Rows fill in their ratings when they come near
  // the viewport. The detail view and Compare are reached through ctx.detail
  // and ctx.compare, set once they exist.

  // [group, title, open at first]. With over 300 maps, all start closed; inside a
  // section, only Matplotlib's sub-headings start open.
  const SECTIONS = [
    ['sequential', 'Sequential', false],
    ['diverging', 'Diverging', false],
    ['cyclic', 'Cyclic', false],
    ['rainbow', 'Rainbow', false],
    ['multi-sequential', 'Multi-sequential', false],
    ['qualitative', 'Qualitative', false],
    ['others', 'Others', false],
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
  const VIEW_KEY = 'colormeris.cmapView'; // localStorage: 'all' or one view key

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

  function setupCmapBrowse(ctx) {
    const { el, VIEWS, RATING_COLS, data, state, items, root, metrics, viewData, isRev, makeStrip, renderStrip, hideTip, ratingPills, ratingCells, refNumber, methodList } = ctx;
    state.stripView = loadStripView();
    let uid = 0;

    // Ratings need the metrics, a few ms per map, which for every map took
    // most of the start-up time. List rows fill theirs in when they come near
    // the viewport (sections start closed), and the rest are computed while
    // the page is idle, so sorting and filtering by rating stay quick.
    const rowObserver = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          rowObserver.unobserve(e.target);
          e.target._fill();
        }
      }, { rootMargin: '400px 0px' })
      : null;

    function precomputeMetrics() {
      const queue = data.maps.slice();
      const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 50));
      const step = (deadline) => {
        while (queue.length && deadline.timeRemaining() > 4) metrics(queue.shift());
        if (queue.length) idle(step);
      };
      idle(step);
    }

    function makeRow(map) {
      const item = el('div', { class: 'cmap-item' });
      const row = el('div', { class: 'cmap-row' });
      const panelId = `cmap-panel-${++uid}`;
      for (const k of CM.citeFor(map.name)) refNumber(k); // footer numbers follow the list order

      const name = el('div', { class: 'cmap-name' });
      const code = el('code', { class: 'cmap-name-link', title: `Show details of ${map.name}` }, map.name);
      name.append(code);
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
      const cells = RATING_COLS.map(() => el('span', { class: 'cmap-rc' }));
      row.append(...cells);
      row._fill = () => {
        name.append(ratingPills(map));
        const filled = ratingCells(map);
        cells.forEach((c, i) => c.replaceWith(filled[i]));
      };
      if (rowObserver) rowObserver.observe(row);
      else row._fill();

      const button = el('button', {
        class: 'cmap-toggle cmap-open-btn', type: 'button', 'aria-expanded': 'false',
        'aria-label': `Details of ${map.name}`, title: 'Show plots and details',
      });
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const cmpBtn = el('button', { class: 'cmap-toggle cmap-cmp', type: 'button', 'aria-pressed': 'false' });
      cmpBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="i-add" d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path class="i-on" d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // Reverse this map only, as in Compare.
      const revBtn = el('button', { class: 'cmap-toggle cmap-sm', type: 'button', 'data-act': 'rev' });
      revBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const actions = el('div', { class: 'cmap-actions' });
      actions.append(revBtn, cmpBtn, button);
      row.append(actions);

      const panel = el('div', { class: 'cmap-panel', id: panelId, hidden: '' });
      item.append(row, panel);
      item.dataset.name = map.name.toLowerCase();
      const entry = { map, item, strips, panel, button, cmpBtn, revBtn, order: items.length };
      syncRevBtn(entry);
      revBtn.addEventListener('click', () => {
        if (!state.flipped.delete(map.name)) state.flipped.add(map.name);
        redirect([entry]);
      });
      const toggleDetail = () => (state.open === map.name ? ctx.detail.close() : ctx.detail.open(map.name));
      button.addEventListener('click', toggleDetail);
      code.addEventListener('click', toggleDetail);
      cmpBtn.addEventListener('click', () => ctx.compare.setCompared(map.name, cmpBtn.getAttribute('aria-pressed') !== 'true'));
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
      let family = null; // sources of one family (the R packages) sit under their own title
      for (const src of data.sources) {
        const n = data.maps.filter((m) => m.source === src.key).length;
        if (!n) continue;
        if (src.family !== family) {
          family = src.family;
          if (family) filtPop.append(el('div', { class: 'cmap-pop-title' }, `${family} (${data.maps.filter((m) => data.sources.find((s) => s.key === m.source).family === family).length})`));
        }
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
        redirect(items);
      });
      return { bar, search, sort, boxes, sources, filtBtn, viewBtns, rev };
    }

    function syncRevBtn(entry) {
      const on = isRev(entry.map);
      const pre = state.flipped.has(entry.map.name) && entry.map.flip;
      entry.revBtn.setAttribute('aria-pressed', String(on));
      entry.revBtn.setAttribute('aria-label', `Reverse ${entry.map.name}`);
      entry.revBtn.title = on
        ? `Shown reversed${pre ? ' (to run the same way as its neighbors)' : ''}: click to show ${entry.map.name} in its original direction`
        : `Reverse ${entry.map.name}`;
    }

    // Redraw maps whose direction changed: their strips, the open detail and Compare.
    function redirect(entries) {
      for (const entry of entries) {
        syncRevBtn(entry);
        for (const s of entry.strips) if (s._cm.rendered) renderStrip(s);
      }
      hideTip();
      if (entries.some((e) => e.map.name === state.open)) ctx.detail.refresh();
      ctx.compare.render();
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
      for (const b of header.querySelectorAll('.cmap-th[data-sort]')) {
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
        // Only rating filters need the metrics; a search must not compute them all.
        const fails = (on.length > 0 && on.some(([, , , key]) => metrics(entry.map).rating[key] !== 'yes'))
          || (srcs.length > 0 && !srcs.includes(entry.map.source));
        entry.item.hidden = (q !== '' && !entry.item.dataset.name.includes(q)) || fails;
      }
      for (const sub of root.querySelectorAll('.cmap-browse .cmap-sub')) {
        const has = !!sub.querySelector('.cmap-item:not([hidden])');
        sub.hidden = !has;
        const n = sub.querySelectorAll('.cmap-item:not([hidden])').length;
        sub._count.textContent = filtering() ? `${n} of ${sub._total}` : String(sub._total);
        // Like sections: open the ones with matches while searching.
        sub.open = filtering() ? has : sub._userOpen;
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
      ctx.goTab('browse');
      if (entry.item.hidden) {
        ui.search.value = '';
        clearFilters();
        applyFilter();
      }
      const sec = entry.item.closest('.cmap-section');
      if (sec && !sec.open) { sec.open = true; sec._userOpen = true; }
      const sub = entry.item.closest('.cmap-sub');
      if (sub && !sub.open) { sub.open = true; sub._userOpen = true; }
      ctx.detail.open(name);
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

    // ---- the tab ----

  const ui = buildControls();
  const header = headerRow(true);
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
      const box = el('details', { class: 'cmap-sub' });
      const rows = maps.filter((x) => x.sub === sub);
      // Matplotlib's sub-headings start open, and in Sequential only its
      // perceptually uniform ones; the others are a click away.
      box._userOpen = box.open = group === 'sequential' ? /perceptually uniform/.test(sub) : rows.some((m) => m.source === 'matplotlib');
      box.addEventListener('toggle', () => { if (!filtering()) box._userOpen = box.open; });
      const subSum = el('summary');
      const subCount = el('span', { class: 'cmap-count' }, String(rows.length));
      subSum.append(el('h3', {}, sub), subCount);
      Object.assign(box, { _count: subCount, _total: rows.length });
      box.append(subSum);
      for (const m of rows) box.append(makeRow(m));
      sec.append(box);
    }
    sections.push(sec);
    browse.append(sec);
  }
  // Expand all opens every section and sub-heading, and becomes Collapse all.
  const folds = () => [...sections, ...browse.querySelectorAll('.cmap-sub')].filter((d) => !d.hidden);
  const foldBtn = el('button', { type: 'button', class: 'btn small' }, 'Expand all');
  const syncFoldBtn = () => { foldBtn.textContent = folds().every((d) => d.open) ? 'Collapse all' : 'Expand all'; };
  foldBtn.addEventListener('click', () => {
    const open = foldBtn.textContent === 'Expand all';
    for (const d of folds()) d.open = d._userOpen = open;
    syncFoldBtn();
  });
  browse.addEventListener('toggle', syncFoldBtn, true);
  ui.bar.insertBefore(foldBtn, ui.bar.querySelector('#cmap-pop-filters'));
  const empty = el('p', { class: 'muted', hidden: '' }, 'No colormap matches your search.');
  browse.append(empty);

    // Native popovers are placed once both they and their buttons are in the page.
    const anchorPopovers = () => { for (const [btn, pop] of popovers) ctx.anchorPopover(btn, pop); };

    return { bar: ui.bar, header, list: browse, sections, headerRow, applyStripView, showRow, anchorPopovers, precomputeMetrics };
  }

  Object.assign(CM, { setupCmapBrowse });
})((globalThis.Colormeris ??= {}));
