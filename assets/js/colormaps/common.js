(function (CM) {
  'use strict';

  // DOM helpers and constants shared by the colormap viewer's modules
  // (colormaps.html). The modules get them through ctx (viewer.js).

  const VIEWS = [
    { key: 'orig', label: 'Colormap', short: 'Colormap' },
    { key: 'protanopia', label: 'Protanopia', short: 'Protan' },
    { key: 'deuteranopia', label: 'Deuteranopia', short: 'Deutan' },
    { key: 'tritanopia', label: 'Tritanopia', short: 'Tritan' },
    { key: 'gray', label: 'Grayscale', short: 'Gray' },
  ];
  // The rating columns of the list: key in rating, header, full name, sort key.
  const RATING_COLS = [
    { key: 'uniform', abbr: 'U', label: 'Uniform', sort: 'uniform' },
    { key: 'cvdSafe', abbr: 'CVD', label: 'CVD-safe', sort: 'cvd' },
    { key: 'graySafe', abbr: 'Gray', label: 'Grayscale-safe', sort: 'gray' },
    { key: 'readable', abbr: 'Read', label: 'Readable', sort: 'readable' },
  ];
  const GLYPH = { yes: '✓', partly: '~', no: '✕' };
  const PILL = { uniform: 'Uniform', cvdSafe: 'CVD', graySafe: 'Gray', readable: 'Readable' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  CM.cmapCommon = { VIEWS, RATING_COLS, GLYPH, PILL, clamp8, roundRgb, pct, el, svgEl, anchorPopover };
})((globalThis.Colormeris ??= {}));
