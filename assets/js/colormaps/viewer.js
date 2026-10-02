(function (CM) {
  'use strict';
  const { VIEWS, RATING_COLS, GLYPH, PILL, clamp8, roundRgb, pct, el, svgEl, anchorPopover } = CM.cmapCommon;

  // The colormap viewer page (colormaps.html), in five tabs:
  //   Browse    every colormap as five vector SVG strips (as seen, three
  //             color-vision-deficiency simulations, grayscale) with rating
  //             columns; one map at a time opens in the detail view (detail-drawer.js)
  //   Compare   up to 10 maps side by side (compare-tab.js)
  //   Identify  find the colormap of a figure (identify-tab.js)
  //   Recolor   redraw a figure in another colormap (recolor-tab.js)
  //   CVD       a figure next to a color-vision-deficiency simulation (cvd-tab.js)
  // The tab, the open map and the comparison live in the URL (route.js). The
  // data comes from core/colormap-library.js, so the page needs no fetch and
  // works from file://.
  //
  // This file holds the shared state, the colors and metrics of each map, the
  // ratings, the tabs and the page assembly. Every module gets the shared
  // `ctx` built here:
  //   common.js         DOM helpers and constants
  //   strips.js         strips and the shared tooltip
  //   plots.js          SVG plots and per-position profiles
  //   footer.js         references and the footer
  //   browse-tab.js     the Browse tab (rows, controls, sort, filters)
  //   detail-drawer.js, compare-tab.js, identify-tab.js, recolor-tab.js, cvd-tab.js
  //   scroll-anchor.js  keeps the reader's place on resize

  function setupColormapViewer(root) {
    const data = CM.cmapData;
    if (!data) throw new Error('core/colormap-library.js did not load');

    const names = data.maps.map((m) => m.name);
    const route = CM.parseViewerRoute(location.search, location.hash, names);
    // Shared with the modules. `selected` is the comparison (?compare=),
    // `open` the map in the detail view (?map=). Browse sets stripView.
    const state = {
      reversed: false, selected: route.compare, open: null, tab: 'browse', stripView: 'all', sort: null,
      // Maps shown the other way round in Browse. It starts with the sequential
      // maps the export script marked `flip`, so each section runs one way.
      flipped: new Set(data.maps.filter((m) => m.flip).map((m) => m.name)),
    };
    // A map's direction in Browse: its own toggle, then the global Reversed.
    const isRev = (map) => state.reversed !== state.flipped.has(map.name);
    const cache = new Map(); // `${name}|${reversed}` -> { view key -> { colors, L } }
    const baseOf = new Map(); // name -> original colors, parsed once
    const items = []; // { map, item, strips: [el], panel, button, cmpBtn, order }
    const mapByName = new Map(data.maps.map((m) => [m.name, m]));

    // ---- colors per view (computed once per map and direction) ----

    function base(map) {
      if (!baseOf.has(map.name)) baseOf.set(map.name, CM.parseHexColors(map.colors));
      return baseOf.get(map.name);
    }

    // `reversed` defaults to the map's Browse direction; the Compare tab passes its own.
    function viewData(map, view, reversed = isRev(map)) {
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
      if (!s || !isRev(map)) return s;
      if (map.kind === 'qualitative') {
        const n = base(map).length;
        return { min: s.min, t: [n - 1 - s.t[1], n - 1 - s.t[0]] };
      }
      return { min: s.min, t: [1 - s.t[1], 1 - s.t[0]] };
    }

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
      browse.bar.hidden = !browsing;
      browse.header.hidden = !browsing;
      browse.list.hidden = !browsing;
      compare.sec.hidden = tab !== 'compare';
      identify.sec.hidden = tab !== 'identify';
      recolor.sec.hidden = tab !== 'recolor';
      cvd.sec.hidden = tab !== 'cvd';
      if (tab === 'cvd') cvd.show();
      ctx.hideTip();
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

    // ---- page ----

    const ctx = {
      CM, el, svgEl, pct, clamp8, roundRgb, anchorPopover, VIEWS, RATING_COLS, GLYPH, PILL, data, state, items, mapByName, root,
      base, viewData, metrics, sepOf, rev, isRev, ratingPills, ratingCells, updateUrl, goTab,
      // Late bound: the modules call each other through these.
      setCompared: (name, on) => compare.setCompared(name, on),
      onCompareChange: () => { syncTabs(); detail.syncCompare(); },
      openDetail: (name) => detail.open(name),
      recolorFigure: (file, line) => { goTab('recolor'); recolor.open(file, line); },
      showRow: (name, opts) => browse.showRow(name, opts),
      detail: null, // set below
      compare: null,
    };
    // Each module adds what it shares; later modules use what earlier ones added.
    Object.assign(ctx, CM.setupCmapStrips(ctx));
    Object.assign(ctx, CM.setupCmapPlots(ctx));
    Object.assign(ctx, CM.setupCmapFooter(ctx));
    // Builds the rows, which number the references in list order.
    const browse = CM.setupCmapBrowse(ctx);
    Object.assign(ctx, { headerRow: browse.headerRow, applyStripView: browse.applyStripView });
    const detail = CM.setupCmapDetail(ctx);
    const compare = CM.setupCmapCompare(ctx);
    const identify = CM.setupCmapIdentify(ctx);
    const recolor = CM.setupCmapRecolor(ctx);
    const cvd = CM.setupCmapCvd(ctx);
    Object.assign(ctx, { detail, compare });

    root.replaceChildren();
    const inner = el('div', { class: 'cmap-inner' });
    inner.append(el('h1', {}, 'Colormaps'));
    inner.append(el('p', { class: 'cmap-intro' }, `The ${data.maps.length} colormaps of Matplotlib, CMasher, Crameri’s Scientific colour maps, cmocean, colorcet, seaborn, CarbonPlan, NCL, SciVisColor and CARTOColors as seen, as simulated for three kinds of color-vision deficiency, and in grayscale, rated for uniformity, CVD and grayscale safety, and how well values can be read back. Hover a strip for its values; click to copy the hex.`));
    // Tabs, controls and column names share one sticky bar, so they stay
    // readable while scrolling instead of one floating header per section.
    const top = el('div', { class: 'cmap-top' });
    top.append(buildTabs(), browse.bar, browse.header);
    const footer = ctx.buildFooter();
    inner.append(top, browse.list, compare.sec, identify.sec, recolor.sec, cvd.sec, footer);
    root.append(inner, detail.drawer, compare.tray);
    browse.anchorPopovers();

    // Links into the footer open it first, so the target is visible.
    root.addEventListener('click', (e) => {
      if (e.target.closest?.('a[href^="#ref-"], a[href="#cmap-about"]')) footer.open = true;
    });
    window.addEventListener('hashchange', () => {
      const r = CM.parseViewerRoute(location.search, location.hash, names);
      if (r.tab) setTab(r.tab);
      else if (/^#(ref-|cmap-about)/.test(location.hash)) footer.open = true;
    });

    browse.applyStripView(root);
    compare.syncButtons();
    compare.render();
    syncTabs();
    setTab(route.tab || 'browse', { scroll: false });
    // Every history entry gets its tab, so Back returns to the right one.
    if (!location.hash) {
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}#${state.tab}`); } catch { /* file:// */ }
    }
    if (route.map) browse.showRow(route.map, { smooth: false });
    CM.keepPlaceOnResize({ root, top, state, detail });
    browse.precomputeMetrics();
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
