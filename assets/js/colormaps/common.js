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

  // Native popovers open in the middle of the screen; put them under their
  // button (above it when there is more room there) and keep them there while
  // the page scrolls or resizes. A popover whose button leaves the screen closes.
  function anchorPopover(btn, pop) {
    btn.setAttribute('popovertarget', pop.id);
    const GAP = 6;
    const EDGE = 8;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      if (!r.width || r.bottom < 0 || r.top > vh) { pop.hidePopover(); return; }
      // Measure at the left edge with no height cap: placed near the right
      // edge, a fixed box shrinks to the space left and wraps every word.
      Object.assign(pop.style, { left: '0px', top: '0px', maxHeight: '' });
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const below = vh - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = h > below && above > below;
      const room = Math.max(80, up ? above : below);
      const top = up ? r.top - GAP - Math.min(h, room) : r.bottom + GAP;
      Object.assign(pop.style, {
        left: `${Math.round(Math.max(EDGE, Math.min(r.left, vw - w - EDGE)))}px`,
        top: `${Math.round(top)}px`,
        maxHeight: `${Math.floor(room)}px`,
      });
    };
    // Scrolls inside the popover itself don't move the button.
    const onScroll = (e) => { if (!pop.contains(e.target)) place(); };
    pop.addEventListener('beforetoggle', (e) => { if (e.newState === 'open') place(); });
    pop.addEventListener('toggle', (e) => {
      const open = e.newState === 'open';
      btn.setAttribute('aria-expanded', String(open));
      if (open) {
        place(); // again, now that its width is known
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('resize', place);
      } else {
        document.removeEventListener('scroll', onScroll, { capture: true });
        window.removeEventListener('resize', place);
      }
    });
  }

  CM.cmapCommon = { VIEWS, RATING_COLS, GLYPH, PILL, clamp8, roundRgb, pct, el, svgEl, anchorPopover };
})((globalThis.Colormeris ??= {}));
