(function (CM) {
  'use strict';

  // The Recolor tab of the colormap viewer (colormaps.html): load a figure,
  // drag along its colorbar, pick another colormap, and the figure is redrawn
  // in it (cmap-recolor.js). Pixels far from the bar's colors (background,
  // text, axes) keep theirs. Hovering a color in the figure, its recolored copy or the strips
  // flashes every pixel with a similar value to its complementary color. The image never leaves the browser.

  const DEFAULT_MAP = 'viridis';
  const TOLERANCE = 12; // ΔE76: JPEG noise stays inside, white and gray outside
  const BAND = 0.02; // share of the bar that counts as "similar" on hover
  const CHUNK = 300000; // pixels indexed between pauses
  const OVERLAY_MAX = 1600; // the highlight is drawn at about screen size, not image size

  function setupCmapRecolor(ctx) {
    const { el, pct, data, state, mapByName, base, stripSvg, roundRgb } = ctx;

    const d = el('section', { class: 'cmap-recolor', 'aria-labelledby': 'cmap-recolor-title', hidden: '' });
    d.append(el('h2', { id: 'cmap-recolor-title' }, 'Recolor a figure into another colormap'));
    d.append(el('p', { class: 'muted' }, 'Give an image of a figure, drag along its colorbar, and pick a new colormap. Each pixel with a color of the bar gets the new map’s color at the same place. The image stays in your browser.'));

    const EMPTY_HINT = 'Drop an image here, paste one (Ctrl/Cmd+V), or click to choose a file (PNG, JPEG, WebP or GIF).';
    const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });
    const oldNote = el('p', { class: 'cmap-rc-old', hidden: '' });

    // ---- controls ----
    const controls = el('div', { class: 'cmap-rc-controls', hidden: '' });
    let chosen = DEFAULT_MAP;
    const revBox = el('input', { type: 'checkbox' });
    const revLabel = el('label', { class: 'cmap-rc-check' });
    revLabel.append(revBox, ' Reversed');
    const picker = CM.createMapPicker(ctx, {
      id: 'cmap-rc',
      label: 'New colormap',
      current: () => chosen,
      onChoose: (name, typedReversed) => {
        const changed = name !== chosen || (typedReversed && !revBox.checked);
        chosen = name;
        if (typedReversed) revBox.checked = true;
        if (changed) render();
      },
    });
    const mapField = field('New colormap', 'The colormap the figure is redrawn in. Type to search; leave empty to see them all.', picker.box, revLabel);

    const tol = el('input', { type: 'range', min: '2', max: '40', step: '1', value: String(TOLERANCE) });
    const tolOut = el('output', {}, String(TOLERANCE));
    const tolField = field('Match within (ΔE)', 'Pixels farther than this from every colorbar color keep their color (background, text, axes). Raise it for noisy or JPEG images; lower it if white or gray parts change.', tol, tolOut);

    const band = el('input', { type: 'range', min: '0.5', max: '10', step: '0.5', value: String(BAND * 100) });
    const bandOut = el('output', {}, pct(BAND));
    const bandField = field('Similar within', 'On hover, pixels whose place on the colorbar is this close to the hovered one flash', band, bandOut);

    const flashBox = el('input', { type: 'checkbox', checked: '' });
    const flashLabel = el('label', { class: 'cmap-rc-check' });
    flashLabel.append(flashBox, ' Flash');
    const flashField = field('Highlight', 'On: the pixels at the hovered value flash to their complementary color. Off: they stay as they are and the rest is veiled in white.', flashLabel);

    const download = el('button', { type: 'button', class: 'btn small primary', hidden: '' }, 'Download PNG');
    const fieldsRow = el('div', { class: 'cmap-rc-fields' });
    fieldsRow.append(mapField, tolField, bandField, flashField);
    controls.append(fieldsRow);

    // ---- strips: the sampled bar over the new colors, both hoverable ----
    const strips = el('div', { class: 'cmap-rc-strips', hidden: '' });
    const oldStrip = el('div', { class: 'cmap-id-strip cmap-rc-strip', role: 'slider', tabindex: '0', 'aria-label': 'Colors of the old colorbar. Hover or use the arrow keys to highlight a value.', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    const newStrip = el('div', { class: 'cmap-id-strip cmap-rc-strip', role: 'slider', tabindex: '0', 'aria-label': 'The new colors at the same places. Hover or use the arrow keys to highlight a value.', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    strips.append(el('span', { class: 'muted' }, 'Old colors, as sampled along the line'), oldStrip,
      el('span', { class: 'muted' }, 'New colors'), newStrip);
    const readout = el('p', { class: 'cmap-rc-readout muted', 'aria-live': 'polite' });

    // ---- the figure and its recolored copy side by side, each with the highlight on top ----
    const overlay = el('canvas', { class: 'cmap-rc-overlay', 'aria-hidden': 'true' });
    const overlay2 = el('canvas', { class: 'cmap-rc-overlay', 'aria-hidden': 'true' });

    let samples = null; // the calibrated bar
    let flip = false; // the line was drawn from the old map's high end
    let index = null; // per-pixel t and ΔE
    const out = el('canvas', { class: 'cmap-id-canvas cmap-rc-canvas', role: 'img', 'aria-label': 'Your figure, recolored. Hover a color to see where it is.' }); // the recolored image
    let outData = null; // its RGBA bytes, for the highlight's colors
    let outImage = null; // the same as ImageData, to put back after a peek
    let peek = null; // { canvas pressed, x, y }: it shows the other version while held
    let job = 0; // the indexing run in progress; a new one cancels it
    let hoverT = null;
    let mask = null;
    let overlayData = null; // one buffer per overlay
    let pending = null; // the latest hover, drawn at the next frame
    let frame = 0;

    const fig = CM.createFigureInput({
      buttons: [download], // beside the other buttons, before Clear
      el,
      state,
      tab: 'recolor',
      label: 'Your figure. Drag along the colorbar from its low end to its high end, then hover a color to see where it is.',
      hints: {
        empty: EMPTY_HINT,
        loaded: 'Drag along the colorbar from one end to the other. The figure is then redrawn in the new colormap next to the original. Hover a color in either to see where it appears; press and hold one to see the other version in its place.',
      },
      base: () => (peek?.canvas === fig.canvas ? out : null),
      showLine: () => peek?.canvas !== fig.canvas,
      keepLineOnClick: true,
      onReset: (keepImage) => {
        job++;
        samples = null;
        index = null;
        outPanel.hidden = true;
        outData = null;
        mask = null;
        overlayData = null;
        clearHighlight();
        controls.hidden = download.hidden = true;
        strips.hidden = true;
        oldNote.hidden = true;
        status.textContent = '';
        readout.textContent = '';
        if (!keepImage) { overlay.hidden = true; origPanel.hidden = true; }
      },
      onLoad: () => { overlay.hidden = false; origPanel.hidden = false; },
      onError: (msg) => { status.textContent = msg; },
      onLine: (a, b) => calibrate(a, b),
    });
    fig.canvas.classList.add('cmap-rc-canvas');
    function panel(caption, canvas, ov) {
      const f = el('figure', { class: 'cmap-rc-panel', hidden: '' });
      const stack = el('div', { class: 'cmap-rc-stack' });
      stack.append(canvas, ov);
      f.append(el('figcaption', {}, caption), stack);
      return f;
    }
    const origPanel = panel('Original', fig.canvas, overlay);
    const outPanel = panel('Recolored', out, overlay2);
    const grid = el('div', { class: 'cmap-rc-grid' });
    grid.append(origPanel, outPanel);
    d.append(fig.zone, fig.file, controls, status, grid, readout, oldNote, strips);

    function field(label, title, ...inputs) {
      const f = el('div', { class: 'cmap-rc-field', title });
      const row = el('div', { class: 'cmap-rc-input' });
      row.append(...inputs);
      f.append(el('span', { class: 'cmap-rc-label' }, label), row);
      return f;
    }

    const newMap = () => {
      const m = mapByName.get(chosen) || mapByName.get(DEFAULT_MAP);
      return { name: m.name, kind: m.kind, rgbs: base(m) };
    };
    const tolerance = () => Number(tol.value);
    const bandWidth = () => Number(band.value) / 100;
    const mapLabel = () => `${chosen}${revBox.checked ? '_r' : ''}`;

    // ---- calibration ----

    function calibrate(a, b) {
      const img = fig.img;
      const k = CM.refineColorbar(img, a, b);
      let start = a;
      let end = b;
      let half = 2;
      if (k) { ({ start, end } = k); half = k.halfWidth; }
      fig.line = { start, end };
      outPanel.hidden = true;
      fig.redraw();
      const s = CM.sampleColorbar(img, start, end, half, 256);
      if (s.length < 2) { status.textContent = 'That line is too short.'; return; }
      samples = s;
      describeOld(s.map((x) => x.rgb), Boolean(k));
      buildIndex();
    }

    // Name the old map when it is a known one, and read the bar in its
    // direction, so the low end stays the low end whichever way it was drawn.
    function describeOld(rgbs, snapped) {
      const maps = data.maps.map((m) => ({ name: m.name, kind: m.kind, rgbs: base(m) }));
      const best = CM.identifyColorbar(rgbs, maps)[0];
      const level = best ? CM.matchLevel(best.score) : 'none';
      flip = level !== 'none' && best.reversed;
      oldNote.replaceChildren();
      oldNote.hidden = false;
      if (level === 'none') {
        oldNote.append(`The old colors match no known colormap (best ΔE ${best ? best.score.toFixed(1) : '–'}), so the end where you started the line is taken as the low end.`);
      } else {
        oldNote.append(level === 'exact' ? 'Old colormap: ' : 'Old colormap looks like ', el('code', {}, best.name), ` (ΔE ${best.score.toFixed(1)}).`);
        if (flip) oldNote.append(' The line runs from its high end, so it is read the other way.');
      }
      if (!snapped) oldNote.append(' The line could not be snapped to a colorbar; drag along the middle of the bar.');
    }

    function buildIndex() {
      const my = ++job;
      const ix = CM.createIndexer(fig.img, samples);
      status.textContent = 'Reading the colors…';
      const tick = () => {
        if (my !== job) return; // a newer calibration or another image
        const done = ix.step(CHUNK);
        if (done < 1) {
          status.textContent = `Reading the colors… ${pct(done)}`;
          setTimeout(tick, 0);
          return;
        }
        index = ix.index;
        mask = null;
        status.textContent = '';
        controls.hidden = download.hidden = false;
        strips.hidden = false;
        render();
      };
      setTimeout(tick, 0);
    }

    // ---- recoloring ----

    function render() {
      if (!index) return;
      const img = fig.img;
      const r = CM.recolorPixels(img, index, newMap(), { tolerance: tolerance(), reversed: revBox.checked, flip });
      out.width = img.width;
      out.height = img.height;
      outImage = new ImageData(r.data, img.width, img.height);
      out.getContext('2d').putImageData(outImage, 0, 0);
      outData = r.data;
      outPanel.hidden = false;
      oldStrip.innerHTML = stripSvg(samples.map((s) => roundRgb(s.rgb)), false);
      const m = newMap();
      const opt = { reversed: revBox.checked, flip };
      const colors = Array.from({ length: 128 }, (_, i) => roundRgb(CM.newColorAt(m, i / 127, opt)));
      newStrip.innerHTML = stripSvg(colors, m.kind === 'qualitative');
      for (const s of [oldStrip, newStrip]) s.append(el('span', { class: 'cmap-rc-mark', hidden: '' }));
      readout.textContent = `${pct(r.changed / (img.width * img.height))} of the pixels have a color of the bar and are recolored. Hover a color to see where it is.`;
      if (hoverT != null) highlight(hoverT, true);
    }

    // ---- hover highlight ----

    const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Pointer events can come faster than a big image can be masked, so only
    // the latest one per frame is drawn.
    function hover(t) {
      pending = t;
      if (frame) return;
      const run = () => { frame = 0; if (pending != null) highlight(pending); };
      frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
    }

    function highlight(t, force = false) {
      if (!index) return;
      pending = null;
      t = Math.max(0, Math.min(1, t));
      // Pointer moves of a fraction of the band would give the same picture.
      if (!force && hoverT != null && Math.abs(t - hoverT) < bandWidth() / 8) return;
      hoverT = t;
      const step = Math.ceil(Math.max(index.width, index.height) / OVERLAY_MAX);
      const res = CM.similarMask(index, t, bandWidth(), tolerance(), { step, mask });
      mask = res.mask;
      const n = mask.length;
      const calm = reduceMotion() || !flashBox.checked;
      overlayData ??= [];
      [[overlay, fig.img.data], [overlay2, outData]].forEach(([ov, shown], i) => {
        if (ov.width !== res.width || ov.height !== res.height) {
          ov.width = res.width;
          ov.height = res.height;
        }
        if (!overlayData[i] || overlayData[i].width !== res.width || overlayData[i].height !== res.height) overlayData[i] = new ImageData(res.width, res.height);
        const px = new Uint32Array(overlayData[i].data.buffer);
        // Little-endian RGBA as one word.
        const dim = (180 << 24) | (255 << 16) | (255 << 8) | 255; // white veil over the rest
        if (calm) {
          for (let j = 0; j < n; j++) px[j] = mask[j] ? 0 : dim;
        } else {
          // Each pixel flashes to the complement (255 − r, 255 − g, 255 − b) of the color shown
          // under it, which stands out whatever the map.
          const w = res.width;
          for (let j = 0; j < n; j++) {
            if (!mask[j]) { px[j] = 0; continue; }
            const o = ((((j / w) | 0) * step) * index.width + (j % w) * step) * 4;
            px[j] = (255 << 24) | ((255 - shown[o + 2]) << 16) | ((255 - shown[o + 1]) << 8) | (255 - shown[o]);
          }
        }
        ov.getContext('2d').putImageData(overlayData[i], 0, 0);
        ov.classList.toggle('flash', !calm);
        ov.classList.add('on');
      });
      for (const s of [oldStrip, newStrip]) {
        const mk = s.querySelector('.cmap-rc-mark');
        if (mk) { mk.hidden = false; mk.style.left = `${(t * 100).toFixed(2)}%`; }
        s.setAttribute('aria-valuenow', String(Math.round(t * 100)));
      }
      const c = roundRgb(CM.colorAtT(samples, t));
      const sw = el('span', { class: 'cmap-sw', style: `background:${CM.rgbToHex(c)}` });
      readout.replaceChildren(sw, ` At ${pct(t)} of the bar: ${pct(res.count / res.total)} of the pixels (±${pct(bandWidth())}).`);
    }

    function clearHighlight() {
      hoverT = null;
      pending = null;
      for (const ov of [overlay, overlay2]) ov.classList.remove('on', 'flash');
      for (const s of [oldStrip, newStrip]) {
        const mk = s.querySelector('.cmap-rc-mark');
        if (mk) mk.hidden = true;
      }
    }

    // Both images have the same size, so a point on either is a point on both.
    const pointOn = (c, e) => {
      const r = c.getBoundingClientRect();
      const k = c.width / (c.clientWidth || c.width);
      return {
        x: Math.max(0, Math.min(c.width - 1, (e.clientX - r.left - c.clientLeft) * k)),
        y: Math.max(0, Math.min(c.height - 1, (e.clientY - r.top - c.clientTop) * k)),
      };
    };
    for (const c of [fig.canvas, out]) {
      c.addEventListener('pointermove', (e) => {
        if (!index || fig.dragging) return;
        const p = pointOn(c, e);
        const hit = CM.tAtPixel(index, p.x, p.y, tolerance());
        if (hit) hover(hit.t);
        else if (hoverT != null || pending != null) clearHighlight();
      });
      c.addEventListener('pointerleave', () => clearHighlight());
    }
    // Press and hold either image to see the other version in its place; it
    // comes back on release, or once the press becomes a drag.
    const showPeek = () => {
      if (peek?.canvas === out) out.getContext('2d').putImageData(fig.img, 0, 0);
      else if (outImage) out.getContext('2d').putImageData(outImage, 0, 0);
      fig.redraw();
    };
    const endPeek = () => {
      if (!peek) return;
      peek = null;
      showPeek();
    };
    for (const c of [fig.canvas, out]) {
      c.addEventListener('pointerdown', (e) => {
        clearHighlight();
        if (!index || e.button > 0) return;
        peek = { canvas: c, x: e.clientX, y: e.clientY };
        showPeek();
      });
      c.addEventListener('pointermove', (e) => {
        if (peek && Math.hypot(e.clientX - peek.x, e.clientY - peek.y) >= 8) endPeek();
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) c.addEventListener(t, endPeek);
    }

    for (const s of [oldStrip, newStrip]) {
      const tOf = (e) => {
        const r = s.getBoundingClientRect();
        return (e.clientX - r.left) / (r.width || 1);
      };
      s.addEventListener('pointermove', (e) => hover(tOf(e)));
      s.addEventListener('pointerdown', (e) => highlight(tOf(e), true));
      s.addEventListener('pointerleave', () => { if (document.activeElement !== s) clearHighlight(); });
      s.addEventListener('blur', clearHighlight);
      s.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.1 : 0.01;
        const now = hoverT ?? 0.5;
        const next = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: 0, End: 1 }[e.key];
        if (next == null) return;
        e.preventDefault();
        highlight(next, true);
      });
    }

    flashBox.addEventListener('change', () => { if (hoverT != null) highlight(hoverT, true); });
    revBox.addEventListener('change', render);
    tol.addEventListener('input', () => { tolOut.textContent = tol.value; render(); });
    band.addEventListener('input', () => {
      bandOut.textContent = pct(bandWidth());
      if (hoverT != null) highlight(hoverT, true);
    });

    download.addEventListener('click', () => {
      if (!index) return;
      out.toBlob((blob) => {
        if (!blob) { status.textContent = 'Could not make the PNG.'; return; }
        const a = el('a', { href: URL.createObjectURL(blob), download: `${fig.name}-${mapLabel()}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    });

    // From Identify: the same figure and line, recolored at once.
    async function open(file, line) {
      if (!file) return;
      if (!(await fig.load(file))) return;
      if (line) calibrate(line.start, line.end);
    }

    return { sec: d, open };
  }

  Object.assign(CM, { setupCmapRecolor });
})((globalThis.Colormeris ??= {}));
