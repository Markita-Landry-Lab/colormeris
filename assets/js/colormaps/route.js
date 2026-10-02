(function (CM) {
  'use strict';

  // Pure: the colormap viewer's URL (colormaps.html). Which tab is open
  // (#browse, #compare, …), which map shows its details (?map=) and which
  // maps are compared (?compare=). Tested in tests/colormaps/route.test.js.

  // The maps chosen for side-by-side comparison, from the page URL
  // (?compare=viridis,jet). Unknown names and repeats are dropped, matching
  // ignores case, and at most `max` are kept, so a hand-edited or old link
  // still opens a valid comparison.
  const COMPARE_MAX = 10;

  function parseCompare(param, names, max = COMPARE_MAX) {
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const out = [];
    for (const part of String(param ?? '').split(',')) {
      const name = byLower.get(part.trim().toLowerCase());
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= max) break;
    }
    return out;
  }

  // What the viewer opens on, from its URL: the tab (#browse, #compare,
  // #identify, #recolor, #cvd), the map whose details are open (?map=) and the compared maps
  // (?compare=). Other hashes (#ref-…) leave the tab alone (tab: null). Old
  // shared links have only ?compare=, so they open on the comparison.
  const VIEWER_TABS = ['browse', 'compare', 'identify', 'recolor', 'cvd'];

  function parseViewerRoute(search, hash, names) {
    const params = new URLSearchParams(search || '');
    const compare = parseCompare(params.get('compare'), names);
    const want = String(params.get('map') ?? '').trim().toLowerCase();
    const map = want ? names.find((n) => n.toLowerCase() === want) ?? null : null;
    const h = String(hash || '').replace(/^#/, '').toLowerCase();
    let tab = VIEWER_TABS.includes(h) ? h : null;
    if (!h) tab = compare.length && !map ? 'compare' : 'browse';
    return { tab, map, compare };
  }

  Object.assign(CM, { COMPARE_MAX, parseCompare, VIEWER_TABS, parseViewerRoute });
})((globalThis.Colormeris ??= {}));
