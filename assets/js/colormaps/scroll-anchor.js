(function (CM) {
  'use strict';

  // Keep the reader's place in the colormap viewer when the window is resized.
  //
  // A resize reflows the list and can move the open detail between the
  // drawer and the list, so the page length changes and the content under
  // the reader would jump. We remember what is at the top of the visible
  // area (below the sticky bar) and put it back there after each resize.
  const ANCHORS = '.cmap-item > .cmap-row, .cmap-panel .cmap-detail > *, .cmap-section > summary, .cmap-sub > h3, '
    + '.cmap-compare-head, .cmap-compare-body > *, .cmap-identify > *, .cmap-recolor > *, .cmap-cvd > *, .cmap-about';

  // ctx: { root, top (the sticky bar), state, detail }.
  function keepPlaceOnResize(ctx) {
    const { root, top, state, detail } = ctx;

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

  Object.assign(CM, { keepPlaceOnResize });
})((globalThis.Colormeris ??= {}));
